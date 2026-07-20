#!/bin/bash
# ä¸é®å¯å¨é¾æå±äº«æå¡å¨ï¼å« Cloudflare Tunnelï¼

cd /Users/zxd/ClawData/WorkBuddy

# åå»ºå±äº«ç®å½
mkdir -p dragon-share/{memory,skills,resources,logs}

# å¯å¨å±äº«æå¡å¨
echo "ð å¯å¨é¾æå±äº«ç¥è¯åºæå¡å¨ (ç«¯å£ 3001)..."
python3 "$(dirname "$0")/sharing_server.py" &
SERVER_PID=$!
echo "  PID: $SERVER_PID"

# ç­å¾æå¡å¨å¯å¨
sleep 1

# å¯å¨ Cloudflare Tunnel
echo "ð å¯å¨ Cloudflare Tunnel..."
/Users/zxd/ClawData/WorkBuddy/cloudflared tunnel --url http://localhost:3001 &
TUNNEL_PID=$!
echo "  PID: $TUNNEL_PID"
echo ""
echo "â³ ç­å¾ Tunnel å»ºç«ï¼çº¦ 5 ç§ï¼..."
sleep 5

echo ""
echo "â æå¡å·²å¯å¨ï¼"
echo "ð æç¤ºï¼è¯·å° Cloudflare åéçå¤ç½å°ååç¥å¶ä»å¾å¼"
echo "   ä¾ï¼python3 dragon_sync.py config set server https://xxxx.trycloudflare.com"
echo ""
echo "æ Ctrl+C åæ­¢æææå¡"

# ç­å¾ä¸­æ­
trap "kill $SERVER_PID $TUNNEL_PID 2>/dev/null; echo 'æå¡å·²åæ­¢'" SIGINT SIGTERM
wait
