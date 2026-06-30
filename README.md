# JA OpenCode Telegram 🤖

Chat with OpenCode from Telegram. Send prompts, switch models, attach files.

## How it works

```
Telegram ──► ja-opencode-telegram ──► opencode serve (:4096)
```

This bot runs **alongside** `opencode serve` on your MacBook. It listens for your Telegram messages, forwards them to OpenCode via its REST API, and sends responses back.

## Setup

### 1. Prerequisites

- Node.js 20+
- `opencode` CLI installed
- `opencode serve` running (the bot talks to this)

### 2. Install

```bash
cd ja-opencode-telegram
npm install
```

### 3. Create a Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot` and choose a name/username
3. Save the API token

### 4. Get Your User ID

Message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID.

### 5. Configure

```bash
mkdir -p ~/.config/opencode/telegram-remote
cp .env.example ~/.config/opencode/telegram-remote/.env
```

Edit `~/.config/opencode/telegram-remote/.env`:

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_IDS=your_telegram_id
```

### 6. Run

**Terminal 1** — Start OpenCode server:
```bash
opencode serve
```

**Terminal 2** — Start the bot:
```bash
cd ja-opencode-telegram
npm start
```

Or for development:
```bash
npm run dev
```

### 7. Test

Open Telegram, find your bot, send `/start`. You're connected.

## Commands

| Command | Description |
|---------|-------------|
| `/new [title]` | Create a new session |
| `/sessions` | List sessions |
| `/session <id>` | Switch to a session |
| `/model [name]` | Show or set model |
| `/models` | List available models |
| `/abort` | Cancel current task |
| `/projects` | List projects |
| `/ls [path]` | Browse files |
| `/cat <path>` | Read a file |
| `/status` | Current session/model |
| `/health` | Connection status |
| `/help` | Command reference |
| *any text* | Send to OpenCode as prompt |

Model selection:
- Use `/model` to see current model
- Use `/models` to list all available models
- Send `/model <name>` to switch, e.g. `/model deepseek-v4-flash-free`

Model shortcuts:
- `deepseek-v4-flash-free` → DeepSeek V4 Flash Free (recommended free tier)
- `claude-sonnet` → Claude Sonnet 4
- `claude-haiku` → Claude Haiku 4.5
- `gemini-flash` → Gemini 3 Flash
- `gpt-5` → GPT-5

## Sending Files

Send any **document** or **photo** with an optional caption. The bot:

1. Downloads the file from Telegram
2. Saves it to `~/.opencode-attachments/`
3. Sends the prompt + file path to OpenCode

## File Structure

```
ja-opencode-telegram/
├── src/
│   ├── index.ts        — Entry point
│   ├── config.ts       — Config + state management
│   ├── opencode.ts     — OpenCode API client
│   └── bot.ts          — Telegram bot and all handlers
├── dist/               — Compiled JavaScript
├── .env.example        — Config template
├── package.json
└── tsconfig.json
```

## Building

```bash
npm run build
node dist/index.js
```
