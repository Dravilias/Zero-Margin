import { CHROME_COST, GRENADE_COST, RECRUITABLE, ROLES, WEAPONS, defaultRoster, makeLoadout, rosterCost } from './data';
import { createGame } from './game';
import { Rand } from './rng';
import type {
  AiLevel, ChromeId, FactionId, InjuryId, GameConfig, GameState, GrenadeKind, Grenades, Loadout, MapSize, RoleId, RulesetId, ScenarioId,
  Skills, Stats, ThemeId, UnitBonus, WeaponId,
} from './types';

/*
 * The campaign is a pure reducer, like the battle rules: host-authoritative, JSON-safe, with its dice inside the state.
 * Stories are data (an Arc), so a hand-written one, a generated one and one written by a language model all run the same way.
 */

/** Text shown to players: a translation key, a literal string, or a key with values to fill in. Value strings may be keys too. */
export type Txt = string | { k: string; v: Record<string, string | number> };

export interface ArcChoice {
  id: string;
  label: Txt;
  result?: Txt;
  flag?: string;
  cash?: number;
  rep?: number;
  /** Makes the next job harder (positive) or easier (negative). */
  threat?: number;
  needCash?: number;
  needFlag?: string;
  /** Node to go to; the following node when left out; END finishes the story. */
  next?: string;
}

export interface GigSpec {
  title: Txt;
  brief: Txt;
  scenario: ScenarioId;
  enemy: FactionId;
  theme: ThemeId;
  threat: number;
  pay: number;
  won: Txt;
  lost: Txt;
}

export type ArcNode =
  | { id: string; kind: 'scene'; chapter: number; speaker?: Txt; text: Txt; choices: ArcChoice[] }
  | { id: string; kind: 'gig'; chapter: number; gig: GigSpec; next?: string };

export interface ArcEnding { id: string; title: Txt; text: Txt; needFlag?: string }

export interface Arc {
  id: string;
  source: 'authored' | 'generated' | 'llm';
  title: Txt;
  premise: Txt;
  chapters: number;
  start: string;
  nodes: ArcNode[];
  endings: ArcEnding[];
  /** Characters and tone a language-model game master must stay true to. */
  bible?: string;
}

export const END = '@end';

export type CrewStatus = 'ok' | 'wounded' | 'dead';

export interface CrewMember {
  id: number;
  name: string;
  role: RoleId;
  ranged: WeaponId | null;
  melee: WeaponId;
  chrome: ChromeId[];
  /** Weapons this person already has, which cost nothing to switch back to. */
  owned: WeaponId[];
  extra: Grenades;
  bonus: Required<Pick<UnitBonus, 'hp' | 'stats' | 'skills'>>;
  level: number;
  xp: number;
  /** Advances earned and not yet spent. */
  points: number;
  /** Which player runs this character when playing online. */
  owner: number;
  status: CrewStatus;
  humanity: number;
  humanityMax: number;
  /** Lasting injuries, carried from job to job until treated. */
  injuries: InjuryId[];
  missions: number;
  kills: number;
}

export interface Player { name: string; peer: string | null; connected: boolean }

export interface Gig extends GigSpec {
  id: string;
  mapSeed: number;
  story: boolean;
}

export interface DebriefLine { id: number; name: string; kills: number; dealt: number; outcome: CrewStatus; xp: number; levelUp: boolean }

export interface Debrief {
  won: boolean;
  title: Txt;
  text: Txt;
  pay: number;
  rep: number;
  lines: DebriefLine[];
  story: boolean;
  narration?: string;
}

export type TranscriptKind = 'narration' | 'gm' | 'free' | 'result';
export interface TranscriptLine { kind: TranscriptKind; text: Txt; from?: string; ok?: boolean }

export type CampaignPhase = 'hub' | 'scene' | 'mission' | 'debrief' | 'ending' | 'over';
export type CampaignMode = 'story' | 'endless';

export interface CampaignState {
  v: 1;
  id: string;
  mode: CampaignMode;
  ruleset: RulesetId;
  crewName: string;
  seed: number;
  rng: number;
  cash: number;
  rep: number;
  crew: CrewMember[];
  nextCrewId: number;
  players: Player[];
  /** Which player runs the enemy; null leaves it to the computer. */
  gmSlot: number | null;
  /** Whether a language model narrates. Rules and dice stay here either way. */
  llm: boolean;
  arc: Arc | null;
  arcsDone: number;
  chronicle: { title: Txt; ending: Txt }[];
  /** Patrons and stakes earlier generated stories used, so a long-running crew doesn't repeat itself. */
  used: { patrons: string[]; stakes: string[] };
  node: string | null;
  flags: string[];
  /** Rewritten scene text from the language model, by node id. */
  narration: Record<string, string>;
  transcript: TranscriptLine[];
  offers: Gig[];
  gigsDone: number;
  threatMod: number;
  freeUsed: string[];
  gmEventUsed: boolean;
  busy: boolean;
  phase: CampaignPhase;
  mission: { gig: Gig; squad: number[] } | null;
  debrief: Debrief | null;
  ending: { title: Txt; text: Txt } | null;
}

/* ---------- Prices and limits ---------- */

/** One rulebook point of gear is worth this many credits. */
export const CREDITS_PER_POINT = 50;
export const MAX_CREW = 10;
export const MAX_SQUAD = 6;
export const MAX_CHROME = 4;
export const MAX_PLAYERS = 4;
export const START_CASH = 1000;
export const REST_COST = 150;
export const MAX_FREE_PER_PLACE = 2;
export const THERAPY_COST = 300;
export const TREAT_COST = 250;
export const ROLE_MOVES: RoleId[] = ['broker', 'face', 'suit'];
const XP_PER_LEVEL = 5;

export const hireCost = (role: RoleId): number => ROLES[role].cost * CREDITS_PER_POINT;
export const weaponCost = (w: WeaponId): number => WEAPONS[w].cost * CREDITS_PER_POINT;
export const chromeCost = (c: ChromeId): number => CHROME_COST[c] * CREDITS_PER_POINT;
export const grenadeCost = (k: GrenadeKind): number => GRENADE_COST[k] * CREDITS_PER_POINT;
export const clinicCost = (m: CrewMember): number => 150 + m.level * 50;
export const xpToNext = (m: CrewMember): number => m.level * XP_PER_LEVEL;

export const STAT_KEYS: (keyof Stats)[] = ['quick', 'aim', 'grit', 'wire', 'nerve'];
export const SKILL_KEYS: (keyof Skills)[] = ['firearms', 'melee', 'evade', 'hack', 'medic', 'tech'];
export type AdvancePick = keyof Stats | keyof Skills | 'hp';
const MAX_BONUS = 3;

/** The advances that actually help this role. Hacking is no use to someone with no Wire. */
export function advancesFor(role: RoleId): AdvancePick[] {
  const r = ROLES[role];
  const stats = STAT_KEYS.filter((k) => k !== 'wire' || r.skills.hack > 0);
  const skills = SKILL_KEYS.filter((k) => r.skills[k] > 0);
  return ['hp', ...stats, ...skills];
}

export const statLine = (m: CrewMember): Stats => {
  const base = ROLES[m.role].stats;
  const out = { ...base };
  for (const k of STAT_KEYS) out[k] += m.bonus.stats[k] ?? 0;
  return out;
};

const STARTERS: RoleId[] = ['breaker', 'razor', 'patcher', 'sapper'];
const HANDLES = ['Hook', 'Sixpence', 'Low Water', 'Marrow', 'Tess', 'Ratchet', 'Pilot', 'Kowalski', 'Nine', 'Rook', 'Mercy', 'Bosun', 'Drift', 'Salt', 'Oksana', 'Tin'];

export function pickHandle(seed: number, taken: string[]): string {
  const free = HANDLES.filter((h) => !taken.includes(h));
  const pool = free.length ? free : HANDLES;
  return pool[Math.abs(seed) % pool.length];
}

export function makeCrew(id: number, role: RoleId, name: string, owner = 0, stats: Partial<Stats> = {}): CrewMember {
  const def = ROLES[role];
  const humanity = 30 + (def.stats.nerve + (stats.nerve ?? 0)) * 4;
  return {
    id, name: name.slice(0, 24), role, ranged: def.ranged[0], melee: def.melee[0], chrome: [], owned: [def.ranged[0], def.melee[0]].filter((w): w is WeaponId => !!w), extra: { frag: 0, smoke: 0, emp: 0 },
    bonus: { hp: 0, stats: { ...stats }, skills: {} }, humanity, humanityMax: humanity, injuries: [], level: 1, xp: 0, points: 0, owner, status: 'ok', missions: 0, kills: 0,
  };
}

export const starterCrew = (seed: number): { role: RoleId; name: string }[] => {
  const r = new Rand(seed);
  const taken: string[] = [];
  return STARTERS.map((role) => {
    const name = pickHandle(r.int(0, 9999), taken);
    taken.push(name);
    return { role, name };
  });
};

export interface NewCampaign {
  id: string;
  mode: CampaignMode;
  ruleset: RulesetId;
  crewName: string;
  seed: number;
  hostName: string;
  crew: { role: RoleId; name: string; stats?: Partial<Stats> }[];
  arc: Arc | null;
  llm: boolean;
  online: boolean;
  gm: 'computer' | 'local' | 'friend';
}

export function createCampaign(o: NewCampaign): CampaignState {
  const players: Player[] = [{ name: o.hostName, peer: null, connected: true }];
  if (o.gm === 'local') players.push({ name: 'GM', peer: null, connected: true });
  const s: CampaignState = {
    v: 1, id: o.id, mode: o.mode, ruleset: o.ruleset, crewName: o.crewName.slice(0, 32) || 'Berth 9', seed: o.seed, rng: (o.seed ^ 0x51ed270b) | 0,
    cash: START_CASH, rep: 0, crew: o.crew.slice(0, MAX_CREW).map((c, i) => makeCrew(i + 1, c.role, c.name, 0, c.stats)), nextCrewId: o.crew.length + 1,
    players, gmSlot: o.gm === 'local' ? 1 : null, llm: o.llm, arc: o.mode === 'story' ? o.arc : null, arcsDone: 0, chronicle: [], used: { patrons: [], stakes: [] }, node: null,
    flags: [], narration: {}, transcript: [], offers: [], gigsDone: 0, threatMod: 0, freeUsed: [], gmEventUsed: false, busy: false,
    phase: 'hub', mission: null, debrief: null, ending: null,
  };
  if (s.arc) enterNode(s, s.arc.start);
  refreshOffers(s);
  return s;
}

/* ---------- Jobs ---------- */

export const nodeOf = (s: CampaignState, id: string | null = s.node): ArcNode | null => s.arc?.nodes.find((n) => n.id === id) ?? null;
const DEFAULT_ENEMIES: FactionId[] = ['meridian', 'choir', 'kilnrats'];
const SCENARIOS: ScenarioId[] = ['flatline', 'terminals', 'heist'];
const THEMES: ThemeId[] = ['docks', 'market', 'plaza'];

export function baseThreat(s: CampaignState): number {
  const n = nodeOf(s);
  if (s.mode === 'story' && n) return n.chapter + s.arcsDone;
  return 1 + Math.floor(s.gigsDone / 2) + s.arcsDone;
}

function refreshOffers(s: CampaignState): void {
  const r = new Rand(s.rng);
  const count = s.mode === 'endless' ? 3 : 2;
  const threat = baseThreat(s);
  s.offers = Array.from({ length: count }, (_, i) => {
    const scenario = r.pick(SCENARIOS);
    const gigThreat = Math.max(1, threat + (i === 0 ? -1 : i === 1 ? 0 : 1));
    const titleN = r.int(0, 2);
    return {
      id: `o${s.gigsDone}-${i}`, story: false, mapSeed: r.int(1, 0x7ffffff), scenario, enemy: r.pick(DEFAULT_ENEMIES), theme: r.pick(THEMES),
      threat: gigThreat, pay: 350 + gigThreat * 200 + r.int(0, 4) * 25,
      title: `gigt.${scenario}.${titleN}`, brief: `gigb.${scenario}.${titleN}`, won: `gig.won.${r.int(0, 2)}`, lost: `gig.lost.${r.int(0, 2)}`,
    };
  });
  s.rng = r.state;
}

/** The job the story is waiting on, if any. */
export function storyGig(s: CampaignState): Gig | null {
  const n = nodeOf(s);
  if (!n || n.kind !== 'gig') return null;
  // The map changes each attempt, so a retry after a loss isn't the same fight.
  return { ...n.gig, id: n.id, story: true, mapSeed: (s.seed + s.gigsDone * 7919 + n.chapter * 104729) & 0x7ffffff };
}

export function availableGigs(s: CampaignState): Gig[] {
  const story = storyGig(s);
  return story ? [story, ...s.offers] : s.offers;
}

/** Lost humanity wears on the nerves; at zero, the person can snap. */
export const humanityPenalty = (m: CrewMember): number => Math.floor((m.humanityMax - m.humanity) / 20);

const crewLoadout = (m: CrewMember): Loadout => {
  const bonus = structuredClone(m.bonus);
  bonus.stats.nerve = (bonus.stats.nerve ?? 0) - humanityPenalty(m);
  return {
    name: m.name, role: m.role, ranged: m.ranged, melee: m.melee, chrome: [...m.chrome], extra: { ...m.extra }, bonus,
    rank: m.level, injuries: [...m.injuries], unstable: m.humanity <= 0,
  };
};

export const crewValue = (crew: CrewMember[]): number => rosterCost('union', crew.map(crewLoadout)) + crew.reduce((sum, m) => sum + (m.level - 1) * 4, 0);

/** What this many people are worth with no gear or experience. */
const BARE_VALUE_PER_PERSON = 22;

/**
 * Threat 1 is weaker than a fresh crew, and each step adds a little, since the computer also plays better from threat 3.
 * Enemies only catch up with part of what the crew has earned, so gear and levels really do make it stronger.
 */
export function enemyPoints(squad: CrewMember[], threat: number): number {
  const bare = squad.length * BARE_VALUE_PER_PERSON;
  const earned = Math.max(0, crewValue(squad) - bare);
  return Math.max(40, Math.round((bare + earned * 0.25) * (0.72 + 0.05 * threat)));
}

export function enemyRoster(faction: FactionId, points: number, threat: number): Loadout[] {
  const pool = defaultRoster(faction, 9999);
  const out: Loadout[] = [];
  let left = points;
  // Hard fights bring sharper people, not just more of them.
  const edge = threat >= 6 ? 2 : threat >= 4 ? 1 : 0;
  for (let i = 0; out.length < 10 && i < pool.length * 3; i++) {
    const l = structuredClone(pool[i % pool.length]);
    const cost = rosterCost(faction, [l]);
    if (cost > left) continue;
    l.rank = Math.ceil(threat / 2);
    if (edge && l.role !== 'punk') l.bonus = { stats: { aim: edge, quick: edge > 1 ? 1 : 0 }, hp: edge * 2 };
    out.push(l);
    left -= cost;
  }
  if (!out.length) out.push(makeLoadout('punk', 'pistol', 'shiv'));
  return out;
}

export function aiLevelFor(threat: number): AiLevel {
  return threat <= 2 ? 'easy' : threat >= 6 ? 'hard' : 'normal';
}

const sizeFor = (n: number): MapSize => (n <= 3 ? 'small' : n <= 5 ? 'medium' : 'large');

/** Later stories start harder, because the crew that reaches them is stronger. */
export const effectiveThreat = (s: CampaignState, gig: Gig): number => Math.max(1, gig.threat + s.threatMod + (gig.story ? s.arcsDone : 0));

/** Turns the job the crew accepted into a battle. */
export function buildMission(s: CampaignState): GameState {
  if (!s.mission) throw new Error('no mission');
  const { gig, squad } = s.mission;
  const members = squad.map((id) => s.crew.find((m) => m.id === id)!);
  const threat = effectiveThreat(s, gig);
  const roster = members.map(crewLoadout);
  // A suit doesn't go anywhere without paid muscle.
  if (members.some((m) => m.role === 'suit')) roster.push({ ...makeLoadout('punk', 'pistol', 'shiv'), name: 'Hired gun' });
  const cfg: GameConfig = {
    seed: gig.mapSeed,
    scenario: gig.scenario,
    ruleset: s.ruleset,
    mapSize: sizeFor(members.length),
    theme: gig.theme,
    maxRounds: gig.scenario === 'heist' ? 10 : 8,
    points: 9999,
    sides: [
      { name: s.crewName, faction: 'union', team: 0, control: 'human', aiLevel: 'normal', roster },
      { name: '', faction: gig.enemy, team: 1, control: s.gmSlot === null ? 'ai' : 'human', aiLevel: aiLevelFor(threat), roster: enemyRoster(gig.enemy, enemyPoints(members, threat), threat) },
    ],
  };
  const game = createGame(cfg);
  if (s.gmSlot !== null) game.gmBudget = { 1: 18 + threat * 6 };
  return game;
}

/* ---------- Battle results ---------- */

export interface MissionResult {
  won: boolean;
  /** The crew pulled out, so there's no pay and nothing learned. */
  fled?: boolean;
  /** One entry per squad member, in squad order. */
  members: { state: 'ok' | 'down' | 'dead'; kills: number; dealt: number; injuries?: InjuryId[] }[];
}

const LASTING: InjuryId[] = ['brokenArm', 'brokenLeg', 'optics'];

export function missionResult(game: GameState): MissionResult {
  const crew = game.units.filter((u) => !u.isDrone && /^s0u\d+$/.test(u.id) && Number(u.id.slice(3)) < 100);
  crew.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
  // Conceding marks a whole side dead on the board, but in a campaign the crew pulls out and drags its living along.
  const fled = game.conceded[0];
  return { won: game.winner === 0, fled, members: crew.map((u) => ({ state: u.retreated ? 'down' : u.state, kills: u.kills, dealt: u.dealt, injuries: u.injuries.filter((i) => LASTING.includes(i)) })) };
}

function applyResult(s: CampaignState, result: MissionResult): void {
  if (!s.mission) return;
  const { gig, squad } = s.mission;
  const alive = (role: RoleId) => s.crew.filter((m) => m.role === role && m.status !== 'dead').reduce((best, m) => Math.max(best, m.level), 0);
  // A broker haggles the fee up; a face makes sure people hear about the win.
  const haggle = 1 + Math.min(0.3, alive('broker') * 0.05);
  const pay = Math.round((result.won ? gig.pay : result.fled ? 0 : gig.pay * 0.2) * haggle);
  const rep = result.won ? 1 + (alive('face') ? 1 : 0) : -1;
  s.cash += pay;
  s.rep += rep;
  s.gigsDone += 1;
  s.threatMod = 0;
  s.gmEventUsed = false;
  const lines: DebriefLine[] = [];
  // Anyone who sat this one out has had time to heal.
  for (const m of s.crew) if (m.status === 'wounded' && !squad.includes(m.id)) m.status = 'ok';
  squad.forEach((id, i) => {
    const m = s.crew.find((c) => c.id === id);
    const r = result.members[i];
    if (!m || !r) return;
    // Only the Full Contract keeps its dead. In lighter rules a fallen character is hurt and out of the next job.
    const outcome: CrewStatus = r.state === 'ok' ? 'ok' : r.state === 'dead' && s.ruleset === 'full' ? 'dead' : 'wounded';
    const xp = result.fled ? 0 : 1 + (result.won ? 1 : 0) + r.kills;
    m.status = outcome;
    if (s.ruleset !== 'quick') for (const i of r.injuries ?? []) if (!m.injuries.includes(i)) m.injuries.push(i);
    m.kills += r.kills;
    m.missions += 1;
    let levelUp = false;
    if (outcome !== 'dead') {
      m.xp += xp;
      while (m.xp >= xpToNext(m)) {
        m.xp -= xpToNext(m);
        m.level += 1;
        m.points += 1;
        levelUp = true;
      }
    }
    lines.push({ id, name: m.name, kills: r.kills, dealt: r.dealt, outcome, xp, levelUp });
  });
  s.debrief = {
    won: result.won, title: gig.title, text: result.won ? gig.won : gig.lost, pay, rep, lines, story: gig.story,
  };
  s.phase = 'debrief';
}

const anyoneLeft = (s: CampaignState): boolean => s.crew.some((m) => m.status !== 'dead');
const cheapestHire = (): number => Math.min(...RECRUITABLE.map(hireCost));

function closeDebrief(s: CampaignState): void {
  const d = s.debrief;
  const mission = s.mission;
  s.debrief = null;
  s.mission = null;
  s.transcript = [];
  if (!anyoneLeft(s) && s.cash < cheapestHire()) {
    s.phase = 'over';
    s.ending = { title: 'ending.wiped.title', text: 'ending.wiped.text' };
    return;
  }
  s.phase = 'hub';
  if (d?.story && d.won && mission) {
    const n = nodeOf(s, mission.gig.id);
    if (n?.kind === 'gig') follow(s, n.next ?? nodeAfter(s, n.id));
  }
  if (s.phase === 'hub') refreshOffers(s);
}

/* ---------- Moving through the story ---------- */

function nodeAfter(s: CampaignState, id: string): string {
  const nodes = s.arc?.nodes ?? [];
  const i = nodes.findIndex((n) => n.id === id);
  return nodes[i + 1]?.id ?? END;
}

function enterNode(s: CampaignState, id: string): void {
  s.node = id;
  const n = nodeOf(s, id);
  s.transcript = [];
  s.phase = n?.kind === 'scene' ? 'scene' : 'hub';
}

function follow(s: CampaignState, next: string): void {
  if (next === END) finishArc(s);
  else enterNode(s, next);
}

function finishArc(s: CampaignState): void {
  const arc = s.arc;
  if (!arc) return;
  const ending = arc.endings.find((e) => !e.needFlag || s.flags.includes(e.needFlag)) ?? arc.endings[arc.endings.length - 1];
  s.ending = { title: ending.title, text: ending.text };
  s.chronicle.push({ title: arc.title, ending: ending.title });
  if (arc.source === 'generated' && arc.bible) {
    const notes = JSON.parse(arc.bible) as { patron: string; stake: string };
    s.used.patrons.push(notes.patron);
    s.used.stakes.push(notes.stake);
  }
  s.arcsDone += 1;
  s.node = null;
  s.phase = 'ending';
}

export const choiceAllowed = (s: CampaignState, c: ArcChoice): boolean =>
  (c.needCash === undefined || s.cash >= c.needCash) && (!c.needFlag || s.flags.includes(c.needFlag));

export const freePlace = (s: CampaignState): string => (s.phase === 'scene' && s.node ? s.node : `hub${s.gigsDone}`);
export const freeLeft = (s: CampaignState): number => MAX_FREE_PER_PLACE - s.freeUsed.filter((k) => k === freePlace(s)).length;

/* ---------- Actions ---------- */

export type CampaignAction =
  | { a: 'hire'; role: RoleId; name: string }
  | { a: 'dismiss'; id: number }
  | { a: 'rename'; id: number; name: string }
  | { a: 'setOwner'; id: number; slot: number }
  | { a: 'weapon'; id: number; kind: 'ranged' | 'melee'; weapon: WeaponId | null }
  | { a: 'chrome'; id: number; chrome: ChromeId }
  | { a: 'grenade'; id: number; kind: GrenadeKind }
  | { a: 'clinic'; id: number }
  | { a: 'therapy'; id: number }
  | { a: 'treat'; id: number; injury: InjuryId }
  | { a: 'roleMove'; role: RoleId }
  | { a: 'advance'; id: number; pick: AdvancePick }
  | { a: 'rest' }
  | { a: 'choose'; choice: string }
  | { a: 'takeGig'; gig: string; squad: number[] }
  | { a: 'closeDebrief' }
  | { a: 'gmSay'; text: string }
  | { a: 'gmEvent'; kind: GmEvent }
  | { a: 'freeAsk'; text: string; actor: number }
  // Everything below comes from the host's own game and is refused from anyone else.
  | { a: 'finishMission'; result: MissionResult }
  | { a: 'setGm'; slot: number | null }
  | { a: 'setPlayers'; players: Player[] }
  | { a: 'setBusy'; busy: boolean }
  | { a: 'narrate'; node: string; text: string }
  | { a: 'narrateDebrief'; text: string }
  | { a: 'transcript'; line: TranscriptLine }
  | { a: 'freeRoll'; text: string; actor: number; stat: keyof Stats; tn: number; from: string }
  | { a: 'nextArc'; arc: Arc }
  | { a: 'toEndless' };

export type GmEvent = 'ambush' | 'tipoff' | 'windfall' | 'shakedown';

const HOST_ONLY = new Set<CampaignAction['a']>([
  'finishMission', 'setGm', 'setPlayers', 'setBusy', 'narrate', 'narrateDebrief', 'transcript', 'freeRoll', 'nextArc', 'toEndless',
]);

export interface CampaignResult { ok: boolean; state: CampaignState; error?: string; roll?: FreeRoll }
export interface FreeRoll { nat: number; mod: number; tn: number; ok: boolean; cash: number; rep: number; threat: number }

class Refused extends Error {}
const refuse = (why: string): never => { throw new Refused(why); };

function member(s: CampaignState, id: number): CrewMember {
  return s.crew.find((m) => m.id === id) ?? refuse('noCrew');
}

function spend(s: CampaignState, amount: number): void {
  if (!Number.isFinite(amount) || s.cash < amount) refuse('noCash');
  s.cash -= amount;
}

function buyWeapon(s: CampaignState, m: CrewMember, w: WeaponId): void {
  if (m.owned.includes(w)) return;
  spend(s, weaponCost(w));
  m.owned.push(w);
}

/** A player may spend on their own people; the host may spend on anyone. Hot-seat play is all host. */
function mayManage(slot: number, m: CrewMember): void {
  if (slot !== 0 && m.owner !== slot) refuse('notYours');
}

function hubOnly(s: CampaignState): void {
  if (s.phase !== 'hub') refuse('notNow');
}

const clean = (text: string, max: number): string => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function step(s: CampaignState, act: CampaignAction, slot: number, out: { roll?: FreeRoll }): void {
  // Actions can arrive from another player's game, so their shape isn't taken on trust.
  if (!act || typeof act !== 'object' || typeof act.a !== 'string') refuse('badAction');
  if (HOST_ONLY.has(act.a) && slot !== 0) refuse('hostOnly');
  const isGm = s.gmSlot !== null && s.gmSlot === slot;
  switch (act.a) {
    case 'hire': {
      hubOnly(s);
      if (isGm) refuse('gmOnly');
      if (!RECRUITABLE.includes(act.role)) refuse('badRole');
      if (s.crew.filter((m) => m.status !== 'dead').length >= MAX_CREW) refuse('crewFull');
      spend(s, hireCost(act.role));
      const name = clean(act.name, 24) || pickHandle(s.nextCrewId * 37, s.crew.map((m) => m.name));
      s.crew.push(makeCrew(s.nextCrewId++, act.role, name, slot));
      break;
    }
    case 'dismiss': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (s.crew.filter((c) => c.status !== 'dead').length <= 1) refuse('lastOne');
      s.crew = s.crew.filter((c) => c.id !== act.id);
      break;
    }
    case 'rename': {
      const m = member(s, act.id);
      mayManage(slot, m);
      m.name = clean(act.name, 24) || m.name;
      break;
    }
    case 'setOwner': {
      const m = member(s, act.id);
      if (!Number.isInteger(act.slot) || !s.players[act.slot] || act.slot === s.gmSlot) refuse('badPlayer');
      // Anyone may take a character the host is covering; only the host can move one between friends.
      if (slot !== 0 && !(act.slot === slot && m.owner === 0)) refuse('notYours');
      m.owner = act.slot;
      break;
    }
    case 'weapon': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      const def = ROLES[m.role];
      const list: (WeaponId | null)[] = act.kind === 'ranged' ? def.ranged : def.melee;
      if (!list.includes(act.weapon)) refuse('badWeapon');
      if (act.kind === 'ranged') {
        if (m.ranged === act.weapon) return;
        if (act.weapon) buyWeapon(s, m, act.weapon);
        m.ranged = act.weapon;
      } else {
        if (m.melee === act.weapon) return;
        buyWeapon(s, m, act.weapon!);
        m.melee = act.weapon!;
      }
      break;
    }
    case 'chrome': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (!Object.hasOwn(CHROME_COST, act.chrome)) refuse('badChrome');
      if (m.chrome.includes(act.chrome)) {
        m.chrome = m.chrome.filter((c) => c !== act.chrome);
        break;
      }
      if (m.chrome.length >= MAX_CHROME) refuse('chromeFull');
      spend(s, chromeCost(act.chrome));
      m.chrome.push(act.chrome);
      {
        // Each implant costs a piece of who you were, and some never comes back.
        const r = new Rand(s.rng);
        m.humanity -= r.d(6) + 2;
        m.humanityMax -= 2;
        s.rng = r.state;
      }
      break;
    }
    case 'grenade': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (!Object.hasOwn(GRENADE_COST, act.kind)) refuse('badGrenade');
      if (m.extra[act.kind] >= 3) refuse('tooMany');
      spend(s, grenadeCost(act.kind));
      m.extra[act.kind] += 1;
      break;
    }
    case 'clinic': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (m.status !== 'wounded') refuse('notWounded');
      spend(s, clinicCost(m));
      m.status = 'ok';
      break;
    }
    case 'therapy': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (m.humanity >= m.humanityMax) refuse('notNeeded');
      spend(s, THERAPY_COST);
      const r = new Rand(s.rng);
      m.humanity = Math.min(m.humanityMax, m.humanity + r.d(6) + 4);
      s.rng = r.state;
      break;
    }
    case 'treat': {
      hubOnly(s);
      const m = member(s, act.id);
      mayManage(slot, m);
      if (!m.injuries.includes(act.injury)) refuse('notNeeded');
      spend(s, TREAT_COST);
      m.injuries = m.injuries.filter((i) => i !== act.injury);
      break;
    }
    case 'roleMove': {
      if (s.phase !== 'scene' || isGm) refuse('notNow');
      if (!ROLE_MOVES.includes(act.role)) refuse('badRole');
      const key = `role:${s.node}`;
      if (s.freeUsed.includes(key)) refuse('freeUsed');
      const m = s.crew.filter((c) => c.role === act.role && c.status !== 'dead').sort((a, b) => b.level - a.level)[0] ?? refuse('noCrew');
      const r = new Rand(s.rng);
      const nat = r.d(10);
      const mod = statLine(m).nerve + m.level - 1;
      s.rng = r.state;
      s.freeUsed.push(key);
      const ok = nat + mod >= 13;
      if (ok && act.role === 'broker') s.cash += 100 + 50 * m.level;
      if (ok && act.role === 'face') s.rep += 1;
      if (ok && act.role === 'suit') s.threatMod -= 1;
      s.transcript.push({ kind: 'result', ok, text: { k: ok ? `rolemove.${act.role}.ok` : 'rolemove.fail', v: { name: m.name, nat, mod, cash: 100 + 50 * m.level } } });
      break;
    }
    case 'advance': {
      const m = member(s, act.id);
      mayManage(slot, m);
      if (m.points <= 0 || !advancesFor(m.role).includes(act.pick)) refuse('noAdvance');
      if (act.pick === 'hp') {
        if (m.bonus.hp >= MAX_BONUS * 3) refuse('maxed');
        m.bonus.hp += 3;
      } else if ((STAT_KEYS as string[]).includes(act.pick)) {
        const k = act.pick as keyof Stats;
        if ((m.bonus.stats[k] ?? 0) >= MAX_BONUS) refuse('maxed');
        m.bonus.stats[k] = (m.bonus.stats[k] ?? 0) + 1;
      } else {
        const k = act.pick as keyof Skills;
        if ((m.bonus.skills[k] ?? 0) >= MAX_BONUS) refuse('maxed');
        m.bonus.skills[k] = (m.bonus.skills[k] ?? 0) + 1;
      }
      m.points -= 1;
      break;
    }
    case 'rest': {
      hubOnly(s);
      if (isGm) refuse('gmOnly');
      // Lying low costs rent, but a broke crew can always sleep it off.
      s.cash = Math.max(0, s.cash - REST_COST);
      for (const m of s.crew) if (m.status === 'wounded') m.status = 'ok';
      refreshOffers(s);
      break;
    }
    case 'choose': {
      if (s.phase !== 'scene') refuse('notNow');
      if (isGm) refuse('gmOnly');
      const n = nodeOf(s);
      if (n?.kind !== 'scene') return refuse('notNow');
      const c = n.choices.find((x) => x.id === act.choice) ?? refuse('badChoice');
      if (!choiceAllowed(s, c)) refuse('notAllowed');
      s.cash = Math.max(0, s.cash + (c.cash ?? 0));
      s.rep += c.rep ?? 0;
      s.threatMod += c.threat ?? 0;
      if (c.flag && !s.flags.includes(c.flag)) s.flags.push(c.flag);
      follow(s, c.next ?? nodeAfter(s, n.id));
      if (s.phase === 'hub') {
        refreshOffers(s);
        // The answer stays on screen when the story moves to a job.
        if (c.result) s.transcript = [{ kind: 'result', text: c.result }];
      }
      break;
    }
    case 'takeGig': {
      hubOnly(s);
      if (isGm) refuse('gmOnly');
      const gig = availableGigs(s).find((g) => g.id === act.gig) ?? refuse('noGig');
      if (!Array.isArray(act.squad)) refuse('badSquad');
      const squad = [...new Set(act.squad)];
      if (!squad.length || squad.length > MAX_SQUAD) refuse('badSquad');
      for (const id of squad) {
        const m = member(s, id);
        if (m.status !== 'ok') refuse('badSquad');
        // A guest only brings their own people; the host decides for anyone else.
        mayManage(slot, m);
      }
      s.mission = { gig, squad };
      s.phase = 'mission';
      s.transcript = [];
      break;
    }
    case 'finishMission':
      if (s.phase !== 'mission') refuse('notNow');
      applyResult(s, act.result);
      break;
    case 'closeDebrief':
      if (s.phase !== 'debrief') refuse('notNow');
      closeDebrief(s);
      break;
    case 'gmSay': {
      if (!isGm && slot !== 0) refuse('gmOnly');
      const text = clean(act.text, 600);
      if (text) s.transcript.push({ kind: 'gm', text, from: s.players[slot]?.name });
      break;
    }
    case 'gmEvent': {
      // A game master at the host's own PC has no seat of their own to act from.
      const localGm = slot === 0 && s.gmSlot !== null && !s.players[s.gmSlot]?.peer;
      if (!isGm && !localGm) refuse('gmOnly');
      hubOnly(s);
      if (s.gmEventUsed) refuse('eventUsed');
      s.gmEventUsed = true;
      if (act.kind === 'ambush') s.threatMod += 1;
      else if (act.kind === 'tipoff') s.threatMod -= 1;
      else if (act.kind === 'windfall') s.cash += 200;
      else if (act.kind === 'shakedown') s.cash = Math.max(0, s.cash - 150);
      else refuse('badEvent');
      s.transcript.push({ kind: 'gm', text: `gmevent.${act.kind}.log`, from: s.players[slot]?.name });
      break;
    }
    case 'freeAsk':
      // The host's game turns this into a freeRoll once the language model has weighed it up.
      refuse('hostHandles');
      break;
    case 'setGm':
      hubOnly(s);
      if (act.slot !== null && !s.players[act.slot]) refuse('badPlayer');
      s.gmSlot = act.slot;
      // The game master runs the other side, so their characters go to another player.
      if (act.slot !== null) {
        const other = Math.max(0, s.players.findIndex((_, i) => i !== act.slot));
        for (const m of s.crew) if (m.owner === act.slot) m.owner = other;
      }
      break;
    case 'setPlayers':
      s.players = act.players.slice(0, MAX_PLAYERS);
      if (s.gmSlot !== null && !s.players[s.gmSlot]) s.gmSlot = null;
      break;
    case 'setBusy':
      s.busy = act.busy;
      break;
    case 'narrate':
      s.narration[act.node] = act.text;
      break;
    case 'narrateDebrief':
      if (s.debrief) s.debrief.narration = act.text;
      break;
    case 'transcript':
      s.transcript.push(act.line);
      break;
    case 'freeRoll': {
      if (freeLeft(s) <= 0) refuse('freeUsed');
      if (s.phase !== 'scene' && s.phase !== 'hub') refuse('notNow');
      const m = member(s, act.actor);
      if (m.status === 'dead') refuse('noCrew');
      if (!STAT_KEYS.includes(act.stat)) refuse('badStat');
      const tn = Math.max(8, Math.min(20, Math.round(act.tn)));
      const r = new Rand(s.rng);
      const nat = r.d(10);
      const mod = statLine(m)[act.stat] + m.level - 1;
      const ok = nat + mod >= tn;
      const cash = ok ? 50 * r.int(2, 6) : 0;
      const threat = ok ? 0 : r.next() < 0.5 ? 1 : 0;
      const rep = !ok && threat === 0 ? -1 : 0;
      s.rng = r.state;
      s.cash += cash;
      s.rep += rep;
      s.threatMod += threat;
      s.freeUsed.push(freePlace(s));
      s.transcript.push({ kind: 'free', text: clean(act.text, 300), from: act.from });
      s.transcript.push({ kind: 'result', ok, text: { k: ok ? 'free.success' : 'free.failure', v: { name: m.name, stat: `stat.${act.stat}`, nat, mod, tn } } });
      if (cash) s.transcript.push({ kind: 'result', ok, text: { k: 'free.gain', v: { cash } } });
      if (threat) s.transcript.push({ kind: 'result', ok, text: 'free.heat' });
      if (rep) s.transcript.push({ kind: 'result', ok, text: 'free.rep' });
      out.roll = { nat, mod, tn, ok, cash, rep, threat };
      break;
    }
    case 'nextArc':
      if (s.phase !== 'ending') refuse('notNow');
      s.mode = 'story';
      s.arc = act.arc;
      s.flags = [];
      s.narration = {};
      s.freeUsed = [];
      s.ending = null;
      s.threatMod = 0;
      enterNode(s, act.arc.start);
      refreshOffers(s);
      break;
    case 'toEndless':
      if (s.phase !== 'ending') refuse('notNow');
      s.mode = 'endless';
      s.arc = null;
      s.node = null;
      s.ending = null;
      s.phase = 'hub';
      refreshOffers(s);
      break;
    default:
      refuse('unknown');
  }
}

/** Pure step function: the input state is left untouched. */
export function applyCampaign(prev: CampaignState, action: CampaignAction, slot: number): CampaignResult {
  const s = structuredClone(prev);
  const out: { roll?: FreeRoll } = {};
  try {
    step(s, action, slot, out);
  } catch (e) {
    if (e instanceof Refused) return { ok: false, state: prev, error: e.message };
    throw e;
  }
  return { ok: true, state: s, roll: out.roll };
}
