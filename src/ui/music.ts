/* Original background music, synthesized live like the rest of the game's sound, so it ships no audio files. */

export type MusicMood = 'menu' | 'battle';

/** Semitones from A, one chord for each bar. */
const SCORES: Record<MusicMood, { bpm: number; chords: number[][]; melody: (number | null)[]; bass: (number | null)[]; pad: number; pulse: number }> = {
  menu: {
    bpm: 76,
    chords: [[0, 3, 7], [-4, 0, 3], [-7, -3, 0], [-2, 2, 5], [0, 3, 7], [-4, 0, 3], [5, 8, 12], [-2, 2, 7]],
    // A slow tune over eight bars of eight notes each, with plenty of room between phrases.
    melody: [
      12, null, null, 15, null, 14, 12, null,
      8, null, null, null, 10, null, null, null,
      7, null, 12, null, 10, null, 7, null,
      5, null, null, null, 2, null, null, null,
      12, null, null, 15, null, 19, 17, null,
      15, null, 12, null, null, 8, null, null,
      17, null, 15, null, 12, null, 8, null,
      10, null, null, 7, null, null, null, null,
    ],
    bass: [0, null, null, null, 0, null, null, null],
    pad: 0.11,
    pulse: 0,
  },
  battle: {
    bpm: 92,
    chords: [[0, 3, 7], [0, 3, 7], [-4, 0, 3], [-2, 2, 5]],
    melody: [
      null, null, null, null, null, null, null, null,
      null, null, 12, null, null, 10, null, null,
      null, null, null, null, null, null, null, null,
      null, null, 7, null, 10, null, null, null,
    ],
    bass: [0, null, 0, null, null, 0, null, 0],
    pad: 0.06,
    pulse: 0.05,
  },
};

const ROOT_HZ = 110;
const hz = (semitones: number, octave = 0) => ROOT_HZ * 2 ** (semitones / 12 + octave);
const STEPS_PER_BAR = 8;
const LOOKAHEAD_S = 0.4;
const FADE_S = 1.5;
const LEVEL = 0.5;

/** Writes one step of the score. Separate from the timer, so it can be checked without any real audio. */
export function scheduleStep(c: BaseAudioContext, out: AudioNode, mood: MusicMood, step: number, at: number): void {
  const score = SCORES[mood];
  const stepLen = 60 / score.bpm / 2;
  const barLen = stepLen * STEPS_PER_BAR;
  const inBar = step % STEPS_PER_BAR;
  const chord = score.chords[Math.floor(step / STEPS_PER_BAR) % score.chords.length];

  const tone = (type: OscillatorType, freq: number, start: number, dur: number, gain: number, cutoff: number, attack = 0.01) => {
    const osc = c.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(gain, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(filter).connect(g).connect(out);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  };

  if (inBar === 0) {
    for (const note of chord) {
      // Two slightly detuned voices make the chord sound wide instead of thin.
      tone('sawtooth', hz(note) * 0.997, at, barLen * 1.1, score.pad, 700, 0.6);
      tone('sawtooth', hz(note) * 1.003, at, barLen * 1.1, score.pad, 700, 0.6);
    }
  }
  const bass = score.bass[inBar];
  if (bass !== null) tone('triangle', hz(chord[0] + bass, -1), at, stepLen * 1.8, 0.3, 500);
  if (score.pulse && inBar % 2 === 0) tone('square', hz(chord[inBar % 4 === 0 ? 0 : 2], 1), at, stepLen * 0.5, score.pulse, 1200);
  const melody = score.melody[step % score.melody.length];
  if (melody !== null) tone('triangle', hz(melody, 1), at, stepLen * 3, 0.14, 2400, 0.02);
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let track: GainNode | null = null;
let mood: MusicMood | null = null;
let step = 0;
let nextAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let volume = 0.5;

function pump(): void {
  if (!ctx || !track || !mood || ctx.state !== 'running' || volume <= 0) return;
  // Picks up cleanly after the audio was held up, instead of playing everything it missed at once.
  if (nextAt < ctx.currentTime) nextAt = ctx.currentTime + 0.05;
  const stepLen = 60 / SCORES[mood].bpm / 2;
  while (nextAt < ctx.currentTime + LOOKAHEAD_S) {
    scheduleStep(ctx, track, mood, step, nextAt);
    step += 1;
    nextAt += stepLen;
  }
}

function fadeOut(g: GainNode): void {
  if (!ctx) return;
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + FADE_S);
  setTimeout(() => g.disconnect(), (FADE_S + 0.5) * 1000);
}

/** Browsers hold sound back until the player has touched the page, so this tries again on the first input. */
function wake(): void {
  void ctx?.resume();
}

export function playMusic(next: MusicMood): void {
  if (mood === next) return;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume * LEVEL;
      master.connect(ctx.destination);
      window.addEventListener('pointerdown', wake);
      window.addEventListener('keydown', wake);
    }
    wake();
    if (track) fadeOut(track);
    mood = next;
    step = 0;
    nextAt = 0;
    track = ctx.createGain();
    track.gain.setValueAtTime(0.0001, ctx.currentTime);
    track.gain.exponentialRampToValueAtTime(1, ctx.currentTime + FADE_S);
    track.connect(master!);
    timer ??= setInterval(pump, 120);
    pump();
  } catch { /* the game works fine without music */ }
}

export function setMusicVolume(value: number): void {
  volume = value;
  if (ctx && master) master.gain.setTargetAtTime(value * LEVEL, ctx.currentTime, 0.05);
}
