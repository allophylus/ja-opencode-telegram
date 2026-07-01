#!/usr/bin/env node
/**
 * ja-opencode-telegram — custom polling bot for OpenCode via Telegram
 * Uses raw https.request for getUpdates (avoids grammy v1 409 race condition)
 * Keeps all grinev bot message handlers, middleware, and services intact
 *
 * Run: node --dns-result-order=ipv4first ja-opencode-telegram.cjs
 */
'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');

// ── Load environment (ALWAYS from .env file, overriding system env) ─────
// System env has OpenClaw gateway's bot token set globally — we MUST use
// our own .env token to avoid 409 conflicts from two bots on same token.
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
    for (const line of fs.readFileSync(ENV_PATH, 'utf-8').split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#')) {
            const eq = t.indexOf('=');
            if (eq > 0) {
                let v = t.slice(eq + 1).trim();
                if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))
                    v = v.slice(1, -1);
                process.env[t.slice(0, eq).trim()] = v;
            }
        }
    }
}

process.env.TELEGRAM_FORCE_IPV4 = 'true';
process.env.OPENCODE_AUTO_RESTART_ENABLED = 'false';

const DIST = '/home/fen/.npm-global/lib/node_modules/@grinev/opencode-telegram-bot/dist';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('[FATAL] TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
}

// ── Shared IPv4 agent (single agent for all Telegram requests) ────────
const sharedAgent = new https.Agent({
    family: 4,
    keepAlive: true,
    keepAliveMsecs: 60000,
});

// ── Raw Telegram API helper (bypasses grammy entirely for polling) ────
function tgApiCall(method, payload) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const opts = {
            hostname: 'api.telegram.org',
            path: '/bot' + BOT_TOKEN + '/' + method,
            method: 'POST',
            agent: sharedAgent,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        };
        const req = https.request(opts, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error('JSON parse error: ' + data.slice(0, 200)));
                }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ── Graceful shutdown ─────────────────────────────────────────────────
let shuttingDown = false;
let cleanupBotRuntime = null;
let heartbeatTimer = null;
let opencodeProcess = null;

// ── Ensure OpenCode server is running ────────────────────────────────
async function ensureOpencodeServer() {
    // Check if already running on port 4096
    try {
        const resp = await fetch('http://localhost:4096/health', { signal: AbortSignal.timeout(2000) });
        if (resp.ok) {
            console.log('[OPENCODE] Already running');
            return;
        }
    } catch (e) { /* not running */ }

    console.log('[OPENCODE] Starting server...');
    const { spawn } = require('child_process');
    opencodeProcess = spawn('opencode', ['serve', '--port', '4096', '--print-logs'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
    });

    opencodeProcess.stdout.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log('[OPENCODE]', line);
    });
    opencodeProcess.stderr.on('data', (d) => {
        const line = d.toString().trim();
        if (line) console.log('[OPENCODE]', line);
    });
    opencodeProcess.on('exit', (code) => {
        console.log('[OPENCODE] Process exited (code=' + code + ')');
        opencodeProcess = null;
        if (!shuttingDown) {
            // Restart on crash
            console.log('[OPENCODE] Restarting in 3s...');
            setTimeout(ensureOpencodeServer, 3000);
        }
    });

    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            const resp = await fetch('http://localhost:4096/health', { signal: AbortSignal.timeout(1000) });
            if (resp.ok) {
                console.log('[OPENCODE] Server ready on port 4096');
                return;
            }
        } catch (e) { /* still starting */ }
    }
    console.warn('[OPENCODE] Server did not become ready within 30s');
}

async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[SHUTDOWN] ${reason} — cleaning up...`);
    if (cleanupBotRuntime) {
        try { cleanupBotRuntime(reason); } catch (e) { /* ignore */ }
    }
    if (opencodeProcess) {
        console.log('[SHUTDOWN] Stopping OpenCode server...');
        opencodeProcess.kill('SIGTERM');
        opencodeProcess = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    console.log('[SHUTDOWN] Done');
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err.message);
    shutdown('uncaughtException');
});

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
    console.log('[START] ' + new Date().toISOString());

    // 1. Load grinev bot modules
    const grinevIndex = require(path.join(DIST, 'bot/index.js'));
    const { initializeLogger } = require(path.join(DIST, 'utils/logger.js'));
    const { config } = require(path.join(DIST, 'config.js'));
    const { loadSettings } = require(path.join(DIST, 'app/stores/settings-store.js'));
    const { reconcileStoredModelSelection } = require(path.join(DIST, 'app/services/model-selection-service.js'));
    const { registerOpenCodeReadyRefreshHandler } = require(path.join(DIST, 'opencode/ready-refresh.js'));
    const { scheduledTaskRuntime } = require(path.join(DIST, 'app/services/scheduled-task-runtime-service.js'));

    cleanupBotRuntime = grinevIndex.cleanupBotRuntime;

    // 2. Initialize logging
    await initializeLogger();
    console.log('[INIT] Logger initialized');

    // 3. Load settings and services
    try {
        await loadSettings();
        await reconcileStoredModelSelection();
        registerOpenCodeReadyRefreshHandler();
        console.log('[INIT] Services loaded');
    } catch (e) {
        console.warn('[INIT] Non-critical service error:', e.message);
    }

    // 4. Create the grinev bot (handlers, middleware, composer)
    const bot = grinevIndex.createBot();
    await bot.init();
    console.log('[BOT] @' + bot.botInfo.username + ' (id=' + bot.botInfo.id + ')');

    // 4a. /model command handler — set model from Telegram
    const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_ID || '').split(',').filter(Boolean);
    function isAllowedUser(userId) {
        return ALLOWED_USER_IDS.length === 0 || ALLOWED_USER_IDS.includes(String(userId));
    }

    // Load model utilities
    const { getCurrentModel, setCurrentModel } = require(path.join(DIST, 'app/stores/settings-store.js'));
    const MODEL_CATALOG_PATH = '/home/fen/.cache/opencode/models.json';
    function readModelCatalog() {
        try {
            const content = require('fs').readFileSync(MODEL_CATALOG_PATH, 'utf-8');
            const raw = JSON.parse(content);
            const models = [];
            for (const [providerID, info] of Object.entries(raw)) {
                if (info.models) {
                    for (const [modelID, m] of Object.entries(info.models)) {
                        models.push({ providerID, modelID, name: m.name || modelID });
                    }
                }
            }
            return models;
        } catch (e) {
            console.warn('[MODEL] Failed to read catalog:', e.message);
            return null;
        }
    }

    /**
     * Fetch connected providers from the running opencode server
     */
    async function fetchConnectedProviders() {
        const http = require('http');
        return new Promise((resolve) => {
            const req = http.get('http://127.0.0.1:4096/provider', { timeout: 5000 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        // The response has a "connected" array at the root showing
                        // which providers have working API keys configured
                        if (Array.isArray(parsed.connected)) {
                            resolve(new Set(parsed.connected));
                        } else {
                            resolve(null);
                        }
                    } catch (e) {
                        resolve(null);
                    }
                });
            });
            req.on('error', () => resolve(null));
            req.end();
        });
    }

    /**
     * Handle /model command
     */
    async function handleModelCommand(chatId, args, messageId) {
        const current = getCurrentModel();

        // /model list — show all available models via inline keyboard
        if (args === 'list') {
            const catalog = readModelCatalog();
            if (!catalog || catalog.length === 0) {
                await tgApiCall('sendMessage', {
                    chat_id: chatId,
                    text: '⚠️ No models available from catalog.',
                    reply_to_message_id: messageId,
                });
                return;
            }

            // Fetch connected providers from the running opencode server
            const connectedProviders = await fetchConnectedProviders();

            // Group by provider
            const byProvider = {};
            for (const m of catalog) {
                const p = m.providerID || 'unknown';
                if (!byProvider[p]) byProvider[p] = [];
                byProvider[p].push(m);
            }

            // Filter to only providers connected via opencode (have API keys configured)
            const sortedProviders = Object.keys(byProvider).sort().filter(p => {
                return connectedProviders && connectedProviders.has(p);
            });
            const providerButtons = [];
            for (let i = 0; i < sortedProviders.length; i += 2) {
                const row = [
                    { text: sortedProviders[i], callback_data: 'model_provider:' + sortedProviders[i] }
                ];
                if (sortedProviders[i + 1]) {
                    row.push({ text: sortedProviders[i + 1], callback_data: 'model_provider:' + sortedProviders[i + 1] });
                }
                providerButtons.push(row);
            }

            await tgApiCall('sendMessage', {
                chat_id: chatId,
                text: '📋 *Available Providers*\nCurrent: `' + (current ? current.providerID + '/' + current.modelID : 'none') + '`\nSelect a provider:',
                parse_mode: 'Markdown',
                reply_markup: JSON.stringify({
                    inline_keyboard: providerButtons
                }),
            });
            return;
        }

        // If specific model key provided (e.g. /model deepseek/deepseek-v4-flash)
        if (args && args.includes('/')) {
            const parts = args.split('/');
            const providerID = parts[0];
            const modelID = parts.slice(1).join('/');

            setCurrentModel({ providerID, modelID });
            try { await reconcileStoredModelSelection({ force: true }); } catch (e) { /* ok */ }

            await tgApiCall('sendMessage', {
                chat_id: chatId,
                text: '✅ Model set to `' + providerID + '/' + modelID + '`',
                parse_mode: 'Markdown',
                reply_to_message_id: messageId,
            });
            return;
        }

        // /model with no args — show providers first (clean two-step flow)
        return handleModelCommand(chatId, 'list', messageId);
    }

    /**
     * Handle model-related callback queries
     */
    async function handleModelCallback(chatId, messageId, callbackData) {
        if (callbackData === 'model_list') {
            // Same as /model list
            return handleModelCommand(chatId, 'list', messageId);
        }

        if (callbackData.startsWith('model_provider:')) {
            const providerID = callbackData.split(':')[1];
            const catalog = readModelCatalog();
            const models = (catalog || []).filter(m => m.providerID === providerID);

            const rows = [];
            for (const m of models) {
                const key = m.providerID + '/' + m.modelID;
                const label = m.modelID.length > 30 ? m.modelID.slice(0, 28) + '…' : m.modelID;
                if (rows.length === 0 || rows[rows.length - 1].length >= 2) rows.push([]);
                rows[rows.length - 1].push({ text: label, callback_data: 'model_set:' + key });
            }
            rows.push([{ text: '⬅ Back', callback_data: 'model_list' }]);

            await tgApiCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: '📋 *' + providerID.toUpperCase() + '* models',
                parse_mode: 'Markdown',
                reply_markup: JSON.stringify({ inline_keyboard: rows }),
            });
            return;
        }

        if (callbackData.startsWith('model_set:')) {
            const key = callbackData.split(':').slice(1).join(':');
            const parts = key.split('/');
            const providerID = parts[0];
            const modelID = parts.slice(1).join('/');

            setCurrentModel({ providerID, modelID });
            try { await reconcileStoredModelSelection({ force: true }); } catch (e) { /* ok */ }

            await tgApiCall('editMessageText', {
                chat_id: chatId,
                message_id: messageId,
                text: '✅ Model set to `' + providerID + '/' + modelID + '`',
                parse_mode: 'Markdown',
            });

            // Send a confirmation as a new message too
            await tgApiCall('sendMessage', {
                chat_id: chatId,
                text: '✅ Switched to `' + providerID + '/' + modelID + '`',
                parse_mode: 'Markdown',
            });
            return;
        }
    }

    /**
     * Pre-process updates to handle /model commands and callbacks
     */
    async function preProcessUpdates(updates) {
        const handled = [];
        for (const update of updates) {
            let intercepted = false;

            // Text messages starting with /model
            if (update.message?.text?.startsWith('/model')) {
                const userId = String(update.message.from?.id);
                if (!isAllowedUser(userId)) {
                    console.log('[MODEL] Unauthorized user:', userId);
                    continue;
                }
                const chatId = update.message.chat.id;
                const messageId = update.message.message_id;
                const args = update.message.text.slice('/model'.length).trim();

                console.log('[MODEL] Command from user ' + userId + ': ' + (args || '(no args)'));
                await handleModelCommand(chatId, args, messageId);
                intercepted = true;
            }

            // Callback queries starting with model_
            if (update.callback_query?.data?.startsWith('model_')) {
                const userId = String(update.callback_query.from?.id);
                if (!isAllowedUser(userId)) {
                    console.log('[MODEL] Unauthorized callback:', userId);
                    await tgApiCall('answerCallbackQuery', {
                        callback_query_id: update.callback_query.id,
                        text: '❌ Not authorized',
                    });
                    continue;
                }

                const chatId = update.callback_query.message.chat.id;
                const messageId = update.callback_query.message.message_id;
                const callbackData = update.callback_query.data;

                console.log('[MODEL] Callback: ' + callbackData);
                await handleModelCallback(chatId, messageId, callbackData);

                // Answer the callback to dismiss the loading state
                await tgApiCall('answerCallbackQuery', {
                    callback_query_id: update.callback_query.id,
                });
                intercepted = true;
            }

            if (!intercepted) {
                handled.push(update);
            }
        }
        return handled;
    }

    // 5. Initialize scheduled task runtime
    try {
        await scheduledTaskRuntime.initialize(bot, {});
        console.log('[INIT] Scheduled task runtime initialized');
    } catch (e) {
        console.warn('[INIT] Scheduled task runtime warning:', e.message);
    }

    // 6. Start OpenCode server
    await ensureOpencodeServer();

    // 7. Heartbeat (every 60s)
    let hbCount = 0;
    heartbeatTimer = setInterval(() => {
        hbCount++;
        if (hbCount % 2 === 0) {
            console.log('[HEARTBEAT] #' + hbCount + ' — alive at ' + new Date().toISOString());
        }
    }, 30000);

    // 7. Pre-drain any pending updates (prevents grammy's stop() race condition)
    console.log('[DRAIN] Checking for pending updates...');
    let offset = 0;
    let drained = await tgApiCall('getUpdates', { offset: 0, timeout: 2, limit: 100 });
    while (drained.ok && drained.result && drained.result.length > 0) {
        offset = drained.result[drained.result.length - 1].update_id + 1;
        console.log('[DRAIN] Consumed ' + drained.result.length + ' pending updates, offset=' + offset);
        drained = await tgApiCall('getUpdates', { offset, timeout: 2, limit: 100 });
    }
    console.log('[DRAIN] Complete — offset=' + offset);

    // 8. Polling loop
    const POLL_TIMEOUT = 30; // seconds
    const POLL_LIMIT = 100;
    let pollCount = 0;
    let lastUpdateTime = Date.now();
    let consecutiveErrors = 0;

    console.log('[POLL] Starting polling loop (timeout=' + POLL_TIMEOUT + 's)...');

    while (!shuttingDown) {
        pollCount++;

        try {
            const result = await tgApiCall('getUpdates', {
                offset,
                timeout: POLL_TIMEOUT,
                limit: POLL_LIMIT,
            });

            if (!result.ok) {
                // 409 conflict — log and continue (offset unchanged)
                if (result.error_code === 409) {
                    console.log('[409] Poll #' + pollCount + ' — ' + (result.description || 'conflict'));
                    consecutiveErrors++;
                    if (consecutiveErrors > 100) {
                        console.warn('[409] Too many consecutive 409s, sleeping 5s...');
                        await new Promise(r => setTimeout(r, 5000));
                        consecutiveErrors = 0;
                    }
                    continue;
                }

                // Other error
                console.error('[ERR] Poll #' + pollCount + ' — ' + result.error_code + ': ' + (result.description || 'unknown'));
                consecutiveErrors++;
                if (consecutiveErrors > 10) {
                    console.error('[ERR] Too many errors, sleeping 10s...');
                    await new Promise(r => setTimeout(r, 10000));
                    consecutiveErrors = 0;
                }
                continue;
            }

            // Success — reset error counter
            consecutiveErrors = 0;

            const updates = result.result || [];
            if (updates.length > 0) {
                // Update offset
                offset = updates[updates.length - 1].update_id + 1;
                lastUpdateTime = Date.now();

                // Pre-process for model commands, pass rest to grammy
                const filtered = await preProcessUpdates(updates);
                if (filtered.length > 0) {
                    console.log('[UPDATE] Processing ' + filtered.length + ' update(s) (skipped ' + (updates.length - filtered.length) + ')');
                    try {
                        await bot.handleUpdates(filtered);
                    } catch (handlerError) {
                        console.error('[HANDLE] Error processing updates:', handlerError.message);
                        // Don't crash — continue polling
                    }
                } else {
                    console.log('[UPDATE] All ' + updates.length + ' update(s) intercepted by pre-processor');
                }
            }

            // Log every 50th poll
            if (pollCount % 50 === 0) {
                const uptime = Math.floor((Date.now() - new Date().getTime() + 36000000) / 1000);
                console.log('[POLL] #' + pollCount + ' — offset=' + offset + ' — ' + updates.length + ' updates');
            }
        } catch (netError) {
            console.error('[NET] Poll #' + pollCount + ' — ' + netError.message);
            consecutiveErrors++;
            if (consecutiveErrors > 5) {
                console.error('[NET] Too many network errors, sleeping 5s...');
                await new Promise(r => setTimeout(r, 5000));
                consecutiveErrors = 0;
            }
        }
    }

    // Shouldn't reach here
    shutdown('end_of_loop');
}

main().catch((err) => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});
