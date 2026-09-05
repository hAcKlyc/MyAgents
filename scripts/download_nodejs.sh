#!/bin/bash
# Download Node.js LTS binaries for bundling with MyAgents.
#
# This script downloads the official Node.js distribution into an
# architecture-specific cache, then stages the requested runtime into
# src-tauri/resources/nodejs/ for Tauri bundling.
#
# The full distribution includes node, npm, and npx — everything needed
# for MCP servers and AI bash tool execution.
#
# Usage:
#   ./scripts/download_nodejs.sh              # Download for current platform only
#   ./scripts/download_nodejs.sh --target arm64|x64  # Download specific macOS arch
#   ./scripts/download_nodejs.sh --all        # Populate all macOS caches, stage host arch
#   ./scripts/download_nodejs.sh --clean      # Remove staged runtime and all caches first

set -e

# ========================================
# Configuration
# ========================================
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Bootstrap must work without system Node or jq. This checked-in manifest has
# one exact version per line; PowerShell and Vite read the same JSON authority.
RUNTIME_MANIFEST="${PROJECT_DIR}/scripts/node-runtime.json"
NODE_VERSION=$(sed -nE 's/^[[:space:]]*"node":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"[,]?[[:space:]]*$/\1/p' "$RUNTIME_MANIFEST")
NPM_VERSION=$(sed -nE 's/^[[:space:]]*"npm":[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"[,]?[[:space:]]*$/\1/p' "$RUNTIME_MANIFEST")
if [[ ! "$NODE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ || ! "$NPM_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Invalid pinned Node/npm versions in $RUNTIME_MANIFEST" >&2
    exit 1
fi
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
RESOURCES_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"
CACHE_ROOT="${PROJECT_DIR}/src-tauri/resources/nodejs-cache"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# ========================================
# Helpers
# ========================================

log_info()  { echo -e "${BLUE}[nodejs]${NC} $1"; }
log_ok()    { echo -e "${GREEN}[nodejs]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[nodejs]${NC} $1"; }
log_error() { echo -e "${RED}[nodejs]${NC} $1"; }

normalize_arch() {
    case "$1" in
        arm64|aarch64) echo "arm64" ;;
        x64|x86_64) echo "x64" ;;
        *) echo "$1" ;;
    esac
}

cache_dir_for() {
    local platform="$1"
    local arch
    arch=$(normalize_arch "$2")
    echo "${CACHE_ROOT}/${platform}-${arch}-v${NODE_VERSION}"
}

node_bin_for_dir() {
    local dir="$1"
    local platform="$2"
    if [[ "$platform" == "win" ]]; then
        echo "${dir}/node.exe"
    else
        echo "${dir}/bin/node"
    fi
}

write_metadata() {
    local dir="$1"
    local platform="$2"
    local arch
    arch=$(normalize_arch "$3")
    printf "%s\n" "$NODE_VERSION" > "${dir}/.myagents-nodejs-version"
    printf "%s\n" "$platform" > "${dir}/.myagents-nodejs-platform"
    printf "%s\n" "$arch" > "${dir}/.myagents-nodejs-arch"
}

check_arch() {
    local node_bin="$1"
    local expected_arch
    expected_arch=$(normalize_arch "$2")
    local file_info
    file_info=$(file "$node_bin" 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")

    if [[ "$expected_arch" == "arm64" ]]; then
        if [[ "$file_info" != *"arm64"* && "$file_info" != *"aarch64"* ]]; then
            log_warn "Architecture mismatch: expected arm64, got ${file_info:-unknown}"
            return 1
        fi
    elif [[ "$expected_arch" == "x64" ]]; then
        if [[ "$file_info" != *"x86_64"* && "$file_info" != *"x86-64"* ]]; then
            log_warn "Architecture mismatch: expected x64, got ${file_info:-unknown}"
            return 1
        fi
    fi
    return 0
}

# npm belongs to the official Node distribution. Inspect the package itself
# even for cross-target caches, where the bundled executable cannot run here.
check_npm() {
    local dir="$1"
    local platform="$2"
    local npm_dir="${dir}/lib/node_modules/npm"
    local bin_dir="${dir}/bin"
    local suffix=""
    if [[ "$platform" == "win" ]]; then
        npm_dir="${dir}/node_modules/npm"
        bin_dir="$dir"
        suffix=".cmd"
    fi
    [[ -f "${npm_dir}/package.json" && -f "${npm_dir}/bin/npm-cli.js" && -f "${npm_dir}/bin/npx-cli.js" ]] || return 1
    [[ -f "${bin_dir}/npm${suffix}" && -f "${bin_dir}/npx${suffix}" ]] || return 1
    local existing_npm
    existing_npm=$(sed -nE 's/^  "version":[[:space:]]*"([^" ]+)"[,]?[[:space:]]*$/\1/p' "${npm_dir}/package.json")
    [[ "$existing_npm" == "$NPM_VERSION" ]]
}

# Check the pinned Node/npm pair and target before reusing or staging a tree.
# Usage: check_existing <dir> <platform> [expected_arch]
#   platform: darwin | linux | win
#   expected_arch: arm64 | x64 (optional for win)
check_existing() {
    local dir="$1"
    local platform="$2"
    local expected_arch
    expected_arch=$(normalize_arch "$3")
    local node_bin
    node_bin=$(node_bin_for_dir "$dir" "$platform")

    if [[ -f "$node_bin" ]]; then
        case "$dir" in
            "$CACHE_ROOT"/*)
                if [[ ! -f "${dir}/.myagents-nodejs-version" ]]; then
                    return 1
                fi
                ;;
        esac
        # Check version
        local existing_ver
        if [[ -f "${dir}/.myagents-nodejs-version" ]]; then
            existing_ver=$(cat "${dir}/.myagents-nodejs-version" 2>/dev/null || echo "")
        else
            # Cross-arch binaries may not execute on every host, so metadata is
            # the source of truth after the first cache population. This fallback
            # only supports pre-cache staged directories from older checkouts.
            existing_ver=$("$node_bin" --version 2>/dev/null | sed 's/^v//' || echo "")
        fi
        if [[ "$existing_ver" != "${NODE_VERSION}" ]]; then
            return 1
        fi
        if [[ -f "${dir}/.myagents-nodejs-platform" ]]; then
            local existing_platform
            existing_platform=$(cat "${dir}/.myagents-nodejs-platform" 2>/dev/null || echo "")
            if [[ "$existing_platform" != "$platform" ]]; then
                return 1
            fi
        fi
        if [[ -n "$expected_arch" && -f "${dir}/.myagents-nodejs-arch" ]]; then
            local existing_arch
            existing_arch=$(normalize_arch "$(cat "${dir}/.myagents-nodejs-arch" 2>/dev/null || echo "")")
            if [[ "$existing_arch" != "$expected_arch" ]]; then
                return 1
            fi
        fi
        # Check architecture where `file(1)` can identify native binaries.
        if [[ -n "$expected_arch" && ( "$platform" == "darwin" || "$platform" == "linux" ) ]]; then
            check_arch "$node_bin" "$expected_arch" || return 1
        fi
        check_npm "$dir" "$platform" || return 1
        return 0  # Node/npm versions and target match
    fi
    return 1
}

stage_nodejs() {
    local cache_dir="$1"
    local platform="$2"
    local arch
    arch=$(normalize_arch "$3")

    if ! check_existing "$cache_dir" "$platform" "$arch"; then
        log_error "Cache is not usable: ${cache_dir}"
        return 1
    fi

    rm -rf "$RESOURCES_DIR"
    mkdir -p "$RESOURCES_DIR"
    cp -R "${cache_dir}/." "$RESOURCES_DIR/"

    if ! check_existing "$RESOURCES_DIR" "$platform" "$arch"; then
        log_error "Staged Node.js failed verification: ${RESOURCES_DIR}"
        return 1
    fi

    log_ok "Staged ${platform}-${arch} Node.js v${NODE_VERSION} from cache"
}

seed_cache_from_staging() {
    local cache_dir="$1"
    local platform="$2"
    local arch
    arch=$(normalize_arch "$3")

    if check_existing "$RESOURCES_DIR" "$platform" "$arch"; then
        log_info "Seeding cache from existing staged ${platform}-${arch} runtime..."
        rm -rf "$cache_dir"
        mkdir -p "$cache_dir"
        cp -R "${RESOURCES_DIR}/." "$cache_dir/"
        write_metadata "$cache_dir" "$platform" "$arch"
        return 0
    fi
    return 1
}

install_unix_distribution() {
    local extracted_dir="$1"
    local dest_dir="$2"

    rm -rf "$dest_dir"
    mkdir -p "$dest_dir"
    cp -R "${extracted_dir}/bin" "$dest_dir/"
    cp -R "${extracted_dir}/lib" "$dest_dir/"

    # Resolve symlinks: npm/npx are symlinks, but Tauri resource copy may not
    # preserve them. Replace with actual shell scripts.
    for cmd in npm npx; do
        local link_target
        link_target=$(readlink "${dest_dir}/bin/${cmd}" 2>/dev/null || echo "")
        if [[ -n "$link_target" ]]; then
            local cli_name
            if [[ "$cmd" == "npm" ]]; then cli_name="npm-cli"; else cli_name="npx-cli"; fi
            rm -f "${dest_dir}/bin/${cmd}"
            cat > "${dest_dir}/bin/${cmd}" <<EOF
#!/bin/sh
basedir=\$(cd "\$(dirname "\$0")" && pwd)
exec "\$basedir/node" "\$basedir/../lib/node_modules/npm/bin/${cli_name}.js" "\$@"
EOF
            chmod +x "${dest_dir}/bin/${cmd}"
        fi
    done

    # Remove unnecessary files to reduce size.
    rm -rf "${dest_dir}/bin/corepack"
    rm -rf "${dest_dir}/include"
    rm -rf "${dest_dir}/share"
    rm -rf "${dest_dir}/lib/node_modules/corepack"

    chmod +x "${dest_dir}/bin/node"
}

# Download and extract Node.js for macOS
download_macos() {
    local arch="$1"  # arm64 or x64
    local should_stage="${2:-true}"
    local node_arch

    if [[ "$arch" == "arm64" ]]; then
        node_arch="arm64"
    else
        node_arch="x64"
    fi

    local tarball="node-v${NODE_VERSION}-darwin-${node_arch}.tar.xz"
    local url="${NODE_BASE_URL}/${tarball}"
    local cache_dir
    cache_dir=$(cache_dir_for "darwin" "$node_arch")

    # Check arch-specific cache first. The staging directory is intentionally
    # overwritten per target; it is not the cache.
    if check_existing "$cache_dir" "darwin" "$node_arch"; then
        log_ok "macOS ${node_arch}: Cache hit at v${NODE_VERSION}"
        if [[ "$should_stage" == "true" ]]; then
            stage_nodejs "$cache_dir" "darwin" "$node_arch"
        fi
        return 0
    fi

    # One-time migration path for older checkouts where resources/nodejs already
    # contains the requested arch.
    if seed_cache_from_staging "$cache_dir" "darwin" "$node_arch"; then
        log_ok "macOS ${node_arch}: Cache seeded at v${NODE_VERSION}"
        if [[ "$should_stage" == "true" ]]; then
            stage_nodejs "$cache_dir" "darwin" "$node_arch"
        fi
        return 0
    fi

    log_info "Downloading Node.js v${NODE_VERSION} for macOS ${node_arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    # Download
    curl -fsSL "$url" -o "${tmp_dir}/${tarball}"

    # Extract — strip the top-level directory
    log_info "Extracting..."
    tar xf "${tmp_dir}/${tarball}" -C "$tmp_dir"

    # Cache full distribution (replacing only this platform/arch/version cache).
    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-darwin-${node_arch}"
    install_unix_distribution "$extracted_dir" "$cache_dir"

    write_metadata "$cache_dir" "darwin" "$node_arch"
    check_existing "$cache_dir" "darwin" "$node_arch" || { log_error "Downloaded runtime does not match Node $NODE_VERSION / npm $NPM_VERSION"; return 1; }

    if [[ "$should_stage" == "true" ]]; then
        stage_nodejs "$cache_dir" "darwin" "$node_arch"
    fi

    log_ok "macOS ${node_arch}: Node.js v${NODE_VERSION} ready"
}

# Download and extract Node.js for Linux (glibc; Alpine users install Node.js manually)
download_linux() {
    local arch="$1"  # x64 or arm64
    local should_stage="${2:-true}"
    local node_arch
    if [[ "$arch" == "arm64" || "$arch" == "aarch64" ]]; then
        node_arch="arm64"
    else
        node_arch="x64"
    fi

    local tarball="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"
    local url="${NODE_BASE_URL}/${tarball}"
    local cache_dir
    cache_dir=$(cache_dir_for "linux" "$node_arch")

    if check_existing "$cache_dir" "linux" "$node_arch"; then
        log_ok "Linux ${node_arch}: Cache hit at v${NODE_VERSION}"
        if [[ "$should_stage" == "true" ]]; then
            stage_nodejs "$cache_dir" "linux" "$node_arch"
        fi
        return 0
    fi

    if seed_cache_from_staging "$cache_dir" "linux" "$node_arch"; then
        log_ok "Linux ${node_arch}: Cache seeded at v${NODE_VERSION}"
        if [[ "$should_stage" == "true" ]]; then
            stage_nodejs "$cache_dir" "linux" "$node_arch"
        fi
        return 0
    fi

    log_info "Downloading Node.js v${NODE_VERSION} for Linux ${node_arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    curl -fsSL "$url" -o "${tmp_dir}/${tarball}"

    log_info "Extracting..."
    tar xf "${tmp_dir}/${tarball}" -C "$tmp_dir"

    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-linux-${node_arch}"
    install_unix_distribution "$extracted_dir" "$cache_dir"

    write_metadata "$cache_dir" "linux" "$node_arch"
    check_existing "$cache_dir" "linux" "$node_arch" || { log_error "Downloaded runtime does not match Node $NODE_VERSION / npm $NPM_VERSION"; return 1; }

    if [[ "$should_stage" == "true" ]]; then
        stage_nodejs "$cache_dir" "linux" "$node_arch"
    fi

    log_ok "Linux ${node_arch}: Node.js v${NODE_VERSION} ready"
}

# Download Node.js for Windows (used in CI/CD cross-build)
download_windows() {
    local arch="$1"  # x64 or arm64
    local should_stage="${2:-true}"
    arch=$(normalize_arch "$arch")
    local zipfile="node-v${NODE_VERSION}-win-${arch}.zip"
    local url="${NODE_BASE_URL}/${zipfile}"
    local cache_dir
    cache_dir=$(cache_dir_for "win" "$arch")

    if check_existing "$cache_dir" "win" "$arch"; then
        log_ok "Windows ${arch}: Cache hit at v${NODE_VERSION}"
        if [[ "$should_stage" == "true" ]]; then
            stage_nodejs "$cache_dir" "win" "$arch"
        fi
        return 0
    fi

    log_info "Downloading Node.js v${NODE_VERSION} for Windows ${arch}..."

    local tmp_dir
    tmp_dir=$(mktemp -d)
    trap "rm -rf '$tmp_dir'" RETURN

    curl -fsSL "$url" -o "${tmp_dir}/${zipfile}"

    log_info "Extracting..."
    unzip -q "${tmp_dir}/${zipfile}" -d "$tmp_dir"

    local extracted_dir="${tmp_dir}/node-v${NODE_VERSION}-win-${arch}"
    rm -rf "$cache_dir"
    mkdir -p "$cache_dir"

    # Windows: flat structure (node.exe, npm.cmd, npx.cmd, node_modules/)
    cp "${extracted_dir}/node.exe" "$cache_dir/"
    cp "${extracted_dir}/npm.cmd" "$cache_dir/" 2>/dev/null || true
    cp "${extracted_dir}/npx.cmd" "$cache_dir/" 2>/dev/null || true
    cp "${extracted_dir}/npm" "$cache_dir/" 2>/dev/null || true
    cp "${extracted_dir}/npx" "$cache_dir/" 2>/dev/null || true
    cp -R "${extracted_dir}/node_modules" "$cache_dir/" 2>/dev/null || true

    # Remove corepack
    rm -f "${cache_dir}/corepack.cmd" "${cache_dir}/corepack"
    rm -rf "${cache_dir}/node_modules/corepack"

    write_metadata "$cache_dir" "win" "$arch"
    check_existing "$cache_dir" "win" "$arch" || { log_error "Downloaded runtime does not match Node $NODE_VERSION / npm $NPM_VERSION"; return 1; }

    if [[ "$should_stage" == "true" ]]; then
        stage_nodejs "$cache_dir" "win" "$arch"
    fi

    log_ok "Windows ${arch}: Node.js v${NODE_VERSION} ready"
}

# ========================================
# Main
# ========================================

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}Node.js v${NODE_VERSION} Download${NC}               ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════╝${NC}"
echo ""

# Handle --clean flag
if [[ "$1" == "--clean" ]]; then
    log_warn "Cleaning staged Node.js resources and architecture caches..."
    rm -rf "$RESOURCES_DIR"
    rm -rf "$CACHE_ROOT"
    mkdir -p "$RESOURCES_DIR"
    touch "$RESOURCES_DIR/.gitkeep"
    shift
fi

if [[ "$1" == "--all" ]]; then
    # Populate architecture-specific caches, then leave staging on host arch.
    log_info "Populating macOS architecture caches..."
    download_macos "arm64" "false"
    download_macos "x64" "false"
    if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
        stage_nodejs "$(cache_dir_for "darwin" "arm64")" "darwin" "arm64"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        stage_nodejs "$(cache_dir_for "darwin" "x64")" "darwin" "x64"
    fi
    # Windows requires a separate build environment
    log_warn "Windows binaries must be downloaded on the Windows build machine"
elif [[ "$1" == "--windows" ]]; then
    download_windows "${2:-x64}"
elif [[ "$1" == "--target" ]]; then
    # Download for a specific macOS architecture (used by build_macos.sh for cross-compilation)
    TARGET_ARCH="${2:-}"
    if [[ "$TARGET_ARCH" == "arm64" || "$TARGET_ARCH" == "aarch64" ]]; then
        download_macos "arm64"
    elif [[ "$TARGET_ARCH" == "x64" || "$TARGET_ARCH" == "x86_64" ]]; then
        download_macos "x64"
    else
        log_error "Invalid target architecture: '${TARGET_ARCH}' (expected: arm64, x64, aarch64, x86_64)"
        exit 1
    fi
else
    # Download for current platform only
    ARCH=$(uname -m)
    PLATFORM=$(uname -s)

    if [[ "$PLATFORM" == "Darwin" ]]; then
        if [[ "$ARCH" == "arm64" ]]; then
            download_macos "arm64"
        else
            download_macos "x64"
        fi
    elif [[ "$PLATFORM" == "Linux" ]]; then
        if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
            download_linux "arm64"
        else
            download_linux "x64"
        fi
    else
        log_error "Unsupported platform: $PLATFORM"
        exit 1
    fi
fi

echo ""
log_ok "Done! Node.js resources at: ${RESOURCES_DIR}"
log_info "Architecture cache root: ${CACHE_ROOT}"
echo ""

# Show contents
if [[ -f "${RESOURCES_DIR}/bin/node" ]]; then
    local_ver=$("${RESOURCES_DIR}/bin/node" --version 2>/dev/null || echo "unknown")
    log_info "Bundled node version: ${local_ver}"
    log_info "Contents:"
    du -sh "${RESOURCES_DIR}" 2>/dev/null | awk '{print "  Total: " $1}'
    du -sh "${RESOURCES_DIR}/bin/node" 2>/dev/null | awk '{print "  node binary: " $1}'
    du -sh "${RESOURCES_DIR}/lib/node_modules/npm" 2>/dev/null | awk '{print "  npm: " $1}'
elif [[ -f "${RESOURCES_DIR}/node.exe" ]]; then
    log_info "Windows Node.js extracted"
fi
