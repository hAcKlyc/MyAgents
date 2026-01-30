#!/bin/bash
# upload_qr_code.sh - Upload user community QR code to R2 storage
# Usage: ./upload_qr_code.sh
#
# This script uploads a QR code image to R2 storage for the user community section
# in Settings > About page. The image is loaded dynamically from R2.
#
# Prerequisites:
# - AWS CLI configured with R2 credentials (uses aws s3 with custom endpoint)
# - Environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#   Or use existing ~/.aws/credentials with R2 profile

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
R2_BUCKET="download-myagents"
TARGET_PATH="assets/feedback_qr_code.png"
PUBLIC_URL="https://download.myagents.io/${TARGET_PATH}"

# Check R2 credentials
if [ -z "$R2_ACCOUNT_ID" ]; then
    echo -e "${RED}Error: R2_ACCOUNT_ID environment variable is not set.${NC}"
    echo "Please set it before running this script."
    exit 1
fi
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

echo -e "${BLUE}╔════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║     MyAgents QR Code Upload Tool               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}Error: AWS CLI is not installed.${NC}"
    echo "Please install it first: brew install awscli"
    exit 1
fi

# Prompt for image path
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

# Upload to R2
echo ""
echo -e "${BLUE}Uploading...${NC}"

# Determine content type
CONTENT_TYPE="image/png"
if [[ "$FILE_TYPE" == "image/jpeg" ]]; then
    CONTENT_TYPE="image/jpeg"
elif [[ "$FILE_TYPE" == "image/gif" ]]; then
    CONTENT_TYPE="image/gif"
elif [[ "$FILE_TYPE" == "image/webp" ]]; then
    CONTENT_TYPE="image/webp"
fi

# Upload using AWS CLI with R2 endpoint
aws s3 cp "$IMAGE_PATH" "s3://${R2_BUCKET}/${TARGET_PATH}" \
    --endpoint-url "$R2_ENDPOINT" \
    --content-type "$CONTENT_TYPE" \
    --cache-control "public, max-age=3600"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Upload successful!${NC}"
    echo ""
    echo -e "${BLUE}Public URL:${NC}"
    echo "  $PUBLIC_URL"
    echo ""
    echo -e "${YELLOW}Note: CDN cache may take up to 1 hour to refresh.${NC}"
    echo -e "${YELLOW}To purge cache immediately, run:${NC}"
    echo "  curl -X POST \"https://api.cloudflare.com/client/v4/zones/\$ZONE_ID/purge_cache\" \\"
    echo "    -H \"Authorization: Bearer \$CF_TOKEN\" \\"
    echo "    -H \"Content-Type: application/json\" \\"
    echo "    --data '{\"files\":[\"$PUBLIC_URL\"]}'"
else
    echo -e "${RED}✗ Upload failed!${NC}"
    exit 1
fi
