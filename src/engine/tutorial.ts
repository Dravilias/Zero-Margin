import { makeLoadout } from './data';
import { createGame, unitById, unitOptions } from './game';
import type { Action, GameConfig, GameState, MapData } from './types';

/*
 * The guided first battle. The player's moves are fixed step by step and the dice seed is chosen so
 * the lesson always plays out the same way, right up to the free-play ending. tests/tutorial.test.ts
 * checks every number the lesson text quotes, so a rules change can't silently make the text wrong.
 */

const ROWS = [
  '.....##......',
  '.....##...c..',
  '.........##..',
  '......c..##..',
  '.......c.....',
  '.....c.......',
  '.............',
  '..c.....##...',
  '........##...',
];

export const TUTORIAL_MAP: MapData = {
  id: 'tutorial-v1',
  w: 13,
  h: 9,
  tiles: ROWS.join(''),
  theme: 'docks',
  zones: [{ x: 0, y: 0, w: 4, h: 9 }, { x: 9, y: 0, w: 4, h: 9 }],
  terminals: [],
  core: null,
};

export const RIVET = 's0u0';
export const ANCHOR = 's0u1';
export const SOOT = 's1u0';
export const CLINKER = 's1u1';

const COVER_SQUARE: [number, number] = [4, 5];
const CLOSE_SQUARE: [number, number] = [5, 3];
const CLINKER_OUT: [number, number] = [10, 5];

/** Found by scripts/find-tutorial-seed.ts: Rivet hits, cover makes Soot miss, Anchor kills, you win initiative, Clinker hits. */
export const TUTORIAL_RNG = 102;

export function createTutorialGame(rng = TUTORIAL_RNG): GameState {
  const cfg: GameConfig = {
    seed: 1,
    scenario: 'flatline',
    ruleset: 'quick',
    mapSize: 'small',
    theme: 'docks',
    maxRounds: 12,
    points: 100,
    sides: [
      {
        name: '', faction: 'union', team: 0, control: 'human', aiLevel: 'easy',
        roster: [
          { ...makeLoadout('breaker', 'rifle', 'shiv'), name: 'Rivet' },
          { ...makeLoadout('breaker', 'smg', 'shiv'), name: 'Anchor' },
        ],
      },
      {
        name: '', faction: 'meridian', team: 1, control: 'ai', aiLevel: 'easy',
        roster: [
          { ...makeLoadout('punk', 'pistol', 'shiv'), name: 'Soot' },
          { ...makeLoadout('punk', 'pistol', 'shiv'), name: 'Clinker' },
        ],
      },
    ],
  };
  const s = createGame(cfg, TUTORIAL_MAP);
  const place = (id: string, x: number, y: number) => {
    const u = unitById(s, id)!;
    u.x = x;
    u.y = y;
  };
  place(RIVET, 1, 6);
  place(ANCHOR, 3, 2);
  place(SOOT, 8, 5);
  place(CLINKER, 11, 2);
  // Skip deployment and the first initiative roll, so the lesson opens on the player's turn.
  s.phase = 'battle';
  s.round = 1;
  s.ready = [true, true];
  s.order = [0, 1];
  s.turnIdx = 0;
  s.activeSide = 0;
  s.rng = rng;
  return s;
}

export interface TutorialSpot {
  unit?: string;
  tile?: [number, number];
  button?: 'aim' | 'end';
  panel?: 'preview' | 'dice' | 'roster' | 'log' | 'scores';
}

export interface TutorialStep {
  /** Text comes from the translation keys tutorial.step.<id>.title and .text */
  id: string;
  /** info: read and continue. do: one exact action. hover: point at a unit. enemy: watch. free: play on. */
  kind: 'info' | 'do' | 'hover' | 'enemy' | 'free';
  spot?: TutorialSpot;
  /** Keep this enemy's odds on the panel even when the mouse moves away. */
  pin?: string;
  action?: Action;
  unit?: string;
  script?: Action[];
  done?: (s: GameState) => boolean;
}

const backToPlayer = (s: GameState) => s.activeUnit === null && s.activeSide === 0;

export const TUTORIAL_STEPS: TutorialStep[] = [
  { id: 'welcome', kind: 'info' },
  { id: 'crew', kind: 'info', spot: { panel: 'roster' } },
  {
    id: 'activate', kind: 'do', spot: { unit: RIVET },
    action: { type: 'select', unitId: RIVET },
    done: (s) => s.activeUnit === RIVET,
  },
  {
    id: 'move', kind: 'do', spot: { tile: COVER_SQUARE },
    action: { type: 'move', x: COVER_SQUARE[0], y: COVER_SQUARE[1] },
    done: (s) => unitById(s, RIVET)!.x === COVER_SQUARE[0] && unitById(s, RIVET)!.y === COVER_SQUARE[1],
  },
  { id: 'cover', kind: 'info', spot: { unit: RIVET } },
  { id: 'hover', kind: 'hover', spot: { unit: SOOT }, unit: SOOT },
  { id: 'odds', kind: 'info', spot: { panel: 'preview' }, pin: SOOT },
  {
    id: 'shoot', kind: 'do', spot: { unit: SOOT }, pin: SOOT,
    action: { type: 'shoot', targetId: SOOT },
    done: (s) => unitById(s, RIVET)!.attacks > 0,
  },
  { id: 'hit', kind: 'info', spot: { panel: 'dice' } },
  {
    id: 'enemy1', kind: 'enemy',
    script: [{ type: 'select', unitId: SOOT }, { type: 'shoot', targetId: RIVET }, { type: 'end' }],
    done: backToPlayer,
  },
  { id: 'missed', kind: 'info', spot: { panel: 'log' } },
  {
    id: 'activate2', kind: 'do', spot: { unit: ANCHOR },
    action: { type: 'select', unitId: ANCHOR },
    done: (s) => s.activeUnit === ANCHOR,
  },
  { id: 'hover2', kind: 'hover', spot: { unit: SOOT }, unit: SOOT },
  {
    id: 'aim', kind: 'do', spot: { button: 'aim' }, pin: SOOT,
    action: { type: 'aim' },
    done: (s) => unitById(s, ANCHOR)!.aiming > 0,
  },
  {
    id: 'shoot2', kind: 'do', spot: { unit: SOOT }, pin: SOOT,
    action: { type: 'shoot', targetId: SOOT },
    done: (s) => unitById(s, ANCHOR)!.attacks > 0,
  },
  { id: 'kill', kind: 'info', spot: { panel: 'scores' } },
  {
    id: 'enemy2', kind: 'enemy',
    script: [{ type: 'select', unitId: CLINKER }, { type: 'brace' }, { type: 'end' }],
    done: backToPlayer,
  },
  { id: 'round2', kind: 'info' },
  {
    id: 'activate3', kind: 'do', spot: { unit: ANCHOR },
    action: { type: 'select', unitId: ANCHOR },
    done: (s) => s.activeUnit === ANCHOR,
  },
  {
    id: 'closein', kind: 'do', spot: { tile: CLOSE_SQUARE },
    action: { type: 'move', x: CLOSE_SQUARE[0], y: CLOSE_SQUARE[1] },
    done: (s) => unitById(s, ANCHOR)!.x === CLOSE_SQUARE[0] && unitById(s, ANCHOR)!.y === CLOSE_SQUARE[1],
  },
  {
    id: 'end', kind: 'do', spot: { button: 'end' },
    action: { type: 'end' },
    done: (s) => s.activeUnit === null,
  },
  {
    id: 'enemy3', kind: 'enemy',
    script: [
      { type: 'select', unitId: CLINKER },
      { type: 'move', x: CLINKER_OUT[0], y: CLINKER_OUT[1] },
      { type: 'shoot', targetId: ANCHOR },
    ],
    done: backToPlayer,
  },
  { id: 'hurt', kind: 'info', spot: { unit: ANCHOR } },
  { id: 'free', kind: 'free' },
];

/** Whether two actions are the same move. Interface code may add undefined option fields. */
export function sameAction(a: Action, b: Action): boolean {
  if (a.type !== b.type) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of ['unitId', 'targetId', 'x', 'y']) if (x[k] !== y[k]) return false;
  return true;
}

/*
 * The second lesson: a whole fight under Standard Contract rules, with a hint for whatever the
 * active operator can do that the player hasn't tried yet. Nothing here is scripted, so it needs
 * no dice seed: the hint is worked out from the state of the game.
 */

export const PRACTICE_SKILLS = ['overwatch', 'burst', 'grenade', 'charge', 'hack', 'patch'] as const;
export type PracticeSkill = typeof PRACTICE_SKILLS[number];
export type PracticeTip = PracticeSkill | 'deploy' | 'wait' | 'pick' | 'reload' | 'melee' | 'act' | 'over';

export function createPracticeGame(seed = 31): GameState {
  return createGame({
    seed,
    scenario: 'flatline',
    ruleset: 'standard',
    mapSize: 'small',
    theme: 'docks',
    maxRounds: 12,
    points: 100,
    sides: [
      {
        name: '', faction: 'union', team: 0, control: 'human', aiLevel: 'easy',
        roster: [
          { ...makeLoadout('breaker', 'rifle', 'hammer'), name: 'Rivet' },
          { ...makeLoadout('sapper', 'shotgun', 'shiv', [], { frag: 3, smoke: 1 }), name: 'Fuse' },
          { ...makeLoadout('razor', 'pistol', 'monoblade'), name: 'Anchor' },
          { ...makeLoadout('wire', 'smg', 'shiv'), name: 'Static' },
          { ...makeLoadout('patcher', 'pistol', 'shiv'), name: 'Gauze' },
        ],
      },
      {
        name: '', faction: 'meridian', team: 1, control: 'ai', aiLevel: 'easy',
        roster: [
          { ...makeLoadout('punk', 'pistol', 'shiv'), name: 'Soot' },
          { ...makeLoadout('punk', 'pistol', 'shiv'), name: 'Clinker' },
          { ...makeLoadout('punk', 'smg', 'shiv'), name: 'Slag' },
          { ...makeLoadout('punk', 'pistol', 'hammer'), name: 'Cinder' },
        ],
      },
    ],
  });
}

/** Which of the practised skills an action counts as, if any. */
export function practiceSkill(a: Action): PracticeSkill | null {
  switch (a.type) {
    case 'overwatch': case 'charge': case 'hack': case 'patch': return a.type;
    case 'grenade': return 'grenade';
    case 'shoot': return a.mode === 'burst' ? 'burst' : null;
    default: return null;
  }
}

/** The hint to show right now: the first thing the active operator can do that hasn't been tried. */
export function practiceTip(s: GameState, tried: ReadonlySet<string>): PracticeTip {
  if (s.phase === 'over') return 'over';
  if (s.phase === 'deploy') return s.ready[0] ? 'wait' : 'deploy';
  if (s.activeSide !== 0) return 'wait';
  const u = s.activeUnit ? unitById(s, s.activeUnit) : null;
  if (!u) return 'pick';
  const o = unitOptions(s, u);
  const fresh = (k: PracticeSkill) => !tried.has(k);
  if (o.reload && u.ammo === 0) return 'reload';
  if (o.patch && fresh('patch')) return 'patch';
  if (o.charge && fresh('charge')) return 'charge';
  if (o.grenades.includes('frag') && o.shoot && fresh('grenade')) return 'grenade';
  if (o.programs.some((p) => p !== 'terminal') && fresh('hack')) return 'hack';
  if (o.burst && o.shoot && fresh('burst')) return 'burst';
  if (o.overwatch && !o.shoot && !o.melee && fresh('overwatch')) return 'overwatch';
  if (o.melee) return 'melee';
  return 'act';
}
