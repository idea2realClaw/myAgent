#!/bin/bash
# 一键启动龙族共享服务器（含 Cloudflare Tunnel）

cd /Users/zxd/ClawData/WorkBuddy

# 创建共享目录
mkdir -p dragon-share/{memory,skills,resources,logs}

# 启动共享服务器
echo "🚀 启动龙族共享知识库服务器 (端口 3001)..."
python3 "$(dirname "$0")/sharing_server.py" &
SERVER_PID=$!
echo "  PID: $SERVER_PID"

# 等待服务器启动
sleep 1

# 启动 Cloudflare Tunnel
echo "🌐 启动 Cloudflare Tunnel..."
/Users/zxd/ClawData/WorkBuddy/cloudflared tunnel --url http://localhost:3001 &
TUNNEL_PID=$!
echo "  PID: $TUNNEL_PID"
echo ""
echo "⏳ 等待 Tunnel 建立（约 5 秒）..."
sleep 5

echo ""
echo "✅ 服务已启动！"
echo "📋 提示：请将 Cloudflare 分配的外网地址告知其他徒弟"
echo "   例：python3 dragon_sync.py config set server https://xxxx.trycloudflare.com"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待中断
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo '服务已停止'" SIGINT SIGTERM
wait
