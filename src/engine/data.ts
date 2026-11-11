import type {
  ChromeId, FactionId, Grenades, Loadout, RoleId, RuleFlags, RulesetId, Skills, Stats, WeaponId,
} from './types';

/* Display names and descriptions live in src/ui/i18n. Everything here is rules data, keyed by id. */

export const RULESETS: Record<RulesetId, RuleFlags> = {
  quick: {
    id: 'quick', exploding: false, fixedDamage: true, ammo: false, burst: false, crits: false, wounds: false,
    downed: false, overwatch: false, armorWear: false, hitLocations: false, aimedShots: false, fumbles: false,
    morale: false, bleeding: false, suppress: false, chromeLoad: false, scatter: false, emp: false, luck: false, netDive: false,
    programs: ['glitch', 'seize', 'terminal'],
  },
  standard: {
    id: 'standard', exploding: true, fixedDamage: false, ammo: true, burst: true, crits: true, wounds: true,
    downed: true, overwatch: true, armorWear: false, hitLocations: false, aimedShots: false, fumbles: false,
    morale: false, bleeding: true, suppress: false, chromeLoad: false, scatter: true, emp: true, luck: true, netDive: true,
    programs: ['glitch', 'seize', 'burn', 'hijack', 'terminal'],
  },
  full: {
    id: 'full', exploding: true, fixedDamage: false, ammo: true, burst: true, crits: true, wounds: true,
    downed: true, overwatch: true, armorWear: true, hitLocations: true, aimedShots: true, fumbles: true,
    morale: true, bleeding: true, suppress: true, chromeLoad: true, scatter: true, emp: true, luck: true, netDive: true,
    programs: ['glitch', 'seize', 'burn', 'hijack', 'terminal'],
  },
};

export interface WeaponDef {
  id: WeaponId;
  kind: 'ranged' | 'melee';
  dice: number;
  bonus: number;
  mag: number;
  burst: boolean;
  /** Cannot fire after moving in the same activation. */
  heavy?: boolean;
  halfArmor?: boolean;
  /** Pairs of [maximum distance, target number]. */
  bands: [number, number][];
  /** Beyond this distance the weapon rolls this many dice instead. */
  falloff?: { dist: number; dice: number };
  cost: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pistol: { id: 'pistol', kind: 'ranged', dice: 2, bonus: 2, mag: 9, burst: false, bands: [[3, 11], [6, 13], [10, 17], [14, 23]], cost: 0 },
  smg: { id: 'smg', kind: 'ranged', dice: 2, bonus: 1, mag: 12, burst: true, bands: [[3, 12], [7, 14], [11, 18], [15, 24]], cost: 3 },
  rifle: { id: 'rifle', kind: 'ranged', dice: 3, bonus: 0, mag: 10, burst: true, bands: [[3, 14], [9, 13], [15, 15], [21, 20]], cost: 6 },
  shotgun: { id: 'shotgun', kind: 'ranged', dice: 4, bonus: 0, mag: 5, burst: false, bands: [[2, 10], [4, 12], [7, 17]], falloff: { dist: 4, dice: 2 }, cost: 4 },
  sniper: { id: 'sniper', kind: 'ranged', dice: 5, bonus: 0, mag: 3, burst: false, heavy: true, bands: [[3, 24], [7, 16], [16, 12], [26, 14]], cost: 8 },
  dronegun: { id: 'dronegun', kind: 'ranged', dice: 2, bonus: 0, mag: 10, burst: false, bands: [[3, 12], [7, 14], [11, 18]], cost: 0 },
  shiv: { id: 'shiv', kind: 'melee', dice: 1, bonus: 2, mag: 0, burst: false, bands: [], cost: 0 },
  monoblade: { id: 'monoblade', kind: 'melee', dice: 3, bonus: 0, mag: 0, burst: false, halfArmor: true, bands: [], cost: 5 },
  hammer: { id: 'hammer', kind: 'melee', dice: 3, bonus: 2, mag: 0, burst: false, bands: [], cost: 3 },
  claws: { id: 'claws', kind: 'melee', dice: 2, bonus: 1, mag: 0, burst: false, bands: [], cost: 0 },
  ram: { id: 'ram', kind: 'melee', dice: 1, bonus: 0, mag: 0, burst: false, bands: [], cost: 0 },
};

export interface RoleDef {
  id: RoleId;
  cost: number;
  stats: Stats;
  skills: Skills;
  armor: number;
  armorHead: number;
  ranged: (WeaponId | null)[];
  melee: WeaponId[];
  grenades: Grenades;
  kits: number;
  drones: number;
}

const skills = (firearms: number, melee: number, evade: number, hack = 0, medic = 0, tech = 0): Skills =>
  ({ firearms, melee, evade, hack, medic, tech });
const stats = (quick: number, aim: number, grit: number, wire: number, nerve: number): Stats =>
  ({ quick, aim, grit, wire, nerve });
const noGrenades: Grenades = { frag: 0, smoke: 0, emp: 0 };

export const ROLES: Record<RoleId, RoleDef> = {
  breaker: { id: 'breaker', cost: 20, stats: stats(5, 8, 5, 2, 5), skills: skills(4, 2, 2), armor: 3, armorHead: 1, ranged: ['rifle', 'smg', 'shotgun', 'pistol'], melee: ['shiv', 'hammer'], grenades: noGrenades, kits: 0, drones: 0 },
  razor: { id: 'razor', cost: 20, stats: stats(7, 4, 6, 2, 6), skills: skills(1, 5, 4), armor: 2, armorHead: 1, ranged: [null, 'pistol'], melee: ['monoblade', 'hammer', 'shiv'], grenades: noGrenades, kits: 0, drones: 0 },
  longeye: { id: 'longeye', cost: 22, stats: stats(4, 10, 3, 3, 5), skills: skills(5, 1, 2), armor: 1, armorHead: 0, ranged: ['sniper', 'rifle'], melee: ['shiv'], grenades: noGrenades, kits: 0, drones: 0 },
  wire: { id: 'wire', cost: 22, stats: stats(4, 5, 3, 7, 5), skills: skills(2, 1, 2, 6), armor: 1, armorHead: 0, ranged: ['pistol', 'smg'], melee: ['shiv'], grenades: noGrenades, kits: 0, drones: 0 },
  patcher: { id: 'patcher', cost: 18, stats: stats(5, 7, 4, 4, 6), skills: skills(3, 2, 3, 0, 6), armor: 1, armorHead: 1, ranged: ['pistol', 'smg'], melee: ['shiv'], grenades: { frag: 0, smoke: 1, emp: 0 }, kits: 4, drones: 0 },
  wrench: { id: 'wrench', cost: 20, stats: stats(4, 7, 5, 5, 5), skills: skills(3, 2, 2, 2, 0, 6), armor: 2, armorHead: 1, ranged: ['pistol', 'smg', 'shotgun'], melee: ['shiv', 'hammer'], grenades: noGrenades, kits: 0, drones: 1 },
  sapper: { id: 'sapper', cost: 20, stats: stats(5, 7, 5, 2, 4), skills: skills(4, 2, 2), armor: 2, armorHead: 1, ranged: ['shotgun', 'smg', 'pistol'], melee: ['shiv'], grenades: { frag: 3, smoke: 1, emp: 0 }, kits: 0, drones: 0 },
  punk: { id: 'punk', cost: 9, stats: stats(5, 6, 4, 1, 4), skills: skills(3, 3, 2), armor: 0, armorHead: 0, ranged: ['pistol', 'smg', null], melee: ['shiv', 'hammer'], grenades: noGrenades, kits: 0, drones: 0 },
  broker: { id: 'broker', cost: 14, stats: stats(5, 5, 4, 4, 7), skills: skills(2, 1, 3), armor: 1, armorHead: 0, ranged: ['pistol', 'smg'], melee: ['shiv'], grenades: { frag: 0, smoke: 1, emp: 0 }, kits: 0, drones: 0 },
  face: { id: 'face', cost: 14, stats: stats(5, 5, 3, 3, 8), skills: skills(2, 1, 4), armor: 0, armorHead: 0, ranged: ['pistol'], melee: ['shiv'], grenades: noGrenades, kits: 0, drones: 0 },
  suit: { id: 'suit', cost: 14, stats: stats(4, 5, 4, 5, 6), skills: skills(2, 1, 2), armor: 2, armorHead: 0, ranged: ['pistol', 'smg'], melee: ['shiv'], grenades: noGrenades, kits: 0, drones: 0 },
  drone: { id: 'drone', cost: 0, stats: stats(6, 7, 2, 1, 10), skills: skills(3, 0, 3), armor: 2, armorHead: 2, ranged: ['dronegun'], melee: ['ram'], grenades: noGrenades, kits: 0, drones: 0 },
};

/** Roles a player can recruit; drones only arrive through a Wrench. */
export const RECRUITABLE: RoleId[] = ['breaker', 'razor', 'longeye', 'wire', 'patcher', 'wrench', 'sapper', 'punk', 'broker', 'face', 'suit'];

export const CHROME_COST: Record<ChromeId, number> = {
  smartlink: 4, dermal: 5, spike: 5, stim: 3, dashlegs: 4, targeteye: 3, firewall: 3, backlash: 4, claws: 3,
};
export const CHROME_IDS = Object.keys(CHROME_COST) as ChromeId[];
export const GRENADE_COST: Record<keyof Grenades, number> = { frag: 3, smoke: 2, emp: 3 };

export const FACTIONS: Record<FactionId, { color: string; dark: string }> = {
  union: { color: '#ff9f2e', dark: '#4a2a07' },
  meridian: { color: '#58d6f5', dark: '#0b3845' },
  choir: { color: '#e84fd0', dark: '#47103f' },
  kilnrats: { color: '#a6e22e', dark: '#2c3f08' },
};
export const FACTION_IDS = Object.keys(FACTIONS) as FactionId[];

export function unitCost(faction: FactionId, l: Loadout): number {
  const role = ROLES[l.role];
  let c = role.cost;
  if (faction === 'kilnrats' && l.role === 'punk') c -= 2;
  if (l.ranged) c += WEAPONS[l.ranged].cost;
  c += WEAPONS[l.melee].cost;
  for (const ch of l.chrome) c += Math.max(1, CHROME_COST[ch] - (faction === 'choir' ? 1 : 0));
  c += l.extra.frag * GRENADE_COST.frag + l.extra.smoke * GRENADE_COST.smoke + l.extra.emp * GRENADE_COST.emp;
  return c;
}

export function rosterCost(faction: FactionId, roster: Loadout[]): number {
  return roster.reduce((sum, l) => sum + unitCost(faction, l), 0);
}

const NO_EXTRA: Grenades = { frag: 0, smoke: 0, emp: 0 };

export function makeLoadout(role: RoleId, ranged: WeaponId | null, melee: WeaponId, chrome: ChromeId[] = [], extra: Partial<Grenades> = {}): Loadout {
  return { role, ranged, melee, chrome, extra: { ...NO_EXTRA, ...extra } };
}

const SQUAD_ORDER: Record<FactionId, Loadout[]> = {
  union: [
    makeLoadout('breaker', 'rifle', 'hammer', ['dermal']),
    makeLoadout('razor', 'pistol', 'hammer'),
    makeLoadout('sapper', 'shotgun', 'shiv'),
    makeLoadout('patcher', 'pistol', 'shiv'),
    makeLoadout('breaker', 'shotgun', 'hammer'),
    makeLoadout('punk', 'smg', 'hammer'),
    makeLoadout('punk', 'pistol', 'hammer'),
  ],
  meridian: [
    makeLoadout('breaker', 'rifle', 'shiv', ['smartlink']),
    makeLoadout('wire', 'smg', 'shiv', ['firewall']),
    makeLoadout('longeye', 'sniper', 'shiv'),
    makeLoadout('punk', 'smg', 'shiv'),
    makeLoadout('breaker', 'rifle', 'shiv'),
    makeLoadout('wrench', 'smg', 'shiv'),
    makeLoadout('patcher', 'smg', 'shiv'),
  ],
  choir: [
    makeLoadout('razor', 'pistol', 'monoblade'),
    makeLoadout('razor', null, 'hammer', ['dermal']),
    makeLoadout('wire', 'pistol', 'shiv', ['firewall']),
    makeLoadout('punk', 'pistol', 'shiv', ['claws']),
    makeLoadout('punk', 'smg', 'shiv'),
    makeLoadout('patcher', 'pistol', 'shiv', ['stim']),
    makeLoadout('breaker', 'smg', 'shiv', ['claws']),
  ],
  kilnrats: [
    makeLoadout('sapper', 'smg', 'shiv'),
    makeLoadout('breaker', 'shotgun', 'hammer'),
    makeLoadout('punk', 'smg', 'hammer'),
    makeLoadout('punk', 'smg', 'shiv'),
    makeLoadout('punk', 'pistol', 'hammer'),
    makeLoadout('razor', 'pistol', 'shiv'),
    makeLoadout('punk', 'pistol', 'hammer'),
    makeLoadout('wrench', 'shotgun', 'shiv'),
  ],
};

/** A sensible ready-made squad for the faction that fits the budget. */
export function defaultRoster(faction: FactionId, points: number): Loadout[] {
  const out: Loadout[] = [];
  let left = points;
  for (const l of SQUAD_ORDER[faction]) {
    const cost = unitCost(faction, l);
    if (cost <= left) {
      out.push(structuredClone(l));
      left -= cost;
    }
  }
  return out;
}

const NAMES: Record<FactionId, string[]> = {
  union: ['Big Marta', 'Rivet', 'Tollbooth', 'Anchor', 'Old Kowal', 'Bilge', 'Second Shift', 'Hawser', 'Dockyard Jo'],
  meridian: ['Asset Vance', 'Asset Pryce', 'Asset Ito', 'Asset Oyelaran', 'Asset Duarte', 'Asset Holm', 'Asset Reyes', 'Asset Nowak', 'Asset Kerr'],
  choir: ['Sister Hush', 'Cantor', 'Brother Null', 'Psalm', 'Vesper', 'Deacon Wire', 'Requiem', 'Mother Static', 'Antiphon'],
  kilnrats: ['Soot', 'Matchstick', 'Little Fuse', 'Ember', 'Clinker', 'Slag', 'Tinder', 'Ash Baby', 'Kindle'],
};

export function unitName(faction: FactionId, index: number): string {
  const pool = NAMES[faction];
  return pool[index % pool.length];
}
