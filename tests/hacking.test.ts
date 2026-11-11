import { describe, expect, it } from 'vitest';
import { ROLES, makeLoadout } from '../src/engine/data';
import { ICE_STEP, applyAction, createGame, hackPreview, hackTargets, moveOf, previewAttack, unitById } from '../src/engine/game';
import type { GameConfig, GameState, MapData } from '../src/engine/types';

// A wall in the middle, with low cover in front of the hacker's corner.
const ROWS = [
  '...........',
  '.....#.....',
  '.....#.....',
  '.....#.....',
  '...........',
];
const MAP: MapData = {
  id: 'hack-test', w: 11, h: 5, tiles: ROWS.join(''), theme: 'docks',
  zones: [{ x: 0, y: 0, w: 2, h: 5 }, { x: 9, y: 0, w: 2, h: 5 }], terminals: [], core: null,
};
const WIRE = 's0u0';
const GUN = 's0u1';
const A = 's1u0';
const B = 's1u1';

function game(): GameState {
  const cfg: GameConfig = {
    seed: 1, scenario: 'flatline', ruleset: 'standard', mapSize: 'small', theme: 'docks', maxRounds: 8, points: 100,
    sides: [
      { name: '', faction: 'union', team: 0, control: 'human', aiLevel: 'easy', roster: [makeLoadout('wire', 'pistol', 'shiv'), makeLoadout('breaker', 'rifle', 'shiv')] },
      { name: '', faction: 'union', team: 1, control: 'human', aiLevel: 'easy', roster: [makeLoadout('punk', 'pistol', 'shiv'), makeLoadout('punk', 'pistol', 'shiv')] },
    ],
  };
  const s = createGame(cfg, MAP);
  const at = (id: string, x: number, y: number) => { const u = unitById(s, id)!; u.x = x; u.y = y; };
  at(WIRE, 3, 4);
  at(GUN, 3, 0);
  at(A, 8, 2);
  at(B, 8, 4);
  s.phase = 'battle';
  s.round = 1;
  s.ready = [true, true];
  s.order = [0, 1];
  s.turnIdx = 0;
  s.activeSide = 0;
  return s;
}

describe('hacking counterplay', () => {
  it('reaches through walls and smoke, like a hack should', () => {
    const s = game();
    const wire = unitById(s, WIRE)!;
    s.smoke = [{ x: 6, y: 4, until: 9 }];
    expect(hackTargets(s, wire, 'glitch').map((v) => v.id).sort()).toEqual([A, B]);
  });

  it('makes a target harder to hack again after each program lands, until the next round', () => {
    let s = game();
    const before = hackPreview(s, unitById(s, WIRE)!, 'glitch', B).tn;
    for (let rng = 1; ; rng++) {
      const t = game();
      t.rng = rng;
      let r = applyAction(t, { type: 'select', unitId: WIRE }, 0);
      r = applyAction(r.state, { type: 'hack', program: 'glitch', targetId: B }, 0);
      expect(r.ok, r.error).toBe(true);
      if (r.events.some((e) => e.t === 'traced')) { s = r.state; break; }
      if (rng > 200) throw new Error('no hack ever landed');
    }
    expect(unitById(s, B)!.iced).toBe(1);
    expect(hackPreview(s, unitById(s, WIRE)!, 'glitch', B).tn).toBe(before + ICE_STEP);
    expect(unitById(s, WIRE)!.traced).toBe(true);
  });

  it('lets a traced hacker be shot with its cover counting for less', () => {
    const s = game();
    const wire = unitById(s, WIRE)!;
    const gun = unitById(s, B)!;
    gun.x = 8; gun.y = 4;
    s.map = { ...s.map, tiles: s.map.tiles.slice(0, 4 * 11 + 4) + 'c' + s.map.tiles.slice(4 * 11 + 5) };
    s.activeSide = 1;
    const plain = previewAttack(s, gun, wire, 'ranged', { hypothetical: true });
    expect(plain.cover).toBeGreaterThan(0);
    wire.traced = true;
    const traced = previewAttack(s, gun, wire, 'ranged', { hypothetical: true });
    expect(traced.tn).toBe(plain.tn - 2);
  });
});

describe('backlash loop', () => {
  function failedHack(rez: number) {
    for (let rng = 1; rng < 400; rng++) {
      const t = game();
      t.rng = rng;
      unitById(t, B)!.chrome = ['backlash'];
      unitById(t, WIRE)!.rez = rez;
      let r = applyAction(t, { type: 'select', unitId: WIRE }, 0);
      r = applyAction(r.state, { type: 'hack', program: 'glitch', targetId: B }, 0);
      const hack = r.events.find((e) => e.t === 'hack');
      if (hack && hack.t === 'hack' && !hack.ok) return r;
    }
    throw new Error('no hack ever failed');
  }

  it('hurts a hacker whose hack fails against it', () => {
    const r = failedHack(0);
    const hit = r.events.find((e) => e.t === 'backlash');
    expect(hit && hit.t === 'backlash' && hit.dealt).toBeGreaterThan(0);
    expect(unitById(r.state, WIRE)!.hp).toBeLessThan(unitById(game(), WIRE)!.hp);
  });

  it('is soaked by a Wire’s own defences first', () => {
    const r = failedHack(1);
    expect(r.events.some((e) => e.t === 'backlash')).toBe(false);
    expect(unitById(r.state, WIRE)!.rez).toBe(0);
  });
});

describe('faction objective rules', () => {
  it('lets Meridian take the data core without spending an action', () => {
    for (const faction of ['meridian', 'union'] as const) {
      const s = game();
      const u = unitById(s, WIRE)!;
      u.faction = faction;
      s.core = { x: u.x + 1, y: u.y, carrier: null };
      let r = applyAction(s, { type: 'select', unitId: WIRE }, 0);
      const ap = unitById(r.state, WIRE)!.ap;
      r = applyAction(r.state, { type: 'grab' }, 0);
      expect(r.ok, r.error).toBe(true);
      expect(unitById(r.state, WIRE)!.ap).toBe(faction === 'meridian' ? ap : ap - 1);
    }
  });

  it('slows Kilnrats more than others while they carry the core', () => {
    const s = game();
    const u = unitById(s, WIRE)!;
    s.core = { x: u.x, y: u.y, carrier: u.id };
    const normal = moveOf(s, u);
    u.faction = 'kilnrats';
    expect(moveOf(s, u)).toBe(normal - 1);
  });
});

describe('aim and firearms', () => {
  it('keep every role’s base chance to hit the same as before the split', () => {
    const before: Record<string, number> = { breaker: 10, razor: 4, longeye: 12, wire: 6, patcher: 8, wrench: 8, sapper: 9, punk: 7 };
    for (const [role, total] of Object.entries(before)) {
      const r = ROLES[role as keyof typeof ROLES];
      expect(r.stats.aim + Math.floor(r.skills.firearms / 2), role).toBe(total);
    }
  });

  it('use firearms training to offset the penalty for a burst, where aim does not', () => {
    const s = game();
    const gun = unitById(s, GUN)!;
    const target = unitById(s, B)!;
    gun.x = 3; gun.y = 4;
    unitById(s, WIRE)!.y = 0;
    target.x = 6;
    const single = previewAttack(s, gun, target, 'ranged', { hypothetical: true });
    const burst = previewAttack(s, gun, target, 'ranged', { hypothetical: true, mode: 'burst' });
    expect(burst.mods.find((m) => m.k === 'handling')?.v).toBe(1);
    expect(burst.mod).toBe(single.mod);
    gun.skills.firearms = 0;
    expect(previewAttack(s, gun, target, 'ranged', { hypothetical: true, mode: 'burst' }).mod).toBeLessThan(previewAttack(s, gun, target, 'ranged', { hypothetical: true }).mod);
  });
});
