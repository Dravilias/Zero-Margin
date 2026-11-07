import { describe, expect, it } from 'vitest';
import { scheduleStep } from '../src/ui/music';

/** Records every note instead of playing it, to check the score is sane without any audio hardware. */
function fakeAudio() {
  const notes: { freq: number; start: number; stop: number; gain: number }[] = [];
  const node = () => ({ connect: (n: unknown) => n, frequency: { value: 0 }, type: '' });
  const c = {
    createOscillator: () => {
      const o = { ...node(), start(t: number) { note.start = t; }, stop(t: number) { note.stop = t; notes.push({ ...note }); } };
      const note = { freq: 0, start: 0, stop: 0, gain: 0 };
      Object.defineProperty(o.frequency, 'value', { set(v: number) { note.freq = v; } });
      return o;
    },
    createBiquadFilter: node,
    createGain: () => ({
      ...node(),
      gain: {
        setValueAtTime() {},
        exponentialRampToValueAtTime() {},
        linearRampToValueAtTime(v: number) { lastGain = v; },
      },
    }),
  };
  let lastGain = 0;
  return { c: c as unknown as BaseAudioContext, notes, gain: () => lastGain };
}

describe('music', () => {
  for (const mood of ['menu', 'battle'] as const) {
    it(`${mood}: writes audible, in-range notes in order across a long stretch`, () => {
      const { c, notes, gain } = fakeAudio();
      for (let step = 0; step < 512; step++) scheduleStep(c, {} as AudioNode, mood, step, step * 0.3);
      expect(notes.length).toBeGreaterThan(50);
      for (const n of notes) {
        expect(n.freq).toBeGreaterThan(20);
        expect(n.freq).toBeLessThan(5000);
        expect(n.stop).toBeGreaterThan(n.start);
      }
      expect(gain()).toBeGreaterThan(0);
      expect(gain()).toBeLessThanOrEqual(0.3);
    });
  }
});
