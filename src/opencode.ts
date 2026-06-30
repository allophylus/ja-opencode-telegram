import { log } from "./config.js";

// ─── Typed OpenCode SDK wrapper ────────────────────────────────────────────
// Talks to `opencode serve` at localhost:4096 (or configured URL)

export interface Session {
  id: string;
  title: string;
  agent?: string;
  model?: string;
  status?: string;
  created_at?: string;
}

export interface MessagePart {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MessageResponse {
  info: {
    id: string;
    session_id: string;
    role: string;
    created_at: string;
    [key: string]: unknown;
  };
  parts: MessagePart[];
}

export type Client = ReturnType<typeof createClient>;

export function createClient(baseUrl: string) {
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenCode API ${method} ${path}: ${res.status} ${text}`);
    }

    // Handle SSE response (for streaming endpoints)
    if (res.headers.get("content-type")?.includes("text/event-stream")) {
      return res as unknown as T;
    }

    return res.json() as Promise<T>;
  };

  return {
    // ─── Sessions ─────────────────────────────────────────────────────
    async listSessions(): Promise<Session[]> {
      return api<Session[]>("GET", "/session");
    },

    async getSession(id: string): Promise<Session> {
      return api<Session>("GET", `/session/${id}`);
    },

    async createSession(title?: string): Promise<Session> {
      return api<Session>("POST", "/session", title ? { title } : {});
    },

    async deleteSession(id: string): Promise<boolean> {
      return api<boolean>("DELETE", `/session/${id}`);
    },

    async abortSession(id: string): Promise<boolean> {
      return api<boolean>("POST", `/session/${id}/abort`);
    },

    // ─── Messages ─────────────────────────────────────────────────────
    async sendMessage(
      sessionId: string,
      parts: MessagePart[],
      options?: { model?: string; agent?: string }
    ): Promise<MessageResponse> {
      const body: Record<string, unknown> = { parts };
      if (options?.model) body.model = options.model;
      if (options?.agent) body.agent = options.agent;
      return api<MessageResponse>("POST", `/session/${sessionId}/message`, body);
    },

    async getMessages(sessionId: string, limit = 20): Promise<MessageResponse[]> {
      return api<MessageResponse[]>("GET", `/session/${sessionId}/message?limit=${limit}`);
    },

    // ─── Models ───────────────────────────────────────────────────────
    async listModels(): Promise<Record<string, unknown>> {
      return api<Record<string, unknown>>("GET", "/config/providers");
    },

    async getConfig(): Promise<Record<string, unknown>> {
      return api<Record<string, unknown>>("GET", "/config");
    },

    async patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
      return api<Record<string, unknown>>("PATCH", "/config", patch);
    },

    // ─── Projects ─────────────────────────────────────────────────────
    async listProjects(): Promise<unknown[]> {
      return api<unknown[]>("GET", "/project");
    },

    async getCurrentProject(): Promise<unknown> {
      return api<unknown>("GET", "/project/current");
    },

    // ─── Files ───────────────────────────────────────────────────────
    async listFiles(path = "."): Promise<unknown[]> {
      return api<unknown[]>("GET", `/file?path=${encodeURIComponent(path)}`);
    },

    async readFile(path: string): Promise<{ content?: string }> {
      return api<{ content?: string }>("GET", `/file/content?path=${encodeURIComponent(path)}`);
    },

    // ─── Health ──────────────────────────────────────────────────────
    async health(): Promise<Record<string, unknown>> {
      return api<Record<string, unknown>>("GET", "/global/health");
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function extractResponseText(response: MessageResponse): string {
  if (!response?.parts) return "[no response]";
  return response.parts
    .filter(p => p.type === "assistant" || p.type === "text" || p.type === "content")
    .map(p => p.content)
    .join("\n\n");
}

// ─── Model Shortcuts ────────────────────────────────────────────────────────

export const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-free": "opencode/deepseek-v4-flash-free",
  "deepseek-v4-flash": "opencode/deepseek-v4-flash",
  "deepseek-v4-pro": "opencode/deepseek-v4-pro",
  "deepseek-r1": "opencode/deepseek-r1-free",
  "claude-sonnet": "anthropic/claude-sonnet-4-20250514",
  "claude-haiku": "anthropic/claude-haiku-4-5",
  "claude-opus": "anthropic/claude-opus-4-7",
  "gpt-5": "openai/gpt-5",
  "gemini-flash": "google/gemini-3-flash",
};

export function resolveModel(input: string): string {
  const lower = input.toLowerCase();
  return MODEL_ALIASES[lower] || input;
}
