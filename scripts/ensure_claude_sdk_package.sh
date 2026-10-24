#!/bin/bash
# Validate and repair Claude Agent SDK native platform packages.
#
# npm optionalDependencies can be left half-installed if a previous install is
# interrupted. A truncated Mach-O can still exist and pass simple "file exists"
# checks, but it is killed by macOS at spawn time with opaque errors such as
# "spawn Unknown system error -88".

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'
CURRENT_TMP_DIR=""

cleanup_tmp_dir() {
    if [ -n "${CURRENT_TMP_DIR:-}" ]; then
        rm -rf "$CURRENT_TMP_DIR"
    fi
}

trap cleanup_tmp_dir EXIT

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo -e "${YELLOW}Skipping Claude SDK native package validation on non-macOS host${NC}"
    exit 0
fi

for cmd in node npm lipo otool codesign; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo -e "${RED}Missing required command: $cmd${NC}"
        exit 1
    fi
done

SDK_VERSION=$(node - <<'NODE'
const pkg = require('./package.json');
const deps = pkg.optionalDependencies || {};
const arm = deps['@anthropic-ai/claude-agent-sdk-darwin-arm64'];
const x64 = deps['@anthropic-ai/claude-agent-sdk-darwin-x64'];
if (!arm && !x64) {
  console.error('Claude Agent SDK darwin optionalDependencies are missing');
  process.exit(1);
}
if (arm && x64 && arm !== x64) {
  console.error(`Claude Agent SDK darwin package versions differ: arm64=${arm}, x64=${x64}`);
  process.exit(1);
}
process.stdout.write(arm || x64);
NODE
)

expected_macho_arch() {
    case "$1" in
        arm64) echo "arm64" ;;
        x64) echo "x86_64" ;;
        *)
            echo -e "${RED}Unsupported Claude SDK arch: $1${NC}" >&2
            return 1
            ;;
    esac
}

validate_macho_binary() {
    local binary="$1"
    local expected_arch="$2"
    local label="$3"
    local arches=""
    local output=""

    if [ ! -f "$binary" ]; then
        echo -e "  ${YELLOW}${label} missing: $binary${NC}"
        return 1
    fi

    arches=$(lipo -archs "$binary" 2>/dev/null || true)
    if [[ " $arches " != *" $expected_arch "* ]]; then
        echo -e "  ${YELLOW}${label} arch mismatch: expected=${expected_arch}, actual=${arches:-unknown}${NC}"
        return 1
    fi

    if ! output=$(otool -l "$binary" 2>&1); then
        echo -e "  ${YELLOW}${label} has unreadable Mach-O load commands${NC}"
        echo "$output" | sed 's/^/    /'
        return 1
    fi
    if grep -q "past end of file" <<<"$output"; then
        echo -e "  ${YELLOW}${label} is truncated: Mach-O load commands point past end of file${NC}"
        return 1
    fi

    if ! output=$(codesign --verify --strict --verbose=2 "$binary" 2>&1); then
        echo -e "  ${YELLOW}${label} has invalid code signature${NC}"
        echo "$output" | sed 's/^/    /'
        return 1
    fi

    return 0
}

validate_package() {
    local arch="$1"
    local expected_arch
    expected_arch=$(expected_macho_arch "$arch")
    local pkg_name="@anthropic-ai/claude-agent-sdk-darwin-${arch}"
    local pkg_dir="${PROJECT_DIR}/node_modules/${pkg_name}"
    local pkg_json="${pkg_dir}/package.json"
    local binary="${pkg_dir}/claude"

    if [ ! -f "$pkg_json" ]; then
        echo -e "  ${YELLOW}${pkg_name} package.json missing${NC}"
        return 1
    fi

    if ! node - "$pkg_json" "$pkg_name" "$SDK_VERSION" <<'NODE'; then
const fs = require('fs');
const [pkgPath, expectedName, expectedVersion] = process.argv.slice(2);
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  process.exit(pkg.name === expectedName && pkg.version === expectedVersion ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
        echo -e "  ${YELLOW}${pkg_name} package.json does not match ${SDK_VERSION}${NC}"
        return 1
    fi

    validate_macho_binary "$binary" "$expected_arch" "${pkg_name}/claude"
}

repair_package() {
    local arch="$1"
    local pkg_name="@anthropic-ai/claude-agent-sdk-darwin-${arch}"
    local pkg_dir="${PROJECT_DIR}/node_modules/${pkg_name}"
    local tmp_dir=""

    echo -e "${BLUE}准备下载并安装 Claude SDK darwin-${arch}@${SDK_VERSION}（首次下载可能较慢）...${NC}"
    echo "  npm 将显示下载日志；完成前可能只有转圈提示，当前尚未进入编译或公证。"
    tmp_dir=$(mktemp -d "${PROJECT_DIR}/.tmp-claude-sdk-${arch}.XXXXXX")
    CURRENT_TMP_DIR="$tmp_dir"

    # --force permits an Intel package on an ARM host; --ignore-scripts avoids
    # executing the target binary during cross-architecture preparation.
    if ! npm install --prefix "$tmp_dir" --force --prefer-online --no-save --package-lock=false \
        --no-audit --no-fund --ignore-scripts --loglevel=http \
        --os=darwin --cpu="$arch" \
        "${pkg_name}@${SDK_VERSION}"; then
        rm -rf "$tmp_dir"
        CURRENT_TMP_DIR=""
        echo -e "${RED}Failed to install ${pkg_name}@${SDK_VERSION}${NC}"
        exit 1
    fi

    if [ ! -d "${tmp_dir}/node_modules/${pkg_name}" ]; then
        rm -rf "$tmp_dir"
        CURRENT_TMP_DIR=""
        echo -e "${RED}Temporary install did not produce ${pkg_name}${NC}"
        exit 1
    fi

    rm -rf "$pkg_dir"
    mkdir -p "$(dirname "$pkg_dir")"
    cp -R "${tmp_dir}/node_modules/${pkg_name}" "$pkg_dir"
    rm -rf "$tmp_dir"
    CURRENT_TMP_DIR=""
    xattr -d com.apple.quarantine "${pkg_dir}/claude" 2>/dev/null || true

    if ! validate_package "$arch"; then
        echo -e "${RED}${pkg_name}@${SDK_VERSION} is still invalid after repair${NC}"
        exit 1
    fi
}

arches=("$@")
if [ ${#arches[@]} -eq 0 ]; then
    case "$(uname -m)" in
        arm64) arches=("arm64") ;;
        x86_64) arches=("x64") ;;
        *)
            echo -e "${RED}Unsupported host arch: $(uname -m)${NC}"
            exit 1
            ;;
    esac
fi

for arch in "${arches[@]}"; do
    case "$arch" in
        arm64|x64) ;;
        *)
            echo -e "${RED}Unsupported Claude SDK arch: $arch${NC}"
            exit 1
            ;;
    esac

    if validate_package "$arch"; then
        echo -e "${GREEN}Claude SDK darwin-${arch}@${SDK_VERSION} is valid${NC}"
    else
        repair_package "$arch"
        echo -e "${GREEN}Claude SDK darwin-${arch}@${SDK_VERSION} repaired${NC}"
    fi
done
