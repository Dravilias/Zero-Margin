import { setLang, type Lang } from './i18n';
import { setMusicVolume } from './music';

export interface Settings {
  lang: Lang;
  name: string;
  volume: number;
  music: number;
  speed: 'slow' | 'normal' | 'fast';
  rain: boolean;
  relayUrl: string;
  tutorialDone: boolean;
  /** Whether new campaigns may use a language-model game master. */
  gmEnabled: boolean;
  /** Asks GitHub for the latest version when the menu opens. */
  checkUpdates: boolean;
  /** Campaign tips this player has already read, so each shows once. */
  tipsSeen: string[];
}

export const DEFAULT_RELAY = 'wss://relay.dravilias.me';
const KEY = 'zm.settings.v1';

function systemLang(): Lang {
  return navigator.language?.toLowerCase().startsWith('pl') ? 'pl' : 'en';
}

const defaults = (): Settings => ({
  lang: systemLang(), name: '', volume: 0.6, music: 0.5, speed: 'normal', rain: true, relayUrl: DEFAULT_RELAY, tutorialDone: false,
  gmEnabled: true, checkUpdates: true, tipsSeen: [],
});

export const settings: Settings = defaults();

/** Keeps only stored values of the right kind, so a damaged or hand-edited entry can't break the game. */
function clean(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const base = defaults();
  const out: Partial<Settings> = {};
  const level = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);
  if (r.lang === 'en' || r.lang === 'pl') out.lang = r.lang;
  if (typeof r.name === 'string') out.name = r.name.slice(0, 40);
  out.volume = level(r.volume) ?? base.volume;
  out.music = level(r.music) ?? base.music;
  if (r.speed === 'slow' || r.speed === 'normal' || r.speed === 'fast') out.speed = r.speed;
  if (typeof r.relayUrl === 'string' && /^wss?:\/\//.test(r.relayUrl)) out.relayUrl = r.relayUrl;
  for (const k of ['rain', 'tutorialDone', 'gmEnabled', 'checkUpdates'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  if (Array.isArray(r.tipsSeen)) out.tipsSeen = r.tipsSeen.filter((x): x is string => typeof x === 'string').slice(0, 40);
  return out;
}

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(settings, clean(JSON.parse(raw)));
  } catch { /* fall back to defaults */ }
  setLang(settings.lang);
  setMusicVolume(settings.music);
}

export function saveSettings(): void {
  setLang(settings.lang);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch { /* settings just won't persist */ }
}

export const speedFactor = (): number => ({ slow: 1.5, normal: 1, fast: 0.5 })[settings.speed];
