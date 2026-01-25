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

# Bun 版本配置
BUN_VERSION="1.3.6"

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

# 下载 Bun 二进制到 src-tauri/binaries
download_bun_binaries() {
    local BINARIES_DIR="$PROJECT_DIR/src-tauri/binaries"
    mkdir -p "$BINARIES_DIR"
    
    echo -e "${BLUE}下载 Bun 运行时 (v${BUN_VERSION})...${NC}"
    
    # 检测当前架构
    local ARCH=$(uname -m)
    local PLATFORM=$(uname -s)
    
    if [[ "$PLATFORM" != "Darwin" ]]; then
        echo -e "${YELLOW}警告: 当前仅支持 macOS，跳过 Bun 下载${NC}"
        return 0
    fi
    
    # macOS ARM (M1/M2)
    local ARM_FILE="$BINARIES_DIR/bun-aarch64-apple-darwin"
    if [[ ! -f "$ARM_FILE" ]]; then
        echo -e "  ${CYAN}下载 macOS ARM 版本...${NC}"
        curl -sL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-aarch64.zip" -o /tmp/bun-arm.zip
        unzip -q -o /tmp/bun-arm.zip -d /tmp/bun-arm-extract
        mv /tmp/bun-arm-extract/bun-darwin-aarch64/bun "$ARM_FILE"
        chmod +x "$ARM_FILE"
        rm -rf /tmp/bun-arm.zip /tmp/bun-arm-extract
        echo -e "  ${GREEN}✓ macOS ARM${NC}"
    else
        echo -e "  ${GREEN}✓ macOS ARM (已存在)${NC}"
    fi
    
    # macOS Intel
    local INTEL_FILE="$BINARIES_DIR/bun-x86_64-apple-darwin"
    if [[ ! -f "$INTEL_FILE" ]]; then
        echo -e "  ${CYAN}下载 macOS Intel 版本...${NC}"
        curl -sL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-darwin-x64.zip" -o /tmp/bun-intel.zip
        unzip -q -o /tmp/bun-intel.zip -d /tmp/bun-intel-extract
        mv /tmp/bun-intel-extract/bun-darwin-x64/bun "$INTEL_FILE"
        chmod +x "$INTEL_FILE"
        rm -rf /tmp/bun-intel.zip /tmp/bun-intel-extract
        echo -e "  ${GREEN}✓ macOS Intel${NC}"
    else
        echo -e "  ${GREEN}✓ macOS Intel (已存在)${NC}"
    fi
    
    echo -e "${GREEN}✓ Bun 运行时准备完成${NC}"
}

echo -e "${BLUE}[1/5] 检查依赖${NC}"
MISSING=0

check_install "Node.js" "node --version" "https://nodejs.org" || MISSING=1
check_install "npm" "npm --version" "随 Node.js 安装" || MISSING=1
check_install "Bun" "bun --version" "curl -fsSL https://bun.sh/install | bash (开发必需)" || MISSING=1
check_install "Rust" "rustc --version" "https://rustup.rs" || MISSING=1
check_install "Cargo" "cargo --version" "随 Rust 安装" || MISSING=1

echo ""
if [ $MISSING -eq 1 ]; then
    echo -e "${RED}请先安装上述缺失的依赖，然后重新运行此脚本${NC}"
    echo -e "${YELLOW}注意: Bun 在最终用户运行时无需安装，已打包到应用内${NC}"
    exit 1
fi

# 下载 Bun 二进制
echo ""
echo -e "${BLUE}[2/5] 下载 Bun 运行时${NC}"
download_bun_binaries
echo ""

# 安装前端依赖
echo -e "${BLUE}[3/5] 安装前端依赖${NC}"
bun install
echo -e "${GREEN}✓ 前端依赖安装完成${NC}"
echo ""

# 安装 Rust 依赖
echo -e "${BLUE}[4/5] 检查 Rust 依赖${NC}"
cd src-tauri
cargo check --quiet 2>/dev/null || cargo fetch
cd ..
echo -e "${GREEN}✓ Rust 依赖准备完成${NC}"
echo ""

# 完成
echo -e "${BLUE}[5/5] 初始化完成!${NC}"
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
