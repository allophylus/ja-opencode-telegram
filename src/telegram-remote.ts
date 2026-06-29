/**
 * OpenCode Telegram Remote Plugin v2
 * Replaces @coinseeker/opencode-telegram-plugin
 * 
 * Features:
 * - Receive Telegram messages from Fen and process them via OpenCode
 * - Session completion notifications
 * - Handle permission requests with inline buttons
 * - Handle questions with inline buttons
 * - Switch models via /model command
 * - Cancel operations via /cancel
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { homedir, tmpdir } from "os";
import { createHash, randomUUID } from "crypto";
import type { Plugin, Hooks, PluginInput } from "@opencode-ai/plugin";

// ─── Process Guard ───────────────────────────────────────────────────────────
// OpenCode loads the plugin file as multiple separate module instances.
// A let-scoped variable isn't shared, but globalThis is.
const GUARD_KEY = "__telegram_plugin_started__";
function isAlreadyStarted(): boolean {
  if ((globalThis as any)[GUARD_KEY]) return true;
  (globalThis as any)[GUARD_KEY] = true;
  return false;
}

// ─── Config ─────────────────────────────────────────────────────────────────

interface TelegramConfig {
  botToken: string;
  allowedUserIds: number[];
  chatId?: number;
}

function loadEnv(): TelegramConfig {
  const envPaths = [
    join(homedir(), ".config", "opencode", "telegram-remote", ".env"),
    join(homedir(), ".config", "opencode", ".env"),
  ];

  for (const p of envPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf-8");
      const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("#"));
      const env: Record<string, string> = {};
      for (const line of lines) {
        const eqIdx = line.indexOf("=");
        if (eqIdx > 0) {
          env[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
        }
      }

      const botToken = env.TELEGRAM_BOT_TOKEN || "";
      const allowedIds = (env.TELEGRAM_ALLOWED_USER_IDS || "")
        .split(",")
        .map(s => parseInt(s.trim(), 10))
        .filter(n => !isNaN(n));
      const chatId = env.TELEGRAM_CHAT_ID ? parseInt(env.TELEGRAM_CHAT_ID, 10) : undefined;

      if (botToken && allowedIds.length > 0) {
        return { botToken, allowedUserIds: allowedIds, chatId };
      }
    }
  }

  throw new Error("Telegram config not found. Create ~/.config/opencode/telegram-remote/.env with TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_IDS");
}

// ─── State Store ─────────────────────────────────────────────────────────────

const statePath = join(homedir(), ".config", "opencode", "telegram-remote", "state.json");

interface State {
  chatId: number | null;
  lastUpdateId?: number;
  /** @deprecated legacy @coinseeker field — migrate to lastUpdateId */
  discoveredBy?: number;
  /** @deprecated legacy @coinseeker field — migrate to lastUpdateId */
  updatedAt?: string;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return { chatId: null, lastUpdateId: 0 };
  }
}

function writeState(state: State) {
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  // Migrate: remove legacy fields
  const clean: Record<string, any> = { lastUpdateId: state.lastUpdateId ?? 0, chatId: state.chatId ?? null };
  writeFileSync(statePath, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

// ─── Logger ──────────────────────────────────────────────────────────────────

const logPath = join(tmpdir(), "opencoder-telegram.log");

function log(level: string, msg: string, data?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  try { appendFileSync(logPath, line); } catch {}
}

// ─── OpenCode Config ─────────────────────────────────────────────────────────

const configPath = join(homedir(), ".config", "opencode", "opencode.json");

interface OpenCodeConfig {
  model?: string;
  plugin?: string[];
  mcp?: Record<string, any>;
}

function readOpenCodeConfig(): OpenCodeConfig {
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeOpenCodeConfig(config: OpenCodeConfig) {
  writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
}

// ─── Model Configuration ──────────────────────────────────────────────────────

// Built-in shortcut aliases for common models
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "opencode/deepseek-v4-flash",
  "deepseek-v4-free": "opencode/deepseek-v4-flash-free",
  "deepseek-v4-pro": "opencode/deepseek-v4-pro",
  "claude-sonnet": "opencode/claude-sonnet-4",
  "claude-haiku": "opencode/claude-haiku-4-5",
  "claude-opus": "opencode/claude-opus-4-7",
  "gpt-5": "opencode/gpt-5",
  "gemini-flash": "opencode/gemini-3-flash",
};

/** Resolve a model key to its full ID (alias → full, raw → pass-through) */
function resolveModel(input: string): string {
  return MODEL_ALIASES[input] || input;
}

/** Get the currently configured model from opencode.json */
function getCurrentModel(): string {
  return readOpenCodeConfig().model || "";
}


// ─── Telegram Bot API ────────────────────────────────────────────────────────

class TelegramBot {
  private base: string;
  private offset = 0;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private state: State;
  private allowedUserIds: number[];
  private onMessage: (chatId: number, text: string) => Promise<void>;
  /** Resolver map for pending permission callbacks */
  pendingPermissions = new Map<string, (result: { action: "allow" | "deny"; mode: "once" | "always" }) => void>();

  private consecutive409s = 0;

  constructor(
    token: string,
    allowedUserIds: number[],
    initialChatId: number | null,
    onMessage: (chatId: number, text: string) => Promise<void>,
  ) {
    this.base = `https://api.telegram.org/bot${token}`;
    this.allowedUserIds = allowedUserIds;
    this.state = readState();
    // Restore offset from state (handles old @coinseeker format too)
    this.offset = this.state.lastUpdateId || 0;
    if (initialChatId) this.state.chatId = initialChatId;
    this.onMessage = onMessage;
  }

  private polling = false;

  private async killOldConnection() {
    try {
      // Delete webhook + drop pending to clear any stale polling session
      await fetch(`${this.base}/deleteWebhook?drop_pending_updates=true`);
      await new Promise(r => setTimeout(r, 500));
      // Get latest update ID to learn correct offset
      const res = await fetch(`${this.base}/getUpdates?offset=-1&timeout=0&limit=1`);
      if (res.ok) {
        const data = await res.json() as { ok: boolean; result: any[] };
        if (data.ok && data.result?.length > 0) {
          this.offset = data.result[data.result.length - 1].update_id;
          this.state.lastUpdateId = this.offset;
          writeState(this.state);
          log("info", "Recovered offset from existing update", { offset: this.offset });
          return;
        }
      }
      // No pending updates — start from offset 0.
      // After deleteWebhook cleared stale connections, the first poll with
      // offset=1 should work (serial polling means no overlapping connections).
      this.offset = 0;
      this.state.lastUpdateId = 0;
      writeState(this.state);
      log("info", "No pending updates, starting fresh");
    } catch (err) {
      log("error", "Failed to kill old connection", { error: String(err) });
    }
  }

  async start() {
    log("info", "Telegram polling started");
    // Kill stale polling session before starting
    await this.killOldConnection();
    // Use serial polling — next poll starts only after previous completes
    // (avoids 409 conflicts from overlapping long-polling requests)
    const loop = async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        await this.poll();
      } finally {
        this.polling = false;
      }
      this.updateInterval = setTimeout(loop, 2000);
    };
    loop();
  }

  stop() {
    if (this.updateInterval) {
      clearTimeout(this.updateInterval);
      this.updateInterval = null;
    }
    log("info", "Telegram polling stopped");
  }

  private async poll() {
    try {
      const url = `${this.base}/getUpdates?offset=${this.offset + 1}&timeout=10&allowed_updates=["message","callback_query"]`;
      const res = await fetch(url);

      if (res.status === 409) {
        this.consecutive409s++;
        log("warn", "Polling conflict (409)", { consecutive: this.consecutive409s, offset: this.offset });

        // After 3 consecutive 409s, reset polling state
        if (this.consecutive409s >= 3) {
          log("warn", "Resetting polling after 3 consecutive 409s");
          await this.killOldConnection();
          this.consecutive409s = 0;
        }
        return;
      }

      // Success — reset 409 counter
      this.consecutive409s = 0;

      if (!res.ok) {
        log("error", `Poll failed: ${res.status} ${res.statusText}`);
        return;
      }

      const data = (await res.json()) as { ok: boolean; result: any[] };
      if (!data.ok || !data.result) return;

      // Advance offset past all received updates
      for (const update of data.result) {
        if (update.update_id > this.offset) {
          this.offset = update.update_id;
        }

        // Handle messages
        if (update.message) {
          const msg = update.message;
          const userId = msg.from?.id;
          const chatId = msg.chat?.id;
          const text = msg.text || "";

          if (userId && !this.allowedUserIds.includes(userId)) {
            log("warn", "Unauthorized message", { userId });
            continue;
          }

          if (chatId && this.state.chatId !== chatId) {
            this.state.chatId = chatId;
            writeState(this.state);
            await this.sendMessage(chatId, `✅ Connected!\n\nChat ID: ${chatId}\n\nSend any message to control OpenCode.`);
          }

          if (chatId && text) {
            await this.onMessage(chatId, text);
          }
        }

        // Handle callback queries
        if (update.callback_query) {
          const cb = update.callback_query;
          const userId = cb.from?.id;
          const chatId = cb.message?.chat?.id;
          const cbData = cb.data || "";

          if (userId && !this.allowedUserIds.includes(userId)) {
            log("warn", "Unauthorized callback", { userId });
            continue;
          }

          if (chatId && cbData) {
            await this.handleCallback(chatId, cb.id, cbData, cb.message?.message_id ?? 0);
          }
        }
      }

      this.state.lastUpdateId = this.offset;
      writeState(this.state);
    } catch (err) {
      log("error", "Poll error", { error: String(err) });
    }
  }

  async sendMessage(chatId: number, text: string, options?: { replyMarkup?: any; replyTo?: number }) {
    try {
      const body: Record<string, any> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      };
      if (options?.replyMarkup) body.reply_markup = options.replyMarkup;
      if (options?.replyTo) body.reply_to_message_id = options.replyTo;

      const res = await fetch(`${this.base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        log("error", "sendMessage failed", { status: res.status, error: errText.slice(0, 200) });
      }
      return await res.json();
    } catch (err) {
      log("error", "sendMessage error", { error: String(err) });
    }
  }

  async answerCallback(callbackId: string, text?: string) {
    try {
      await fetch(`${this.base}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackId,
          ...(text ? { text } : {}),
        }),
      });
    } catch (err) {
      log("error", "answerCallback error", { error: String(err) });
    }
  }

  async editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: any) {
    try {
      await fetch(`${this.base}/editMessageReplyMarkup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: replyMarkup,
        }),
      });
    } catch (err) {
      log("error", "editMessageReplyMarkup error", { error: String(err) });
    }
  }

  private async handleCallback(chatId: number, callbackId: string, data: string, messageId: number) {
    log("info", "Callback received", { data });

    const parts = data.split(":");
    const type = parts[0];

    if (type === "p" && parts.length >= 3) {
      // Permission callback: p:permissionId:action
      const permissionId = parts[1];
      const action = parts[2]; // o=allow_once, a=always_allow, r=reject
      const resolvedAction: "allow" | "deny" = action === "r" ? "deny" : "allow";
      const resolvedMode: "once" | "always" = action === "a" ? "always" : "once";

      await this.answerCallback(callbackId, resolvedAction === "allow" ? "✅ Approved" : "❌ Rejected");
      await this.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });

      // Resolve the waiting promise if someone is listening
      const resolver = this.pendingPermissions.get(permissionId);
      if (resolver) {
        resolver({ action: resolvedAction, mode: resolvedMode });
        this.pendingPermissions.delete(permissionId);
      }
    }

    if (type === "c" && parts.length >= 2) {
      // Model selection callback: c:modelKey
      const modelKey = parts[1];
      const modelId = resolveModel(modelKey);
      await this.answerCallback(callbackId, `✅ Switching to ${modelId}...`);
      await this.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] });
      await this.onMessage(chatId, `/model ${modelId}`);
    }
  }

  /** Send a permission notification and return a promise that resolves when user responds */
  async askPermission(
    chatId: number,
    permission: { id: string; title?: string; metadata?: Record<string, unknown>; pattern?: string | string[] }
  ): Promise<"allow" | "deny"> {
    const title = permission.title || "Permission Required";
    const metaStr = permission.metadata ? JSON.stringify(permission.metadata, null, 2) : "";
    const text = `<b>🔑 Permission Needed</b>\n\n${escapeHtml(title)}${metaStr ? `\n\n<code>${escapeHtml(metaStr)}</code>` : ""}`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Allow Once", callback_data: `p:${permission.id}:o` },
          { text: "🔁 Always Allow", callback_data: `p:${permission.id}:a` },
          { text: "❌ Reject", callback_data: `p:${permission.id}:r` },
        ],
      ],
    };

    await this.sendMessage(chatId, text, { replyMarkup: keyboard });

    // Wait for user response via callback
    return new Promise((resolve) => {
      this.pendingPermissions.set(permission.id, (result) => {
        resolve(result.action);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingPermissions.has(permission.id)) {
          log("warn", "Permission request timed out", { permissionId: permission.id });
          this.pendingPermissions.delete(permission.id);
          resolve("deny");
        }
      }, 5 * 60 * 1000);
    });
  }
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

const plugin: Plugin = async (input: PluginInput) => {
  // Guard: OpenCode loads plugin as multiple module instances
  if (isAlreadyStarted()) {
    log("info", "Plugin already started — skipping duplicate instantiation");
    return {};
  }

  const { $ } = input;
  const config = loadEnv();
  let chatId = config.chatId || readState().chatId || 0;

  const onMessage = async (incomingChatId: number, text: string) => {
    try {
      chatId = incomingChatId;

    // Handle commands
    if (text.startsWith("/")) {
      const [cmd, ...args] = text.split(" ");
      switch (cmd) {
        case "/start":
        case "/help": {
          const helpText = `<b>🤖 OpenCode Remote</b>

Send any message to chat with OpenCode.

<b>Commands:</b>
/help — Show this help
/model &lt;name&gt; — Switch model
/models — List available models
/sessions — List recent sessions
/status &lt;id&gt; — Session details
/cancel — Cancel current operation
/config — Show current model/config
/stats — Show token usage and costs
/health — System status with model + stats`;
          await bot.sendMessage(incomingChatId, helpText);
          return;
        }

        case "/config": {
          const ocConfig = readOpenCodeConfig();
          const currentModel = ocConfig.model || "(not set)";
          await bot.sendMessage(incomingChatId, `<b>⚙️ OpenCode Config</b>\n\nModel: <code>${escapeHtml(currentModel)}</code>`);
          return;
        }

        case "/stats": {
          try {
            const stats = await $`opencode stats`.quiet().nothrow().text();
            await bot.sendMessage(incomingChatId, `<b>📊 Token Usage</b>\n\n<code>${escapeHtml(stats.trim())}</code>`);
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Error getting stats: ${String(err)}`);
          }
          return;
        }

        case "/health": {
          try {
            const [statsOutput, modelCfg] = await Promise.all([
              $`opencode stats`.quiet().nothrow().text(),
              Promise.resolve(readOpenCodeConfig()),
            ]);
            const model = modelCfg.model || "(not set)";
            const now = new Date().toISOString();
            await bot.sendMessage(
              incomingChatId,
              `<b>🩺 OpenCode Health</b>\n\n📍 PID: ${process.pid}\n🧠 Model: <code>${escapeHtml(model)}</code>\n🕐 Time: ${now}\n\n<code>${escapeHtml(statsOutput.trim())}</code>`
            );
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Health check failed: ${String(err)}`);
          }
          return;
        }

        case "/models": {
          const currentModel = getCurrentModel();
          const modelsRaw = await $`opencode models`.quiet().nothrow().text();
          const allModels = modelsRaw.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("["));
          const lines = allModels.map(m => `${m === currentModel ? "✅" : "  "} <code>${escapeHtml(m)}</code>`);
          const aliasLines = Object.entries(MODEL_ALIASES).map(([alias, id]) =>
            `${id === currentModel ? "✅" : "  "} <code>${alias}</code> → <code>${escapeHtml(id)}</code>`
          );
          const parts = [
            `<b>📦 Models</b>`,
            ``,
            `Current: <code>${escapeHtml(currentModel || "(not set)")}</code>`,
            ``,
            `<b>All Available (${allModels.length}):</b>`,
            ...lines,
            ``,
            `<b>Shortcuts:</b>`,
            ...aliasLines,
          ];
          await bot.sendMessage(incomingChatId, parts.join("\n"));
          return;
        }

        case "/model": {
          const modelKey = args.join(" ");
          if (!modelKey) {
            const current = getCurrentModel();
            await bot.sendMessage(incomingChatId, `Usage: /model &lt;model_id&gt;\n\nCurrent: <code>${escapeHtml(current || "(not set)")}</code>\nUse /models to list all.`);
            return;
          }

          const modelId = resolveModel(modelKey);

          try {
            const oldModel = getCurrentModel();
            const ocConfig = readOpenCodeConfig();
            ocConfig.model = modelId;
            writeOpenCodeConfig(ocConfig);

            await bot.sendMessage(
              incomingChatId,
              `✅ <b>Model switched</b>\n\nFrom: <code>${escapeHtml(oldModel || "(not set)")}</code>\nTo: <code>${escapeHtml(modelId)}</code>\n\n<i>Note: may need OpenCode restart for full effect</i>`
            );
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Error switching model: ${String(err)}`);
          }
          return;
        }

        case "/sessions": {
          try {
            const output = await $`opencode session list`.quiet().nothrow().text();
            const sessions = output.trim() || "No active sessions.";
            await bot.sendMessage(incomingChatId, `<b>📋 Sessions</b>\n\n<code>${escapeHtml(sessions)}</code>`);
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Error listing sessions: ${String(err)}`);
          }
          return;
        }

        case "/status": {
          const sessionId = args[0];
          if (!sessionId) {
            await bot.sendMessage(incomingChatId, "Usage: /status &lt;session_id&gt;");
            return;
          }
          try {
            const output = await $`opencode session get ${sessionId}`.quiet().nothrow().text();
            await bot.sendMessage(incomingChatId, `<b>📊 Session</b> <code>${escapeHtml(sessionId)}</code>\n\n<code>${escapeHtml(output.trim())}</code>`);
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Error: ${String(err)}`);
          }
          return;
        }

        case "/cancel": {
          try {
            const output = await $`opencode cancel`.quiet().nothrow().text();
            await bot.sendMessage(incomingChatId, `✅ Cancelled: ${escapeHtml(output.trim())}`);
          } catch (err) {
            await bot.sendMessage(incomingChatId, `⚠️ Error: ${String(err)}`);
          }
          return;
        }

        default:
          await bot.sendMessage(incomingChatId, `Unknown: ${escapeHtml(cmd)}\n/help for commands.`);
          return;
      }
    }

    // Regular message — forward to OpenCode
    const modelLabel = getCurrentModel() || "default";
    await bot.sendMessage(incomingChatId, `⏳ <b>${escapeHtml(modelLabel)}</b> — Processing...`);

    try {
      const promptDir = input.directory || process.cwd();
      const resultPromise = $`cd ${promptDir} && opencode --prompt ${text}`.quiet().nothrow();
      const result = await resultPromise.text();

      const response = result?.trim() || "(No response)";

      // Fetch stats for footer context
      const statsText = await $`opencode stats`.quiet().nothrow().text().catch(() => "");
      const tokens = statsText ? statsText.split("\n").slice(0, 2).join(" | ").trim() : "";

      let footer = `\n\n— <i>${escapeHtml(modelLabel)}</i>`;
      if (tokens) {
        const short = tokens.length > 100 ? tokens.slice(0, 100) + "…" : tokens;
        footer += ` | <code>${escapeHtml(short)}</code>`;
      }

      const truncated = response.length > 3800 ? response.slice(0, 3800) + "\n\n… (truncated)" : response;
      await bot.sendMessage(incomingChatId, truncated + footer);
    } catch (err) {
      await bot.sendMessage(incomingChatId, `⚠️ Error processing message: ${String(err)}`);
    }
    } catch (err) {
      await bot.sendMessage(incomingChatId, `⚠️ Something went wrong: ${String(err)}`);
      log("error", "onMessage unhandled error", { error: String(err) });
    }
  };

  const bot = new TelegramBot(config.botToken, config.allowedUserIds, config.chatId || null, onMessage);
  await bot.start();

  // Register bot commands with Telegram (@BotFather /setcommands equivalent)
  const commands = [
    { command: "help", description: "Show help and available commands" },
    { command: "model", description: "Switch model (e.g. deepseek-v4-free)" },
    { command: "models", description: "List available models" },
    { command: "sessions", description: "List recent OpenCode sessions" },
    { command: "status", description: "Get session details" },
    { command: "stats", description: "Show token usage and costs" },
    { command: "health", description: "System health (PID, model, stats)" },
    { command: "cancel", description: "Cancel current operation" },
    { command: "config", description: "Show current model/config" },
  ];
  fetch(`https://api.telegram.org/bot${config.botToken}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands }),
  }).catch(e => log("warn", "Failed to register bot commands", { error: String(e) }));

  // ─── Hooks ──────────────────────────────────────────────────────────────

  const hooks: Hooks = {
    // Handle OpenCode events
    event: async ({ event }) => {
      const evt = event as any;
      const type = evt.type || "";
      const currentChatId = readState().chatId || 0;
      if (!currentChatId) return;

      try {
        switch (type) {
          case "session.status":
          case "session.idle": {
            const sessionTitle = evt.title || evt.session?.title || "Untitled";
            const agent = evt.agent || "";
            const status = evt.status || "idle";

            // Don't report child/subagent idle events
            if (evt.id && evt.id !== evt.rootId) return;

            if (status === "idle") {
              await bot.sendMessage(
                currentChatId,
                `✅ <b>Done:</b> ${escapeHtml(sessionTitle)}${agent ? ` (${escapeHtml(agent)})` : ""}`
              );
            }
            break;
          }

          case "question.asked": {
            const question = evt;
            const qText = question.question || question.text || "Question";
            const options = question.options || [];
            const header = question.header || "Question";

            if (options.length > 0) {
              const keyboard = {
                inline_keyboard: options.map((opt: any) => [
                  { text: opt.label || opt, callback_data: `q:${question.id || ""}:${opt.value || opt}` }
                ]),
              };
              await bot.sendMessage(currentChatId, `❓ <b>${escapeHtml(header)}</b>\n\n${escapeHtml(qText)}`, {
                replyMarkup: keyboard,
              });
            } else {
              await bot.sendMessage(currentChatId, `❓ <b>${escapeHtml(header)}</b>\n\n${escapeHtml(qText)}`);
            }
            break;
          }
        }
      } catch (err) {
        log("error", "Event handler error", { type, error: String(err) });
      }
    },

    // Handle permission.ask hook — blocks until Telegram user responds
    "permission.ask": async (input: any, output: { status: "ask" | "deny" | "allow" }) => {
      const permissionId = input.id || "";
      const currentChatId = readState().chatId;

      if (!currentChatId) {
        output.status = "deny";
        return;
      }

      try {
        const decision = await bot.askPermission(currentChatId, {
          id: permissionId,
          title: input.title || "Permission Required",
          metadata: input.metadata,
          pattern: input.pattern,
        });
        output.status = decision;
      } catch (err) {
        log("error", "permission.ask error", { permissionId, error: String(err) });
        output.status = "deny";
      }
    },
  };

  return hooks;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default plugin;
