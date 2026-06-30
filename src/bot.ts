import { Telegraf, Context } from "telegraf";
import { message } from "telegraf/filters";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppConfig, log, writeState, readSessionState, writeSessionState } from "./config.js";
import { createClient, extractResponseText, resolveModel, MODEL_ALIASES, type Client } from "./opencode.js";

// ─── Bot Session (in-memory, per-chat) ──────────────────────────────────────

interface ChatState {
  currentSessionId: string | null;
  currentModel: string | null;
  defaultAgent: string;
}

export async function startBot(config: AppConfig) {
  const oc = createClient(config.opencodeUrl);
  const bot = new Telegraf(config.botToken, {
    // Use local HTTP proxy to bypass broken IPv6 on this VM
    // The proxy forwards to api.telegram.org via IPv4 + proper TLS
    ...(config.telegramProxyUrl
      ? { handlerTimeout: 30000, telegram: { apiRoot: config.telegramProxyUrl } }
      : {}),
  });

  // Restore persisted state
  const persisted = readSessionState();
  const chatStates = new Map<number, ChatState>();

  function getChatState(chatId: number): ChatState {
    let state = chatStates.get(chatId);
    if (!state) {
      state = {
        currentSessionId: null,
        currentModel: persisted.currentModel,
        defaultAgent: persisted.defaultAgent,
      };
      chatStates.set(chatId, state);
    }
    return state;
  }

  // ─── Middleware: auth check ─────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && !config.allowedUserIds.includes(userId)) {
      log("warn", "Unauthorized access", { userId });
      return;
    }
    if (ctx.chat?.id) {
      writeState({ chatId: ctx.chat.id });
    }
    return next();
  });

  // ─── START ──────────────────────────────────────────────────────────
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    const state = getChatState(chatId);

    // Try getting or creating a session
    try {
      const sessions = await oc.listSessions();
      if (sessions.length > 0 && !state.currentSessionId) {
        state.currentSessionId = sessions[sessions.length - 1].id;
        writeSessionState({ currentSessionId: state.currentSessionId });
      }
    } catch { /* opencode serve might not be running yet */ }

    await ctx.reply(
      `🤖 <b>JA OpenCode Telegram</b>\n\n` +
      `Connected. Send any message to talk to OpenCode.\n\n` +
      `Commands:\n` +
      `/model &lt;name&gt; — switch model\n` +
      `/models — list models\n` +
      `/new [title] — new session\n` +
      `/sessions — list sessions\n` +
      `/session &lt;id&gt; — switch session\n` +
      `/abort — cancel current task\n` +
      `/projects — list projects\n` +
      `/ls [path] — browse files\n` +
      `/cat &lt;path&gt; — read file\n` +
      `/status — current state\n` +
      `/help — full help\n\n` +
      `Send any document/photo to attach files to your prompt.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── HELP ───────────────────────────────────────────────────────────
  bot.help((ctx) => {
    return ctx.reply(
      `<b>Commands</b>\n\n` +
      `<code>/model &lt;name&gt;</code> — Switch model\n` +
      `<code>/models</code> — List available models\n` +
      `<code>/new [title]</code> — Create new session\n` +
      `<code>/sessions</code> — List sessions\n` +
      `<code>/session &lt;id&gt;</code> — Switch to session\n` +
      `<code>/abort</code> — Cancel current task\n` +
      `<code>/projects</code> — List OpenCode projects\n` +
      `<code>/ls [path]</code> — Browse files\n` +
      `<code>/cat &lt;path&gt;</code> — Read file contents\n` +
      `<code>/status</code> — Current session, model, project\n` +
      `<code>/health</code> — System health check\n` +
      `<code>/help</code> — This message\n\n` +
      `<b>Files:</b>\n` +
      `Send any document or photo as a caption with your prompt.\n` +
      `The bot saves it and includes it in the request.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── MODEL / MODELS ─────────────────────────────────────────────────
  bot.command("models", async (ctx) => {
    try {
      const models = await oc.listModels();
      const current = readSessionState().currentModel;

      // Flatten provider model lists
      const lines: string[] = ["<b>Available Models</b>\n"];

      // Also show built-in shortcuts
      lines.push("<b>Shortcuts:</b>");
      for (const [alias, full] of Object.entries(MODEL_ALIASES)) {
        const active = current === full || current === alias ? " ✅" : "";
        lines.push(`<code>/${alias}</code> → ${full}${active}`);
      }

      // Show provider info if available
      if (models && typeof models === "object") {
        lines.push("\n<b>Providers:</b>");
        for (const [provider, info] of Object.entries(models)) {
          const modelName = (info as Record<string, unknown>)?.model || "";
          lines.push(`<code>${provider}</code>: ${String(modelName)}`);
        }
      }

      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`❌ Failed to list models: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("model", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const modelArg = args.join(" ").trim().toLowerCase();

    if (!modelArg) {
      const current = readSessionState().currentModel;
      return ctx.reply(
        current
          ? `Current model: <code>${current}</code>\n\nUsage: <code>/model &lt;name&gt;</code>`
          : "No model set. Default will be used.\n\nUsage: <code>/model &lt;name&gt;</code>",
        { parse_mode: "HTML" }
      );
    }

    // Support shortcut aliases
    const resolved = resolveModel(modelArg);
    const state = readSessionState();

    // Also try to update OpenCode config so new sessions pick it up
    try {
      // Store in local state
      writeSessionState({ currentModel: resolved });
      await ctx.reply(
        `✅ Model set to: <code>${resolved}</code>\n` +
        `Will be used for subsequent prompts.`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      // Fallback: just set locally
      writeSessionState({ currentModel: resolved });
      await ctx.reply(`✅ Model set locally: <code>${resolved}</code>`, { parse_mode: "HTML" });
    }
  });

  // ─── SESSION MANAGEMENT ──────────────────────────────────────────────
  bot.command("new", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const title = args.join(" ").trim() || `telegram-${Date.now().toString(36)}`;

    try {
      const session = await oc.createSession(title);
      const chatId = ctx.chat.id;
      const state = getChatState(chatId);
      state.currentSessionId = session.id;
      writeSessionState({ currentSessionId: session.id });

      await ctx.reply(
        `✅ New session created\n` +
        `<b>ID:</b> <code>${session.id}</code>\n` +
        `<b>Title:</b> ${session.title}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply(`❌ Failed to create session: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("sessions", async (ctx) => {
    try {
      const sessions = await oc.listSessions();
      const currentId = readSessionState().currentSessionId;

      if (!sessions || sessions.length === 0) {
        return ctx.reply("No sessions found. Create one with <code>/new</code>", { parse_mode: "HTML" });
      }

      const lines = sessions.slice(-20).reverse().map((s, i) => {
        const active = s.id === currentId ? " ✅" : "";
        const title = s.title || "Untitled";
        return `${i + 1}. <code>${s.id.slice(0, 8)}</code> — ${escapeHtml(title)}${active}`;
      });

      await ctx.reply(`<b>Sessions (last 20):</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`❌ Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("session", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const sessionId = args[0]?.trim();

    if (!sessionId) {
      const state = readSessionState();
      if (state.currentSessionId) {
        try {
          const session = await oc.getSession(state.currentSessionId);
          return ctx.reply(
            `Current session: <code>${state.currentSessionId}</code>\n` +
            `Title: ${escapeHtml(session?.title || "Untitled")}`,
            { parse_mode: "HTML" }
          );
        } catch {
          return ctx.reply(`Current session: <code>${state.currentSessionId}</code>`, { parse_mode: "HTML" });
        }
      }
      return ctx.reply("No session set. Usage: <code>/session &lt;id&gt;</code> or <code>/new</code>", { parse_mode: "HTML" });
    }

    const chatId = ctx.chat.id;
    const state = getChatState(chatId);
    state.currentSessionId = sessionId;
    writeSessionState({ currentSessionId: sessionId });

    await ctx.reply(`✅ Switched to session: <code>${sessionId}</code>`, { parse_mode: "HTML" });
  });

  bot.command("abort", async (ctx) => {
    const state = readSessionState();
    if (!state.currentSessionId) {
      return ctx.reply("No active session to abort.");
    }
    try {
      await oc.abortSession(state.currentSessionId);
      await ctx.reply("🛑 Task aborted.");
    } catch (err) {
      await ctx.reply(`❌ Failed to abort: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ─── PROJECTS & FILES ───────────────────────────────────────────────
  bot.command("projects", async (ctx) => {
    try {
      const projects = await oc.listProjects();
      const current = await oc.getCurrentProject();

      const lines: string[] = ["<b>Projects</b>\n"];
      if (projects && Array.isArray(projects)) {
        for (const p of projects) {
          const name = (p as Record<string, unknown>)?.name || String(p);
          const active = name === (current as Record<string, unknown>)?.name ? " ✅" : "";
          lines.push(`<code>${escapeHtml(String(name))}</code>${active}`);
        }
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("ls", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const path = args.join(" ") || ".";

    try {
      const files = await oc.listFiles(path);
      if (Array.isArray(files)) {
        const lines = files.map(f => {
          const name = (f as Record<string, unknown>)?.name || String(f);
          const isDir = (f as Record<string, unknown>)?.type === "directory";
          const icon = isDir ? "📁" : "📄";
          return `${icon} ${escapeHtml(String(name))}`;
        });
        await ctx.reply(`<b>${escapeHtml(path)}</b>\n\n${lines.join("\n") || "(empty)"}`, { parse_mode: "HTML" });
      } else {
        await ctx.reply("(no files)");
      }
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("cat", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).slice(1);
    const path = args.join(" ").trim();
    if (!path) return ctx.reply("Usage: <code>/cat &lt;path&gt;</code>", { parse_mode: "HTML" });

    try {
      const result = await oc.readFile(path);
      const content = result?.content || "(empty or binary)";
      // Truncate to avoid Telegram message limits
      const truncated = content.length > 3500 ? content.slice(0, 3500) + "\n\n… (truncated)" : content;
      await ctx.reply(`<code>${escapeHtml(truncated)}</code>`, { parse_mode: "HTML" });
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ─── HEALTH ─────────────────────────────────────────────────────────
  bot.command("health", async (ctx) => {
    try {
      const health = await oc.health();
      const state = readSessionState();
      await ctx.reply(
        `🩺 <b>OpenCode Bridge</b>\n\n` +
        `📍 <b>Status:</b> ${health?.status || "unknown"}\n` +
        `🧠 <b>Model:</b> <code>${state.currentModel || "default"}</code>\n` +
        `💬 <b>Session:</b> <code>${state.currentSessionId?.slice(0, 12) || "none"}</code>\n` +
        `🔗 <b>Server:</b> ${process.env.OPENCODE_URL || "http://localhost:4096"}`,
        { parse_mode: "HTML" }
      );
    } catch (err) {
      await ctx.reply(`❌ OpenCode not reachable at ${process.env.OPENCODE_URL || "http://localhost:4096"}\n${err instanceof Error ? err.message : String(err)}\n\nMake sure <code>opencode serve</code> is running.`, { parse_mode: "HTML" });
    }
  });

  bot.command("status", async (ctx) => {
    const state = readSessionState();
    let sessionInfo = "";
    if (state.currentSessionId) {
      try {
        const session = await oc.getSession(state.currentSessionId);
        sessionInfo = `\n📋 <b>Title:</b> ${escapeHtml(session?.title || "Untitled")}`;
      } catch { /* ignore */ }
    }

    await ctx.reply(
      `<b>Current State</b>\n\n` +
      `🧠 <b>Model:</b> <code>${state.currentModel || "default"}</code>\n` +
      `💬 <b>Session:</b> <code>${state.currentSessionId?.slice(0, 12) || "none"}</code>` +
      `${sessionInfo}\n` +
      `🤖 <b>Agent:</b> ${state.defaultAgent || "build"}`,
      { parse_mode: "HTML" }
    );
  });

  // ─── FILE HANDLING ───────────────────────────────────────────────────
  bot.on(message("document"), async (ctx) => {
    const doc = ctx.message.document;
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption || "";
    const state = getChatState(chatId);

    if (!state.currentSessionId) {
      await ctx.reply("No active session. Create one with <code>/new</code> first.", { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(`⏳ Downloading <b>${escapeHtml(doc.file_name || "file")}</b>...`, { parse_mode: "HTML" });
    log("info", "Received document", { name: doc.file_name, size: doc.file_size });

    try {
      // Get download link from Telegram
      const fileLink = await ctx.telegram.getFileLink(doc.file_id);
      log("info", "File link obtained", { url: fileLink.href });

      // Download to temp
      mkdirSync(config.tmpDir, { recursive: true, mode: 0o755 });
      const fileName = doc.file_name || `file_${Date.now()}`;
      const localPath = join(config.tmpDir, fileName);

      const response = await fetch(fileLink.href);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(localPath, buffer);

      log("info", "File saved", { path: localPath, bytes: buffer.length });

      // Build prompt with file reference
      const promptText = caption
        ? `${caption}\n\nI've attached a file: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)\nPath: ${localPath}`
        : `I've attached a file: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)\nPath: ${localPath}\n\nPlease analyze this file.`;

      await ctx.reply(`📎 File saved. Sending to OpenCode...`, { parse_mode: "HTML" });

      // Send to OpenCode
      const response2 = await oc.sendMessage(
        state.currentSessionId,
        [{ type: "text", content: promptText }],
        { model: state.currentModel || undefined, agent: state.defaultAgent }
      );

      const responseText = extractResponseText(response2);
      const modelInfo = state.currentModel ? `\n\n— <code>${state.currentModel}</code>` : "";
      const truncatedResponse = responseText.length > 3800
        ? responseText.slice(0, 3800) + "\n\n… (truncated)"
        : responseText;

      await ctx.reply(truncatedResponse + modelInfo, { parse_mode: "HTML" });
    } catch (err) {
      log("error", "File handling failed", { error: String(err) });
      await ctx.reply(`❌ File processing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.on(message("photo"), async (ctx) => {
    const photos = ctx.message.photo;
    const caption = ctx.message.caption || "";
    const chatId = ctx.chat.id;
    const state = getChatState(chatId);

    if (!state.currentSessionId) {
      await ctx.reply("No active session. Create one with <code>/new</code> first.", { parse_mode: "HTML" });
      return;
    }

    // Get the highest resolution photo
    const photo = photos[photos.length - 1];
    await ctx.reply(`⏳ Downloading photo...`, { parse_mode: "HTML" });

    try {
      const fileLink = await ctx.telegram.getFileLink(photo.file_id);

      mkdirSync(config.tmpDir, { recursive: true, mode: 0o755 });
      const fileName = `photo_${Date.now()}.jpg`;
      const localPath = join(config.tmpDir, fileName);

      const response = await fetch(fileLink.href);
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(localPath, buffer);

      const promptText = caption
        ? `${caption}\n\nI've attached an image: ${fileName}\nPath: ${localPath}`
        : `I've attached an image: ${fileName}\nPath: ${localPath}\n\nPlease analyze this image.`;

      await ctx.reply(`📸 Photo saved. Sending to OpenCode...`);

      const response2 = await oc.sendMessage(
        state.currentSessionId,
        [{ type: "text", content: promptText }],
        { model: state.currentModel || undefined, agent: state.defaultAgent }
      );

      const responseText = extractResponseText(response2);
      const modelInfo = state.currentModel ? `\n\n— <code>${state.currentModel}</code>` : "";
      const truncated = responseText.length > 3800
        ? responseText.slice(0, 3800) + "\n\n… (truncated)"
        : responseText;

      await ctx.reply(truncated + modelInfo, { parse_mode: "HTML" });
    } catch (err) {
      log("error", "Photo handling failed", { error: String(err) });
      await ctx.reply(`❌ Photo processing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ─── TEXT MESSAGES (prompts) ─────────────────────────────────────────
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    const state = getChatState(chatId);

    // Skip commands
    if (text.startsWith("/")) return;

    if (!state.currentSessionId) {
      await ctx.reply("No active session. Create one with <code>/new</code> or check <code>/sessions</code>.", { parse_mode: "HTML" });
      return;
    }

    const modelInfo = state.currentModel ? ` (${state.currentModel})` : "";
    await ctx.reply(`⏳ Processing${modelInfo}...`);

    try {
      const response = await oc.sendMessage(
        state.currentSessionId,
        [{ type: "text", content: text }],
        { model: state.currentModel || undefined, agent: state.defaultAgent }
      );

      const responseText = extractResponseText(response);
      const truncated = responseText.length > 3800
        ? responseText.slice(0, 3800) + "\n\n… (truncated)"
        : responseText;
      const footer = state.currentModel ? `\n\n— <code>${state.currentModel}</code>` : "";

      await ctx.reply(truncated + footer, { parse_mode: "HTML" });
    } catch (err) {
      log("error", "Prompt failed", { error: String(err), session: state.currentSessionId });
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ─── START POLLING (with 409 retry) ──────────────────────────────────
  log("info", "Starting bot", { allowedUsers: config.allowedUserIds, opencodeUrl: config.opencodeUrl });

  // Drop stale polling sessions before launching
  try {
    const dropResp = await fetch(
      `${config.telegramProxyUrl || "https://api.telegram.org"}/bot${config.botToken}/getUpdates`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset: -1, timeout: 0 }) }
    );
    const dropResult = await dropResp.json();
    log("info", "Dropped stale polling", { ok: dropResult.ok });
  } catch (e) {
    log("warn", "Failed to drop stale polling", { error: String(e) });
  }

  // Give Telegram a moment to clean up
  await new Promise(r => setTimeout(r, 1000));

  // Launch with drop_pending_updates to avoid 409 conflicts
  await bot.launch({ dropPendingUpdates: true });
  log("info", "Bot launched");

  // Graceful shutdown
  process.once("SIGINT", () => {
    log("info", "Shutting down (SIGINT)");
    bot.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    log("info", "Shutting down (SIGTERM)");
    bot.stop("SIGTERM");
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
