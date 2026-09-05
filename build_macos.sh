#!/bin/bash
# MyAgents macOS 正式发布构建脚本
# 构建签名+公证的 DMG 安装包用于分发
# 支持 ARM (M1/M2)、Intel 构建

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_CONF="${PROJECT_DIR}/src-tauri/tauri.conf.json"
ENV_FILE="${PROJECT_DIR}/.env"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 MyAgents macOS 签名发布构建${NC}                      ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${BLUE}Version: ${VERSION}${NC}                                      ${CYAN}║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================
# 版本同步检查
# ========================================
PKG_VERSION=$(grep '"version"' "${PROJECT_DIR}/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
TAURI_VERSION=$(grep '"version"' "${PROJECT_DIR}/src-tauri/tauri.conf.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
CARGO_VERSION=$(grep '^version = ' "${PROJECT_DIR}/src-tauri/Cargo.toml" | head -1 | sed 's/version = "\([^"]*\)".*/\1/')

if [ "$PKG_VERSION" != "$TAURI_VERSION" ] || [ "$PKG_VERSION" != "$CARGO_VERSION" ]; then
    echo -e "${YELLOW}⚠ 版本号不一致:${NC}"
    echo -e "  package.json:      ${CYAN}${PKG_VERSION}${NC}"
    echo -e "  tauri.conf.json:   ${CYAN}${TAURI_VERSION}${NC}"
    echo -e "  Cargo.toml:        ${CYAN}${CARGO_VERSION}${NC}"
    echo ""
    read -p "是否同步版本号到 ${PKG_VERSION}? (y/N) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        node "${PROJECT_DIR}/scripts/sync-version.js"
        VERSION="$PKG_VERSION"  # 更新显示的版本号
        echo ""
    fi
fi

# ========================================
# 加载环境变量 (签名配置)
# ========================================
echo -e "${BLUE}[1/7] 加载签名配置...${NC}"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
    echo -e "${GREEN}✓ 已加载 .env${NC}"
else
    echo -e "${RED}错误: .env 文件不存在!${NC}"
    echo "请创建 .env 文件并配置以下变量:"
    echo "  APPLE_SIGNING_IDENTITY"
    echo "  APPLE_TEAM_ID"
    echo "  APPLE_API_ISSUER"
    echo "  APPLE_API_KEY"
    echo "  APPLE_API_KEY_PATH"
    exit 1
fi

# 验证签名环境变量
if [ -z "$APPLE_SIGNING_IDENTITY" ]; then
    echo -e "${RED}错误: APPLE_SIGNING_IDENTITY 未设置!${NC}"
    exit 1
fi

if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
    echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║ 警告: TAURI_SIGNING_PRIVATE_KEY 未设置                     ║${NC}"
    echo -e "${YELLOW}║ 自动更新功能将不可用!                                      ║${NC}"
    echo -e "${YELLOW}║                                                           ║${NC}"
    echo -e "${YELLOW}║ 如需启用自动更新，请在 .env 中添加:                         ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY=<私钥内容>                     ║${NC}"
    echo -e "${YELLOW}║   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码>                ║${NC}"
    echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
    echo ""
    read -p "是否继续构建? (Y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
        echo -e "${RED}构建已取消${NC}"
        exit 1
    fi
else
    echo -e "  ${GREEN}✓ Tauri 签名私钥已配置${NC}"
fi

echo -e "  签名身份: ${CYAN}${APPLE_SIGNING_IDENTITY}${NC}"
echo ""

# ========================================
# 清理残留进程
# ========================================
echo -e "${BLUE}[准备] 清理残留进程...${NC}"
pkill -f "node.*src/server/index.ts" 2>/dev/null || true
pkill -f "node.*server-dist.js" 2>/dev/null || true
pkill -f "MyAgents.app" 2>/dev/null || true
sleep 1
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 架构选择
echo -e "${YELLOW}请选择目标架构:${NC}"
echo "  1) ARM (Apple Silicon M1/M2) [默认]"
echo "  2) Intel (x86_64)"
echo "  3) Both (同时构建两个版本)"
echo ""
read -p "请输入选项 (1/2/3) [1]: " -r ARCH_CHOICE
ARCH_CHOICE=${ARCH_CHOICE:-1}

case $ARCH_CHOICE in
    1)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本${NC}"
        ;;
    2)
        BUILD_TARGETS=("x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 Intel 版本${NC}"
        ;;
    3)
        BUILD_TARGETS=("aarch64-apple-darwin" "x86_64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 和 Intel 两个版本${NC}"
        ;;
    *)
        BUILD_TARGETS=("aarch64-apple-darwin")
        echo -e "${GREEN}✓ 将构建 ARM 版本 (默认)${NC}"
        ;;
esac
echo ""

# 检查依赖
check_dependency() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${RED}错误: $1 未安装${NC}"
        echo "$2"
        exit 1
    fi
}

echo -e "${BLUE}[2/7] 检查依赖...${NC}"
check_dependency "rustc" "请安装 Rust: https://rustup.rs"
check_dependency "rustup" "请通过 rustup 安装 Rust: https://rustup.rs"
check_dependency "npm" "请安装 Node.js: https://nodejs.org"
check_dependency "codesign" "需要 Xcode Command Line Tools"
check_dependency "lipo" "需要 Xcode Command Line Tools"
check_dependency "otool" "需要 Xcode Command Line Tools"

# 检查仓库内置的 mino 工作区模板
if [ ! -f "${PROJECT_DIR}/bundled-workspaces/mino/CLAUDE.md" ]; then
    echo -e "${RED}错误: bundled-workspaces/mino/ 模板不存在或不完整!${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ mino 内置工作区模板已就绪${NC}"

# Rust toolchain/components/target 必须与 rust-toolchain.toml 和 CI 对齐。
"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh" "${BUILD_TARGETS[@]}"

# Fail before TypeScript/app builds or large source downloads when a selected
# target has a cold document-resource cache but lacks its source-build tools.
# The prepare owner keeps this target/cache-aware; build_macos does not mirror
# CMake/Python/Git version policy or install system packages itself.
for TARGET in "${BUILD_TARGETS[@]}"; do
    node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs" "$TARGET" --check-prerequisites
done

echo -e "${GREEN}✓ 依赖检查通过${NC}"
echo ""

# CSP 验证（tauri.conf.json 中已包含跨平台完整 CSP，无需覆写）
echo -e "${BLUE}[3/7] 验证 CSP 配置...${NC}"
echo -e "${GREEN}✓ 使用 tauri.conf.json 中的跨平台 CSP（含 Windows 兼容指令）${NC}"
echo ""

# 清理旧构建
echo -e "${BLUE}[准备] 清理旧构建...${NC}"
rm -rf "${PROJECT_DIR}/dist"

for TARGET in "${BUILD_TARGETS[@]}"; do
    rm -rf "${PROJECT_DIR}/src-tauri/target/${TARGET}/release/bundle"
done

echo -e "${GREEN}✓ 清理完成${NC}"
echo ""

# TypeScript 类型检查
echo -e "${BLUE}[4/7] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# npm optionalDependencies are platform-filtered. A previous cross-arch repair
# (for example installing the x64 Claude SDK on an arm64 host) can leave the
# root node_modules with @esbuild/darwin-x64 while the current Node process is
# arm64. esbuild then fails before Tauri build starts. Repair the host-Node
# esbuild binary up front; later cross-arch SDK installs are done in temp dirs
# and copied into place, so they no longer mutate the root dependency tree.
ensure_host_esbuild() {
    if node -e "require('esbuild').transformSync('let x = 1', { loader: 'js' })" >/dev/null 2>&1; then
        return
    fi

    local NODE_ARCH ESBUILD_VERSION ESBUILD_PKG
    NODE_ARCH=$(node -p "process.arch")
    case "$NODE_ARCH" in
        arm64|x64) ;;
        *)
            echo -e "${RED}✗ 不支持的 Node 架构: ${NODE_ARCH}${NC}"
            exit 1
            ;;
    esac

    ESBUILD_VERSION=$(node -p "require('./node_modules/esbuild/package.json').version" 2>/dev/null || true)
    if [ -z "$ESBUILD_VERSION" ]; then
        echo -e "${RED}✗ 无法读取 node_modules/esbuild/package.json，请先运行 npm install${NC}"
        exit 1
    fi

    ESBUILD_PKG="@esbuild/darwin-${NODE_ARCH}@${ESBUILD_VERSION}"
    echo -e "  ${YELLOW}⚠ esbuild native binary 与当前 Node(${NODE_ARCH}) 不匹配，正在修复 ${ESBUILD_PKG}...${NC}"
    npm install --no-save --no-audit --no-fund --ignore-scripts \
        --os=darwin --cpu="$NODE_ARCH" \
        "$ESBUILD_PKG"

    if ! node -e "require('esbuild').transformSync('let x = 1', { loader: 'js' })" >/dev/null 2>&1; then
        echo -e "${RED}✗ esbuild native binary 修复后仍不可用${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}✓ esbuild native binary 已匹配当前 Node(${NODE_ARCH})${NC}"
}

# 构建前端和服务端
echo -e "${BLUE}[5/7] 构建前端和服务端...${NC}"
ensure_host_esbuild

# Sidecar / Bridge / CLI 三件套都走 `npm run build:*` —— 后台是
# `node scripts/esbuild-bundle.mjs <target>`。单一配置入口（entry /
# banner / format / external / target），不再让 shell 引号介入。
# Driver 内部完整接管 target 生命周期：cli 构建前清理 staging inventory、只产出
# bundle authority myagents.cjs；server 构建后校验无硬编码 __dirname 路径。
echo -e "  ${CYAN}打包服务端代码...${NC}"
npm run build:server
echo -e "  ${CYAN}打包 Plugin Bridge...${NC}"
npm run build:bridge
echo -e "  ${CYAN}打包 myagents CLI...${NC}"
npm run build:cli

# SDK native binary 按架构在 per-target loop 里拷贝（见下方 Tauri 构建循环）。
# SDK 0.2.113+ 不再 ship cli.js/sdk.mjs/vendor，改为 per-platform native binary。
# 目录保留清理，具体 claude[.exe] 文件在 loop 内按 $TARGET 对应架构拷贝 + codesign。
SDK_DEST="src-tauri/resources/claude-agent-sdk"
rm -rf "${SDK_DEST}"
mkdir -p "${SDK_DEST}"

# 构建前端
echo -e "  ${CYAN}构建前端...${NC}"
npm run build:web
echo -e "${GREEN}✓ 前端和服务端构建完成${NC}"
echo ""

# Node.js staging 目录（每个构建目标在循环中按架构从 cache 同步）
NODEJS_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"

# ========================================
# 签名 Vendor 二进制文件 (ripgrep)
# ========================================
echo -e "${BLUE}[6/7] 签名 Vendor 二进制文件 (ripgrep, .node)...${NC}"

# 签名所有 macOS 二进制文件
VENDOR_DIR="${SDK_DEST}/vendor"
SIGNED_COUNT=0
FAILED_COUNT=0

# 使用 process substitution 避免子 shell 问题
while IFS= read -r binary; do
    echo -e "    ${CYAN}签名: $(basename "$binary")${NC}"
    if codesign --force --options runtime --timestamp \
        --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
        ((SIGNED_COUNT++))
    else
        echo -e "    ${YELLOW}警告: 签名失败 - $binary${NC}"
        ((FAILED_COUNT++))
    fi
done < <(find "$VENDOR_DIR" -type f \( -name "*.node" -o -name "rg" \) -path "*darwin*")

echo -e "${GREEN}✓ Vendor 签名完成 (成功: ${SIGNED_COUNT}, 失败: ${FAILED_COUNT})${NC}"
echo ""

# 构建 Tauri 应用
echo -e "${BLUE}[7/7] 构建 Tauri 应用 (Release + 签名 + 公证)...${NC}"
echo -e "${YELLOW}这可能需要 5-10 分钟 (包含公证等待时间)...${NC}"

# ---- 补齐 Claude Agent SDK 的跨架构 native 包 ----
# `@anthropic-ai/claude-agent-sdk-darwin-{arm64,x64}` 在 package.json 里
# 是 optionalDependencies；npm 默认只装匹配 host 架构的那一份，所以
# arm64 Mac 上 `npm install` 后通常只有 darwin-arm64。这里只补齐本次
# 选择的 target 需要的 arch；build "Both" 模式会校验 arm64 + x64。
#
# 强制安装非 host 架构 platform package 必须带 `--force`。npm 10+ 对
# direct install 仍会按 host CPU 做 EBADPLATFORM 校验；`--os` / `--cpu`
# 只作为 optional dep 过滤输入保留，真正允许 darwin-x64 在 arm64 host
# 上落盘的是 `--force`。每个 arch 必须用各自的 flag 单独装一次。
#
# `--no-save` 不写回 package.json（仓库 optionalDeps 形态保持不变）；
# `--ignore-scripts` 同 setup-tsx-runtime 的逻辑（避免跨平台 postinstall
# 触发自检失败）。
SDK_VERSION=$(grep '"@anthropic-ai/claude-agent-sdk-darwin-arm64"' "${PROJECT_DIR}/package.json" | sed 's/.*: "\([0-9][0-9.]*\)".*/\1/')
if [ -z "$SDK_VERSION" ]; then
    echo -e "${RED}✗ 无法从 package.json 解析 Claude SDK 版本号${NC}"
    exit 1
fi

SHARP_VERSION=$(node -p "require('./package.json').dependencies.sharp" 2>/dev/null || true)
if [[ ! "$SHARP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo -e "${RED}✗ package.json 中的 sharp 必须使用精确版本，当前值: ${SHARP_VERSION:-missing}${NC}"
    exit 1
fi

expected_macho_arch() {
    case "$1" in
        arm64) echo "arm64" ;;
        x64) echo "x86_64" ;;
        *) return 1 ;;
    esac
}

validate_macho_binary() {
    local BINARY="$1"
    local EXPECTED_ARCH="$2"
    local LABEL="$3"
    local ARCHES=""
    local OTOOL_OUTPUT=""

    if [ ! -f "$BINARY" ]; then
        echo -e "    ${YELLOW}⚠ ${LABEL} 缺失: $BINARY${NC}"
        return 1
    fi

    ARCHES=$(lipo -archs "$BINARY" 2>/dev/null || true)
    if [ "$ARCHES" != "$EXPECTED_ARCH" ]; then
        echo -e "    ${YELLOW}⚠ ${LABEL} 架构不匹配: expected=${EXPECTED_ARCH}, actual=${ARCHES:-unknown}${NC}"
        return 1
    fi

    # Truncated Mach-O files can still pass `file`/`lipo`, then fail later at
    # codesign with the opaque "main executable failed strict validation".
    # `otool -l` prints "(past end of file)" for those broken load commands.
    if ! OTOOL_OUTPUT=$(otool -l "$BINARY" 2>&1); then
        echo -e "    ${YELLOW}⚠ ${LABEL} Mach-O load commands 不可读${NC}"
        echo "$OTOOL_OUTPUT" | sed 's/^/      /'
        return 1
    fi
    if grep -q "past end of file" <<<"$OTOOL_OUTPUT"; then
        echo -e "    ${YELLOW}⚠ ${LABEL} 已损坏: Mach-O load commands 指向文件末尾之后${NC}"
        return 1
    fi

    return 0
}

prepare_sharp_runtime() {
    local ARCH="$1"
    local EXPECTED_ARCH
    local SHARP_DIR="${PROJECT_DIR}/src-tauri/resources/sharp-runtime"
    local SHARP_NODE="${SHARP_DIR}/node_modules/@img/sharp-darwin-${ARCH}/lib/sharp-darwin-${ARCH}.node"
    local SHARP_DYLIB_DIR="${SHARP_DIR}/node_modules/@img/sharp-libvips-darwin-${ARCH}/lib"
    local SHARP_NATIVE_COUNT=0
    local SHARP_SIGNED_COUNT=0

    if ! EXPECTED_ARCH=$(expected_macho_arch "$ARCH"); then
        echo -e "${RED}✗ 不支持的 sharp macOS 架构: $ARCH${NC}"
        exit 1
    fi

    echo -e "  ${CYAN}填充 sharp-runtime (darwin-${ARCH})...${NC}"
    rm -rf "$SHARP_DIR"
    mkdir -p "$SHARP_DIR"
    cat > "${SHARP_DIR}/package.json" <<SHARP_PKG
{
  "name": "sharp-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": { "sharp": "${SHARP_VERSION}" }
}
SHARP_PKG

    # staging 每个 target 都从空目录开始。sharp 自己的 optionalDependencies
    # 是平台包版本的唯一 authority；--os/--cpu 只选择当前 target，避免在两个
    # thin app 中各塞一份用不到的另一架构 libvips。
    if ! (cd "$SHARP_DIR" && npm install --no-save --package-lock=false --force \
        --no-audit --no-fund --ignore-scripts --os=darwin --cpu="$ARCH"); then
        echo -e "${RED}✗ sharp darwin-${ARCH} 预装失败${NC}"
        exit 1
    fi

    if [ ! -f "$SHARP_NODE" ]; then
        echo -e "${RED}✗ sharp-darwin-${ARCH}.node 缺失${NC}"
        exit 1
    fi
    if [ ! -d "$SHARP_DYLIB_DIR" ] || [ -z "$(find "$SHARP_DYLIB_DIR" -maxdepth 1 -type f -name '*.dylib' -print -quit)" ]; then
        echo -e "${RED}✗ sharp-libvips-darwin-${ARCH} dylib 缺失${NC}"
        exit 1
    fi

    # Tauri 会复制整个目录，所以验证并签名目录里的每一个原生文件，而不是只
    # 信任 npm package 名。exact-arch 校验同时阻止另一架构或 universal 文件
    # 偷渡进当前 thin app。
    while IFS= read -r binary; do
        SHARP_NATIVE_COUNT=$((SHARP_NATIVE_COUNT + 1))
        if ! validate_macho_binary "$binary" "$EXPECTED_ARCH" "sharp darwin-${ARCH}: ${binary#${SHARP_DIR}/}"; then
            echo -e "${RED}✗ sharp-runtime 含非目标架构或损坏的原生文件${NC}"
            exit 1
        fi
    done < <(find "${SHARP_DIR}/node_modules/@img" -type f \( -name "*.node" -o -name "*.dylib" \) 2>/dev/null)

    if [ "$SHARP_NATIVE_COUNT" -eq 0 ]; then
        echo -e "${RED}✗ sharp-runtime 未包含任何原生文件${NC}"
        exit 1
    fi

    while IFS= read -r binary; do
        echo -e "    ${CYAN}签名: ${binary#${SHARP_DIR}/node_modules/}${NC}"
        xattr -d com.apple.quarantine "$binary" 2>/dev/null || true
        if ! codesign --force --options runtime --timestamp \
            --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
            echo -e "${RED}✗ sharp 原生二进制签名失败: $binary${NC}"
            exit 1
        fi
        SHARP_SIGNED_COUNT=$((SHARP_SIGNED_COUNT + 1))
    done < <(find "${SHARP_DIR}/node_modules/@img" -type f \( -name "*.node" -o -name "*.dylib" \) 2>/dev/null)

    echo -e "  ${GREEN}✓ sharp-runtime 就绪 (darwin-${ARCH}, ${SHARP_SIGNED_COUNT} 个原生文件)${NC}"
}

validate_claude_sdk_package() {
    local ARCH="$1"
    local EXPECTED_ARCH
    EXPECTED_ARCH=$(expected_macho_arch "$ARCH")
    local PKG_NAME="@anthropic-ai/claude-agent-sdk-darwin-${ARCH}"
    local PKG_DIR="${PROJECT_DIR}/node_modules/${PKG_NAME}"
    local PKG_JSON="${PKG_DIR}/package.json"
    local SDK_PKG_BIN="${PKG_DIR}/claude"

    if [ ! -f "$PKG_JSON" ]; then
        echo -e "    ${YELLOW}⚠ ${PKG_NAME} package.json 缺失${NC}"
        return 1
    fi
    if ! node -e '
const fs = require("fs");
const [pkgPath, expectedName, expectedVersion] = process.argv.slice(1);
try {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  process.exit(pkg.name === expectedName && pkg.version === expectedVersion ? 0 : 1);
} catch {
  process.exit(1);
}
' "$PKG_JSON" "$PKG_NAME" "$SDK_VERSION"; then
        echo -e "    ${YELLOW}⚠ ${PKG_NAME} package.json 与期望版本不匹配${NC}"
        return 1
    fi

    validate_macho_binary "$SDK_PKG_BIN" "$EXPECTED_ARCH" "${PKG_NAME}/claude"
}

ensure_claude_sdk_package() {
    local ARCH="$1"
    local PKG_NAME="@anthropic-ai/claude-agent-sdk-darwin-${ARCH}"
    local PKG_DIR="${PROJECT_DIR}/node_modules/${PKG_NAME}"

    if validate_claude_sdk_package "$ARCH"; then
        echo -e "${GREEN}  ✓ darwin-${ARCH} 已验证${NC}"
        return
    fi

    echo -e "${BLUE}[7.0/7] 修复 Claude SDK darwin-${ARCH}@${SDK_VERSION}...${NC}"
    local TMP_DIR="${PROJECT_DIR}/.tmp-claude-sdk-${ARCH}-$$"
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    if ! npm install --prefix "$TMP_DIR" --force --no-save --package-lock=false --no-audit --no-fund --ignore-scripts \
        --os=darwin --cpu="$ARCH" \
        "${PKG_NAME}@${SDK_VERSION}"; then
        rm -rf "$TMP_DIR"
        echo -e "${RED}✗ darwin-${ARCH} 临时安装失败${NC}"
        exit 1
    fi

    if [ ! -d "${TMP_DIR}/node_modules/${PKG_NAME}" ]; then
        rm -rf "$TMP_DIR"
        echo -e "${RED}✗ darwin-${ARCH} 临时安装未产出 ${PKG_NAME}${NC}"
        exit 1
    fi

    rm -rf "$PKG_DIR"
    mkdir -p "$(dirname "$PKG_DIR")"
    cp -R "${TMP_DIR}/node_modules/${PKG_NAME}" "$PKG_DIR"
    rm -rf "$TMP_DIR"
    if ! validate_claude_sdk_package "$ARCH"; then
        echo -e "${RED}✗ darwin-${ARCH} 安装后仍未通过完整性校验: ${PKG_DIR}/claude${NC}"
        exit 1
    fi
    echo -e "${GREEN}  ✓ darwin-${ARCH} 就绪${NC}"
}

REQUIRED_SDK_ARCHES=()
for TARGET in "${BUILD_TARGETS[@]}"; do
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        REQUIRED_SDK_ARCHES+=("arm64")
    else
        REQUIRED_SDK_ARCHES+=("x64")
    fi
done

for ARCH in "${REQUIRED_SDK_ARCHES[@]}"; do
    ensure_claude_sdk_package "$ARCH"
done

for TARGET in "${BUILD_TARGETS[@]}"; do
    echo ""
    echo -e "${YELLOW}━━━ 构建目标: $TARGET ━━━${NC}"

    # ---- 确保 Node.js 匹配目标架构 ----
    # 将 Tauri target triple 映射为 Node.js 架构名
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        NODE_TARGET_ARCH="arm64"
    else
        NODE_TARGET_ARCH="x64"
    fi

    echo -e "  ${CYAN}确保 Node.js 匹配目标架构 (${NODE_TARGET_ARCH})...${NC}"
    "${PROJECT_DIR}/scripts/download_nodejs.sh" --target "$NODE_TARGET_ARCH"

    # ---- 重新填充 sharp-runtime 资源以匹配目标架构 ----
    prepare_sharp_runtime "$NODE_TARGET_ARCH"

    # ---- 重新填充 tsx-runtime 资源以匹配目标架构 ----
    # `setup-tsx-runtime.mjs` 用 npm 的 --os/--cpu 选择对应平台的
    # `@esbuild/<triple>` 二进制；跨架构 Mac DMG 必须按 TARGET 重灌。
    echo -e "  ${CYAN}填充 tsx-runtime (darwin-${NODE_TARGET_ARCH})...${NC}"
    npm run build:tsx-runtime -- darwin "$NODE_TARGET_ARCH"

    # ---- 签名 tsx-runtime 内的 esbuild 原生二进制 ----
    # esbuild 是 Go 静态编译，没有 JIT 需求；跟 ripgrep / sharp 一样只要
    # `--options runtime --timestamp`，不需要 entitlements。
    # npm 安装后两处 path 都有 binary：
    #   - node_modules/esbuild/bin/esbuild              (npm postinstall 拷贝/硬链接)
    #   - node_modules/@esbuild/<triple>/bin/esbuild    (per-platform optional dep)
    # 两者通常共享同一个 inode（hardlink），但 codesign 路径独立，必须各签一次；
    # node_modules/.bin/esbuild 是 symlink，notarizer 跟随符号链接验证，所以签源
    # 文件就够了，不必单独处理。
    TSX_RUNTIME_DIR="${PROJECT_DIR}/src-tauri/resources/tsx-runtime"
    TSX_SIGNED_COUNT=0
    TSX_FAILED_COUNT=0
    while IFS= read -r binary; do
        echo -e "    ${CYAN}签名: $(echo "$binary" | sed "s|.*/tsx-runtime/||")${NC}"
        xattr -d com.apple.quarantine "$binary" 2>/dev/null || true
        if codesign --force --options runtime --timestamp \
            --sign "$APPLE_SIGNING_IDENTITY" "$binary" 2>/dev/null; then
            ((TSX_SIGNED_COUNT++))
        else
            echo -e "    ${RED}✗ 签名失败 - $binary${NC}"
            ((TSX_FAILED_COUNT++))
        fi
    done < <(find "${TSX_RUNTIME_DIR}/node_modules" -type f -path "*/bin/esbuild" 2>/dev/null)
    if [ $TSX_FAILED_COUNT -gt 0 ]; then
        echo -e "${RED}✗ tsx-runtime esbuild 签名失败 (${TSX_FAILED_COUNT} 个)，公证必定失败${NC}"
        exit 1
    fi
    if [ $TSX_SIGNED_COUNT -eq 0 ]; then
        echo -e "${RED}✗ 未签名任何 esbuild 二进制，setup-tsx-runtime 可能没装上 native dep${NC}"
        exit 1
    fi
    echo -e "    ${GREEN}✓ tsx-runtime esbuild 签名完成 (${TSX_SIGNED_COUNT} 个)${NC}"

    # 签名 Node.js 二进制 (TCC / notarization 需要统一签名)
    NODE_BINARY="${NODEJS_DIR}/bin/node"
    if [ -f "$NODE_BINARY" ]; then
        xattr -d com.apple.quarantine "$NODE_BINARY" 2>/dev/null || true
        if codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$NODE_BINARY"; then
            echo -e "    ${GREEN}✓ node (${NODE_TARGET_ARCH}) 签名成功${NC}"
        else
            echo -e "    ${RED}✗ node 签名失败${NC}"
            exit 1
        fi
    fi

    # ---- 拷贝并签名 Claude Agent SDK native binary ----
    # SDK 0.2.113+ 通过 per-platform optional deps 分发 `bun build --compile` 产物。
    # 每个 target 架构拷对应的 binary；binary 内嵌 Bun runtime，需 allow-jit entitlements
    # （与 Node 一致，已在 Entitlements.plist 声明）。
    if [[ "$NODE_TARGET_ARCH" == "arm64" ]]; then
        SDK_ARCH="arm64"
        SDK_TRIPLE="darwin-arm64"
    else
        SDK_ARCH="x64"
        SDK_TRIPLE="darwin-x64"
    fi
    CLAUDE_SRC="${PROJECT_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}/claude"
    CLAUDE_DEST="${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk/claude"
    CLAUDE_EXPECTED_ARCH=$(expected_macho_arch "$SDK_ARCH")
    echo -e "  ${CYAN}拷贝 Claude native binary (${SDK_TRIPLE})...${NC}"
    if ! validate_claude_sdk_package "$SDK_ARCH"; then
        echo -e "    ${RED}✗ Claude native binary 未通过完整性校验: $CLAUDE_SRC${NC}"
        exit 1
    fi
    rm -f "$CLAUDE_DEST"
    cp "$CLAUDE_SRC" "$CLAUDE_DEST"
    chmod +x "$CLAUDE_DEST"
    xattr -d com.apple.quarantine "$CLAUDE_DEST" 2>/dev/null || true
    if ! validate_macho_binary "$CLAUDE_DEST" "$CLAUDE_EXPECTED_ARCH" "staged claude (${SDK_TRIPLE})"; then
        echo -e "    ${RED}✗ staged claude 已损坏: $CLAUDE_DEST${NC}"
        exit 1
    fi
    if codesign --force --options runtime --timestamp \
        --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
        --sign "$APPLE_SIGNING_IDENTITY" "$CLAUDE_DEST"; then
        echo -e "    ${GREEN}✓ claude (${SDK_TRIPLE}) 签名成功${NC}"
    else
        echo -e "    ${RED}✗ claude 签名失败${NC}"
        exit 1
    fi

    echo -e "  ${CYAN}准备离线文档与语音推理资源 (${TARGET})...${NC}"
    node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs" "$TARGET"

    npm run tauri:build -- --target "$TARGET"

    echo -e "${GREEN}✓ $TARGET 构建完成${NC}"
done

# 双架构发布构建会按 target 重写 resources/nodejs。产物已经在各自
# target 构建时复制完毕，收尾时把本地 staging 恢复成当前主机架构，
# 避免后续 build_dev.sh / npm rebuild 先碰到另一种架构的 Node。
if [[ "$(uname -m)" == "arm64" ]]; then
    HOST_NODE_TARGET_ARCH="arm64"
else
    HOST_NODE_TARGET_ARCH="x64"
fi
echo ""
echo -e "${CYAN}恢复 Node.js staging 到当前主机架构 (${HOST_NODE_TARGET_ARCH})...${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh" --target "$HOST_NODE_TARGET_ARCH"

echo ""

# 检查输出
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target"

echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  🎉 签名版构建成功!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

# 显示构建产物
UPDATER_READY=true
for TARGET in "${BUILD_TARGETS[@]}"; do
    TARGET_BUNDLE_DIR="${BUNDLE_DIR}/${TARGET}/release/bundle"
    DMG_PATH=$(find "${TARGET_BUNDLE_DIR}/dmg" -name "*.dmg" 2>/dev/null | head -1)
    APP_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app" 2>/dev/null | head -1)
    TAR_GZ_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz" ! -name "*.sig" 2>/dev/null | head -1)
    SIG_PATH=$(find "${TARGET_BUNDLE_DIR}/macos" -name "*.app.tar.gz.sig" 2>/dev/null | head -1)

    # 架构友好名称
    if [[ "$TARGET" == "aarch64-apple-darwin" ]]; then
        ARCH_NAME="ARM (Apple Silicon)"
    else
        ARCH_NAME="Intel (x86_64)"
    fi

    echo -e "  ${CYAN}【$ARCH_NAME】${NC}"

    # DMG (官网下载用)
    if [ -n "$DMG_PATH" ]; then
        DMG_SIZE=$(du -h "$DMG_PATH" | cut -f1)
        echo -e "    📦 DMG: $(basename "$DMG_PATH") (${DMG_SIZE})"
    else
        echo -e "    ${RED}✗${NC} DMG: 未找到"
    fi

    # tar.gz (自动更新用)
    if [ -n "$TAR_GZ_PATH" ]; then
        TAR_SIZE=$(du -h "$TAR_GZ_PATH" | cut -f1)
        echo -e "    📄 tar.gz: $(basename "$TAR_GZ_PATH") (${TAR_SIZE})"
    else
        echo -e "    ${YELLOW}⚠️${NC} tar.gz: 未找到"
        UPDATER_READY=false
    fi

    # 签名文件 (自动更新验证用)
    if [ -n "$SIG_PATH" ]; then
        echo -e "    🔐 签名: $(basename "$SIG_PATH")"
    else
        echo -e "    ${YELLOW}⚠️${NC} 签名: 未找到 (自动更新将不可用)"
        UPDATER_READY=false
    fi

    if [ -n "$APP_PATH" ]; then
        # 验证 Apple 签名
        if codesign --verify --deep --strict "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ Apple 签名: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ Apple 签名: ${YELLOW}失败${NC}"
        fi

        # 验证公证
        if spctl --assess --type exec "$APP_PATH" 2>/dev/null; then
            echo -e "    ✅ 公证验证: ${GREEN}通过${NC}"
        else
            echo -e "    ⚠️ 公证验证: ${YELLOW}未完成或失败${NC}"
        fi
    fi
    echo ""
done

# 自动更新状态总结
if [ "$UPDATER_READY" = true ]; then
    echo -e "  ${GREEN}✅ 自动更新: 所有文件就绪${NC}"
else
    echo -e "  ${YELLOW}⚠️  自动更新: 缺少必要文件 (tar.gz 或 .sig)${NC}"
    echo -e "  ${YELLOW}   请确保 .env 中配置了 TAURI_SIGNING_PRIVATE_KEY${NC}"
fi
echo ""

echo -e "  ${CYAN}正式版特性:${NC}"
echo -e "    ✅ Developer ID 签名"
echo -e "    ✅ Apple 公证 (Notarized)"
echo -e "    ✅ Hardened Runtime"
echo -e "    ✅ CSP 安全策略"
echo -e "    ✅ Release 优化"
echo ""

read -p "是否打开输出目录? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    FIRST_TARGET="${BUILD_TARGETS[0]}"
    open "${BUNDLE_DIR}/${FIRST_TARGET}/release/bundle"
fi

echo ""
read -p "是否发布到 Cloudflare R2? (y/N) " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]]; then
    "${PROJECT_DIR}/publish_release.sh"
fi
