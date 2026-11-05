import { settings } from './settings';

/* All sound is synthesized here, so the game ships no audio files. */

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

function audio(): AudioContext | null {
  if (settings.volume <= 0) return null;
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function burst(opts: { at?: number; dur: number; gain: number; freq: number; q?: number; type?: BiquadFilterType }): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + (opts.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const filter = c.createBiquadFilter();
  filter.type = opts.type ?? 'bandpass';
  filter.frequency.value = opts.freq;
  filter.Q.value = opts.q ?? 1;
  const g = c.createGain();
  g.gain.setValueAtTime(opts.gain * settings.volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  src.connect(filter).connect(g).connect(c.destination);
  src.start(t, Math.random() * 0.5, opts.dur + 0.02);
}

function tone(opts: { at?: number; dur: number; gain: number; from: number; to?: number; type?: OscillatorType }): void {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + (opts.at ?? 0);
  const o = c.createOscillator();
  o.type = opts.type ?? 'sine';
  o.frequency.setValueAtTime(opts.from, t);
  if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(opts.gain * settings.volume, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + opts.dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + opts.dur + 0.02);
}

export const sfx = {
  click: () => tone({ dur: 0.05, gain: 0.08, from: 900, to: 500, type: 'square' }),
  dice: (count = 1) => {
    for (let i = 0; i < 4 + count * 2; i++) {
      burst({ at: i * (0.05 + Math.random() * 0.05), dur: 0.035, gain: 0.3 - i * 0.015, freq: 2400 + Math.random() * 1800, q: 4 });
    }
  },
  move: () => burst({ dur: 0.1, gain: 0.08, freq: 500, q: 0.7, type: 'lowpass' }),
  shot: (heavy: boolean) => {
    burst({ dur: heavy ? 0.28 : 0.14, gain: heavy ? 0.7 : 0.45, freq: heavy ? 700 : 1500, q: 0.6 });
    tone({ dur: 0.12, gain: 0.3, from: heavy ? 160 : 240, to: 50, type: 'triangle' });
  },
  melee: () => burst({ dur: 0.12, gain: 0.4, freq: 3200, q: 2 }),
  hit: () => tone({ dur: 0.1, gain: 0.25, from: 220, to: 70, type: 'sawtooth' }),
  blast: () => {
    burst({ dur: 0.7, gain: 0.8, freq: 260, q: 0.5, type: 'lowpass' });
    tone({ dur: 0.5, gain: 0.5, from: 110, to: 30, type: 'sine' });
  },
  hack: () => {
    for (let i = 0; i < 5; i++) tone({ at: i * 0.05, dur: 0.04, gain: 0.08, from: 700 + Math.random() * 1500, type: 'square' });
  },
  heal: () => {
    tone({ dur: 0.14, gain: 0.12, from: 520 });
    tone({ at: 0.1, dur: 0.2, gain: 0.12, from: 780 });
  },
  turn: () => tone({ dur: 0.18, gain: 0.1, from: 330, to: 440, type: 'triangle' }),
  down: () => tone({ dur: 0.45, gain: 0.25, from: 180, to: 40, type: 'sawtooth' }),
  win: () => [392, 494, 587, 784].forEach((f, i) => tone({ at: i * 0.13, dur: 0.3, gain: 0.14, from: f, type: 'triangle' })),
};
