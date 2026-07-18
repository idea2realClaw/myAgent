#!/bin/bash
# Qualcomm IMA 问答工具
# 使用Playwright CLI在腾讯ima的高通开源资料库中提问
# 首次使用需要微信扫码登录，之后自动保存登录状态

set -e

# 配置
SKILL_DIR="$HOME/.workbuddy/skills/qualcomm-ima"
PROFILE_DIR="$HOME/.workbuddy/playwright-ima-profile"
KB_ID="7437325709611728"
SHARE_ID="9825daa962f2fb8ee4f387da61d8bb1218356f39f477153e3f37b8131d740354"
BASE_URL="https://ima.qq.com/wikis?webFrom=10000050&channel=10000050&shareId=${SHARE_ID}&knowledgeBaseId=${KB_ID}&needAutoLogin=0"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

usage() {
    echo "Qualcomm IMA 高通开源资料库问答工具"
    echo ""
    echo "用法: $0 <问题>          提问"
    echo "   $0 --setup           初始化浏览器（首次使用）"
    echo "   $0 --snapshot        查看当前页面快照"
    echo "   $0 --screenshot      截图"
    echo "   --help               显示帮助"
    echo ""
    echo "示例:"
    echo "  $0 \"QCS6490 NPU Spec\""
    echo "  $0 \"怎么使用Radxa D6a\""
    echo "  $0 \"Snapdragon X Elite性能\""
}

# 检查playwright-cli是否安装
check_playwright() {
    if ! command -v playwright-cli &> /dev/null; then
        echo -e "${RED}错误: playwright-cli 未安装${NC}"
        echo "请先安装: npm install -g playwright-cli"
        exit 1
    fi
}

# 设置浏览器
setup_browser() {
    echo -e "${GREEN}正在初始化浏览器配置...${NC}"

    # 设置持久化profile
    export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"

    # 打开浏览器
    playwright-cli goto "$BASE_URL"
    echo -e "${YELLOW}请用微信扫码登录！${NC}"
    echo "登录后浏览器状态会自动保存"
    echo ""
    echo "以后使用无需再次登录"
}

# 提问
ask_question() {
    local question="$1"

    if [ -z "$question" ]; then
        echo -e "${RED}错误: 请输入问题${NC}"
        usage
        exit 1
    fi

    # URL编码问题
    encoded_question=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$question'))")

    # 构建带问题的URL
    question_url="${BASE_URL}&question=${encoded_question}"

    echo -e "${GREEN}正在加载问题: $question${NC}"

    # 设置持久化profile
    export PLAYWRIGHT_CHROMIUM_USER_DATA_DIR="$PROFILE_DIR"

    # 访问页面
    playwright-cli goto "$question_url"

    # 等待加载
    echo "等待回答生成（约5秒）..."
    sleep 5

    # 获取快照
    echo ""
    echo "========== 回答内容 =========="
    playwright-cli snapshot
}

# 主程序
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
