#!/bin/bash
# MyAgents 开发环境初始化脚本
# 首次 clone 仓库后运行此脚本

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}  ${GREEN}🤖 MyAgents 开发环境初始化${NC}              ${BLUE}║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════╝${NC}"
echo ""

# 检查依赖
check_install() {
    local name=$1
    local check_cmd=$2
    local install_hint=$3
    
    echo -n "  检查 $name... "
    if eval "$check_cmd" &> /dev/null; then
        echo -e "${GREEN}✓${NC}"
        return 0
    else
        echo -e "${RED}✗${NC}"
        echo -e "    ${YELLOW}请安装: $install_hint${NC}"
        return 1
    fi
}

echo -e "${BLUE}[1/6] 检查依赖${NC}"
MISSING=0

check_install "Node.js" "node --version" "https://nodejs.org (≥ v20)" || MISSING=1
check_install "npm" "npm --version" "随 Node.js 安装" || MISSING=1
check_install "Rust" "rustc --version" "https://rustup.rs" || MISSING=1
check_install "Cargo" "cargo --version" "随 Rust 安装" || MISSING=1
check_install "rustup" "rustup --version" "https://rustup.rs" || MISSING=1

echo ""
if [ $MISSING -eq 1 ]; then
    echo -e "${RED}请先安装上述缺失的依赖，然后重新运行此脚本${NC}"
    exit 1
fi

# 固定 Rust toolchain/components，避免 rustfmt/clippy 或 IDE 使用系统 Rust 漂移。
echo -e "${BLUE}[2/6] 准备 Rust toolchain / components${NC}"
"${PROJECT_DIR}/scripts/ensure_rust_toolchain.sh"
echo ""

# 原生推理 owner 按 host target 和 exact prepared cache 判断是否真的需要
# CMake/Python/compiler；在任何大下载或依赖安装前给出权威恢复提示。
echo -e "${BLUE}[2.5/6] 检查原生推理构建依赖${NC}"
node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs" --check-prerequisites
echo -e "${GREEN}✓ 原生推理构建依赖检查完成${NC}"
echo ""

# 下载 Node.js 二进制（Sidecar + MCP Server + 社区工具 统一 runtime）
echo ""
echo -e "${BLUE}[3/6] 下载 Node.js 运行时${NC}"
"${PROJECT_DIR}/scripts/download_nodejs.sh"
echo ""

# 安装依赖（使用 npm — v0.2.0 起不再依赖 Bun）
echo -e "${BLUE}[4/6] 安装依赖${NC}"
npm install
if [[ "$(uname -s)" == "Darwin" ]]; then
    echo -e "  ${CYAN}Validating Claude Agent SDK native package...${NC}"
    "${PROJECT_DIR}/scripts/ensure_claude_sdk_package.sh"
fi
# Rebuild native addons (e.g. better-sqlite3) against bundled Node.js ABI —
# system `node` may differ in NODE_MODULE_VERSION and produce binaries that
# crash in our runtime with ERR_DLOPEN_FAILED.
NODE_BIN="${PROJECT_DIR}/src-tauri/resources/nodejs/bin/node"
if [ -x "$NODE_BIN" ]; then
    echo -e "  ${CYAN}Rebuilding native addons against bundled Node...${NC}"
    PATH="${PROJECT_DIR}/src-tauri/resources/nodejs/bin:$PATH" npm rebuild
fi
echo -e "${GREEN}✓ 依赖安装完成${NC}"
echo ""

# 安装 Rust 依赖
echo -e "${BLUE}[5/6] 检查 Rust 依赖${NC}"
cd src-tauri
cargo check --quiet 2>/dev/null || cargo fetch
cd ..
echo -e "${GREEN}✓ Rust 依赖准备完成${NC}"
echo ""

# 准备 host target 的离线文档与语音推理资源。setup 完成后用户可直接运行
# `npm run tauri:dev`；prepare owner 自带 fingerprint，重复 setup 为 no-op。
echo -e "${BLUE}[6/6] 准备离线文档与语音推理资源${NC}"
node "${PROJECT_DIR}/scripts/prepare-native-inference.mjs"
echo -e "${GREEN}✓ 原生推理资源 ready${NC}"
echo ""

# 完成
echo -e "${BLUE}✓ 初始化完成!${NC}"
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  开发环境准备就绪!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "  后续步骤:"
echo ""
echo "  ${BLUE}开发模式:${NC}"
echo "    ./start_dev.sh"
echo ""
echo "  ${BLUE}运行 Tauri 应用:${NC}"
echo "    npm run tauri:dev"
echo ""
echo "  ${BLUE}构建 macOS 安装包:${NC}"
echo "    ./build_macos.sh"
echo ""
