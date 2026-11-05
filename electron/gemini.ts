/* Talks to the Gemini API from the main process, so the page never sees the key and its network policy stays closed. */

export interface GeminiRequest {
  model: string;
  system: string;
  prompt: string;
  json: boolean;
  maxTokens: number;
}

export type GeminiFailure = 'nokey' | 'quota' | 'blocked' | 'network' | 'badkey' | 'error';
export type GeminiReply = { ok: true; text: string } | { ok: false; reason: GeminiFailure; detail?: string };

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,62}$/;
const TIMEOUT_MS = 120000;

function body(req: GeminiRequest, thinking: boolean): string {
  return JSON.stringify({
    contents: [{ parts: [{ text: req.prompt }] }],
    systemInstruction: { parts: [{ text: req.system }] },
    generationConfig: {
      maxOutputTokens: req.maxTokens,
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
      // Short narration shouldn't spend its token budget on thinking. Older models reject this field.
      ...(thinking ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
    },
  });
}

async function post(url: string, key: string, payload: string, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: payload,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
}

export function readReply(data: GeminiResponse): GeminiReply {
  if (data.promptFeedback?.blockReason) return { ok: false, reason: 'blocked', detail: data.promptFeedback.blockReason };
  const c = data.candidates?.[0];
  if (!c) return { ok: false, reason: 'error', detail: 'no candidates' };
  const text = (c.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  if (c.finishReason && !['STOP', 'MAX_TOKENS'].includes(c.finishReason)) return { ok: false, reason: 'blocked', detail: c.finishReason };
  if (!text) return { ok: false, reason: 'error', detail: c.finishReason ?? 'empty' };
  return { ok: true, text };
}

export async function callGemini(req: GeminiRequest, key: string, fetchImpl: typeof fetch = fetch): Promise<GeminiReply> {
  if (!key) return { ok: false, reason: 'nokey' };
  if (!MODEL_ID.test(req.model)) return { ok: false, reason: 'error', detail: 'bad model name' };
  const url = `${BASE}/${req.model}:generateContent`;
  try {
    let res = await post(url, key, body(req, true), fetchImpl);
    if (res.status === 400) res = await post(url, key, body(req, false), fetchImpl);
    if (res.status === 429) return { ok: false, reason: 'quota' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'badkey' };
    if (!res.ok) return { ok: false, reason: 'error', detail: `HTTP ${res.status}` };
    return readReply(await res.json() as GeminiResponse);
  } catch {
    return { ok: false, reason: 'network' };
  }
}
