import type { LlmReply, LlmRequest, LlmTransport } from '../net/gm';
import { settings } from './settings';

export interface LlmServerStatus { endpoint: string; writer: string; runner: string; hasKey: boolean }
export interface LlmServerInput { endpoint: string; key: string; writer: string; runner: string }

declare global {
  interface Window {
    zmDesktop?: {
      quit(): void;
      updateCheck(): Promise<{ current: string; latest: string | null; available: boolean; canInstall: boolean; page: string }>;
      updateInstall(): Promise<{ ok: boolean; log: string }>;
      llmStatus(): Promise<{ servers: LlmServerStatus[]; canSave: boolean }>;
      llmConfigure(servers: LlmServerInput[]): Promise<{ ok: boolean; badServer?: number; saved: boolean }>;
      llmTest(): Promise<(LlmReply | null)[]>;
      llmGenerate(req: LlmRequest): Promise<LlmReply>;
    };
  }
}

/* Server addresses and keys live in the desktop app's main process. A browser build has no way to reach a model at all. */

export function desktopLlm(): LlmTransport | null {
  const d = window.zmDesktop;
  return d ? { generate: (req) => d.llmGenerate(req) } : null;
}

export async function llmStatus(): Promise<{ desktop: boolean; servers: LlmServerStatus[]; canSave: boolean }> {
  const d = window.zmDesktop;
  if (!d) return { desktop: false, servers: [], canSave: false };
  return { desktop: true, ...(await d.llmStatus()) };
}

/** Campaigns can use a model once some server can write stories and some server can narrate them. */
export async function llmReady(): Promise<boolean> {
  if (!settings.gmEnabled) return false;
  const { servers } = await llmStatus();
  return servers.some((s) => s.endpoint && s.writer) && servers.some((s) => s.endpoint && s.runner);
}
