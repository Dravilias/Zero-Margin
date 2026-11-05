import { setLang, type Lang } from './i18n';

export interface Settings {
  lang: Lang;
  name: string;
  volume: number;
  speed: 'slow' | 'normal' | 'fast';
  rain: boolean;
  relayUrl: string;
  tutorialDone: boolean;
  /** Whether new campaigns may use a language-model game master. */
  gmEnabled: boolean;
  gmWriterModel: string;
  gmRunnerModel: string;
}

export const DEFAULT_RELAY = 'wss://relay.dravilias.me';
export const DEFAULT_WRITER_MODEL = 'gemini-3.8-flash';
export const DEFAULT_RUNNER_MODEL = 'gemini-3.5-flash-lite';
const KEY = 'zm.settings.v1';

function systemLang(): Lang {
  return navigator.language?.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

const defaults = (): Settings => ({
  lang: systemLang(), name: '', volume: 0.6, speed: 'normal', rain: true, relayUrl: DEFAULT_RELAY, tutorialDone: false,
  gmEnabled: true, gmWriterModel: DEFAULT_WRITER_MODEL, gmRunnerModel: DEFAULT_RUNNER_MODEL,
});

export const settings: Settings = defaults();

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch { /* fall back to defaults */ }
  setLang(settings.lang);
}

export function saveSettings(): void {
  setLang(settings.lang);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* settings just won't persist */ }
}

export const speedFactor = (): number => ({ slow: 1.5, normal: 1, fast: 0.5 })[settings.speed];
