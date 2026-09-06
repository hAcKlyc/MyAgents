#!/bin/bash
# MyAgents macOS Dev 构建脚本
# 构建带 DevTools 的调试版本，启动时自动打开控制台
# 只构建 .app 不构建 DMG (避免弹窗)

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 加载 .env 文件（如果存在）
if [ -f "${PROJECT_DIR}/.env" ]; then
    set -a  # 自动导出所有变量
    source "${PROJECT_DIR}/.env"
    set +a
fi

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}╔═══════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║${NC}  ${GREEN}🤖 MyAgents macOS Dev 构建${NC}                           ${CYAN}║${NC}"
echo -e "${CYAN}║${NC}  ${YELLOW}⚠ DevTools 启用 + 只构建 App${NC}                        ${CYAN}║${NC}"
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
        echo ""
    fi
fi

# Prepare the pinned Rust identity first, then let the native inference owner
# decide target/cache-aware source-build prerequisites before stopping the app
# or mutating build staging.
echo -e "${BLUE}[准备] 准备 Rust toolchain / components...${NC}"
"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh"
echo -e "${GREEN}✓ Rust toolchain ready${NC}"
echo ""

DEV_NATIVE_TARGET="x86_64-apple-darwin"
if [[ "$(uname -m)" == "arm64" || "$(uname -m)" == "aarch64" ]]; then
    DEV_NATIVE_TARGET="aarch64-apple-darwin"
fi
echo -e "${BLUE}[准备] 检查原生推理构建依赖 (${DEV_NATIVE_TARGET})...${NC}"
node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs" "$DEV_NATIVE_TARGET" --check-prerequisites
echo -e "${GREEN}✓ 原生推理构建依赖检查完成${NC}"
echo ""

# 杀死残留 MyAgents 实例（避免生产版和 debug 版同时运行互相打架）
# 优先使用 PID lock file 精确杀——只杀 MyAgents 主进程，不误杀其他 node 进程。
# SIGKILL(-9) 防止 macOS Automatic Termination 自动重启被杀的 .app。
echo -e "${BLUE}[准备] 杀死残留进程...${NC}"
LOCK_FILE="$HOME/.myagents/app.lock"
if [ -f "$LOCK_FILE" ]; then
    OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    # Validate PID is a positive integer before using it with kill
    if [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo -e "${YELLOW}  杀死运行中的 MyAgents (PID $OLD_PID)...${NC}"
        kill -9 "$OLD_PID" 2>/dev/null || true
    fi
    rm -f "$LOCK_FILE"
fi
# Fallback: 杀死任何漏网的 MyAgents 进程（lock file 可能不存在或 PID 已过期）
pkill -9 -f "MyAgents.app" 2>/dev/null || true
pkill -9 -f "node.*src/server/index.ts" 2>/dev/null || true
pkill -9 -f "node.*server-dist.js" 2>/dev/null || true
sleep 1  # 等待进程完全退出
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 清理旧构建（包括 Rust 缓存的 resources）
echo -e "${BLUE}[准备] 清理旧构建...${NC}"
rm -rf "${PROJECT_DIR}/dist"
# Tauri 会原样递归复制 resources/ 下声明的目录，placeholder 不会覆盖上一次
# release build 留下的 package.json/node_modules。dev build 因此必须先取得这些
# staging 目录的完整 authority，再创建本次构建需要的精确内容。
#
# sharp / tsx 在 debug runtime 会 fallback 到项目根 node_modules，这里只保留
# bundler 要求的空目录标记。Claude native binary 会在下方按 host arch 重新拷贝。
rm -rf "${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk"
mkdir -p "${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk"

rm -rf "${PROJECT_DIR}/src-tauri/resources/sharp-runtime"
mkdir -p "${PROJECT_DIR}/src-tauri/resources/sharp-runtime"
echo "dev mode: sharp loads from top-level node_modules/sharp; this dir is prod-only" \
    > "${PROJECT_DIR}/src-tauri/resources/sharp-runtime/.dev-placeholder"

# 填充 tsx-runtime（dev 模式 bridge.rs::find_tsx_runtime_loader 优先 fallback
# 到项目根 node_modules/tsx，但 Tauri bundler 仍要求资源目录存在；填一个最小
# 占位避免 cargo bundle 警告，prod build 才需要完整安装）。
rm -rf "${PROJECT_DIR}/src-tauri/resources/tsx-runtime"
mkdir -p "${PROJECT_DIR}/src-tauri/resources/tsx-runtime"
echo "dev mode: tsx loads from top-level node_modules/tsx via find_tsx_runtime_loader fallback" \
    > "${PROJECT_DIR}/src-tauri/resources/tsx-runtime/.dev-placeholder"

# 确保 Node.js 运行时已下载且架构匹配当前主机。download_nodejs.sh 使用
# per-arch cache，resources/nodejs 只是当前 build 的 staging 目录。
NODEJS_DIR="${PROJECT_DIR}/src-tauri/resources/nodejs"
echo -e "${BLUE}[准备] 确保 Node.js 运行时匹配当前主机架构...${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh"

# Rebuild native addons against bundled Node ABI (fixes ERR_DLOPEN_FAILED
# when system npm used a different Node.js version for initial install).
NODE_BIN="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
if [ -x "$NODE_BIN" ]; then
    EXPECTED_ABI=$("$NODE_BIN" -p "process.versions.modules" 2>/dev/null)
    NATIVE_NODE="${PROJECT_DIR}/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
    if [ -f "$NATIVE_NODE" ]; then
        # Check actual ABI by test-loading with bundled Node (cheap fail-fast)
        if ! "$NODE_BIN" -e "require('better-sqlite3')" 2>/dev/null; then
            echo -e "${CYAN}[预备] Rebuilding native addons for Node ABI ${EXPECTED_ABI}...${NC}"
            PATH="${PROJECT_DIR}/src-tauri/resources/nodejs/bin:$PATH" npm rebuild better-sqlite3
        fi
    fi
fi

# 清理 debug 构建产物（确保 resources 被重新复制）
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/bundle"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/MyAgents.app"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/resources"
echo -e "${GREEN}✓ 已清理并创建占位符${NC}"
echo ""

echo -e "${BLUE}[准备] 准备离线文档与语音推理资源 (${DEV_NATIVE_TARGET})...${NC}"
node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs" "$DEV_NATIVE_TARGET"
node "${PROJECT_DIR}/scripts/prepare-cuse-bundle.mjs" "$DEV_NATIVE_TARGET"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "${PROJECT_DIR}/bundled-skills/cuse/scripts/cuse"
fi
echo -e "${GREEN}✓ 原生推理资源 ready${NC}"
echo ""

# TypeScript 检查
echo -e "${BLUE}[1/3] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! npm run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# 构建前端
echo -e "${BLUE}[2/3] 构建前端...${NC}"
export VITE_DEBUG_MODE=true
echo -e "${YELLOW}  VITE_DEBUG_MODE=${VITE_DEBUG_MODE}${NC}"
npm run build:web
echo -e "${GREEN}✓ 前端构建完成${NC}"
echo ""

# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)
touch "${PROJECT_DIR}/src-tauri/src/sidecar.rs"
touch "${PROJECT_DIR}/src-tauri/src/main.rs"

# 构建 Tauri 应用
echo -e "${BLUE}[3/3] 构建 Tauri 应用 (Debug 模式, 仅 App)...${NC}"
# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接
rm -f "${PROJECT_DIR}/src-tauri/target/debug/app"

# 保留签名但禁用公证 (签名是必需的，否则 TCC 权限无法持久化)
# 参考: https://developer.apple.com/forums/thread/698337
# Ad hoc signing 会导致 TCC 无法正确追踪权限
unset APPLE_API_ISSUER
unset APPLE_API_KEY
unset APPLE_API_KEY_PATH
echo -e "${YELLOW}⚠ 已禁用 Apple 公证 (开发版，保留签名)${NC}"

# Node.js 已在前置准备阶段完成 staging；这里开始处理 SDK native binary。

# 拷贝 Claude Agent SDK native binary（按本机架构，debug app 运行时需要）
# 0.2.113+ 取代原 cli.js 分发模式
HOST_ARCH=$(uname -m)
if [[ "$HOST_ARCH" == "arm64" ]]; then
    SDK_ARCH="arm64"
    SDK_TRIPLE="darwin-arm64"
else
    SDK_ARCH="x64"
    SDK_TRIPLE="darwin-x64"
fi
"${PROJECT_DIR}/scripts/ensure_claude_sdk_package.sh" "$SDK_ARCH"
CLAUDE_SRC="${PROJECT_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}/claude"
CLAUDE_DEST="${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk/claude"
if [ ! -f "$CLAUDE_SRC" ]; then
    echo -e "${RED}✗ Claude native binary 不存在: $CLAUDE_SRC${NC}"
    echo -e "${YELLOW}  请运行 npm install 安装 @anthropic-ai/claude-agent-sdk-${SDK_TRIPLE}${NC}"
    exit 1
fi
echo -e "  ${CYAN}拷贝 Claude native binary (${SDK_TRIPLE})...${NC}"
rm -f "$CLAUDE_DEST"
cp "$CLAUDE_SRC" "$CLAUDE_DEST"
chmod +x "$CLAUDE_DEST"
xattr -d com.apple.quarantine "$CLAUDE_DEST" 2>/dev/null || true
# Debug 构建不需要发布签名；ensure_claude_sdk_package.sh 已验证 npm 包自带
# 的 Anthropic 签名和 Mach-O 完整性。如设置了签名身份，则为本地 app 资源重签。
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    codesign --force --options runtime --timestamp \
        --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
        --sign "$APPLE_SIGNING_IDENTITY" "$CLAUDE_DEST"
fi
echo -e "  ${GREEN}✓ claude (${SDK_TRIPLE}) 已就绪${NC}"

# myagents CLI 的打包不在这里——`npm run tauri:build` 的 beforeBuildCommand
# (tauri.conf.json) 已包含 `npm run build:cli`。该 target 会清理 CLI staging
# 并只生成 bundle authority `myagents.cjs`；dev 脚本只需保证目录存在，避免
# Tauri bundle 阶段的 resource 校验报错。
mkdir -p "${PROJECT_DIR}/src-tauri/resources/cli"

# Debug 模式签名 (optional — build_macos.sh per-TARGET loop 已处理 Node + Claude)
# build_dev.sh 只构建 host arch 单个，本段处理该情况下的 Node + Claude 签名。
if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
    NODE_BIN_DEV="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
    if [ -f "$NODE_BIN_DEV" ]; then
        xattr -d com.apple.quarantine "$NODE_BIN_DEV" 2>/dev/null || true
        codesign --force --options runtime --timestamp \
            --entitlements "${PROJECT_DIR}/src-tauri/Entitlements.plist" \
            --sign "$APPLE_SIGNING_IDENTITY" "$NODE_BIN_DEV" 2>/dev/null || true
    fi
fi

echo -e "${YELLOW}这可能需要几分钟...${NC}"
# Dev App 不发布 updater artifact，也不应要求把发布私钥放进开发环境。
# 用 Tauri 的 config merge 覆盖 release 默认值，保留普通 macOS App 签名，
# 同时让真正的编译/打包失败保持非零退出，禁止 `|| true` 制造假成功。
DEV_TAURI_CONFIG='{"bundle":{"createUpdaterArtifacts":false}}'
npm run tauri:build -- --debug --bundles app --config "${DEV_TAURI_CONFIG}"

# 查找输出
BUNDLE_DIR="${PROJECT_DIR}/src-tauri/target/debug/bundle"
APP_PATH=$(find "${BUNDLE_DIR}/macos" -name "*.app" 2>/dev/null | head -1)

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  Dev 构建完成!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo ""

if [ -n "$APP_PATH" ]; then
    APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
    echo -e "  ${CYAN}应用路径:${NC}"
    echo -e "    🍎 ${APP_PATH}"
    echo -e "    📏 大小: ${APP_SIZE}"
    echo ""
    echo -e "  ${CYAN}Dev 特性:${NC}"
    echo -e "    ✅ 启动时自动打开 DevTools"
    echo -e "    ✅ 宽松 CSP (允许 IPC)"
    echo -e "    ✅ 包含最新 server 代码"
    echo ""
else
    echo -e "  ${YELLOW}未找到构建产物，请检查上方输出${NC}"
fi

echo -e "  ${CYAN}运行方式:${NC}"
echo -e "    open \"$APP_PATH\""
echo ""
