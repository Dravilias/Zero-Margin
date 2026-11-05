import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/engine/ai';
import { FACTION_IDS, RULESETS, defaultRoster, rosterCost } from '../src/engine/data';
import { applyAction, createGame, hitChance, previewAttack, reachable, stoppable, unitById } from '../src/engine/game';
import { generateMap, los } from '../src/engine/map';
import { Rand } from '../src/engine/rng';
import type { AiLevel, FactionId, GameConfig, GameState, MapSize, RulesetId, ScenarioId, ThemeId } from '../src/engine/types';

function config(o: Partial<GameConfig> & { factions?: FactionId[]; levels?: AiLevel[] } = {}): GameConfig {
  const factions = o.factions ?? ['union', 'meridian'];
  const points = o.points ?? 100;
  return {
    seed: o.seed ?? 1,
    scenario: o.scenario ?? 'flatline',
    ruleset: o.ruleset ?? 'standard',
    mapSize: o.mapSize ?? 'small',
    theme: o.theme ?? 'docks',
    maxRounds: o.maxRounds ?? 8,
    points,
    sides: factions.map((faction, i) => ({
      name: `Side ${i}`, faction, team: i, control: 'ai', aiLevel: o.levels?.[i] ?? 'normal', roster: defaultRoster(faction, points),
    })),
  };
}

export function playOut(cfg: GameConfig): { state: GameState; actions: number } {
  let s = createGame(cfg);
  const rnd = new Rand(cfg.seed + 99);
  let actions = 0;
  while (s.phase !== 'over') {
    const side = s.activeSide;
    const action = chooseAction(s, side, cfg.sides[side].aiLevel, rnd);
    const res = applyAction(s, action, side);
    if (!res.ok) throw new Error(`AI chose an illegal action ${JSON.stringify(action)}: ${res.error}`);
    s = res.state;
    actions += 1;
    if (actions > 5000) throw new Error('game did not finish');
  }
  return { state: s, actions };
}

describe('dice', () => {
  it('computes hit chance consistently with the rules', () => {
    expect(hitChance(RULESETS.quick, 10, 15)).toBeCloseTo(0.6);
    expect(hitChance(RULESETS.quick, 30, 15)).toBeCloseTo(0.9); // natural 1 always misses
    expect(hitChance(RULESETS.quick, 0, 99)).toBeCloseTo(0.1); // natural 10 always hits
    expect(hitChance(RULESETS.standard, 0, 99)).toBeCloseTo(0); // exploding rules have no auto-hit
    expect(hitChance(RULESETS.standard, 10, 25)).toBeCloseTo(0.06);
  });
});

describe('squads', () => {
  it('builds default squads that fit their budget', () => {
    for (const f of FACTION_IDS) {
      for (const pts of [75, 100, 150]) {
        const roster = defaultRoster(f, pts);
        expect(roster.length).toBeGreaterThanOrEqual(3);
        expect(rosterCost(f, roster)).toBeLessThanOrEqual(pts);
      }
    }
  });
});

describe('maps', () => {
  it('is deterministic and has a symmetric layout', () => {
    const a = generateMap(42, 'medium', 'market', 2, 'flatline');
    const b = generateMap(42, 'medium', 'market', 2, 'flatline');
    expect(a.tiles).toBe(b.tiles);
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        const c = a.tiles[y * a.w + x];
        const mirror = a.tiles[y * a.w + (a.w - 1 - x)];
        expect(c === '#').toBe(mirror === '#');
      }
    }
  });

  it('generates a valid board for every combination', () => {
    const sizes: MapSize[] = ['small', 'medium', 'large'];
    const themes: ThemeId[] = ['docks', 'market', 'plaza'];
    const scenarios: ScenarioId[] = ['flatline', 'terminals', 'heist'];
    for (const size of sizes) for (const theme of themes) for (const scenario of scenarios) for (const sides of [2, 3, 4]) {
      for (let seed = 1; seed <= 5; seed++) {
        const m = generateMap(seed, size, theme, sides, scenario);
        expect(m.tiles.length).toBe(m.w * m.h);
        expect(m.zones.length).toBe(sides);
      }
    }
  });

  it('walls block line of sight', () => {
    const m = { id: 'wall-test', w: 5, h: 1, tiles: '..#..', theme: 'docks', zones: [], terminals: [], core: null } as Parameters<typeof los>[0];
    expect(los(m, null, 0, 0, 1, 0).visible).toBe(true);
    expect(los(m, null, 0, 0, 4, 0).visible).toBe(false);
  });
});

describe('rules', () => {
  it('rejects a move outside the reachable set and acts on the right side only', () => {
    let s = createGame(config());
    s = applyAction(s, { type: 'ready' }, 0).state;
    s = applyAction(s, { type: 'ready' }, 1).state;
    expect(s.phase).toBe('battle');
    const wrong = s.activeSide === 0 ? 1 : 0;
    const unit = s.units.find((u) => u.side === s.activeSide)!;
    expect(applyAction(s, { type: 'select', unitId: unit.id }, wrong).ok).toBe(false);
    const selected = applyAction(s, { type: 'select', unitId: unit.id }, s.activeSide);
    expect(selected.ok).toBe(true);
    expect(applyAction(selected.state, { type: 'move', x: 999, y: 999 }, s.activeSide).ok).toBe(false);
  });

  it('never mutates the input state', () => {
    let s = createGame(config());
    s = applyAction(s, { type: 'ready' }, 0).state;
    s = applyAction(s, { type: 'ready' }, 1).state;
    const before = JSON.stringify(s);
    const unit = s.units.find((u) => u.side === s.activeSide)!;
    applyAction(s, { type: 'select', unitId: unit.id }, s.activeSide);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('spends an action on a move and moves the unit there', () => {
    let s = createGame(config());
    s = applyAction(s, { type: 'ready' }, 0).state;
    s = applyAction(s, { type: 'ready' }, 1).state;
    const unit = s.units.find((u) => u.side === s.activeSide)!;
    s = applyAction(s, { type: 'select', unitId: unit.id }, s.activeSide).state;
    const k = stoppable(s, unit, reachable(s, unit))[0];
    const x = k % s.map.w;
    const y = Math.floor(k / s.map.w);
    const res = applyAction(s, { type: 'move', x, y }, s.activeSide);
    expect(res.ok).toBe(true);
    const moved = unitById(res.state, unit.id)!;
    expect([moved.x, moved.y]).toEqual([x, y]);
    expect(moved.ap).toBe(1);
  });

  it('breaks the attack preview into modifiers that add up', () => {
    let s = createGame(config({ mapSize: 'small' }));
    const a = s.units.find((u) => u.side === 0 && u.ranged)!;
    const t = s.units.find((u) => u.side === 1)!;
    s = { ...s, units: s.units.map((u) => (u.id === a.id ? { ...u, x: 8, y: 6 } : u.id === t.id ? { ...u, x: 9, y: 6 } : u)) };
    const pv = previewAttack(s, unitById(s, a.id)!, unitById(s, t.id)!, 'ranged');
    expect(pv.ok).toBe(true);
    expect(pv.mods.reduce((n, p) => n + p.v, 0)).toBe(pv.mod);
    expect(pv.tnParts.reduce((n, p) => n + p.v, 0)).toBe(pv.tn);
  });

  it('survives a JSON round trip, which is how online games send state', () => {
    const s = createGame(config());
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('ends the game when a side concedes', () => {
    const s = createGame(config());
    const res = applyAction(s, { type: 'concede' }, 0);
    expect(res.state.phase).toBe('over');
    expect(res.state.winner).toBe(1);
  });
});

describe('full games with the computer on every seat', () => {
  const rulesets: RulesetId[] = ['quick', 'standard', 'full'];
  const scenarios: ScenarioId[] = ['flatline', 'terminals', 'heist'];

  it('finish without illegal actions for all rules and scenarios', () => {
    for (const ruleset of rulesets) for (const scenario of scenarios) {
      for (let seed = 1; seed <= 4; seed++) {
        const { state } = playOut(config({ seed, ruleset, scenario, factions: ['union', 'choir'], mapSize: 'small' }));
        expect(state.phase).toBe('over');
      }
    }
  });

  it('finish with four sides on the large board', () => {
    for (const ruleset of rulesets) {
      const { state } = playOut(config({ seed: 7, ruleset, factions: ['union', 'meridian', 'choir', 'kilnrats'], mapSize: 'large', theme: 'plaza', scenario: 'terminals' }));
      expect(state.phase).toBe('over');
    }
  });

  it('hard beats easy clearly', () => {
    let hard = 0;
    let easy = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const { state } = playOut(config({ seed, levels: seed % 2 ? ['hard', 'easy'] : ['easy', 'hard'], factions: ['meridian', 'meridian'] }));
      const hardTeam = seed % 2 ? 0 : 1;
      if (state.winner === hardTeam) hard++;
      else if (state.winner !== -1) easy++;
    }
    expect(hard).toBeGreaterThan(easy * 2);
  });
});
