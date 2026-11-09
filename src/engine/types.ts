export type RulesetId = 'quick' | 'standard' | 'full';
export type ScenarioId = 'flatline' | 'terminals' | 'heist';
export type MapSize = 'small' | 'medium' | 'large';
export type ThemeId = 'docks' | 'market' | 'plaza';
export type FactionId = 'union' | 'meridian' | 'choir' | 'kilnrats';
export type RoleId = 'breaker' | 'razor' | 'longeye' | 'wire' | 'patcher' | 'wrench' | 'sapper' | 'punk' | 'drone' | 'broker' | 'face' | 'suit';
export type WeaponId =
  | 'pistol' | 'smg' | 'rifle' | 'shotgun' | 'sniper' | 'dronegun'
  | 'shiv' | 'monoblade' | 'hammer' | 'claws' | 'ram';
export type ChromeId = 'smartlink' | 'dermal' | 'spike' | 'stim' | 'dashlegs' | 'targeteye' | 'firewall' | 'claws';
export type AiLevel = 'easy' | 'normal' | 'hard';
export type Control = 'human' | 'ai';
export type GrenadeKind = 'frag' | 'smoke' | 'emp';
export type ProgramId = 'glitch' | 'seize' | 'burn' | 'hijack' | 'terminal';
export type HitLoc = 'head' | 'torso' | 'arms' | 'legs';
export type InjuryId = 'bleeding' | 'brokenArm' | 'brokenLeg' | 'concussed' | 'shaken' | 'optics';
export type AttackKind = 'ranged' | 'melee';
export type ShotMode = 'single' | 'burst';

export interface Stats { quick: number; aim: number; grit: number; wire: number; nerve: number }
export interface Skills { firearms: number; melee: number; evade: number; hack: number; medic: number; tech: number }
export interface Grenades { frag: number; smoke: number; emp: number }

/** What a campaign character has earned on top of their role. */
export interface UnitBonus { hp?: number; stats?: Partial<Stats>; skills?: Partial<Skills> }

export interface Loadout {
  name?: string;
  role: RoleId;
  ranged: WeaponId | null;
  melee: WeaponId;
  chrome: ChromeId[];
  extra: Grenades;
  bonus?: UnitBonus;
  /** Campaign level; role abilities grow with it. */
  rank?: number;
  /** A campaign character's own icon: see crewIconOk in the campaign rules. */
  icon?: string;
  /** Lasting injuries carried in from earlier jobs. */
  injuries?: InjuryId[];
  /** Humanity has run out: this person can snap in the middle of a fight. */
  unstable?: boolean;
}

export type FocusKind = 'aim' | 'damage' | 'guard' | 'init';

export interface RuleFlags {
  id: RulesetId;
  exploding: boolean;
  fixedDamage: boolean;
  ammo: boolean;
  burst: boolean;
  crits: boolean;
  wounds: boolean;
  downed: boolean;
  overwatch: boolean;
  armorWear: boolean;
  hitLocations: boolean;
  aimedShots: boolean;
  fumbles: boolean;
  morale: boolean;
  bleeding: boolean;
  suppress: boolean;
  chromeLoad: boolean;
  scatter: boolean;
  emp: boolean;
  luck: boolean;
  netDive: boolean;
  programs: ProgramId[];
}

export interface SideConfig {
  name: string;
  faction: FactionId;
  team: number;
  control: Control;
  aiLevel: AiLevel;
  roster: Loadout[];
}

export interface GameConfig {
  seed: number;
  scenario: ScenarioId;
  ruleset: RulesetId;
  mapSize: MapSize;
  theme: ThemeId;
  maxRounds: number;
  points: number;
  sides: SideConfig[];
}

export interface Rect { x: number; y: number; w: number; h: number }

export interface MapData {
  id: string;
  w: number;
  h: number;
  /** One character per tile, row by row: . floor, # wall, c low cover, ~ water, g glass, T terminal. */
  tiles: string;
  theme: ThemeId;
  zones: Rect[];
  terminals: { x: number; y: number }[];
  core: { x: number; y: number } | null;
}

export interface Unit {
  id: string;
  side: number;
  team: number;
  name: string;
  role: RoleId;
  /** A campaign character's own icon, drawn instead of the role icon. */
  icon?: string;
  faction: FactionId;
  stats: Stats;
  skills: Skills;
  hp: number;
  hpMax: number;
  armor: number;
  armorMax: number;
  armorHead: number;
  armorHeadMax: number;
  move: number;
  ranged: WeaponId | null;
  melee: WeaponId;
  ammo: number;
  chrome: ChromeId[];
  used: string[];
  grenades: Grenades;
  kits: number;
  drones: number;
  x: number;
  y: number;
  state: 'ok' | 'down' | 'dead';
  deathRolls: number;
  downRounds: number;
  ap: number;
  activated: boolean;
  moved: boolean;
  attacks: number;
  hacks: number;
  charged: boolean;
  aiming: number;
  overwatch: boolean;
  braced: boolean;
  glitch: boolean;
  seized: boolean;
  pinned: boolean;
  jammed: boolean;
  injuries: InjuryId[];
  lastShotAtRound: number;
  value: number;
  isDrone: boolean;
  kills: number;
  dealt: number;
  rank: number;
  /** Points to spend for +2 on one roll, per battle. */
  luck: number;
  luckBonus: number;
  /** A Breaker's combat focus. */
  focus: Record<FocusKind, number>;
  /** Network actions left since jacking in. */
  net: number;
  /** Hostile programs this hacker's defences can still absorb. */
  rez: number;
  unstable: boolean;
  /** Who this unit really fights for, while it has snapped. */
  snapped: { side: number; team: number } | null;
  /** Pulled out alive when their side conceded. */
  retreated?: boolean;
}

export interface Terminal { id: number; x: number; y: number; owner: number | null }

export interface GameState {
  v: 1;
  cfg: GameConfig;
  map: MapData;
  units: Unit[];
  round: number;
  phase: 'deploy' | 'battle' | 'over';
  order: number[];
  turnIdx: number;
  activeSide: number;
  activeUnit: string | null;
  ready: boolean[];
  conceded: boolean[];
  rng: number;
  smoke: { x: number; y: number; until: number }[];
  terminals: Terminal[];
  core: { x: number; y: number; carrier: string | null } | null;
  vp: number[];
  /** Winning team, -1 for a draw, null while the game is running. */
  winner: number | null;
  reason: 'elimination' | 'rounds' | 'extraction' | 'concede' | null;
  seq: number;
  /** Co-op: who controls each unit, by unit id. 'host' or a relay peer id; a unit with no entry is anyone's. */
  owners?: Record<string, string>;
  /** Points a human game master has left for reinforcements, by side. */
  gmBudget?: Record<number, number>;
}

export type Action =
  | { type: 'place'; unitId: string; x: number; y: number }
  | { type: 'ready' }
  | { type: 'select'; unitId: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'shoot'; targetId: string; mode?: ShotMode; aimedAt?: HitLoc }
  | { type: 'melee'; targetId: string }
  | { type: 'charge'; targetId: string }
  | { type: 'aim' }
  | { type: 'reload' }
  | { type: 'brace' }
  | { type: 'overwatch' }
  | { type: 'clearJam' }
  | { type: 'suppress'; x: number; y: number }
  | { type: 'grenade'; kind: GrenadeKind; x: number; y: number }
  | { type: 'hack'; program: ProgramId; targetId?: string; terminalId?: number }
  | { type: 'patch'; targetId: string }
  | { type: 'repair'; targetId: string }
  | { type: 'stim' }
  | { type: 'spike' }
  | { type: 'drone'; x: number; y: number }
  | { type: 'capture'; terminalId: number }
  | { type: 'grab' }
  | { type: 'end' }
  | { type: 'concede' }
  | { type: 'luck' }
  | { type: 'focus'; kind: FocusKind }
  | { type: 'reinforce'; role: RoleId; x: number; y: number };

export interface RollInfo { nat: number; extra: number; mod: number; total: number; tn: number }

export type GameEvent =
  | { t: 'deployed'; side: number }
  | { t: 'round'; round: number; rolls: { side: number; nat: number; total: number }[]; order: number[] }
  | { t: 'turn'; side: number }
  | { t: 'activate'; unit: string; ap: number }
  | { t: 'endActivation'; unit: string }
  | { t: 'move'; unit: string; path: [number, number][] }
  | { t: 'attack'; unit: string; target: string; weapon: WeaponId; kind: AttackKind; mode: ShotMode; roll: RollInfo; hit: boolean; crit: boolean; overwatch: boolean; dist: number; cover: number }
  | { t: 'damage'; target: string; dice: number[]; bonus: number; raw: number; armor: number; dealt: number; hp: number; loc: HitLoc | null }
  | { t: 'armorWear'; target: string; armor: number; head: boolean }
  | { t: 'injury'; target: string; injury: InjuryId }
  | { t: 'down'; unit: string; dead: boolean; by: string | null }
  | { t: 'aim'; unit: string; bonus: number }
  | { t: 'reload'; unit: string; ammo: number }
  | { t: 'brace'; unit: string }
  | { t: 'overwatch'; unit: string }
  | { t: 'clearJam'; unit: string }
  | { t: 'fumble'; unit: string; kind: 'jam' | 'guard' | 'friendly' | 'wasted' | 'none'; ally?: string }
  | { t: 'suppress'; unit: string; x: number; y: number }
  | { t: 'grenade'; unit: string; kind: GrenadeKind; x: number; y: number; landX: number; landY: number; roll: RollInfo | null; hit: boolean }
  | { t: 'hack'; unit: string; program: ProgramId; target?: string; terminal?: number; roll: RollInfo; ok: boolean }
  | { t: 'patch'; unit: string; target: string; ok: boolean; healed: number; hp: number; revived: boolean; roll: RollInfo | null }
  | { t: 'repair'; unit: string; target: string; hp: number; armor: number }
  | { t: 'stim'; unit: string; healed: number; hp: number }
  | { t: 'spike'; unit: string }
  | { t: 'drone'; unit: string; drone: Unit }
  | { t: 'capture'; unit: string; terminal: number; team: number }
  | { t: 'core'; unit: string; what: 'grab' | 'drop' | 'extract'; x: number; y: number }
  | { t: 'nerve'; unit: string; roll: RollInfo; ok: boolean }
  | { t: 'bleed'; unit: string; amount: number; hp: number }
  | { t: 'deathRoll'; unit: string; roll: RollInfo; ok: boolean; count: number }
  | { t: 'vp'; team: number; amount: number; why: 'kill' | 'terminal'; total: number }
  | { t: 'concede'; side: number }
  | { t: 'luck'; unit: string; left: number }
  | { t: 'focus'; unit: string; focus: Record<FocusKind, number> }
  | { t: 'snap'; unit: string; roll: RollInfo; side: number; team: number }
  | { t: 'recover'; unit: string; side: number; team: number }
  | { t: 'jackIn'; unit: string; net: number }
  | { t: 'ward'; target: string; rez: number }
  | { t: 'hunter'; unit: string; dealt: number; hp: number }
  | { t: 'reinforce'; unit: Unit; left: number }
  | { t: 'gameover'; winner: number; reason: NonNullable<GameState['reason']> };

export interface ModPart { k: string; v: number }

export interface AttackPreview {
  ok: boolean;
  reason?: string;
  chance: number;
  tn: number;
  mod: number;
  mods: ModPart[];
  tnParts: ModPart[];
  dist: number;
  cover: number;
  avgDmg: number;
  weapon: WeaponId | null;
}
