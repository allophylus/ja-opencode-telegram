# JA OpenCode Telegram 🤖

Chat with OpenCode from Telegram using the **grinev** bot wrapper with a custom IPv4-safe polling loop.

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

### 2. Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot`
3. Choose a display name for your bot (e.g. `My OpenCode Bot`)
4. Choose a username (must end in `bot`, e.g. `my_opencode_bot`)
5. BotFather replies with your **bot token** — save it. It looks like:
   ```
   1234567890:AAE-abc123def456ghi789jkl012mno345pqr
   ```
6. Send `/setprivacy` to BotFather, select your bot, then choose `Disable`
   (lets the bot see all messages, not just commands)
7. (Optional) Send `/setcommands` to BotFather and paste:
   ```
   start - Start the bot
   model - Change AI model
   about - About and support
   status - Bot status
   settings - Configure bot
   help - All commands
   ```

### 3. Get Your Telegram User ID

1. Open Telegram and search for [@userinfobot](https://t.me/userinfobot)
2. Send `/start` — it replies with your numeric user ID
3. Save this ID — you'll need it for `TELEGRAM_ALLOWED_USER_IDS`

### 4. Install grinev bot

```bash
npm install -g @grinev/opencode-telegram-bot@0.22.0
```

### 5. Configure

```bash
mkdir -p ~/.config/opencode-telegram-bot
cp .env.example ~/.config/opencode-telegram-bot/.env
```

Edit `~/.config/opencode-telegram-bot/.env`:

```
TELEGRAM_BOT_TOKEN=*** bot token from BotFather>
TELEGRAM_ALLOWED_USER_IDS=<your numeric user ID>
OPENCODE_API_URL=http://localhost:4096
OPENCODE_MODEL_PROVIDER=opencode
OPENCODE_MODEL_ID=deepseek-v4-flash-free
TELEGRAM_FORCE_IPV4=true
OPENCODE_AUTO_RESTART_ENABLED=false
```

### 6. Apply patches (adds `/model` and `/about` commands)

```bash
cd ja-opencode-telegram
bash patches/apply.sh
```

### 7. Start OpenCode server (separate terminal)

```bash
opencode serve --port 4096
```

### 8. Run the bot

```bash
cd ja-opencode-telegram
node --dns-result-order=ipv4first grinev-runner.cjs
```

Or via the start script:

```bash
./start.sh
```

### 9. Test

- Open Telegram, find your bot
- Send `/start` — registers commands in your chat
- Type `/` — you should see all commands including `/model` and `/about`

## Commands

| Command | Description |
|---------|-------------|
| `/model` | Change AI model (opens selection menu) |
| `/about` | About this bot and support the developer |
| `/status` | Bot, session, and model status |
| `/settings` | Configure bot behavior |
| `/new` | Create a new session |
| `/sessions` | List sessions |
| `/abort` | Cancel current task |
| `/projects` | List OpenCode projects |
| `/help` | All commands |

## Model Selection

Send `/model` to see the current model and pick a new one from favorites/recent, or search all available models.

Free models available:
- `deepseek-v4-flash-free`
- `mimo-v2.5-free`
- `nemotron-3-ultra-free`
- `north-mini-code-free`

## Auto-Start on Reboot

The bot runs as a systemd user service:

```bash
# Enable (start on boot)
systemctl --user enable ja-opencode-telegram

# Start now
systemctl --user start ja-opencode-telegram

# Check status
systemctl --user status ja-opencode-telegram

# View logs
journalctl --user -u ja-opencode-telegram -n 50 --no-pager
```

Service file is in the `systemd/` directory.

## Troubleshooting

**409 Conflict errors**: Fixed by using raw `https.request` polling
(in `grinev-runner.cjs`) instead of grammy's built-in polling. Also
ensure `TELEGRAM_FORCE_IPV4=true` is set.

**Insufficient Balance**: Top up at your OpenCode billing page or
switch to a free model via `/model`.

**IPv6 issues**: This VM cannot reach `api.telegram.org` via IPv6.
Force IPv4 with `--dns-result-order=ipv4first` and
`https.Agent({ family: 4 })`.

## File Structure

```
ja-opencode-telegram/
├── grinev-runner.cjs    ← Bot wrapper (raw polling, auto-starts opencode)
├── patches/             ← /model + /about command patches
│   ├── apply.sh
│   └── *.js
├── systemd/             ← Systemd service file
├── telegram-proxy.cjs   ← IPv4 proxy (alternative approach)
├── .env.example         ← Config template
├── start.sh             ← Quick start script
├── package.json
└── README.md
```

## Support

If you find this bot useful, consider buying me a coffee ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/mrdom78)
