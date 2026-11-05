import type { LlmReply, LlmTransport } from '../net/gm';
import { settings } from './settings';

declare global {
  interface Window {
    zmDesktop?: {
      quit(): void;
      llmStatus(): Promise<{ hasKey: boolean; canSave: boolean }>;
      llmSetKey(key: string): Promise<{ saved: boolean }>;
      llmGenerate(req: { model: string; system: string; prompt: string; json: boolean; maxTokens: number }): Promise<LlmReply>;
    };
  }
}

/* The key lives in the desktop app's main process. A browser build has no way to reach the model at all. */

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

export async function llmStatus(): Promise<{ desktop: boolean; hasKey: boolean; canSave: boolean }> {
  const d = window.zmDesktop;
  if (!d) return { desktop: false, hasKey: false, canSave: false };
  return { desktop: true, ...(await d.llmStatus()) };
}
