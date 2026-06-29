# JA OpenCode Telegram 🤖

A Telegram remote control plugin for [OpenCode](https://opencode.ai). Replace the buggy `@coinseeker/opencode-telegram-plugin` with something that actually handles permissions, shows usage, and doesn't crash on polling conflicts.

## Features

- **Remote Control** — Send any message to Telegram → it reaches OpenCode via `opencode --prompt`
- **Model Switching** — `/model <name>` switches models without editing config files
- **Permission Approval** — Inline buttons in Telegram: Allow Once / Always Allow / Reject
- **Token Tracking** — `/stats` shows token usage & cost; model + token context on every response
- **Health Check** — `/health` shows PID, active model, server time, token stats
- **Session Management** — `/sessions` list, `/status <id>` details, `/cancel`
- **No 409 Conflicts** — Single polling loop, no overlap with MCP servers

## Prerequisites

### 1. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the prompts:
   - Choose a name (e.g. `My OpenCode Bot`)
   - Choose a username ending in `bot` (e.g. `my_opencode_bot`)
3. BotFather gives you an **API token** — save it (looks like `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. (Optional but recommended) Send `/setprivacy` to @BotFather and set to **Disabled** so your bot can see all messages in groups

### 2. Find Your Telegram User ID

Send `/start` to [@userinfobot](https://t.me/userinfobot) — it replies with your numeric user ID (e.g. `123456789`). This goes into the allowlist.

---

## Quick Start

### 1. Install

```bash
mkdir -p ~/.config/opencode/plugins
cp src/telegram-remote.js ~/.config/opencode/plugins/
cp .env.example ~/.config/opencode/telegram-remote/.env
```

### 2. Configure

Edit `~/.config/opencode/telegram-remote/.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_USER_IDS=your_telegram_user_id
```

### 3. Update opencode.json

```json
{
  "plugin": [
    "file:///home/you/.config/opencode/plugins/ja-opencode-telegram.js"
  ],
  "mcp": {
    "telegram": {
      "enabled": false
    }
  }
}
```

Disable any other Telegram MCP server — they conflict on the same bot token.

### 4. Restart OpenCode

```bash
kill $(pgrep opencode)
opencode
```

### 5. Message your bot

Send `/start` to the Telegram bot. It'll auto-detect your chat and respond.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show this help |
| `/models` | List available models |
| `/model <key>` | Switch model (e.g. `deepseek-v4-free`, `claude-sonnet`) |
| `/sessions` | List recent OpenCode sessions |
| `/status <id>` | Get session details |
| `/stats` | Show token usage and cost |
| `/health` | System health (PID, model, stats) |
| `/config` | Show current model |
| `/cancel` | Cancel current operation |
| *any text* | Forward to OpenCode as a prompt |

## Models

Models are loaded **dynamically** from `opencode models` at runtime — up-to-date with whatever OpenCode supports.

Built-in shortcut aliases:
- `deepseek-v4-free` → `opencode/deepseek-v4-flash-free`
- `deepseek-v4-flash` → `opencode/deepseek-v4-flash`
- `deepseek-v4-pro` → `opencode/deepseek-v4-pro`
- `claude-sonnet` → `opencode/claude-sonnet-4`
- `claude-haiku` → `opencode/claude-haiku-4-5`
- `claude-opus` → `opencode/claude-opus-4-7`
- `gpt-5` → `opencode/gpt-5`
- `gemini-flash` → `opencode/gemini-3-flash`

Use `/models` to list every available model.
Use `/model <alias_or_id>` to switch — accepts full IDs or shortcuts.

## Architecture

```
Telegram ──► Plugin (long poll) ──► opencode --prompt "..." ──► Response
                 │                                              │
                 └── Hook: event, permission.ask ───────────────┘
```

The plugin runs inside OpenCode via the Plugin API. It:
1. Polls Telegram for messages from allowed user IDs
2. Forwards text to `opencode --prompt` via BunShell
3. Intercepts `permission.ask` hooks → sends inline buttons to Telegram → blocks until decision
4. Reports session completion events to Telegram
5. Appends model + token stats to every response

## Configuration

### `~/.config/opencode/telegram-remote/.env`
Bot token and user allowlist. See `.env.example`.

### Models
Models are loaded **dynamically** from `opencode models` at runtime — no config file needed.

Shortcut aliases are built into the plugin:
- `deepseek-v4-free` → `opencode/deepseek-v4-flash-free`
- `deepseek-v4-flash` → `opencode/deepseek-v4-flash`
- `deepseek-v4-pro` → `opencode/deepseek-v4-pro`
- `claude-sonnet` → `opencode/claude-sonnet-4`
- `claude-haiku` → `opencode/claude-haiku-4-5`
- `claude-opus` → `opencode/claude-opus-4-7`
- `gpt-5` → `opencode/gpt-5`
- `gemini-flash` → `opencode/gemini-3-flash`

Use `/model <alias>` for shortcuts, or `/model <full_id>` for any model ID.
The `/models` command always shows the full current list from OpenCode.

### `~/.config/opencode/telegram-remote/state.json`
Auto-generated — tracks chat ID and polling offset.

## Files

```
~/.config/opencode/
├── opencode.json                # Plugin registration
├── plugins/
│   └── telegram-remote.js       # Compiled plugin
├── telegram-remote/
│   ├── .env                     # Bot token + allowed users
│   
│   └── state.json               # Chat ID + polling offset
└── logs/
    └── telegram-remote.log      # Debug logging
```

## Development

```bash
# Edit source
vim src/telegram-remote.ts

# Compile
cd src && npx tsc -p tsconfig.json

# Deploy
cp src/telegram-remote.js ~/.config/opencode/plugins/

# Restart OpenCode
kill $(pgrep opencode) && opencode
```
