#!/bin/bash
# Qualcomm IMA é®ç­å·¥å·
# ä½¿ç¨Playwright CLIå¨è¾è®¯imaçé«éå¼æºèµæåºä¸­æé®
# é¦æ¬¡ä½¿ç¨éè¦å¾®ä¿¡æ«ç ç»å½ï¼ä¹åèªå¨ä¿å­ç»å½ç¶æ

set -e

# éç½®
SKILL_DIR="$HOME/.workbuddy/skills/qualcomm-ima"
PROFILE_DIR="$HOME/.workbuddy/playwright-ima-profile"
KB_ID="7437325709611728"
SHARE_ID="9825daa962f2fb8ee4f387da61d8bb1218356f39f477153e3f37b8131d740354"
BASE_URL="https://ima.qq.com/wikis?webFrom=10000050&channel=10000050&shareId=${SHARE_ID}&knowledgeBaseId=${KB_ID}&needAutoLogin=0"

# é¢è²è¾åº
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    echo "Qualcomm IMA é«éå¼æºèµæåºé®ç­å·¥å·"
    echo ""
    echo "ç¨æ³: $0 <é®é¢>          æé®"
    echo "   $0 --setup           åå§åæµè§å¨ï¼é¦æ¬¡ä½¿ç¨ï¼"
    echo "   $0 --snapshot        æ¥çå½åé¡µé¢å¿«ç§"
    echo "   $0 --screenshot      æªå¾"
    echo "   --help               æ¾ç¤ºå¸®å©"
    echo ""
    echo "ç¤ºä¾:"
    echo "  $0 \"QCS6490 NPU Spec\""
    echo "  $0 \"æä¹ä½¿ç¨Radxa D6a\""
    echo "  $0 \"Snapdragon X Eliteæ§è½\""
}

# æ£æ¥playwright-cliæ¯å¦å®è£
check_playwright() {
    if ! command -v playwright-cli &> /dev/null; then
        echo -e "${RED}éè¯¯: playwright-cli æªå®è£${NC}"
        echo "è¯·åå®è£: npm install -g playwright-cli"
        exit 1
    fi
}

# è®¾ç½®æµè§å¨
setup_browser() {
    echo -e "${GREEN}æ­£å¨åå§åæµè§å¨éç½®...${NC}"

    # è®¾ç½®æä¹åprofile
    export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"

    # æå¼æµè§å¨
    playwright-cli goto "$BASE_URL"
    echo -e "${YELLOW}è¯·ç¨å¾®ä¿¡æ«ç ç»å½ï¼${NC}"
    echo "ç»å½åæµè§å¨ç¶æä¼èªå¨ä¿å­"
    echo ""
    echo "ä»¥åä½¿ç¨æ éåæ¬¡ç»å½"
}

# æé®
ask_question() {
    local question="$1"

    if [ -z "$question" ]; then
        echo -e "${RED}éè¯¯: è¯·è¾å¥é®é¢${NC}"
        usage
        exit 1
    fi

    # URLç¼ç é®é¢
    encoded_question=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$question'))")

    # æå»ºå¸¦é®é¢çURL
    question_url="${BASE_URL}&question=${encoded_question}"

    echo -e "${GREEN}æ­£å¨å è½½é®é¢: $question${NC}"

    # è®¾ç½®æä¹åprofile
    export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"

    # è®¿é®é¡µé¢
    playwright-cli goto "$question_url"

    # ç­å¾å è½½
    echo "ç­å¾åç­çæï¼çº¦5ç§ï¼..."
    sleep 5

    # è·åå¿«ç§
    echo ""
    echo "========== åç­åå®¹ =========="
    playwright-cli snapshot
}

# ä¸»ç¨åº
case "${1:-}" in
    --help|-h)
        usage
        ;;
    --setup)
        check_playwright
        setup_browser
        ;;
    --snapshot)
        check_playwright
        export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"
        playwright-cli snapshot
        ;;
    --screenshot)
        check_playwright
        export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"
        playwright-cli screenshot
        ;;
    *)
        if [ -n "$1" ]; then
            check_playwright
            ask_question "$*"
        else
            usage
        fi
        ;;
esac
