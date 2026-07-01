# Known Limitations

## Model & Provider Restrictions

The Grinev Telegram Bot spins up a local `opencode serve` instance on `localhost:4096`. Which models are available depends on the **API key** the server uses for authentication.

### API Key Tiers

| Key | Tier | Models Available |
|---|---|---|
| Free Zen key | Free | Only `opencode` provider with 5 free models |
| Go key (paid) | Go | Both `opencode-go` (13) and `opencode` (49) providers |

### How to Update the API Key

The opencode server reads its auth key from the `OPENCODE_API_KEY` env var (hardcoded in opencode's source). To avoid storing the key in any shell or process environment, the service loads it from a dedicated file on disk.

**Key file location:**
```
~/.config/opencode-telegram-bot/opencode-api-key.env
```

This file contains a single line:
```env
OPENCODE_API_KEY=***   # Go subscription key
```

**To update the key:**
1. Edit the file: `nano ~/.config/opencode-telegram-bot/opencode-api-key.env`
2. Replace the value after `=`
3. Restart the service: `systemctl --user restart ja-opencode-telegram.service`

The file is owned by `fen` with `chmod 600` (only the user can read/write).

## Available Models

### With Go Key

**`opencode-go` provider** (13 paid models):
- `deepseek-v4-flash`, `deepseek-v4-pro`
- `qwen3.7-plus`, `qwen3.7-max`
- `kimi-k2.6`, `kimi-k2.7-code`
- `glm-5.1`, `glm-5.2`
- `mimo-v2.5`, `mimo-v2.5-pro`
- `minimax-m3`, `minimax-m2.7`

**`opencode` provider** (49 models including free + paid):
- All of the above plus `claude-sonnet-4/5`, `claude-opus-4/5/6/7/8`, `gpt-5*`, `gemini-3*`, etc.

### With Free Key

Only `opencode` provider with 5 free models:
- `mimo-v2.5-free` (200K context, reasoning — best free option)
- `nemotron-3-ultra-free`
- `north-mini-code-free`
- `deepseek-v4-flash-free` (quota may be exceeded)
- `big-pickle`

### ❌ Can't Use: Direct Provider Bypass

The bot always proxies through opencode's SDK protocol (`/session/{id}/prompt_async` on the local server). You cannot bypass it to call a third-party API directly.

## Full Configuration

**`~/.config/opencode-telegram-bot/.env`** — bot settings (no API keys here):
```env
TELEGRAM_BOT_TOKEN=899198...fUVw
TELEGRAM_ALLOWED_USER_ID=8908834618
OPENCODE_API_URL=http://localhost:4096
OPENCODE_MODEL_PROVIDER=opencode-go
OPENCODE_MODEL_ID=deepseek-v4-flash
```

**`~/.config/opencode-telegram-bot/opencode-api-key.env`** — API key only (chmod 600):
```env
OPENCODE_API_KEY=***
```

**`~/.config/systemd/user/ja-opencode-telegram.service`** — service unit loads both:
```ini
EnvironmentFile=/home/fen/.config/opencode-telegram-bot/.env
EnvironmentFile=/home/fen/.config/opencode-telegram-bot/opencode-api-key.env
```

The key file is loaded second, so it overrides any `OPENCODE_API_KEY` from the settings env or the inherited systemd user environment.

## Diagnosis

When a model is unavailable, the logs will show:
```
[ModelManager] Filtered unavailable models: favoritesRemoved=X, recentRemoved=Y
```

And the bot responds:
```
🔴 OpenCode returned an error: Model not found: {providerID}/{modelID}. Did you mean: {modelID}?
```
