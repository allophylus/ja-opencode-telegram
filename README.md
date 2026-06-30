# JA OpenCode Telegram 🤖

Chat with OpenCode from Telegram. Currently running using the **grinev** bot with a custom IPv4-safe polling loop.

## How it works

```
Telegram ──► grinev-runner.cjs ──► opencode serve (:4096)
```

The `grinev-runner.cjs` script:
- Wraps `@grinev/opencode-telegram-bot` (grammy v1)
- Uses raw `https.request` for polling (bypasses grammy's IPv6/Happy Eyeballs issues)
- Starts `opencode serve` automatically
- Handles 409 conflicts gracefully
- Forces IPv4 via `https.Agent({ family: 4 })`

## Setup

### 1. Prerequisites

- Node.js 20+
- `opencode` CLI installed globally

### 2. Install grinev bot

```bash
npm install -g @grinev/opencode-telegram-bot@0.22.0
```

### 3. Create a Telegram Bot via @BotFather

Save the API token.

### 4. Configure

```bash
mkdir -p ~/.config/opencode-telegram-bot
cp .env.example ~/.config/opencode-telegram-bot/.env
```

Edit `~/.config/opencode-telegram-bot/.env`:

```
TELEGRAM_BOT_TOKEN=your…ere
TELEGRAM_ALLOWED_USER_IDS=your_telegram_id
OPENCODE_API_URL=http://localhost:4096
OPENCODE_MODEL_PROVIDER=opencode
OPENCODE_MODEL_ID=deepseek-v4-flash-free
```

### 5. Run

```bash
cd ja-opencode-telegram
node --dns-result-order=ipv4first grinev-runner.cjs
```

Or via the start script:

```bash
./start.sh
```

### 6. Test

Open Telegram, find your bot, send `/start`.

## Commands

| Command | Description |
|---------|-------------|
| `/model` | Change AI model (opens selection menu) |
| `/status` | Bot, session, and model status |
| `/settings` | Configure bot behavior |
| `/new` | Create a new session |
| `/sessions` | List sessions |
| `/abort` | Cancel current task |
| `/projects` | List OpenCode projects |
| `/about` | About this bot and support the developer |
| `/help` | All commands |

## Model Selection

Send `/model` to see the current model and pick a new one from favorites/recent, or search all available models.

Free models available under provider `opencode`:
- `deepseek-v4-flash-free` — DeepSeek V4 Flash
- `mimo-v2.5-free` — MiniMax Mimo
- `nemotron-3-ultra-free` — NVIDIA Nemotron
- `north-mini-code-free`

## File Structure

```
ja-opencode-telegram/
├── grinev-runner.cjs    ← Current running bot (grinev wrapper)
├── start.sh              ← Start script
├── telegram-proxy.cjs    ← IPv4 proxy (alternative approach)
├── src/                  ← TypeScript bot (legacy/alternative)
├── dist/                 ← Compiled TS bot
├── .env.example          ← Config template
├── package.json
└── README.md
```

## Troubleshooting

**409 Conflict errors**: Fixed by using raw `https.request` polling (in `grinev-runner.cjs`) instead of grammy's built-in polling. Also ensure `TELEGRAM_FORCE_IPV4=true` is set.

**Insufficient Balance**: Top up at your [OpenCode billing page](https://opencode.ai/workspace/wrk_01KVF2HRG3MKQEXQ5YSW6Z10TZ/billing) or switch to a free model via `/model`.

**IPv6 issues**: The VM cannot reach `api.telegram.org` via IPv6. Force IPv4 with `--dns-result-order=ipv4first` and `https.Agent({ family: 4 })`.

## Support

If you find this bot useful, consider buying me a coffee ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/mrdom78)

## Auto-Start on Reboot

Both services are managed via systemd user units:

```bash
# Enable services (start on boot)
systemctl --user enable ja-opencode-telegram

# Start now
systemctl --user start ja-opencode-telegram

# Check status
systemctl --user status ja-opencode-telegram

# View logs
journalctl --user -u ja-opencode-telegram -n 50 --no-pager
```

Service files are in the `systemd/` directory of this repo.
