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

                // Process through grammy's middleware
                console.log('[UPDATE] Processing ' + updates.length + ' update(s)');
                try {
                    await bot.handleUpdates(updates);
                } catch (handlerError) {
                    console.error('[HANDLE] Error processing updates:', handlerError.message);
                    // Don't crash — continue polling
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
