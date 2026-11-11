import { WEAPONS } from './data';
import {
  adjacentFree, chargeTile, grenadeRange, hackPreview, hackTargets, hackableTerminals, isOk,
  losBetween, moveOf, patchTargets, previewAttack, reachable, repairTargets, rulesOf, stoppable, unitById, unitOptions,
} from './game';
import { cheb, dist, inRect, tileAt } from './map';
import type { Rand } from './rng';
import type { Action, AiLevel, GameState, GrenadeKind, Unit } from './types';

interface Tuning { exposure: number; noise: number; focus: number; tactics: boolean }

const TUNING: Record<AiLevel, Tuning> = {
  easy: { exposure: 0.05, noise: 5.5, focus: 0, tactics: false },
  normal: { exposure: 0.6, noise: 0.8, focus: 0.5, tactics: true },
  hard: { exposure: 1, noise: 0.1, focus: 1, tactics: true },
};

const valueOf = (u: Unit) => Math.max(6, u.value) / 20;

function attackValue(chance: number, avgDmg: number, t: Unit, focus: number): number {
  const effective = Math.min(avgDmg, t.hp);
  let v = chance * (effective / t.hpMax) * 8 * valueOf(t);
  if (avgDmg >= t.hp) v += chance * 5 * valueOf(t);
  v += chance * focus * (1 - t.hp / t.hpMax) * 1.5;
  return v;
}

function bestAttackFrom(s: GameState, u: Unit, enemies: Unit[], x: number, y: number, tune: Tuning): number {
  let best = 0;
  for (const e of enemies) {
    const rangedV = u.ranged
      ? previewAttack(s, u, e, 'ranged', { fx: x, fy: y, hypothetical: true })
      : null;
    if (rangedV?.ok) best = Math.max(best, attackValue(rangedV.chance, rangedV.avgDmg, e, tune.focus));
    if (cheb(x, y, e.x, e.y) === 1) {
      const m = previewAttack(s, u, e, 'melee', { fx: x, fy: y, hypothetical: true });
      if (m.ok) best = Math.max(best, attackValue(m.chance, m.avgDmg, e, tune.focus));
    }
  }
  return best;
}

function exposureAt(s: GameState, u: Unit, enemies: Unit[], x: number, y: number): number {
  let danger = 0;
  for (const e of enemies) {
    if (!e.ranged) {
      const closeness = cheb(x, y, e.x, e.y);
      if (closeness <= moveOf(s, e) + 1) danger += 0.25;
      continue;
    }
    const pv = previewAttack(s, e, u, 'ranged', { tx: x, ty: y, hypothetical: true });
    if (pv.ok) danger += pv.chance * Math.min(1, pv.avgDmg / Math.max(1, u.hp));
  }
  return danger;
}

function nearest<T extends { x: number; y: number }>(items: T[], x: number, y: number): { item: T | null; d: number } {
  let item: T | null = null;
  let d = Infinity;
  for (const it of items) {
    const v = dist(x, y, it.x, it.y);
    if (v < d) { d = v; item = it; }
  }
  return { item, d };
}

/** How much the unit wants to stand on this tile for objective and role reasons. */
function positionPull(s: GameState, u: Unit, enemies: Unit[], allies: Unit[], x: number, y: number): number {
  let pull = 0;
  const { item: closest, d: enemyDist } = nearest(enemies, x, y);
  const w = u.ranged ? WEAPONS[u.ranged] : null;
  if (u.role === 'razor' || !w) {
    pull -= enemyDist * 0.35;
  } else if (closest) {
    // Prefer the distance where the weapon's target number is lowest.
    const sweet = w.bands.reduce((a, b) => (b[1] < a[1] ? b : a));
    pull -= Math.abs(enemyDist - sweet[0] * 0.8) * 0.12;
  }

  if (s.cfg.scenario === 'terminals') {
    const targets = s.terminals.filter((t) => t.owner !== u.team);
    const { d } = nearest(targets.length ? targets : s.terminals, x, y);
    if (Number.isFinite(d)) pull -= d * (u.role === 'wire' ? 0.15 : 0.35);
  } else if (s.cfg.scenario === 'heist' && s.core) {
    const zone = s.map.zones[u.side];
    if (s.core.carrier === u.id) {
      const zx = Math.min(Math.max(x, zone.x), zone.x + zone.w - 1);
      const zy = Math.min(Math.max(y, zone.y), zone.y + zone.h - 1);
      pull -= dist(x, y, zx, zy) * 1.6;
    } else {
      pull -= dist(x, y, s.core.x, s.core.y) * (u.isDrone ? 0.15 : 0.4);
    }
  }

  if (u.role === 'patcher') {
    const hurtAlly = allies.filter((a) => a.id !== u.id && (a.state === 'down' || a.hp < a.hpMax * 0.7));
    const { d } = nearest(hurtAlly, x, y);
    if (Number.isFinite(d)) pull -= d * 0.45;
    else {
      const { d: near } = nearest(allies.filter((a) => a.id !== u.id && isOk(a)), x, y);
      if (Number.isFinite(near)) pull -= near * 0.2;
    }
  }
  if (tileAt(s.map, x, y) === '~') pull -= 0.3;
  return pull;
}

interface Scored { action: Action; score: number }

function grenadeOptions(s: GameState, u: Unit, enemies: Unit[], allies: Unit[], tune: Tuning): Scored[] {
  const out: Scored[] = [];
  const range = grenadeRange(u);
  const inReach = (e: Unit) => {
    const d = dist(u.x, u.y, e.x, e.y);
    return d <= range && d >= 2 && losBetween(s, u.x, u.y, e.x, e.y).visible;
  };
  if (u.grenades.frag > 0) {
    for (const e of enemies.filter(inReach)) {
      let score = 0;
      for (const v of enemies) {
        const c = cheb(v.x, v.y, e.x, e.y);
        if (c <= 1) score += (c === 0 ? 1 : 0.5) * 2.4 * valueOf(v);
      }
      for (const v of allies) {
        const c = cheb(v.x, v.y, e.x, e.y);
        if (isOk(v) && c <= 1) score -= (c === 0 ? 1 : 0.5) * 3.5 * valueOf(v);
      }
      out.push({ action: { type: 'grenade', kind: 'frag', x: e.x, y: e.y }, score: tune.tactics ? score : score * 0.7 });
    }
  }
  const emp: GrenadeKind = 'emp';
  if (u.grenades.emp > 0 && tune.tactics) {
    for (const e of enemies.filter((v) => inReach(v) && (v.isDrone || v.chrome.length > 0))) {
      const wired = (v: Unit) => cheb(v.x, v.y, e.x, e.y) <= 2 && (v.isDrone || v.chrome.length > 0);
      // The pulse doesn't pick sides, so the squad's own chrome and drones count against the throw.
      const own = allies.filter((v) => isOk(v) && wired(v)).length;
      out.push({ action: { type: 'grenade', kind: emp, x: e.x, y: e.y }, score: (enemies.filter(wired).length - own * 1.5) * 1.1 });
    }
  }
  return out;
}

function hackOptions(s: GameState, u: Unit, enemies: Unit[], programs: string[], tune: Tuning): Scored[] {
  const out: Scored[] = [];
  for (const program of programs) {
    if (program === 'terminal') {
      for (const terminalId of hackableTerminals(s, u)) {
        const pv = hackPreview(s, u, 'terminal', undefined, terminalId);
        out.push({ action: { type: 'hack', program: 'terminal', terminalId }, score: pv.chance * 5 });
      }
      continue;
    }
    if (program !== 'burn' && program !== 'hijack' && program !== 'glitch' && program !== 'seize') continue;
    for (const t of hackTargets(s, u, program)) {
      const pv = hackPreview(s, u, program, t.id);
      let score = 0;
      if (program === 'burn') score = attackValue(pv.chance, 7, t, tune.focus);
      else if (program === 'hijack') score = pv.chance * 3;
      else if (program === 'seize') score = t.seized ? 0 : pv.chance * 1.8 * valueOf(t);
      else if (program === 'glitch') score = t.glitch || !t.ranged ? 0 : pv.chance * 1.2 * valueOf(t);
      // A failed hack on backlash chrome hurts, so it's only worth it on good odds.
      if (t.chrome.includes('backlash') && u.rez === 0) score -= (1 - pv.chance) * 1.5;
      if (enemies.includes(t) && score > 0) out.push({ action: { type: 'hack', program, targetId: t.id }, score });
    }
  }
  return out;
}

/** The next action for this side. Only ever returns legal actions; falls back to ending the activation. */
export function chooseAction(s: GameState, side: number, level: AiLevel, rnd: Rand): Action {
  if (s.phase === 'deploy') return { type: 'ready' };
  const tune = TUNING[level];
  const enemies = s.units.filter((v) => v.team !== s.cfg.sides[side].team && isOk(v));

  if (!s.activeUnit) return { type: 'select', unitId: pickUnit(s, side, enemies, tune, rnd).id };

  const u = unitById(s, s.activeUnit)!;
  const allies = s.units.filter((v) => v.team === u.team && v.state !== 'dead');
  const opts = unitOptions(s, u);
  const candidates: Scored[] = [{ action: { type: 'end' }, score: 0 }];
  const ap = u.ap;

  // Attacks from where the unit stands now.
  let bestNow = 0;
  for (const e of enemies) {
    if (opts.shoot) {
      const pv = previewAttack(s, u, e, 'ranged');
      if (pv.ok) {
        const score = attackValue(pv.chance, pv.avgDmg, e, tune.focus);
        bestNow = Math.max(bestNow, score);
        candidates.push({ action: { type: 'shoot', targetId: e.id }, score: score + 0.6 });
        if (opts.burst) {
          const b = previewAttack(s, u, e, 'ranged', { mode: 'burst' });
          if (b.ok) candidates.push({ action: { type: 'shoot', targetId: e.id, mode: 'burst' }, score: attackValue(b.chance, b.avgDmg, e, tune.focus) + 0.5 });
        }
      }
    }
    if (opts.melee) {
      const pv = previewAttack(s, u, e, 'melee');
      if (pv.ok) {
        const score = attackValue(pv.chance, pv.avgDmg, e, tune.focus);
        bestNow = Math.max(bestNow, score);
        candidates.push({ action: { type: 'melee', targetId: e.id }, score: score + 0.6 });
      }
    }
    if (opts.charge && cheb(u.x, u.y, e.x, e.y) > 1) {
      const tile = chargeTile(s, u, e);
      if (tile) {
        const pv = previewAttack(s, u, e, 'melee', { fx: tile[0], fy: tile[1], hypothetical: true });
        if (pv.ok) candidates.push({ action: { type: 'charge', targetId: e.id }, score: attackValue(pv.chance, pv.avgDmg, e, tune.focus) + 1 });
      }
    }
  }

  // Moves. A tile is worth what it lets the unit do next, minus how much danger it stands in.
  if (opts.move) {
    const reach = reachable(s, u);
    const w = u.ranged ? WEAPONS[u.ranged] : null;
    const hereExposure = exposureAt(s, u, enemies, u.x, u.y);
    const herePull = positionPull(s, u, enemies, allies, u.x, u.y);
    for (const k of stoppable(s, u, reach)) {
      const x = k % s.map.w;
      const y = Math.floor(k / s.map.w);
      const exposure = exposureAt(s, u, enemies, x, y);
      const pull = positionPull(s, u, enemies, allies, x, y);
      let score = (pull - herePull) + (hereExposure - exposure) * 2 * tune.exposure;
      if (ap >= 2 && !(w?.heavy)) score += bestAttackFrom(s, u, enemies, x, y, tune) * 0.95;
      else score += bestAttackFrom(s, u, enemies, x, y, tune) * 0.3;
      candidates.push({ action: { type: 'move', x, y }, score });
    }
  }

  if (opts.reload) {
    const w = WEAPONS[u.ranged!];
    const empty = u.ammo === 0;
    candidates.push({ action: { type: 'reload' }, score: empty ? 2.2 : u.ammo < w.mag / 3 ? 0.7 : 0.05 });
  }
  if (opts.clearJam) candidates.push({ action: { type: 'clearJam' }, score: 2.5 });

  if (opts.aim && ap >= 2 && tune.tactics && u.ranged) {
    for (const e of enemies) {
      const now = previewAttack(s, u, e, 'ranged');
      if (!now.ok) continue;
      const bonus = (u.role === 'longeye' ? 3 : 2) / 10;
      const gain = attackValue(Math.min(0.9, now.chance + bonus), now.avgDmg, e, tune.focus);
      // Aiming pays when the shot is worth more with the bonus than two rushed shots.
      const rushed = attackValue(now.chance, now.avgDmg, e, tune.focus) * (WEAPONS[u.ranged].heavy ? 1 : 1.6);
      if (gain > rushed) candidates.push({ action: { type: 'aim' }, score: gain + 0.4 });
    }
  }

  if (opts.overwatch && tune.tactics && bestNow === 0) {
    const close = nearest(enemies, u.x, u.y).d;
    candidates.push({ action: { type: 'overwatch' }, score: close <= 12 ? 0.35 : 0.1 });
  }
  if (opts.brace && bestNow === 0) candidates.push({ action: { type: 'brace' }, score: 0.15 });

  if (opts.grenades.length) candidates.push(...grenadeOptions(s, u, enemies, allies, tune));
  if (opts.programs.length) candidates.push(...hackOptions(s, u, enemies, opts.programs, tune));

  if (opts.patch) {
    for (const t of patchTargets(s, u)) {
      const missing = 1 - t.hp / t.hpMax;
      const score = t.state === 'down' ? 4 * valueOf(t) : missing * 3 + (t.injuries.includes('bleeding') ? 1.5 : 0);
      candidates.push({ action: { type: 'patch', targetId: t.id }, score });
    }
  }
  if (opts.repair) {
    for (const t of repairTargets(s, u)) {
      candidates.push({ action: { type: 'repair', targetId: t.id }, score: t.isDrone ? (1 - t.hp / t.hpMax) * 2 : 0.5 });
    }
  }
  if (opts.stim) candidates.push({ action: { type: 'stim' }, score: (1 - u.hp / u.hpMax) * 3 });
  if (opts.spike && bestNow > 1.2 && ap <= 1) candidates.push({ action: { type: 'spike' }, score: 1.5 });
  if (opts.drone) {
    const [x, y] = adjacentFree(s, u)[0];
    candidates.push({ action: { type: 'drone', x, y }, score: 2 });
  }
  for (const terminalId of opts.capture) {
    const left = s.cfg.maxRounds - s.round + 1;
    candidates.push({ action: { type: 'capture', terminalId }, score: 2.5 + left * 0.35 });
  }
  if (opts.grab) candidates.push({ action: { type: 'grab' }, score: 8 });

  // Luck is worth spending on a good attack, and a Breaker shifts focus to suit the moment.
  if (tune.tactics && u.luck > 0 && u.luckBonus === 0 && ap >= 1 && bestNow > 1.5) candidates.push({ action: { type: 'luck' }, score: bestNow + 1 + tune.noise });
  if (tune.tactics && u.role === 'breaker') {
    if (bestNow === 0 && u.focus.guard === 0 && u.focus.aim > 0) candidates.push({ action: { type: 'focus', kind: 'guard' }, score: tune.noise + 1 });
    if (bestNow > 0 && u.focus.guard > 0) candidates.push({ action: { type: 'focus', kind: 'aim' }, score: tune.noise + 5 });
  }

  const pickFrom = candidates.map((c) => ({ ...c, score: c.score + (rnd.next() - 0.5) * tune.noise }));
  pickFrom.sort((a, b) => b.score - a.score);
  return pickFrom[0].action;
}

function pickUnit(s: GameState, side: number, enemies: Unit[], tune: Tuning, rnd: Rand): Unit {
  const ready = s.units.filter((u) => u.side === side && isOk(u) && !u.activated);
  let best = ready[0];
  let bestScore = -Infinity;
  for (const u of ready) {
    let score = bestAttackFrom(s, u, enemies, u.x, u.y, tune);
    // A unit that could still reach a good shot this activation also matters.
    if (score === 0) {
      const { d } = nearest(enemies, u.x, u.y);
      score = 1 / Math.max(1, d);
    }
    if (rulesOf(s).ammo && u.ranged && u.ammo === 0) score += 0.2;
    if (s.core && s.core.carrier === u.id) score += 6;
    const zone = s.map.zones[u.side];
    if (s.core && s.core.carrier === u.id && inRect(zone, u.x, u.y)) score += 6;
    score += (rnd.next() - 0.5) * tune.noise;
    if (score > bestScore) { bestScore = score; best = u; }
  }
  return best;
}
