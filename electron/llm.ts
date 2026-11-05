/*
 * Talks to any server with an OpenAI-compatible chat API from the main process, so the page never sees the key
 * and its network policy stays closed.
 */

export interface LlmCall {
  model: string;
  system: string;
  prompt: string;
  json: boolean;
  maxTokens: number;
}

export type LlmFailure = 'nokey' | 'quota' | 'blocked' | 'network' | 'badkey' | 'notfound' | 'error';
export type LlmCallReply = { ok: true; text: string } | { ok: false; reason: LlmFailure; detail?: string };

// Local models can be slow.
const TIMEOUT_MS = 300000;

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1') return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
}

/**
 * Cleans up a base URL such as https://api.example.com/v1, or returns null if it can't be used.
 * Plain http is only accepted on this machine or the local network, because the key would travel unencrypted.
 */
export function normalizeEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isPrivateHost(url.hostname))) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  return `${url.origin}${path}`;
}

interface ChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null };
  }[];
  error?: unknown;
}

export function readReply(data: ChatResponse): LlmCallReply {
  const c = data.choices?.[0];
  if (!c) return { ok: false, reason: 'error', detail: 'no choices' };
  if (c.finish_reason === 'content_filter' || c.message?.refusal) return { ok: false, reason: 'blocked', detail: c.finish_reason ?? 'refusal' };
  const content = c.message?.content;
  const joined = Array.isArray(content) ? content.map((p) => p.text ?? '').join('') : content ?? '';
  // Some local models include their reasoning in the answer.
  const text = joined.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
  if (!text) return { ok: false, reason: 'error', detail: c.finish_reason ?? 'empty' };
  return { ok: true, text };
}

async function post(url: string, key: string, payload: object, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(payload),
      // Never let a redirect carry the request somewhere the player didn't choose.
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function callChat(req: LlmCall, endpoint: string, key: string, fetchImpl: typeof fetch = fetch): Promise<LlmCallReply> {
  const base = normalizeEndpoint(endpoint);
  if (!base || !req.model.trim()) return { ok: false, reason: 'nokey' };
  const url = `${base}/chat/completions`;
  const common = {
    model: req.model.trim(),
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
  };
  const json = req.json ? { response_format: { type: 'json_object' } } : {};
  // Servers differ on these two optional fields, so a rejected request is retried with the other forms.
  const attempts: object[] = [
    { ...common, ...json, max_tokens: req.maxTokens },
    { ...common, ...json, max_completion_tokens: req.maxTokens },
    { ...common, max_tokens: req.maxTokens },
  ];
  try {
    let res: Response | null = null;
    for (const attempt of req.json ? attempts : attempts.slice(0, 2)) {
      res = await post(url, key, attempt, fetchImpl);
      if (res.status !== 400 && res.status !== 422) break;
    }
    if (!res) return { ok: false, reason: 'error' };
    if (res.status === 429) return { ok: false, reason: 'quota' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'badkey' };
    if (res.status === 404) return { ok: false, reason: 'notfound' };
    if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}` };
    return readReply(await res.json() as ChatResponse);
  } catch {
    return { ok: false, reason: 'network' };
  }
}
