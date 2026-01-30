#!/bin/bash
# upload_qr_code.sh - Upload user community QR code to R2 storage
# Usage: ./upload_qr_code.sh
#
# This script uploads a QR code image to R2 storage for the user community section
# in Settings > About page. The image is loaded dynamically from R2.
#
# Prerequisites:
# 1. .env 中配置了 R2 凭证（与 publish_release.sh 共用）：
#    - R2_ACCESS_KEY_ID
#    - R2_SECRET_ACCESS_KEY
#    - R2_ACCOUNT_ID
# 2. 安装 rclone: brew install rclone

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration - uses download-myagents bucket (public assets bucket)
R2_BUCKET="download-myagents"
TARGET_PATH="assets/feedback_qr_code.png"
PUBLIC_URL="https://download.myagents.io/${TARGET_PATH}"

echo -e "${CYAN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     MyAgents QR Code Upload Tool               ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# ========================================
# Load environment variables (same as publish_release.sh)
# ========================================
echo -e "${BLUE}[1/4] 加载配置...${NC}"
if [ -f "$ENV_FILE" ]; then
    set -a
    source "$ENV_FILE"
    set +a
    echo -e "${GREEN}✓ 已加载 .env${NC}"
else
    echo -e "${RED}错误: .env 文件不存在!${NC}"
    echo "请确保项目根目录存在 .env 文件，包含 R2 凭证配置。"
    exit 1
fi

# Verify R2 credentials
if [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ] || [ -z "$R2_ACCOUNT_ID" ]; then
    echo -e "${RED}错误: R2 配置不完整!${NC}"
    echo "请在 .env 中配置:"
    echo "  R2_ACCESS_KEY_ID=xxx"
    echo "  R2_SECRET_ACCESS_KEY=xxx"
    echo "  R2_ACCOUNT_ID=xxx"
    exit 1
fi
echo -e "${GREEN}✓ R2 配置已验证${NC}"
echo ""

# ========================================
# Check rclone
# ========================================
echo -e "${BLUE}[2/4] 检查 rclone...${NC}"
if ! command -v rclone &> /dev/null; then
    echo -e "${YELLOW}rclone 未安装，正在安装...${NC}"
    brew install rclone
fi
echo -e "${GREEN}✓ rclone 已就绪${NC}"

# Configure rclone (same pattern as publish_release.sh)
RCLONE_CONFIG=$(mktemp)
chmod 600 "$RCLONE_CONFIG"
cat > "$RCLONE_CONFIG" << EOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_ACCESS_KEY_ID}
secret_access_key = ${R2_SECRET_ACCESS_KEY}
endpoint = https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
EOF

# Cleanup function
cleanup() {
    rm -f "$RCLONE_CONFIG" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo ""

# ========================================
# Get image path from user
# ========================================
echo -e "${BLUE}[3/4] 选择图片...${NC}"
echo -e "${YELLOW}Enter the local path to the QR code image:${NC}"
read -r IMAGE_PATH

# Expand ~ to home directory if present
IMAGE_PATH="${IMAGE_PATH/#\~/$HOME}"

# Check if file exists
if [ ! -f "$IMAGE_PATH" ]; then
    echo -e "${RED}Error: File not found: ${IMAGE_PATH}${NC}"
    exit 1
fi

# Check if file is an image
FILE_TYPE=$(file --mime-type -b "$IMAGE_PATH")
if [[ ! "$FILE_TYPE" =~ ^image/ ]]; then
    echo -e "${RED}Error: File is not an image (detected: ${FILE_TYPE})${NC}"
    exit 1
fi

# Show file info
FILE_SIZE=$(ls -lh "$IMAGE_PATH" | awk '{print $5}')
echo ""
echo -e "${BLUE}File Info:${NC}"
echo "  Path: $IMAGE_PATH"
echo "  Type: $FILE_TYPE"
echo "  Size: $FILE_SIZE"
echo ""

# Confirm upload
echo -e "${YELLOW}This will upload the image to:${NC}"
echo "  Bucket: $R2_BUCKET"
echo "  Path:   $TARGET_PATH"
echo "  URL:    $PUBLIC_URL"
echo ""
echo -e "${YELLOW}Continue? (y/N)${NC}"
read -r CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Upload cancelled.${NC}"
    exit 0
fi

# ========================================
# Upload to R2
# ========================================
echo ""
echo -e "${BLUE}[4/4] 上传到 R2...${NC}"

# Determine content type
CONTENT_TYPE="image/png"
if [[ "$FILE_TYPE" == "image/jpeg" ]]; then
    CONTENT_TYPE="image/jpeg"
elif [[ "$FILE_TYPE" == "image/gif" ]]; then
    CONTENT_TYPE="image/gif"
elif [[ "$FILE_TYPE" == "image/webp" ]]; then
    CONTENT_TYPE="image/webp"
fi

# Upload using rclone (same as publish_release.sh)
if rclone --config="$RCLONE_CONFIG" copyto "$IMAGE_PATH" "r2:${R2_BUCKET}/${TARGET_PATH}" \
    --s3-no-check-bucket \
    --header-upload "Content-Type: $CONTENT_TYPE" \
    --header-upload "Cache-Control: public, max-age=3600" \
    --progress; then
    echo ""
    echo -e "${GREEN}✓ Upload successful!${NC}"
    echo ""
    echo -e "${BLUE}Public URL:${NC}"
    echo "  $PUBLIC_URL"
    echo ""

    # CDN cache purge hint
    if [ -n "$CF_ZONE_ID" ] && [ -n "$CF_API_TOKEN" ]; then
        echo -e "${CYAN}Purging CDN cache...${NC}"
        PURGE_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
            -H "Authorization: Bearer ${CF_API_TOKEN}" \
            -H "Content-Type: application/json" \
            -d "{\"files\":[\"$PUBLIC_URL\"]}")

        if echo "$PURGE_RESPONSE" | grep -q '"success":true'; then
            echo -e "${GREEN}✓ CDN cache purged${NC}"
        else
            echo -e "${YELLOW}⚠️ CDN cache purge may have failed${NC}"
        fi
    else
        echo -e "${YELLOW}Note: CDN cache may take up to 1 hour to refresh.${NC}"
        echo -e "${YELLOW}To purge cache immediately, configure CF_ZONE_ID and CF_API_TOKEN in .env${NC}"
    fi
else
    echo -e "${RED}✗ Upload failed!${NC}"
    exit 1
fi
