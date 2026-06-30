#!/bin/bash
# Apply /model command patch to @grinev/opencode-telegram-bot dist
# Run after: npm install -g @grinev/opencode-telegram-bot@0.22.0

GRINEV_DIST="/home/fen/.npm-global/lib/node_modules/@grinev/opencode-telegram-bot/dist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Adding /model command..."
cp "$SCRIPT_DIR/model-command.js" "$GRINEV_DIST/bot/commands/"
cp "$SCRIPT_DIR/definitions.js" "$GRINEV_DIST/bot/commands/"
cp "$SCRIPT_DIR/command-router.js" "$GRINEV_DIST/bot/routers/"
cp "$SCRIPT_DIR/i18n-en.js" "$GRINEV_DIST/i18n/en.js"

echo "Done. Run: cd ja-opencode-telegram && node --dns-result-order=ipv4first grinev-runner.cjs"
