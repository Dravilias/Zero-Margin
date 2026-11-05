import { describe, expect, it } from 'vitest';
import { landing } from '../src/ui/dice';

describe('dice land on the number that was rolled', () => {
  const check = (sides: 10 | 6, value: number) => {
    const { normal, up, found } = landing(sides, value);
    expect(found, `d${sides} needs exactly one face showing ${value}`).toBe(1);
    expect(normal[2], `d${sides}=${value} faces the camera`).toBeCloseTo(1, 5);
    expect(up[1], `d${sides}=${value} reads upright`).toBeCloseTo(1, 5);
  };
  it('d10, every face', () => { for (let v = 1; v <= 10; v++) check(10, v); });
  it('d6, every face', () => { for (let v = 1; v <= 6; v++) check(6, v); });
});
