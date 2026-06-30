#!/bin/bash
# Start ja-opencode-telegram bot + proxy
set -e

BOT_DIR="/home/fen/1-Projects/ja-opencode-telegram"
LOG="/tmp/ja-opencode-telegram.log"
PROXY_LOG="/tmp/telegram-proxy.log"

# Read token from .env (no hardcoding!)
ENV_FILE="$HOME/.config/opencode/telegram-remote/.env"
if [ -f "$ENV_FILE" ]; then
    TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | sed 's/^TELEGRAM_BOT_TOKEN=//' | tr -d "'\"")
else
    echo "[FATAL] No .env found at $ENV_FILE"
    exit 1
fi

if [ -z "$TOKEN" ]; then
    echo "[FATAL] TELEGRAM_BOT_TOKEN not set in $ENV_FILE"
    exit 1
fi

# Kill any existing proxy on 8091
lsof -ti:8091 2>/dev/null | xargs kill 2>/dev/null || true
sleep 1

# Start proxy fresh
rm -f "$PROXY_LOG"
cd "$BOT_DIR"
node telegram-proxy.cjs &>"$PROXY_LOG" &
PROXY_PID=$!
echo "Proxy PID: $PROXY_PID"
sleep 2

# Warm up proxy
curl -sf -o /dev/null "http://localhost:8091/bot${TOKEN}/getMe" -m 10
echo "Proxy ready"

# Kill old bot
for pid in $(pgrep -f "tsx.*index\|dist/index\.js\|node.*index" 2>/dev/null); do
    if readlink /proc/$pid/cwd 2>/dev/null | grep -q "ja-opencode-telegram"; then
        kill "$pid" 2>/dev/null || true
    fi
done
sleep 1

# Start bot
rm -f "$LOG"

# Prefer compiled dist, fall back to tsx
if [ -f "dist/index.js" ]; then
    node dist/index.js &>"$LOG" &
else
    npx tsx src/index.ts &>"$LOG" &
fi

echo "Bot PID: $!"

# Wait for stable state
sleep 15
tail -5 "$LOG"
echo "---"
pgrep -f "node.*index" >/dev/null && echo "Bot: alive" || echo "Bot: dead"
