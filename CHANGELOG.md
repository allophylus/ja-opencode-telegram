# Changelog

## v2.0.0 — 2026-06-29

Complete rewrite replacing `@coinseeker/opencode-telegram-plugin`.

### Added
- Full Telegram long polling (no 409 conflicts, single polling loop)
- `/model <key>` — switch models via Telegram command
- `/models` — list available models with active indicator
- `/stats` — show token usage and cost from `opencode stats`
- `/health` — system health (PID, model, server time, token stats)
- `/config` — show current active model
- `/sessions` — list recent OpenCode sessions
- `/status <id>` — get session details
- `/cancel` — cancel current OpenCode operation
- `/help` — command reference
- **Permission approval**: inline buttons (Allow Once / Always / Reject) with 5-min timeout
- **Response context**: every response includes model tag + token usage footer
- **Question forwarding**: OpenCode questions sent to Telegram (with inline buttons for options)
- **Session completion notifications**: sent to Telegram when sessions complete
- **State persistence**: chat ID and polling offset saved to `state.json`
- **Debug logging**: to `/tmp/opencoder-telegram.log`

### Changed
- Config moved from npm package to local `file://` plugin path
- `telegram-mcp-server` disabled (was causing 409 polling conflicts)
- Permission handling now blocks properly via Promise resolver instead of returning "ask" immediately
- Model config written directly to `opencode.json` for persistence

### Removed
- Dependency on `@coinseeker/opencode-telegram-plugin` npm package
- Dependency on `telegram-mcp-server` for polling (optional/disabled)
- Hardcoded tokens — all config via `.env`

### Security
- Bot token, allowed user IDs via `~/.config/opencode/telegram-remote/.env` only
- Source code contains zero credentials
- Unauthorized messages silently logged and dropped
