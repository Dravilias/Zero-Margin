import { RECRUITABLE, ROLES, RULESETS, WEAPONS, makeLoadout, unitName, rosterCost, type WeaponDef } from './data';
import { canStand, cheb, dist, generateMap, inRect, isSolid, los, tileAt, type LosInfo } from './map';
import { Rand } from './rng';
import type {
  Action, AttackKind, AttackPreview, FocusKind, GameConfig, GameEvent, GameState, GrenadeKind, HitLoc, InjuryId, Loadout,
  MapData, ModPart, ProgramId, RoleId, RollInfo, RuleFlags, ShotMode, Skills, Stats, Unit,
} from './types';

export const ACTIONS_PER_ACTIVATION = 2;
const CRIT_MARGIN = 8;
const HACK_RANGE = 9;
const TERMINAL_HACK_RANGE = 6;

export class Illegal extends Error {}
const illegal = (why: string): never => { throw new Illegal(why); };

export const rulesOf = (s: GameState): RuleFlags => RULESETS[s.cfg.ruleset];
export const unitById = (s: GameState, id: string): Unit | undefined => s.units.find((u) => u.id === id);
export const isOk = (u: Unit): boolean => u.state === 'ok';

/* ---------- Setup ---------- */

function makeUnit(cfg: GameConfig, side: number, l: Loadout, index: number): Unit {
  const sc = cfg.sides[side];
  const rules = RULESETS[cfg.ruleset];
  const role = ROLES[l.role];
  const stats = { ...role.stats };
  const skills = { ...role.skills };
  for (const [k, v] of Object.entries(l.bonus?.stats ?? {})) stats[k as keyof Stats] += v ?? 0;
  for (const [k, v] of Object.entries(l.bonus?.skills ?? {})) skills[k as keyof Skills] += v ?? 0;
  let armor = role.armor;
  let armorHead = role.armorHead;
  if (sc.faction === 'union') armor += 1;
  if (l.chrome.includes('dermal')) { armor += 1; armorHead += 1; }
  let move = 2 + Math.floor(stats.quick / 2);
  if (sc.faction === 'kilnrats') move += 1;
  if (l.chrome.includes('dashlegs')) move += 1;
  if (rules.chromeLoad) stats.nerve = Math.max(1, stats.nerve - Math.max(0, l.chrome.length - 2));
  const melee = l.chrome.includes('claws') && l.melee === 'shiv' ? 'claws' : l.melee;
  const rank = l.rank ?? 1;
  const hpMax = l.role === 'drone' ? 12 : 10 + stats.grit * 2 + (sc.faction === 'choir' ? 2 : 0) + (l.bonus?.hp ?? 0);
  const grenades = {
    frag: role.grenades.frag + l.extra.frag,
    smoke: role.grenades.smoke + l.extra.smoke,
    emp: rules.emp ? role.grenades.emp + l.extra.emp : 0,
  };
  return {
    id: `s${side}u${index}`,
    side, team: sc.team, name: l.name || unitName(sc.faction, index), role: l.role, faction: sc.faction,
    stats, skills, hp: hpMax, hpMax, armor, armorMax: armor, armorHead, armorHeadMax: armorHead, move,
    ranged: l.ranged, melee, ammo: l.ranged ? WEAPONS[l.ranged].mag : 0, chrome: [...l.chrome], used: [], grenades,
    kits: role.kits + (l.role === 'patcher' ? Math.floor(rank / 2) : 0), drones: role.drones + (l.role === 'wrench' ? Math.floor(rank / 3) : 0), x: 0, y: 0, state: 'ok', deathRolls: 0, ap: 0, activated: false,
    moved: false, attacks: 0, hacks: 0, charged: false, aiming: 0, overwatch: false, braced: false, glitch: false,
    seized: false, pinned: false, jammed: false, injuries: rules.crits ? [...(l.injuries ?? [])] : [], lastShotAtRound: 0,
    value: rosterCost(sc.faction, [l]), isDrone: l.role === 'drone', kills: 0, dealt: 0,
    rank,
    luck: !rules.luck || l.role === 'drone' ? 0 : Math.floor(stats.nerve / 3) + (l.role === 'broker' ? 2 : 0),
    luckBonus: 0,
    // Until someone reassigns it, a Breaker's focus goes on hitting things.
    focus: { aim: l.role === 'breaker' ? (l.rank ?? 0) : 0, damage: 0, guard: 0, init: 0 },
    net: 0,
    rez: l.role === 'wire' && rules.netDive ? 1 + Math.floor(rank / 2) : 0,
    unstable: !!l.unstable,
    snapped: null,
    downRounds: 0,
  };
}

export function createGame(cfg: GameConfig, customMap?: MapData): GameState {
  const map = customMap ?? generateMap(cfg.seed, cfg.mapSize, cfg.theme, cfg.sides.length, cfg.scenario);
  const r = new Rand((cfg.seed * 2654435761) >>> 0);
  const s: GameState = {
    v: 1, cfg, map, units: [], round: 0, phase: 'deploy', order: cfg.sides.map((_, i) => i), turnIdx: 0,
    activeSide: 0, activeUnit: null, ready: cfg.sides.map(() => false), conceded: cfg.sides.map(() => false),
    rng: r.state, smoke: [],
    terminals: map.terminals.map((t, id) => ({ id, x: t.x, y: t.y, owner: null })),
    core: map.core ? { ...map.core, carrier: null } : null,
    vp: [0, 0, 0, 0], winner: null, reason: null, seq: 0,
  };
  cfg.sides.forEach((side, si) => side.roster.forEach((l, i) => s.units.push(makeUnit(cfg, si, l, i))));
  cfg.sides.forEach((_, si) => autoDeploy(s, r, si));
  s.rng = r.state;
  return s;
}

function autoDeploy(s: GameState, r: Rand, side: number): void {
  const z = s.map.zones[side];
  const free: [number, number][] = [];
  for (let y = z.y; y < z.y + z.h; y++) {
    for (let x = z.x; x < z.x + z.w; x++) if (canStand(tileAt(s.map, x, y))) free.push([x, y]);
  }
  for (const u of s.units.filter((v) => v.side === side)) {
    const i = Math.floor(r.next() * free.length);
    const [x, y] = free.splice(i, 1)[0];
    u.x = x;
    u.y = y;
  }
}

function clone(s: GameState): GameState {
  return {
    ...s,
    units: s.units.map((u) => ({ ...u, used: [...u.used], grenades: { ...u.grenades }, injuries: [...u.injuries], focus: { ...u.focus } })),
    order: [...s.order], ready: [...s.ready], conceded: [...s.conceded], smoke: s.smoke.map((m) => ({ ...m })),
    terminals: s.terminals.map((t) => ({ ...t })), core: s.core ? { ...s.core } : null, vp: [...s.vp],
  };
}

/* ---------- Geometry helpers ---------- */

const smokeMemo = new WeakMap<object, Set<number> | null>();

export function smokeSet(s: GameState): Set<number> | null {
  if (s.smoke.length === 0) return null;
  let set = smokeMemo.get(s.smoke);
  if (set === undefined) {
    set = new Set(s.smoke.map((m) => m.x + m.y * s.map.w));
    smokeMemo.set(s.smoke, set);
  }
  return set;
}

export const losBetween = (s: GameState, ax: number, ay: number, bx: number, by: number): LosInfo =>
  los(s.map, smokeSet(s), ax, ay, bx, by);

export function moveOf(s: GameState, u: Unit): number {
  let m = u.move;
  if (u.injuries.includes('brokenLeg')) m -= 2;
  // Badly hurt people don't run.
  if (rulesOf(s).wounds && !u.isDrone && u.faction !== 'choir' && u.hp * 4 <= u.hpMax) m -= 2;
  if (s.core && s.core.carrier === u.id) m -= 1;
  return Math.max(1, m);
}

const blockingUnit = (s: GameState, x: number, y: number): Unit | undefined =>
  s.units.find((u) => u.state !== 'dead' && u.x === x && u.y === y);

export interface PathNode { cost: number; prev: number }

/** Every tile the unit can finish on with one move, plus the tiles it can only pass through. */
export function reachable(s: GameState, u: Unit, allowance = moveOf(s, u)): Map<number, PathNode> {
  const m = s.map;
  const key = (x: number, y: number) => x + y * m.w;
  const best = new Map<number, PathNode>();
  best.set(key(u.x, u.y), { cost: 0, prev: -1 });
  const open = [key(u.x, u.y)];
  while (open.length) {
    let idx = 0;
    for (let i = 1; i < open.length; i++) if (best.get(open[i])!.cost < best.get(open[idx])!.cost) idx = i;
    const cur = open.splice(idx, 1)[0];
    const c = best.get(cur)!;
    const cx = cur % m.w;
    const cy = Math.floor(cur / m.w);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        const t = tileAt(m, nx, ny);
        if (isSolid(t)) continue;
        if (dx && dy && (isSolid(tileAt(m, cx + dx, cy)) || isSolid(tileAt(m, cx, cy + dy)))) continue;
        const other = blockingUnit(s, nx, ny);
        if (other && other.state === 'ok' && other.team !== u.team) continue;
        const cost = c.cost + (dx && dy ? 1.5 : 1) + (t === 'c' || t === '~' ? 1 : 0);
        if (cost > allowance) continue;
        const k = key(nx, ny);
        const known = best.get(k);
        if (known && known.cost <= cost) continue;
        best.set(k, { cost, prev: cur });
        if (!open.includes(k)) open.push(k);
      }
    }
  }
  return best;
}

/** Tiles from the reachable set where the unit may actually stop. */
export function stoppable(s: GameState, u: Unit, reach: Map<number, PathNode>): number[] {
  const out: number[] = [];
  for (const k of reach.keys()) {
    const x = k % s.map.w;
    const y = Math.floor(k / s.map.w);
    if (x === u.x && y === u.y) continue;
    if (!canStand(tileAt(s.map, x, y))) continue;
    if (blockingUnit(s, x, y)) continue;
    out.push(k);
  }
  return out;
}

export function pathTo(s: GameState, reach: Map<number, PathNode>, x: number, y: number): [number, number][] {
  const path: [number, number][] = [];
  let k = x + y * s.map.w;
  while (k !== -1) {
    path.unshift([k % s.map.w, Math.floor(k / s.map.w)]);
    k = reach.get(k)!.prev;
  }
  return path;
}

/* ---------- Dice ---------- */

function rollD10(r: Rand, rules: RuleFlags): { nat: number; extra: number } {
  const nat = r.d(10);
  let extra = 0;
  if (rules.exploding) {
    if (nat === 10) extra = r.d(10);
    else if (nat === 1) extra = -r.d(10);
  }
  return { nat, extra };
}

/** A natural 1 always fails. In the quick rules a natural 10 always succeeds. */
export function hitChance(rules: RuleFlags, mod: number, tn: number): number {
  let p = 0;
  for (let n = 2; n <= 10; n++) {
    if (n === 10) {
      if (!rules.exploding) p += 0.1;
      else for (let m = 1; m <= 10; m++) if (10 + m + mod >= tn) p += 0.01;
    } else if (n + mod >= tn) {
      p += 0.1;
    }
  }
  return p;
}

function checkPasses(rules: RuleFlags, roll: { nat: number; extra: number }, mod: number, tn: number): boolean {
  if (roll.nat === 1) return false;
  if (roll.nat === 10 && !rules.exploding) return true;
  return roll.nat + roll.extra + mod >= tn;
}

const rollInfo = (roll: { nat: number; extra: number }, mod: number, tn: number): RollInfo =>
  ({ nat: roll.nat, extra: roll.extra, mod, tn, total: roll.nat + roll.extra + mod });

function woundPenalty(s: GameState, u: Unit): number {
  const rules = rulesOf(s);
  if (!rules.wounds || u.isDrone) return 0;
  const penalty = u.hp * 4 <= u.hpMax ? (rules.hitLocations ? -4 : -3) : u.hp * 2 <= u.hpMax ? -2 : 0;
  // The Choir's implants dull pain: they feel half of it.
  return u.faction === 'choir' ? Math.trunc(penalty / 2) : penalty;
}

/* ---------- Attack preview ---------- */

export interface AttackOpts {
  mode?: ShotMode;
  aimedAt?: HitLoc;
  reaction?: boolean;
  /** Evaluate from or against a hypothetical position; used by the AI. */
  fx?: number; fy?: number; tx?: number; ty?: number;
  hypothetical?: boolean;
}

function weaponDice(w: WeaponDef, d: number, mode: ShotMode | undefined): number {
  let dice = w.dice;
  if (w.falloff && d > w.falloff.dist) dice = w.falloff.dice;
  if (mode === 'burst') dice += 1;
  return dice;
}

const meleeBonus = (a: Unit) => Math.floor(a.stats.grit / 3) + (a.role === 'razor' ? Math.floor(a.rank / 2) : 0);

function adjacentAlly(s: GameState, u: Unit): boolean {
  return s.units.some((v) => v.id !== u.id && isOk(v) && v.team === u.team && cheb(v.x, v.y, u.x, u.y) <= 2);
}

function diagonalBlocked(s: GameState, ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx || ay === by) return false;
  return isSolid(tileAt(s.map, bx, ay)) && isSolid(tileAt(s.map, ax, by));
}

export function previewAttack(s: GameState, a: Unit, t: Unit, kind: AttackKind, o: AttackOpts = {}): AttackPreview {
  const rules = rulesOf(s);
  const fx = o.fx ?? a.x;
  const fy = o.fy ?? a.y;
  const tx = o.tx ?? t.x;
  const ty = o.ty ?? t.y;
  const d = dist(fx, fy, tx, ty);
  const wid = kind === 'ranged' ? a.ranged : a.melee;
  const bad = (reason: string): AttackPreview =>
    ({ ok: false, reason, chance: 0, tn: 0, mod: 0, mods: [], tnParts: [], dist: d, cover: 0, avgDmg: 0, weapon: wid });
  if (!wid) return bad('noWeapon');
  const w = WEAPONS[wid];
  const mods: ModPart[] = [];
  const tnParts: ModPart[] = [];
  const add = (k: string, v: number) => { if (v) mods.push({ k, v }); };
  const addTn = (k: string, v: number) => { if (v) tnParts.push({ k, v }); };
  let cover = 0;

  if (kind === 'ranged') {
    if (!o.hypothetical && !o.reaction) {
      if (a.jammed) return bad('jammed');
      if (rules.ammo && a.ammo < (o.mode === 'burst' ? 3 : 1)) return bad('noAmmo');
      if (w.heavy && a.moved) return bad('heavyMoved');
      if (w.heavy && a.attacks > 0) return bad('heavyTwice');
    }
    if (o.reaction && (a.jammed || (rules.ammo && a.ammo < 1))) return bad('noAmmo');
    const info = losBetween(s, fx, fy, tx, ty);
    if (!info.visible) return bad('noLos');
    const band = w.bands.find((b) => d <= b[0]);
    if (!band) return bad('outOfRange');
    cover = info.cover;
    addTn('range', band[1]);
    addTn(cover === 2 ? 'heavyCover' : 'lightCover', cover === 2 ? 4 : cover === 1 ? 2 : 0);
    addTn('evade', Math.floor((t.stats.quick + t.skills.evade) / 4));
    add('aimStat', a.stats.aim);
    add('firearms', a.skills.firearms);
    if (a.chrome.includes('smartlink')) add('smartlink', 1);
    if (a.faction === 'meridian') add('meridian', 1);
    if (a.injuries.includes('optics')) add('optics', -2);
    add('aiming', a.aiming);
    if (a.role === 'longeye') add('rank', Math.floor(a.rank / 3));
    if (o.mode === 'burst') add('burst', -1);
    if (o.reaction && a.role !== 'longeye') add('overwatch', -2);
    if (o.aimedAt) add('aimedShot', o.aimedAt === 'head' ? -4 : -2);
  } else {
    if (cheb(fx, fy, tx, ty) !== 1 || diagonalBlocked(s, fx, fy, tx, ty)) return bad('notAdjacent');
    addTn('defence', 6 + t.stats.quick + t.skills.evade);
    add('quickStat', a.stats.quick);
    add('meleeSkill', a.skills.melee);
    if (a.faction === 'choir') add('choir', 1);
  }
  addTn('braced', t.braced ? 2 : 0);
  addTn('focusGuard', t.focus.guard);
  add('focusAim', a.focus.aim);
  if (!o.reaction) add('luck', a.luckBonus);
  if (a.faction === 'union' && adjacentAlly(s, a)) add('solidarity', 1);
  add('wounded', woundPenalty(s, a));
  if (a.glitch) add('glitched', -2);
  if (a.pinned) add('pinned', -2);
  if (a.injuries.includes('brokenArm')) add('brokenArm', -2);
  if (a.injuries.includes('concussed')) add('concussed', -1);
  if (!o.reaction && !o.hypothetical && a.attacks > 0 && a.role !== 'breaker') add('secondAttack', -2);

  const mod = mods.reduce((n, p) => n + p.v, 0);
  const tn = tnParts.reduce((n, p) => n + p.v, 0);
  const dice = weaponDice(w, d, o.mode);
  const raw = dice * 3.5 + w.bonus + a.focus.damage + (kind === 'melee' ? meleeBonus(a) : 0);
  const armor = w.halfArmor ? Math.ceil(t.armor / 2) : t.armor;
  const avgDmg = rules.fixedDamage ? Math.max(1, Math.round(raw) - armor) : Math.max(0, raw - armor);
  return { ok: true, chance: hitChance(rules, mod, tn), tn, mod, mods, tnParts, dist: d, cover, avgDmg, weapon: wid };
}

/* ---------- Damage ---------- */

function addVp(s: GameState, ev: GameEvent[], team: number, amount: number, why: 'kill' | 'terminal'): void {
  s.vp[team] += amount;
  ev.push({ t: 'vp', team, amount, why, total: s.vp[team] });
}

function nerveCheck(s: GameState, r: Rand, ev: GameEvent[], u: Unit, tn: number): void {
  const rules = rulesOf(s);
  if (!rules.morale || u.isDrone || !isOk(u)) return;
  const roll = rollD10(r, rules);
  const ok = checkPasses(rules, roll, u.stats.nerve, tn);
  ev.push({ t: 'nerve', unit: u.id, roll: rollInfo(roll, u.stats.nerve, tn), ok });
  if (!ok) u.pinned = true;
}

function knockDown(s: GameState, r: Rand, ev: GameEvent[], u: Unit, by: Unit | null): void {
  const rules = rulesOf(s);
  const dead = !rules.downed || u.isDrone;
  u.state = dead ? 'dead' : 'down';
  u.overwatch = false;
  u.braced = false;
  ev.push({ t: 'down', unit: u.id, dead, by: by ? by.id : null });
  if (s.core && s.core.carrier === u.id) {
    s.core.carrier = null;
    s.core.x = u.x;
    s.core.y = u.y;
    ev.push({ t: 'core', unit: u.id, what: 'drop', x: u.x, y: u.y });
  }
  if (by && by.team !== u.team && !u.isDrone) {
    by.kills += 1;
    addVp(s, ev, by.team, Math.max(1, Math.floor(u.value / 10)), 'kill');
  }
  if (!u.isDrone) {
    for (const v of s.units) {
      if (v.team === u.team && v.id !== u.id && isOk(v) && cheb(v.x, v.y, u.x, u.y) <= 3) nerveCheck(s, r, ev, v, 11);
    }
  }
}

function hurt(s: GameState, r: Rand, ev: GameEvent[], t: Unit, dealt: number, by: Unit | null): void {
  if (dealt <= 0) return;
  t.hp = Math.max(0, t.hp - dealt);
  if (by) by.dealt += dealt;
  if (t.hp <= 0 && isOk(t)) knockDown(s, r, ev, t, by);
}

function applyInjury(ev: GameEvent[], t: Unit, injury: InjuryId): void {
  if (!t.injuries.includes(injury)) t.injuries.push(injury);
  if (injury === 'shaken') t.pinned = true;
  if (injury === 'concussed') t.seized = true;
  ev.push({ t: 'injury', target: t.id, injury });
}

const RANDOM_INJURIES: InjuryId[] = ['bleeding', 'brokenArm', 'brokenLeg', 'concussed', 'shaken', 'optics'];

function injuryFor(r: Rand, loc: HitLoc | null): InjuryId {
  if (loc === 'head') return r.next() < 0.5 ? 'concussed' : 'optics';
  if (loc === 'torso') return r.next() < 0.7 ? 'bleeding' : 'shaken';
  if (loc === 'arms') return 'brokenArm';
  if (loc === 'legs') return 'brokenLeg';
  return r.pick(RANDOM_INJURIES);
}

function rollLocation(r: Rand): HitLoc {
  const n = r.d(10);
  if (n === 1) return 'head';
  if (n <= 6) return 'torso';
  if (n <= 8) return 'arms';
  return 'legs';
}

function resolveAttack(
  s: GameState, r: Rand, ev: GameEvent[], a: Unit, t: Unit, kind: AttackKind,
  o: { mode?: ShotMode; aimedAt?: HitLoc; reaction?: boolean },
): void {
  const rules = rulesOf(s);
  const pv = previewAttack(s, a, t, kind, o);
  if (!pv.ok) illegal(pv.reason || 'attack');
  const w = WEAPONS[pv.weapon!];
  const mode: ShotMode = o.mode ?? 'single';
  if (kind === 'ranged') {
    if (rules.ammo) a.ammo -= mode === 'burst' ? 3 : 1;
    t.lastShotAtRound = s.round;
    a.aiming = 0;
  }
  if (!o.reaction) {
    a.attacks += 1;
    a.luckBonus = 0;
  }

  const roll = rollD10(r, rules);
  const hit = checkPasses(rules, roll, pv.mod, pv.tn);
  const margin = roll.nat + roll.extra + pv.mod - pv.tn;
  const crit = hit && rules.crits && margin >= CRIT_MARGIN;
  ev.push({
    t: 'attack', unit: a.id, target: t.id, weapon: w.id, kind, mode, roll: rollInfo(roll, pv.mod, pv.tn), hit, crit,
    overwatch: !!o.reaction, dist: pv.dist, cover: pv.cover,
  });

  if (!hit) {
    if (roll.nat === 1 && rules.fumbles && kind === 'ranged') resolveFumble(s, r, ev, a, t, w);
    return;
  }

  const loc: HitLoc | null = rules.hitLocations ? (o.aimedAt ?? rollLocation(r)) : null;
  const head = loc === 'head';
  let armor = head ? t.armorHead : t.armor;
  if (w.halfArmor) armor = Math.ceil(armor / 2);
  const dice: number[] = [];
  let bonus = w.bonus + a.focus.damage + (kind === 'melee' ? meleeBonus(a) : 0);
  let raw: number;
  if (rules.fixedDamage) {
    raw = Math.round(weaponDice(w, pv.dist, mode) * 3.5 + bonus);
    bonus = 0;
  } else {
    for (let i = 0, n = weaponDice(w, pv.dist, mode); i < n; i++) dice.push(r.d(6));
    raw = dice.reduce((x, y) => x + y, 0) + bonus;
  }
  let dealt = rules.fixedDamage ? Math.max(1, raw - armor) : Math.max(0, raw - armor);
  if (head) dealt *= 2;
  const critExtra = crit ? r.d(6) : 0;
  dealt += critExtra;
  ev.push({ t: 'damage', target: t.id, dice, bonus, raw, armor, dealt, hp: Math.max(0, t.hp - dealt), loc });

  if (rules.armorWear && raw > armor) {
    if (head) {
      t.armorHead = Math.max(0, t.armorHead - 1);
      ev.push({ t: 'armorWear', target: t.id, armor: t.armorHead, head: true });
    } else {
      t.armor = Math.max(0, t.armor - 1);
      ev.push({ t: 'armorWear', target: t.id, armor: t.armor, head: false });
    }
  }
  if (crit) applyInjury(ev, t, injuryFor(r, loc));
  else if (o.aimedAt && o.aimedAt !== 'head' && dealt >= 4) applyInjury(ev, t, injuryFor(r, o.aimedAt));
  const heavyHit = dealt * 5 >= t.hpMax * 2;
  hurt(s, r, ev, t, dealt, a);
  if ((crit || heavyHit) && isOk(t)) nerveCheck(s, r, ev, t, 12);
}

function resolveFumble(s: GameState, r: Rand, ev: GameEvent[], a: Unit, t: Unit, w: WeaponDef): void {
  const n = r.d(6);
  if (n <= 2) {
    a.jammed = true;
    ev.push({ t: 'fumble', unit: a.id, kind: 'jam' });
  } else if (n === 3) {
    a.ammo = 0;
    ev.push({ t: 'fumble', unit: a.id, kind: 'wasted' });
  } else if (n === 4) {
    const ally = s.units
      .filter((v) => isOk(v) && v.team === a.team && v.id !== a.id && cheb(v.x, v.y, a.x, a.y) <= 3)
      .sort((p, q) => cheb(p.x, p.y, t.x, t.y) - cheb(q.x, q.y, t.x, t.y))[0];
    if (!ally) {
      ev.push({ t: 'fumble', unit: a.id, kind: 'none' });
      return;
    }
    ev.push({ t: 'fumble', unit: a.id, kind: 'friendly', ally: ally.id });
    const dice: number[] = [];
    for (let i = 0; i < w.dice; i++) dice.push(r.d(6));
    const raw = dice.reduce((x, y) => x + y, 0) + w.bonus;
    const dealt = Math.max(0, Math.floor(raw / 2) - ally.armor);
    ev.push({ t: 'damage', target: ally.id, dice, bonus: w.bonus, raw, armor: ally.armor, dealt, hp: Math.max(0, ally.hp - dealt), loc: null });
    hurt(s, r, ev, ally, dealt, null);
  } else if (n === 5) {
    a.pinned = true;
    ev.push({ t: 'fumble', unit: a.id, kind: 'guard' });
  } else {
    ev.push({ t: 'fumble', unit: a.id, kind: 'none' });
  }
}

/* ---------- Availability, shared by the interface and the AI ---------- */

export interface UnitOptions {
  move: boolean; shoot: boolean; burst: boolean; melee: boolean; charge: boolean; aim: boolean; reload: boolean;
  brace: boolean; overwatch: boolean; clearJam: boolean; suppress: boolean; grenades: GrenadeKind[];
  programs: ProgramId[]; patch: boolean; repair: boolean; stim: boolean; spike: boolean; drone: boolean;
  capture: number[]; grab: boolean;
}

export const grenadeRange = (u: Unit): number => (u.role === 'sapper' ? 11 : 8);

export function adjacentFree(s: GameState, u: Unit): [number, number][] {
  const out: [number, number][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = u.x + dx;
      const y = u.y + dy;
      if (canStand(tileAt(s.map, x, y)) && !blockingUnit(s, x, y)) out.push([x, y]);
    }
  }
  return out;
}

export function patchTargets(s: GameState, u: Unit): Unit[] {
  if (u.skills.medic <= 0 || u.kits <= 0) return [];
  return s.units.filter((v) => {
    if (v.team !== u.team || v.isDrone || cheb(v.x, v.y, u.x, u.y) > 1) return false;
    if (v.state === 'down') return true;
    return isOk(v) && (v.hp < v.hpMax || v.injuries.includes('bleeding'));
  });
}

export function repairTargets(s: GameState, u: Unit): Unit[] {
  if (u.skills.tech <= 0) return [];
  return s.units.filter((v) => {
    if (v.team !== u.team || !isOk(v) || cheb(v.x, v.y, u.x, u.y) > 1) return false;
    if (v.isDrone && v.hp < v.hpMax) return true;
    return v.armor < v.armorMax || v.armorHead < v.armorHeadMax;
  });
}

export function hackTargets(s: GameState, u: Unit, program: ProgramId): Unit[] {
  if (program === 'terminal') return [];
  return s.units.filter((v) => {
    if (v.team === u.team || !isOk(v) || dist(u.x, u.y, v.x, v.y) > HACK_RANGE) return false;
    return program === 'hijack' ? v.isDrone : true;
  });
}

export function hackableTerminals(s: GameState, u: Unit): number[] {
  return s.terminals
    .filter((t) => t.owner !== u.team && dist(u.x, u.y, t.x, t.y) <= TERMINAL_HACK_RANGE)
    .map((t) => t.id);
}

export function hackPreview(s: GameState, u: Unit, program: ProgramId, targetId?: string, terminalId?: number): { chance: number; tn: number; mod: number } {
  const rules = rulesOf(s);
  let mod = u.stats.wire + u.skills.hack + woundPenalty(s, u) + u.luckBonus + (u.role === 'wire' ? Math.floor(u.rank / 2) : 0);
  if (u.hacks > 0 && u.role !== 'wire') mod -= 2;
  let tn: number;
  if (program === 'terminal') {
    const term = s.terminals.find((t) => t.id === terminalId);
    tn = term && term.owner !== null ? 19 : 16;
  } else {
    const t = targetId ? unitById(s, targetId) : undefined;
    tn = 14 + (t ? t.stats.wire : 0) + (t && t.chrome.includes('firewall') ? 2 : 0) + (program === 'hijack' ? 2 : 0);
  }
  return { chance: hitChance(rules, mod, tn), tn, mod };
}

export function capturableTerminals(s: GameState, u: Unit): number[] {
  return s.terminals
    .filter((t) => t.owner !== u.team && cheb(u.x, u.y, t.x, t.y) === 1)
    .filter((t) => !s.units.some((v) => isOk(v) && v.team !== u.team && cheb(v.x, v.y, t.x, t.y) <= 1))
    .map((t) => t.id);
}

export function chargeTile(s: GameState, u: Unit, t: Unit): [number, number] | null {
  const reach = reachable(s, u);
  let best: [number, number] | null = null;
  let bestCost = Infinity;
  for (const k of stoppable(s, u, reach)) {
    const x = k % s.map.w;
    const y = Math.floor(k / s.map.w);
    if (cheb(x, y, t.x, t.y) !== 1 || diagonalBlocked(s, x, y, t.x, t.y)) continue;
    const c = reach.get(k)!.cost;
    if (c < bestCost) { bestCost = c; best = [x, y]; }
  }
  return best;
}

export function unitOptions(s: GameState, u: Unit): UnitOptions {
  const rules = rulesOf(s);
  const can = u.ap >= 1 && isOk(u);
  const canNet = (can || u.net > 0) && isOk(u);
  const w = u.ranged ? WEAPONS[u.ranged] : null;
  const enemies = s.units.filter((v) => v.team !== u.team && isOk(v));
  const programs = !canNet || u.skills.hack <= 0 ? [] : rules.programs.filter((p) => {
    if (p === 'terminal') return s.terminals.length > 0 && hackableTerminals(s, u).length > 0;
    return hackTargets(s, u, p).length > 0;
  });
  return {
    move: can && stoppable(s, u, reachable(s, u)).length > 0,
    shoot: can && !!w && enemies.some((e) => previewAttack(s, u, e, 'ranged').ok),
    burst: can && !!w && rules.burst && w.burst && (!rules.ammo || u.ammo >= 3) && !u.jammed,
    melee: can && enemies.some((e) => previewAttack(s, u, e, 'melee').ok),
    charge: can && u.role === 'razor' && !u.charged && enemies.some((e) => chargeTile(s, u, e) !== null),
    aim: can && !!w && u.aiming === 0 && !u.jammed,
    reload: can && !!w && rules.ammo && u.ammo < w.mag,
    brace: can && !u.braced,
    overwatch: can && !!w && rules.overwatch && !u.jammed && (!rules.ammo || u.ammo >= 1),
    clearJam: can && u.jammed,
    suppress: can && !!w && rules.suppress && w.burst && !u.jammed && u.ammo >= 4,
    grenades: !can ? [] : (['frag', 'smoke', 'emp'] as GrenadeKind[]).filter((k) => u.grenades[k] > 0),
    programs,
    patch: can && patchTargets(s, u).length > 0,
    repair: can && repairTargets(s, u).length > 0,
    stim: can && u.chrome.includes('stim') && !u.used.includes('stim') && u.hp < u.hpMax,
    spike: isOk(u) && u.chrome.includes('spike') && !u.used.includes('spike'),
    drone: can && u.drones > 0 && adjacentFree(s, u).length > 0,
    capture: can ? capturableTerminals(s, u) : [],
    grab: can && !u.isDrone && !!s.core && s.core.carrier === null && cheb(u.x, u.y, s.core.x, s.core.y) <= 1,
  };
}

/* ---------- Turn flow ---------- */

function teamsStanding(s: GameState): Set<number> {
  const teams = new Set<number>();
  for (const u of s.units) if (isOk(u) && !u.isDrone) teams.add(u.team);
  return teams;
}

function finish(s: GameState, ev: GameEvent[], winner: number, reason: NonNullable<GameState['reason']>): void {
  s.phase = 'over';
  s.winner = winner;
  s.reason = reason;
  s.activeUnit = null;
  ev.push({ t: 'gameover', winner, reason });
}

function checkElimination(s: GameState, ev: GameEvent[], reason: 'elimination' | 'concede' = 'elimination'): boolean {
  if (s.phase === 'over') return true;
  const teams = teamsStanding(s);
  if (teams.size > 1) return false;
  finish(s, ev, teams.size === 1 ? [...teams][0] : -1, reason);
  return true;
}

function finishByPoints(s: GameState, ev: GameEvent[]): void {
  const standing = teamsStanding(s);
  const strength = (team: number) => s.units.filter((u) => u.team === team && isOk(u)).reduce((n, u) => n + u.value, 0);
  const teams = [...standing].sort((a, b) => s.vp[b] - s.vp[a] || strength(b) - strength(a));
  const [first, second] = teams;
  const tied = second !== undefined && s.vp[first] === s.vp[second] && strength(first) === strength(second);
  finish(s, ev, tied ? -1 : first, 'rounds');
}

/** Someone with no humanity left can turn on their own crew for a round. */
function snapChecks(s: GameState, r: Rand, ev: GameEvent[]): void {
  const rules = rulesOf(s);
  const others = s.cfg.sides.map((c, i) => ({ i, team: c.team }));
  for (const u of s.units) {
    if (!u.unstable || !isOk(u)) continue;
    const roll = rollD10(r, { ...rules, exploding: false });
    if (checkPasses(rules, roll, u.stats.nerve, 8)) continue;
    const foe = others.find((o) => o.team !== u.team);
    if (!foe) continue;
    u.snapped = { side: u.side, team: u.team };
    u.side = foe.i;
    u.team = foe.team;
    u.overwatch = false;
    ev.push({ t: 'snap', unit: u.id, roll: rollInfo(roll, u.stats.nerve, 8), side: u.side, team: u.team });
  }
}

function startRound(s: GameState, r: Rand, ev: GameEvent[]): void {
  const rules = rulesOf(s);
  s.round += 1;
  for (const u of s.units) {
    if (isOk(u)) { u.activated = false; u.ap = 0; }
    if (u.snapped) {
      u.side = u.snapped.side;
      u.team = u.snapped.team;
      u.snapped = null;
      if (isOk(u)) ev.push({ t: 'recover', unit: u.id, side: u.side, team: u.team });
    }
  }
  snapChecks(s, r, ev);
  const rolls: { side: number; nat: number; total: number; tie: number }[] = [];
  s.cfg.sides.forEach((_, side) => {
    const own = s.units.filter((u) => u.side === side && isOk(u));
    if (own.length === 0) return;
    const roll = rollD10(r, { ...rules, exploding: false });
    rolls.push({ side, nat: roll.nat, total: roll.nat + Math.max(...own.map((u) => u.stats.quick + u.focus.init)), tie: r.next() });
  });
  rolls.sort((a, b) => b.total - a.total || a.tie - b.tie);
  s.order = rolls.map((x) => x.side);
  s.turnIdx = 0;
  s.activeSide = s.order[0];
  s.activeUnit = null;
  ev.push({ t: 'round', round: s.round, rolls: rolls.map(({ side, nat, total }) => ({ side, nat, total })), order: [...s.order] });
  ev.push({ t: 'turn', side: s.activeSide });
}

function endRound(s: GameState, r: Rand, ev: GameEvent[]): void {
  const rules = rulesOf(s);
  for (const t of s.terminals) if (t.owner !== null) addVp(s, ev, t.owner, 1, 'terminal');
  for (const u of s.units) {
    if (isOk(u) && rules.bleeding && u.injuries.includes('bleeding')) {
      u.hp = Math.max(0, u.hp - 2);
      ev.push({ t: 'bleed', unit: u.id, amount: 2, hp: u.hp });
      if (u.hp <= 0) knockDown(s, r, ev, u, null);
    } else if (u.state === 'down' && rules.hitLocations) {
      const roll = rollD10(r, rules);
      // Every round on the ground makes the next roll harder, and two failures end it.
      const tn = 10 + u.downRounds * 2;
      u.downRounds += 1;
      const ok = checkPasses(rules, roll, u.stats.grit, tn);
      if (!ok) u.deathRolls += 1;
      ev.push({ t: 'deathRoll', unit: u.id, roll: rollInfo(roll, u.stats.grit, tn), ok, count: u.deathRolls });
      if (u.deathRolls >= 2) {
        u.state = 'dead';
        ev.push({ t: 'down', unit: u.id, dead: true, by: null });
      }
    }
  }
  s.smoke = s.smoke.filter((m) => m.until > s.round);
  if (checkElimination(s, ev)) return;
  if (s.round >= s.cfg.maxRounds) {
    finishByPoints(s, ev);
    return;
  }
  startRound(s, r, ev);
}

function advance(s: GameState, r: Rand, ev: GameEvent[]): void {
  s.activeUnit = null;
  const n = s.order.length;
  for (let i = 1; i <= n; i++) {
    const idx = (s.turnIdx + i) % n;
    const side = s.order[idx];
    if (s.units.some((u) => u.side === side && isOk(u) && !u.activated)) {
      s.turnIdx = idx;
      s.activeSide = side;
      ev.push({ t: 'turn', side });
      return;
    }
  }
  endRound(s, r, ev);
}

function endActivation(s: GameState, r: Rand, ev: GameEvent[], u: Unit): void {
  u.ap = 0;
  u.aiming = 0;
  u.glitch = false;
  u.pinned = false;
  u.net = 0;
  u.luckBonus = 0;
  ev.push({ t: 'endActivation', unit: u.id });
  advance(s, r, ev);
}

function settle(s: GameState, r: Rand, ev: GameEvent[]): void {
  if (s.phase !== 'battle') return;
  if (checkElimination(s, ev)) return;
  if (!s.activeUnit) return;
  const u = unitById(s, s.activeUnit)!;
  if (!isOk(u) || (u.ap <= 0 && u.net <= 0)) endActivation(s, r, ev, u);
}

function spend(u: Unit, n = 1): void {
  if (u.ap < n) illegal('noAp');
  u.ap -= n;
}

/* ---------- Actions ---------- */

function activeOf(s: GameState): Unit {
  if (s.phase !== 'battle') illegal('notBattle');
  if (!s.activeUnit) illegal('noActiveUnit');
  return unitById(s, s.activeUnit!)!;
}

function enemyTarget(s: GameState, u: Unit, id: string): Unit {
  const t = unitById(s, id);
  if (!t || !isOk(t) || t.team === u.team) return illegal('badTarget');
  return t;
}

function doMove(s: GameState, r: Rand, ev: GameEvent[], u: Unit, x: number, y: number): void {
  const rules = rulesOf(s);
  const reach = reachable(s, u);
  const key = x + y * s.map.w;
  if (!stoppable(s, u, reach).includes(key)) illegal('badMove');
  u.moved = true;
  const path = pathTo(s, reach, x, y);
  let segment: [number, number][] = [path[0]];
  const flush = () => {
    if (segment.length > 1) ev.push({ t: 'move', unit: u.id, path: segment });
    segment = [[u.x, u.y]];
  };
  for (let i = 1; i < path.length; i++) {
    [u.x, u.y] = path[i];
    segment.push(path[i]);
    if (s.core && s.core.carrier === u.id) { s.core.x = u.x; s.core.y = u.y; }
    if (rules.overwatch) {
      for (const e of s.units) {
        if (!isOk(e) || !e.overwatch || e.team === u.team || !isOk(u)) continue;
        const pv = previewAttack(s, e, u, 'ranged', { reaction: true });
        if (!pv.ok || pv.tn > 20) continue;
        flush();
        e.overwatch = false;
        resolveAttack(s, r, ev, e, u, 'ranged', { reaction: true });
      }
      if (!isOk(u)) return;
    }
    if (s.core && s.core.carrier === u.id && inRect(s.map.zones[u.side], u.x, u.y)) {
      flush();
      ev.push({ t: 'core', unit: u.id, what: 'extract', x: u.x, y: u.y });
      finish(s, ev, u.team, 'extraction');
      return;
    }
  }
  flush();
}

function doGrenade(s: GameState, r: Rand, ev: GameEvent[], u: Unit, kind: GrenadeKind, x: number, y: number): void {
  const rules = rulesOf(s);
  if (u.grenades[kind] <= 0) illegal('noGrenade');
  if (tileAt(s.map, x, y) === '#') illegal('badTile');
  const d = dist(u.x, u.y, x, y);
  if (d > grenadeRange(u)) illegal('outOfRange');
  if (d > 2 && !losBetween(s, u.x, u.y, x, y).visible) illegal('noLos');
  u.grenades[kind] -= 1;

  let landX = x;
  let landY = y;
  let info: RollInfo | null = null;
  let hit = true;
  if (rules.scatter) {
    const mod = u.stats.aim + u.skills.firearms + woundPenalty(s, u);
    const roll = rollD10(r, rules);
    hit = checkPasses(rules, roll, mod, 12);
    info = rollInfo(roll, mod, 12);
    if (!hit) {
      const [dx, dy] = r.pick([[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]);
      const steps = r.d(3);
      for (let i = 0; i < steps; i++) {
        if (tileAt(s.map, landX + dx, landY + dy) === '#') break;
        landX += dx;
        landY += dy;
      }
    }
  }
  ev.push({ t: 'grenade', unit: u.id, kind, x, y, landX, landY, roll: info, hit });

  if (kind === 'smoke') {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (tileAt(s.map, landX + dx, landY + dy) !== '#') s.smoke.push({ x: landX + dx, y: landY + dy, until: s.round + 1 });
      }
    }
    s.smoke = [...s.smoke];
    return;
  }
  const radius = kind === 'emp' ? 2 : 1;
  for (const v of [...s.units]) {
    if (!isOk(v)) continue;
    const c = cheb(v.x, v.y, landX, landY);
    if (c > radius || (c > 0 && !los(s.map, null, landX, landY, v.x, v.y).visible)) continue;
    if (kind === 'frag') {
      const n = 3 + (u.role === 'sapper' ? 1 + Math.floor(u.rank / 3) : 0);
      const dice: number[] = [];
      let raw: number;
      if (rules.fixedDamage) raw = Math.round(n * 3.5);
      else {
        for (let i = 0; i < n; i++) dice.push(r.d(6));
        raw = dice.reduce((a, b) => a + b, 0);
      }
      if (c > 0) raw = Math.floor(raw / 2);
      const armor = Math.ceil(v.armor / 2);
      const dealt = rules.fixedDamage ? Math.max(1, raw - armor) : Math.max(0, raw - armor);
      ev.push({ t: 'damage', target: v.id, dice, bonus: 0, raw, armor, dealt, hp: Math.max(0, v.hp - dealt), loc: null });
      hurt(s, r, ev, v, dealt, u);
      if (isOk(v) && dealt > 0) nerveCheck(s, r, ev, v, 11);
    } else if (v.isDrone) {
      const dice = [r.d(6), r.d(6)];
      const dealt = dice[0] + dice[1];
      ev.push({ t: 'damage', target: v.id, dice, bonus: 0, raw: dealt, armor: 0, dealt, hp: Math.max(0, v.hp - dealt), loc: null });
      hurt(s, r, ev, v, dealt, u);
    } else if (v.chrome.length > 0) {
      v.seized = true;
    }
  }
}

function doHack(s: GameState, r: Rand, ev: GameEvent[], u: Unit, program: ProgramId, targetId?: string, terminalId?: number): void {
  const rules = rulesOf(s);
  if (u.skills.hack <= 0 || !rules.programs.includes(program)) illegal('cannotHack');
  let target: Unit | undefined;
  if (program === 'terminal') {
    if (!hackableTerminals(s, u).includes(terminalId ?? -1)) illegal('badTarget');
  } else {
    target = targetId ? unitById(s, targetId) : undefined;
    if (!target || !hackTargets(s, u, program).some((v) => v.id === target!.id)) illegal('badTarget');
  }
  const pv = hackPreview(s, u, program, targetId, terminalId);
  u.hacks += 1;
  u.luckBonus = 0;
  const roll = rollD10(r, rules);
  const ok = checkPasses(rules, roll, pv.mod, pv.tn);
  ev.push({ t: 'hack', unit: u.id, program, target: targetId, terminal: terminalId, roll: rollInfo(roll, pv.mod, pv.tn), ok });
  if (!ok) {
    // Going deep is dangerous: a badly failed run wakes something that hits the hacker directly.
    if (rules.netDive && u.role === 'wire' && roll.nat + roll.extra + pv.mod <= pv.tn - 5) {
      const dealt = rules.hitLocations ? r.d(6) + r.d(6) : r.d(6);
      ev.push({ t: 'hunter', unit: u.id, dealt, hp: Math.max(0, u.hp - dealt) });
      hurt(s, r, ev, u, dealt, null);
    }
    return;
  }
  if (target && target.rez > 0) {
    // A hacker's own defences take the hit first.
    target.rez -= 1;
    ev.push({ t: 'ward', target: target.id, rez: target.rez });
    return;
  }
  if (program === 'terminal') {
    const term = s.terminals.find((t) => t.id === terminalId)!;
    term.owner = u.team;
    ev.push({ t: 'capture', unit: u.id, terminal: term.id, team: u.team });
  } else if (target) {
    if (program === 'glitch') target.glitch = true;
    else if (program === 'seize') target.seized = true;
    else if (program === 'hijack') {
      target.team = u.team;
      target.side = u.side;
      target.activated = true;
      target.overwatch = false;
    } else if (program === 'burn') {
      const dice = [r.d(6), r.d(6)];
      const dealt = dice[0] + dice[1];
      ev.push({ t: 'damage', target: target.id, dice, bonus: 0, raw: dealt, armor: 0, dealt, hp: Math.max(0, target.hp - dealt), loc: null });
      hurt(s, r, ev, target, dealt, u);
    }
  }
}

function doPatch(s: GameState, r: Rand, ev: GameEvent[], u: Unit, targetId: string): void {
  const rules = rulesOf(s);
  const t = unitById(s, targetId);
  if (!t || !patchTargets(s, u).some((v) => v.id === t.id)) return illegal('badTarget');
  u.kits -= 1;
  const revive = t.state === 'down';
  let ok = true;
  let info: RollInfo | null = null;
  if (!rules.fixedDamage) {
    const mod = u.stats.wire + u.skills.medic;
    const tn = revive ? 15 : 12;
    const roll = rollD10(r, rules);
    ok = checkPasses(rules, roll, mod, tn);
    info = rollInfo(roll, mod, tn);
  }
  let healed = 0;
  if (ok) {
    healed = (rules.fixedDamage ? 7 : r.d(6) + Math.floor(u.skills.medic / 2)) + Math.floor(u.rank / 2);
    if (revive) {
      t.state = 'ok';
      t.deathRolls = 0;
      t.downRounds = 0;
      t.seized = true;
      t.activated = true;
    }
    t.hp = Math.min(t.hpMax, t.hp + healed);
    t.injuries = t.injuries.filter((i) => i !== 'bleeding');
  }
  ev.push({ t: 'patch', unit: u.id, target: t.id, ok, healed, hp: t.hp, revived: revive && ok, roll: info });
}

function doRepair(s: GameState, r: Rand, ev: GameEvent[], u: Unit, targetId: string): void {
  const t = unitById(s, targetId);
  if (!t || !repairTargets(s, u).some((v) => v.id === t.id)) return illegal('badTarget');
  if (t.isDrone) t.hp = Math.min(t.hpMax, t.hp + r.d(6) + r.d(6));
  t.armor = Math.min(t.armorMax, t.armor + 2);
  t.armorHead = Math.min(t.armorHeadMax, t.armorHead + 1);
  ev.push({ t: 'repair', unit: u.id, target: t.id, hp: t.hp, armor: t.armor });
}

/** A human game master spends their budget to bring fresh enemies in at their own edge of the map. */
function doReinforce(s: GameState, ev: GameEvent[], side: number, role: RoleId, x: number, y: number): void {
  if (s.activeUnit) illegal('alreadyActive');
  if (s.cfg.sides[side].control !== 'human') illegal('badUnit');
  const left = s.gmBudget?.[side];
  if (left === undefined || !RECRUITABLE.includes(role)) illegal('badUnit');
  const def = ROLES[role];
  if (def.cost > left!) illegal('noBudget');
  if (!inRect(s.map.zones[side], x, y) || !canStand(tileAt(s.map, x, y)) || blockingUnit(s, x, y)) illegal('badTile');
  const count = s.units.filter((v) => v.side === side).length;
  const unit = makeUnit(s.cfg, side, makeLoadout(role, def.ranged[0], def.melee[0]), count);
  unit.id = `s${side}u${100 + s.units.length}`;
  unit.x = x;
  unit.y = y;
  unit.activated = true;
  s.units.push(unit);
  s.gmBudget = { ...s.gmBudget, [side]: left! - def.cost };
  ev.push({ t: 'reinforce', unit: { ...unit }, left: left! - def.cost });
}

function doDrone(s: GameState, ev: GameEvent[], u: Unit, x: number, y: number): void {
  if (u.drones <= 0) illegal('noDrone');
  if (!adjacentFree(s, u).some(([a, b]) => a === x && b === y)) illegal('badTile');
  u.drones -= 1;
  const loadout: Loadout = { role: 'drone', ranged: 'dronegun', melee: 'ram', chrome: [], extra: { frag: 0, smoke: 0, emp: 0 }, name: `${u.name} / D` };
  const drone = makeUnit(s.cfg, u.side, loadout, 100 + s.units.length);
  drone.x = x;
  drone.y = y;
  drone.activated = true;
  drone.team = u.team;
  s.units.push(drone);
  ev.push({ t: 'drone', unit: u.id, drone: { ...drone } });
}

function nextDeployer(s: GameState, r: Rand, ev: GameEvent[]): void {
  const next = s.ready.findIndex((x) => !x);
  if (next >= 0) {
    s.activeSide = next;
    ev.push({ t: 'turn', side: next });
    return;
  }
  s.phase = 'battle';
  startRound(s, r, ev);
}

const GRENADE_KINDS: readonly unknown[] = ['frag', 'smoke', 'emp'];
const FOCUS_KINDS: readonly unknown[] = ['aim', 'damage', 'guard', 'init'];
const AIM_SPOTS: readonly unknown[] = ['head', 'torso', 'arms', 'legs'];

/** Actions can arrive from another player's game, so their shape isn't taken on trust. */
function checkShape(a: Action): void {
  const f = a as unknown as Record<string, unknown> | null;
  if (!f || typeof f !== 'object' || typeof f.type !== 'string') illegal('badAction');
  for (const k of ['x', 'y', 'terminalId']) if (f![k] !== undefined && !Number.isInteger(f![k])) illegal('badAction');
  for (const k of ['unitId', 'targetId']) if (f![k] !== undefined && typeof f![k] !== 'string') illegal('badAction');
  if (f!.type === 'grenade' && !GRENADE_KINDS.includes(f!.kind)) illegal('badAction');
  if (f!.type === 'focus' && !FOCUS_KINDS.includes(f!.kind)) illegal('badAction');
  if (f!.aimedAt !== undefined && !AIM_SPOTS.includes(f!.aimedAt)) illegal('badAction');
  if (f!.mode !== undefined && f!.mode !== 'single' && f!.mode !== 'burst') illegal('badAction');
}

function dispatch(s: GameState, r: Rand, ev: GameEvent[], a: Action, side: number): void {
  checkShape(a);
  if (a.type === 'concede') {
    if (s.phase === 'over' || s.conceded[side]) illegal('alreadyOver');
    s.conceded[side] = true;
    s.ready[side] = true;
    for (const u of s.units) {
      if (u.side !== side) continue;
      // The board treats everyone as gone, but those still alive got out; the dead stay dead.
      if (u.state !== 'dead') u.retreated = true;
      if (s.core && s.core.carrier === u.id) {
        s.core.carrier = null;
        s.core.x = u.x;
        s.core.y = u.y;
        ev.push({ t: 'core', unit: u.id, what: 'drop', x: u.x, y: u.y });
      }
      u.state = 'dead';
    }
    ev.push({ t: 'concede', side });
    if (checkElimination(s, ev, 'concede')) return;
    if (s.phase === 'deploy') {
      if (s.activeSide === side) nextDeployer(s, r, ev);
    } else if (s.activeSide === side) {
      advance(s, r, ev);
    } else if (s.activeUnit && !isOk(unitById(s, s.activeUnit)!)) {
      advance(s, r, ev);
    }
    return;
  }

  if (s.phase === 'over') illegal('gameOver');
  if (side !== s.activeSide) illegal('notYourTurn');

  if (s.phase === 'deploy') {
    if (a.type === 'place') {
      const u = unitById(s, a.unitId);
      if (!u || u.side !== side) return illegal('badUnit');
      if (!inRect(s.map.zones[side], a.x, a.y) || !canStand(tileAt(s.map, a.x, a.y))) illegal('badTile');
      const other = blockingUnit(s, a.x, a.y);
      if (other && other.id !== u.id) {
        other.x = u.x;
        other.y = u.y;
      }
      u.x = a.x;
      u.y = a.y;
      return;
    }
    if (a.type === 'ready') {
      s.ready[side] = true;
      ev.push({ t: 'deployed', side });
      nextDeployer(s, r, ev);
      return;
    }
    illegal('deploying');
  }

  if (a.type === 'reinforce') {
    doReinforce(s, ev, side, a.role, a.x, a.y);
    return;
  }

  if (a.type === 'select') {
    if (s.activeUnit) illegal('alreadyActive');
    const u = unitById(s, a.unitId);
    if (!u || u.side !== side || !isOk(u) || u.activated) return illegal('badUnit');
    s.activeUnit = u.id;
    u.activated = true;
    u.ap = ACTIONS_PER_ACTIVATION;
    u.moved = false;
    u.attacks = 0;
    u.hacks = 0;
    u.charged = false;
    u.aiming = 0;
    u.overwatch = false;
    u.braced = false;
    if (u.seized) { u.ap -= 1; u.seized = false; }
    if (u.pinned) u.ap -= 1;
    u.ap = Math.max(0, u.ap);
    ev.push({ t: 'activate', unit: u.id, ap: u.ap });
    return;
  }

  const u = activeOf(s);
  switch (a.type) {
    case 'move': spend(u); doMove(s, r, ev, u, a.x, a.y); break;
    case 'shoot': {
      const rules = rulesOf(s);
      const t = enemyTarget(s, u, a.targetId);
      if (a.mode === 'burst' && !unitOptions(s, u).burst) illegal('noBurst');
      if (a.aimedAt && !rules.aimedShots) illegal('noAimedShots');
      spend(u);
      resolveAttack(s, r, ev, u, t, 'ranged', { mode: a.mode, aimedAt: a.aimedAt });
      break;
    }
    case 'melee': {
      const t = enemyTarget(s, u, a.targetId);
      spend(u);
      resolveAttack(s, r, ev, u, t, 'melee', {});
      break;
    }
    case 'charge': {
      if (u.role !== 'razor' || u.charged) illegal('cannotCharge');
      const t = enemyTarget(s, u, a.targetId);
      const tile = chargeTile(s, u, t);
      if (!tile) return illegal('noRoute');
      spend(u);
      u.charged = true;
      doMove(s, r, ev, u, tile[0], tile[1]);
      if (isOk(u) && isOk(t) && s.phase === 'battle') resolveAttack(s, r, ev, u, t, 'melee', {});
      break;
    }
    case 'aim': {
      if (!unitOptions(s, u).aim) illegal('cannotAim');
      spend(u);
      u.aiming = (u.role === 'longeye' ? 3 : 2) + (u.chrome.includes('targeteye') ? 1 : 0);
      ev.push({ t: 'aim', unit: u.id, bonus: u.aiming });
      break;
    }
    case 'reload': {
      if (!unitOptions(s, u).reload) illegal('cannotReload');
      spend(u);
      u.ammo = WEAPONS[u.ranged!].mag;
      ev.push({ t: 'reload', unit: u.id, ammo: u.ammo });
      break;
    }
    case 'brace': spend(u); u.braced = true; ev.push({ t: 'brace', unit: u.id }); break;
    case 'overwatch': {
      if (!unitOptions(s, u).overwatch) illegal('cannotOverwatch');
      u.ap = 0;
      u.overwatch = true;
      ev.push({ t: 'overwatch', unit: u.id });
      break;
    }
    case 'clearJam': {
      if (!u.jammed) illegal('notJammed');
      spend(u);
      u.jammed = false;
      ev.push({ t: 'clearJam', unit: u.id });
      break;
    }
    case 'suppress': {
      if (!unitOptions(s, u).suppress) illegal('cannotSuppress');
      const d = dist(u.x, u.y, a.x, a.y);
      if (d > 14 || !losBetween(s, u.x, u.y, a.x, a.y).visible) illegal('noLos');
      spend(u);
      u.ammo -= Math.min(u.ammo, 6);
      ev.push({ t: 'suppress', unit: u.id, x: a.x, y: a.y });
      for (const v of s.units) {
        if (isOk(v) && v.team !== u.team && cheb(v.x, v.y, a.x, a.y) <= 1) nerveCheck(s, r, ev, v, 14);
      }
      break;
    }
    case 'grenade': spend(u); doGrenade(s, r, ev, u, a.kind, a.x, a.y); break;
    case 'hack':
      // A Wire pays one action to jack in, then has several network actions to spend.
      if (rulesOf(s).netDive && u.role === 'wire') {
        if (u.net <= 0) {
          spend(u);
          u.net = 2 + Math.floor(u.rank / 3);
          ev.push({ t: 'jackIn', unit: u.id, net: u.net });
        }
        doHack(s, r, ev, u, a.program, a.targetId, a.terminalId);
        u.net -= 1;
      } else {
        spend(u);
        doHack(s, r, ev, u, a.program, a.targetId, a.terminalId);
      }
      break;
    case 'luck':
      if (u.luck <= 0) illegal('noLuck');
      u.luck -= 1;
      u.luckBonus += 2;
      ev.push({ t: 'luck', unit: u.id, left: u.luck });
      break;
    case 'focus': {
      if (u.role !== 'breaker') illegal('badUnit');
      const from = (Object.keys(u.focus) as FocusKind[]).filter((k) => k !== a.kind).sort((x, y) => u.focus[y] - u.focus[x])[0];
      if (u.focus[from] <= 0) illegal('noFocus');
      u.focus[from] -= 1;
      u.focus[a.kind] += 1;
      ev.push({ t: 'focus', unit: u.id, focus: { ...u.focus } });
      break;
    }
    case 'patch': spend(u); doPatch(s, r, ev, u, a.targetId); break;
    case 'repair': spend(u); doRepair(s, r, ev, u, a.targetId); break;
    case 'stim': {
      if (!unitOptions(s, u).stim) illegal('cannotStim');
      spend(u);
      u.used.push('stim');
      const healed = rulesOf(s).fixedDamage ? 7 : r.d(6) + r.d(6);
      u.hp = Math.min(u.hpMax, u.hp + healed);
      ev.push({ t: 'stim', unit: u.id, healed, hp: u.hp });
      break;
    }
    case 'spike': {
      if (!unitOptions(s, u).spike) illegal('cannotSpike');
      u.used.push('spike');
      u.ap += 1;
      ev.push({ t: 'spike', unit: u.id });
      break;
    }
    case 'drone': spend(u); doDrone(s, ev, u, a.x, a.y); break;
    case 'capture': {
      if (!capturableTerminals(s, u).includes(a.terminalId)) illegal('badTarget');
      spend(u);
      s.terminals.find((t) => t.id === a.terminalId)!.owner = u.team;
      ev.push({ t: 'capture', unit: u.id, terminal: a.terminalId, team: u.team });
      break;
    }
    case 'grab': {
      if (!unitOptions(s, u).grab) illegal('cannotGrab');
      spend(u);
      s.core!.carrier = u.id;
      s.core!.x = u.x;
      s.core!.y = u.y;
      ev.push({ t: 'core', unit: u.id, what: 'grab', x: u.x, y: u.y });
      if (inRect(s.map.zones[u.side], u.x, u.y)) {
        ev.push({ t: 'core', unit: u.id, what: 'extract', x: u.x, y: u.y });
        finish(s, ev, u.team, 'extraction');
      }
      break;
    }
    case 'end': endActivation(s, r, ev, u); return;
    default: illegal('unknownAction');
  }
}

export interface ApplyResult { ok: boolean; state: GameState; events: GameEvent[]; error?: string }

/** Pure step function: the input state is left untouched. */
export function applyAction(prev: GameState, action: Action, side: number): ApplyResult {
  const s = clone(prev);
  const r = new Rand(s.rng);
  const ev: GameEvent[] = [];
  try {
    dispatch(s, r, ev, action, side);
    settle(s, r, ev);
  } catch (e) {
    if (e instanceof Illegal) return { ok: false, state: prev, events: [], error: e.message };
    throw e;
  }
  s.rng = r.state;
  s.seq += 1;
  return { ok: true, state: s, events: ev };
}

/** Which side has to act now, or null if the game is over. */
export function actingSide(s: GameState): number | null {
  return s.phase === 'over' ? null : s.activeSide;
}

export function setSideControl(s: GameState, side: number, control: 'human' | 'ai'): GameState {
  const sides = s.cfg.sides.map((c, i) => (i === side ? { ...c, control } : c));
  return { ...s, cfg: { ...s.cfg, sides } };
}
