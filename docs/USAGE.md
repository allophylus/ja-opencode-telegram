# Usage Guide

## First Connection

1. Message your Telegram bot
2. It responds with `✅ Connected! Chat ID: <your_chat_id>`
3. You're all set — any subsequent messages go to OpenCode

## Regular Messages

Any non-command text is forwarded to OpenCode as a prompt:

```
You: deploy the nginx config for gold-bot
Bot: ⏳ deepseek-v4-free — Processing...
Bot: [OpenCode's response]

— deepseek-v4-free | <code>Tokens: 1,234 | Cost: $0.00</code>
```

## Commands

### `/help`
Shows full command reference.

### `/models`
Lists available models. Active one marked with ✅:

```
📦 Available Models

✅ deepseek-v4-free — DeepSeek V4 Flash (Free)
   deepseek-v4 — DeepSeek V4 Flash
   deepseek-r1 — DeepSeek R1 (Free)
   claude-sonnet — Claude Sonnet 4

Use /model <name> to switch.
```

### `/model <key>`
Switch model. Updates `opencode.json`:

```
You: /model claude-sonnet
Bot: ✅ Model switched
     From: opencode/deepseek-v4-flash-free
     To: anthropic/claude-sonnet-4-20250514
     Note: may need OpenCode restart for full effect
```

Some model changes may need an OpenCode restart to take effect.

### `/sessions`
Lists recent OpenCode sessions (from `opencode session list`).

### `/status <id>`
Get details for a specific session.

### `/stats`
Shows token usage and cost from `opencode stats`:

```
📊 Token Usage
[stats output]
```

### `/health`
Shows system status:

```
🩺 OpenCode Health
📍 PID: 776903
🧠 Model: opencode/deepseek-v4-flash-free
🕐 Time: 2026-06-29T21:59:00.000Z

[stats output]
```

### `/config`
Shows current model setting.

### `/cancel`
Cancels current OpenCode operation.

## Permission Approval

When OpenCode needs permission to execute an action, you get inline buttons:

```
🔑 Permission Needed
Execute command: apt update

[ ✅ Allow Once ] [ 🔁 Always Allow ] [ ❌ Reject ]
```

Tap your choice. The decision is sent back to OpenCode (blocking wait with 5-minute timeout).

## Session Completion

When an OpenCode session finishes, you get:

```
✅ Done: Deploy Nginx Config (build)
```

## Troubleshooting

### Plugin not responding
- Check OpenCode is running: `pgrep opencode`
- Check the log: `tail -f /tmp/opencoder-telegram.log`
- Restart OpenCode: `kill $(pgrep opencode) && opencode`

### 409 polling conflicts
- Make sure `telegram-mcp-server` is disabled in `opencode.json`
- No other bot should be polling the same token
- If all else fails, restart your bot token from @BotFather

### Permission timeout
- If you don't respond to a permission prompt within 5 minutes, it auto-denies
- The OpenCode session may hang waiting — use `/cancel` to recover

### Model changes not taking effect
- Some models require OpenCode restart: `kill $(pgrep opencode) && opencode`
- Verify the config: `/config`
