import type { LlmReply, LlmTransport } from '../net/gm';
import { settings } from './settings';

declare global {
  interface Window {
    zmDesktop?: {
      quit(): void;
      llmStatus(): Promise<{ endpoint: string; hasKey: boolean; canSave: boolean }>;
      llmConfigure(cfg: { endpoint: string; key: string }): Promise<{ ok: boolean; saved: boolean }>;
      llmGenerate(req: { model: string; system: string; prompt: string; json: boolean; maxTokens: number }): Promise<LlmReply>;
    };
  }
}

/* The server address and key live in the desktop app's main process. A browser build has no way to reach a model at all. */

export function desktopLlm(): LlmTransport | null {
  const d = window.zmDesktop;
  if (!d) return null;
  return {
    generate: (req) => d.llmGenerate({
      model: req.tier === 'writer' ? settings.gmWriterModel : settings.gmRunnerModel,
      system: req.system, prompt: req.prompt, json: req.json, maxTokens: req.maxTokens,
    }),
  };
}

export async function llmStatus(): Promise<{ desktop: boolean; endpoint: string; hasKey: boolean; canSave: boolean }> {
  const d = window.zmDesktop;
  if (!d) return { desktop: false, endpoint: '', hasKey: false, canSave: false };
  return { desktop: true, ...(await d.llmStatus()) };
}

/** Well-known servers, to save typing the address. Any other OpenAI-compatible server works too. */
export const LLM_PRESETS: { id: string; label: string; url: string }[] = [
  { id: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { id: 'gemini', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'ollama', label: 'Ollama', url: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://localhost:1234/v1' },
];

/** A server and both model names have to be set before a campaign can use a language model. */
export async function llmReady(): Promise<boolean> {
  const status = await llmStatus();
  return settings.gmEnabled && !!status.endpoint && !!settings.gmWriterModel.trim() && !!settings.gmRunnerModel.trim();
}
