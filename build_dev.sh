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

# 杀死残留进程（避免"旧代码"问题）
echo -e "${BLUE}[准备] 杀死残留进程...${NC}"
pkill -f "bun run.*server" 2>/dev/null || true
pkill -f "MyAgents.app" 2>/dev/null || true
sleep 1  # 等待进程完全退出
echo -e "${GREEN}✓ 进程已清理${NC}"
echo ""

# 清理旧构建（包括 Rust 缓存的 resources）
echo -e "${BLUE}[准备] 清理旧构建...${NC}"
rm -rf "${PROJECT_DIR}/dist"
# 创建占位符资源 (关键: 满足 tauri build 需求，但 sidecar.rs 在 debug 模式下会忽略它们)
mkdir -p "${PROJECT_DIR}/src-tauri/resources/claude-agent-sdk"
echo "// dev placeholder" > "${PROJECT_DIR}/src-tauri/resources/server-dist.js"

# 清理 debug 构建产物（确保 resources 被重新复制）
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/bundle"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/MyAgents.app"
rm -rf "${PROJECT_DIR}/src-tauri/target/debug/resources"
echo -e "${GREEN}✓ 已清理并创建占位符${NC}"
echo ""

# TypeScript 检查
echo -e "${BLUE}[1/3] TypeScript 类型检查...${NC}"
cd "${PROJECT_DIR}"
if ! bun run typecheck; then
    echo -e "${RED}✗ TypeScript 检查失败，请修复后重试${NC}"
    exit 1
fi
echo -e "${GREEN}✓ TypeScript 检查通过${NC}"
echo ""

# 构建前端
echo -e "${BLUE}[2/3] 构建前端...${NC}"
export VITE_DEBUG_MODE=true
echo -e "${YELLOW}  VITE_DEBUG_MODE=${VITE_DEBUG_MODE}${NC}"
bun run build:web
echo -e "${GREEN}✓ 前端构建完成${NC}"
echo ""

# 强制触发 Rust 重新编译 (确保 sidecar.rs 的逻辑修改生效)
touch "${PROJECT_DIR}/src-tauri/src/sidecar.rs"
touch "${PROJECT_DIR}/src-tauri/src/main.rs"

# 构建 Tauri 应用
echo -e "${BLUE}[3/3] 构建 Tauri 应用 (Debug 模式, 仅 App)...${NC}"
# 强制移除旧的可执行文件，防止 cargo 偷懒不重新链接
rm -f "${PROJECT_DIR}/src-tauri/target/debug/app"

# 禁用 Apple 签名和公证 (开发版不需要，且会很慢)
unset APPLE_SIGNING_IDENTITY
unset APPLE_TEAM_ID
unset APPLE_API_ISSUER
unset APPLE_API_KEY
unset APPLE_API_KEY_PATH
unset APPLE_CERTIFICATE
unset APPLE_CERTIFICATE_PASSWORD
echo -e "${YELLOW}⚠ 已禁用 Apple 代码签名 (开发版)${NC}"

echo -e "${YELLOW}这可能需要几分钟...${NC}"
# 如果没有设置 TAURI_SIGNING_PRIVATE_KEY，跳过签名错误
# (App 本身会正常构建，只是 updater 签名会失败)
if [ -z "${TAURI_SIGNING_PRIVATE_KEY}" ]; then
    echo -e "${YELLOW}⚠ 未设置 TAURI_SIGNING_PRIVATE_KEY，更新签名将被跳过${NC}"
    bun run tauri:build -- --debug --bundles app || true
else
    bun run tauri:build -- --debug --bundles app
fi

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
