import { config } from "dotenv";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

config({ path: join(homedir(), ".config", "opencode", "telegram-remote", ".env") });

// ─── Config ────────────────────────────────────────────────────────────────

export interface AppConfig {
  botToken: string;
  allowedUserIds: number[];
  opencodeUrl: string;
  dataDir: string;
  tmpDir: string;
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing ${key} in .env`);
  return val;
}

export function loadConfig(): AppConfig {
  const home = homedir();
  const dataDir = join(home, ".config", "opencode", "telegram-remote");
  const tmpDir = join(home, ".opencode-attachments");

  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || "")
      .split(",")
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n)),
    opencodeUrl: process.env.OPENCODE_URL || "http://localhost:4096",
    dataDir,
    tmpDir,
  };
}

// ─── State Store ────────────────────────────────────────────────────────────

export interface BotState {
  chatId: number | null;
  lastUpdateId: number;
}

const statePath = join(homedir(), ".config", "opencode", "telegram-remote", "state.json");

export function readState(): BotState {
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return { chatId: null, lastUpdateId: 0 };
  }
}

export function writeState(state: Partial<BotState>) {
  const current = readState();
  const merged = { ...current, ...state };
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  writeFileSync(statePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

// ─── Session State ──────────────────────────────────────────────────────────

export interface BotSessionState {
  currentSessionId: string | null;
  currentModel: string | null;
  defaultAgent: string;
}

const sessionStatePath = join(homedir(), ".config", "opencode", "telegram-remote", "session-state.json");

export function readSessionState(): BotSessionState {
  try {
    return JSON.parse(readFileSync(sessionStatePath, "utf-8"));
  } catch {
    return { currentSessionId: null, currentModel: null, defaultAgent: "build" };
  }
}

export function writeSessionState(state: Partial<BotSessionState>) {
  const current = readSessionState();
  const merged = { ...current, ...state };
  mkdirSync(dirname(sessionStatePath), { recursive: true, mode: 0o700 });
  writeFileSync(sessionStatePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

// ─── Logger ─────────────────────────────────────────────────────────────────

const logPath = "/tmp/ja-opencode-telegram.log";

export function log(level: string, msg: string, data?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}\n`;
  try { writeFileSync(logPath, line, { flag: "a" }); } catch {}
}
