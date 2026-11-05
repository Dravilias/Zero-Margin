import { defaultRoster, rosterCost } from '../engine/data';
import type { AiLevel, FactionId, GameConfig, Loadout, MapSize, RulesetId, ScenarioId, ThemeId } from '../engine/types';

export type SeatKind = 'human' | 'ai' | 'open' | 'closed';

export interface Seat {
  kind: SeatKind;
  name: string;
  /** Relay id of a friend in this seat; null means the player is on this PC (the host's PC when online). */
  peer: string | null;
  faction: FactionId;
  team: number;
  aiLevel: AiLevel;
  roster: Loadout[];
  ready: boolean;
}

export interface TableSettings {
  scenario: ScenarioId;
  ruleset: RulesetId;
  mapSize: MapSize;
  theme: ThemeId;
  seed: number;
  points: number;
  maxRounds: number;
}

export interface Table {
  settings: TableSettings;
  seats: Seat[];
  code: string | null;
}

const SEAT_FACTIONS: FactionId[] = ['union', 'meridian', 'choir', 'kilnrats'];
export const POINT_OPTIONS = [75, 100, 150];
export const ROUND_OPTIONS = [6, 8, 10, 12];
export const SIZE_OPTIONS: MapSize[] = ['small', 'medium', 'large'];
export const THEME_OPTIONS: ThemeId[] = ['docks', 'market', 'plaza'];
export const SCENARIO_OPTIONS: ScenarioId[] = ['flatline', 'terminals', 'heist'];
export const RULESET_OPTIONS: RulesetId[] = ['quick', 'standard', 'full'];
export const AI_OPTIONS: AiLevel[] = ['easy', 'normal', 'hard'];

export const randomSeed = (): number => Math.floor(Math.random() * 0x7fffffff);

export function newTable(myName: string, online: boolean): Table {
  const points = 100;
  const seats: Seat[] = SEAT_FACTIONS.map((faction, i) => ({
    kind: i === 0 ? 'human' : i === 1 ? (online ? 'open' : 'ai') : 'closed',
    name: i === 0 ? myName : '',
    peer: null,
    faction,
    team: i,
    aiLevel: 'normal',
    roster: defaultRoster(faction, points),
    ready: i === 0 || !online,
  }));
  return {
    settings: { scenario: 'flatline', ruleset: 'standard', mapSize: 'medium', theme: 'docks', seed: randomSeed(), points, maxRounds: 8 },
    seats,
    code: null,
  };
}

export const activeSeats = (t: Table): Seat[] => t.seats.filter((s) => s.kind !== 'closed');

/** Reasons the table cannot start yet, as translation keys. */
export function startProblems(t: Table): string[] {
  const out: string[] = [];
  const seats = activeSeats(t);
  if (seats.length < 2) out.push('table.problem.fewSeats');
  if (new Set(seats.map((s) => s.team)).size < 2) out.push('table.problem.oneTeam');
  if (seats.some((s) => s.kind === 'open')) out.push('table.problem.openSeat');
  if (seats.some((s) => s.kind === 'human' && s.peer && !s.ready)) out.push('table.problem.notReady');
  for (const s of seats) {
    if (s.roster.length === 0) out.push('table.problem.emptySquad');
    else if (rosterCost(s.faction, s.roster) > t.settings.points) out.push('table.problem.overBudget');
  }
  return [...new Set(out)];
}

/** Builds the engine config. Side indexes follow the order of the active seats. */
export function tableToConfig(t: Table): { cfg: GameConfig; seatOfSide: number[] } {
  const seatOfSide: number[] = [];
  const sides = t.seats.flatMap((s, i) => {
    if (s.kind === 'closed') return [];
    seatOfSide.push(i);
    return [{
      name: s.kind === 'ai' ? '' : s.name,
      faction: s.faction,
      team: s.team,
      control: s.kind === 'ai' ? ('ai' as const) : ('human' as const),
      aiLevel: s.aiLevel,
      roster: s.roster,
    }];
  });
  return {
    seatOfSide,
    cfg: {
      seed: t.settings.seed,
      scenario: t.settings.scenario,
      ruleset: t.settings.ruleset,
      mapSize: t.settings.mapSize,
      theme: t.settings.theme,
      maxRounds: t.settings.scenario === 'heist' ? Math.max(t.settings.maxRounds, 10) : t.settings.maxRounds,
      points: t.settings.points,
      sides,
    },
  };
}
