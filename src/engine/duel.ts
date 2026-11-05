import { Rand } from './rng';
import type { RulesetId } from './types';

/*
 * Stage 3: a hacker against a corporation, three lanes, a pure reducer like the other modes.
 * The hacker's programs strike at the end of the hacker's turn; the corporation's sentries and tracers act at the end of its own.
 */

export type DuelSide = 'hacker' | 'corp';
export type CardKind = 'program' | 'trick' | 'barrier' | 'sentry' | 'tracer' | 'operation';
export type CardId =
  | 'spike' | 'crowbar' | 'worm' | 'ghost' | 'swarm' | 'reroute' | 'overload' | 'scrub' | 'cache' | 'dredge' | 'zeroday'
  | 'firewall' | 'bulkhead' | 'honeypot' | 'watchdog' | 'hound' | 'tracer' | 'repatch' | 'audit' | 'lockdown' | 'purge' | 'overtime';

export interface CardDef { id: CardId; side: DuelSide; kind: CardKind; cost: number; power: number; hp: number; copies: number; tier: 0 | 1 | 2 }

const c = (id: CardId, side: DuelSide, kind: CardKind, cost: number, power: number, hp: number, copies: number, tier: 0 | 1 | 2): CardDef => ({ id, side, kind, cost, power, hp, copies, tier });

export const CARDS: Record<CardId, CardDef> = {
  spike: c('spike', 'hacker', 'program', 1, 2, 1, 4, 0),
  crowbar: c('crowbar', 'hacker', 'program', 2, 3, 2, 4, 0),
  worm: c('worm', 'hacker', 'program', 3, 2, 3, 3, 0),
  ghost: c('ghost', 'hacker', 'program', 3, 3, 3, 2, 1),
  swarm: c('swarm', 'hacker', 'program', 2, 1, 1, 2, 2),
  reroute: c('reroute', 'hacker', 'trick', 1, 0, 0, 2, 1),
  overload: c('overload', 'hacker', 'trick', 2, 3, 0, 3, 0),
  scrub: c('scrub', 'hacker', 'trick', 1, 0, 0, 3, 0),
  cache: c('cache', 'hacker', 'trick', 0, 0, 0, 2, 1),
  dredge: c('dredge', 'hacker', 'trick', 2, 0, 0, 2, 0),
  zeroday: c('zeroday', 'hacker', 'trick', 4, 4, 0, 2, 2),
  firewall: c('firewall', 'corp', 'barrier', 1, 0, 3, 5, 0),
  bulkhead: c('bulkhead', 'corp', 'barrier', 3, 0, 7, 3, 0),
  honeypot: c('honeypot', 'corp', 'barrier', 2, 3, 2, 2, 1),
  watchdog: c('watchdog', 'corp', 'sentry', 2, 2, 2, 4, 0),
  hound: c('hound', 'corp', 'sentry', 3, 3, 3, 2, 1),
  tracer: c('tracer', 'corp', 'tracer', 2, 0, 2, 3, 0),
  repatch: c('repatch', 'corp', 'operation', 1, 2, 0, 2, 0),
  audit: c('audit', 'corp', 'operation', 2, 0, 0, 2, 0),
  lockdown: c('lockdown', 'corp', 'operation', 3, 0, 0, 2, 1),
  purge: c('purge', 'corp', 'operation', 4, 3, 0, 2, 2),
  overtime: c('overtime', 'corp', 'operation', 0, 0, 0, 2, 2),
};

export const CARD_IDS = Object.keys(CARDS) as CardId[];
const DEPTH: Record<RulesetId, { tier: number; nodeHp: number; traceMax: number; rounds: number }> = {
  quick: { tier: 0, nodeHp: 6, traceMax: 8, rounds: 10 },
  standard: { tier: 1, nodeHp: 8, traceMax: 10, rounds: 12 },
  full: { tier: 2, nodeHp: 10, traceMax: 12, rounds: 14 },
};
export const LANES = 3;
export const MAX_IN_LANE = 3;
const HAND_LIMIT = 7;

export interface InPlay { uid: number; card: CardId; hp: number; locked: boolean }
export interface DuelLane { node: number; hacker: InPlay[]; corp: InPlay[] }
export interface DuelPlayer { deck: CardId[]; hand: CardId[]; bandwidth: number }
export interface DuelLog { k: string; v: Record<string, string | number> }

export interface DuelState {
  v: 1;
  ruleset: RulesetId;
  seed: number;
  rng: number;
  round: number;
  active: DuelSide;
  nodeMax: number;
  traceMax: number;
  maxRounds: number;
  trace: number;
  lanes: DuelLane[];
  hacker: DuelPlayer;
  corp: DuelPlayer;
  nextUid: number;
  winner: DuelSide | null;
  reason: 'cracked' | 'traced' | 'deadline' | 'concede' | null;
  log: DuelLog[];
  seq: number;
}

export type DuelAction =
  | { a: 'play'; hand: number; lane: number; target?: number; to?: number }
  | { a: 'end' }
  | { a: 'concede' };

const other = (s: DuelSide): DuelSide => (s === 'hacker' ? 'corp' : 'hacker');

function shuffle(r: Rand, list: CardId[]): CardId[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function buildDeck(side: DuelSide, ruleset: RulesetId, r: Rand): CardId[] {
  const tier = DEPTH[ruleset].tier;
  return shuffle(r, CARD_IDS.filter((id) => CARDS[id].side === side && CARDS[id].tier <= tier).flatMap((id) => Array<CardId>(CARDS[id].copies).fill(id)));
}

function draw(p: DuelPlayer, n: number): void {
  for (let i = 0; i < n && p.deck.length && p.hand.length < HAND_LIMIT; i++) p.hand.push(p.deck.shift()!);
}

export function createDuel(seed: number, ruleset: RulesetId): DuelState {
  const r = new Rand(seed);
  const d = DEPTH[ruleset];
  const s: DuelState = {
    v: 1, ruleset, seed, rng: 0, round: 1, active: 'hacker', nodeMax: d.nodeHp, traceMax: d.traceMax, maxRounds: d.rounds, trace: 0,
    lanes: Array.from({ length: LANES }, () => ({ node: d.nodeHp, hacker: [], corp: [] })),
    hacker: { deck: buildDeck('hacker', ruleset, r), hand: [], bandwidth: 2 },
    corp: { deck: buildDeck('corp', ruleset, r), hand: [], bandwidth: 0 },
    nextUid: 1, winner: null, reason: null, log: [], seq: 0,
  };
  draw(s.hacker, 4);
  draw(s.corp, 5);
  s.rng = r.state;
  return s;
}

const say = (s: DuelState, k: string, v: Record<string, string | number> = {}) => {
  s.log.push({ k, v });
  if (s.log.length > 60) s.log.shift();
};
const cardKey = (id: CardId) => `card.${id}`;

export const crackedCount = (s: DuelState): number => s.lanes.filter((l) => l.node <= 0).length;

function checkEnd(s: DuelState): void {
  if (s.winner) return;
  if (crackedCount(s) >= 2) { s.winner = 'hacker'; s.reason = 'cracked'; } else if (s.trace >= s.traceMax) { s.winner = 'corp'; s.reason = 'traced'; }
}

function hitNode(s: DuelState, lane: number, n: number): void {
  const l = s.lanes[lane];
  if (l.node <= 0) return;
  l.node = Math.max(0, l.node - n);
  say(s, l.node === 0 ? 'duel.log.cracked' : 'duel.log.node', { lane: lane + 1, n });
}

function hacked(s: DuelState, lane: number, target: InPlay, n: number, attacker: InPlay | null): void {
  const l = s.lanes[lane];
  target.hp -= n;
  if (target.hp > 0) return;
  l.corp = l.corp.filter((x) => x !== target);
  say(s, 'duel.log.destroyed', { card: cardKey(target.card), lane: lane + 1 });
  // A honeypot bites whatever broke it.
  if (target.card === 'honeypot' && attacker) {
    attacker.hp -= CARDS.honeypot.power;
    s.trace += 1;
    if (attacker.hp <= 0) l.hacker = l.hacker.filter((x) => x !== attacker);
    say(s, 'duel.log.honeypot', { lane: lane + 1 });
  }
}

/** The order programs chew through a lane: walls first, then whatever is behind them, then the node. */
const frontOf = (l: DuelLane): InPlay | undefined => l.corp.find((x) => CARDS[x.card].kind === 'barrier') ?? l.corp[0];

function hackerStrikes(s: DuelState): void {
  s.lanes.forEach((l, i) => {
    for (const p of [...l.hacker]) {
      if (p.locked) { p.locked = false; continue; }
      if (!l.hacker.includes(p)) continue;
      const def = CARDS[p.card];
      if (p.card === 'worm') hitNode(s, i, 1);
      let left = def.power;
      const front = frontOf(l);
      if (front) {
        const dealt = Math.min(left, front.hp);
        hacked(s, i, front, left, p);
        left -= dealt;
      }
      // Whatever a blow doesn't spend on the wall carries on through.
      if (left > 0 && !frontOf(l)) hitNode(s, i, left);
    }
  });
}

function corpActs(s: DuelState): void {
  s.lanes.forEach((l, i) => {
    for (const d of l.corp) {
      const def = CARDS[d.card];
      if (def.kind === 'tracer') {
        s.trace += 1;
        say(s, 'duel.log.trace', { lane: i + 1 });
      } else if (def.kind === 'sentry' && l.hacker.length) {
        // A ghost can only be found once it's alone.
        const target = l.hacker.find((x) => x.card !== 'ghost') ?? l.hacker[0];
        target.hp -= def.power;
        if (target.hp <= 0) {
          l.hacker = l.hacker.filter((x) => x !== target);
          say(s, 'duel.log.killed', { card: cardKey(target.card), lane: i + 1 });
          if (d.card === 'hound') s.trace += 1;
        }
      }
    }
  });
}

const bandwidthFor = (round: number): number => Math.min(7, 1 + round);

function startTurn(s: DuelState, side: DuelSide): void {
  s.active = side;
  const p = s[side];
  p.bandwidth = bandwidthFor(s.round);
  draw(p, 1);
}

class Bad extends Error {}
const bad = (m: string): never => { throw new Bad(m); };

function place(s: DuelState, side: DuelSide, card: CardId, lane: number): void {
  const l = s.lanes[lane] ?? bad('badLane');
  if (l.node <= 0) bad('cracked');
  if (l[side].length >= MAX_IN_LANE) bad('laneFull');
  l[side].push({ uid: s.nextUid++, card, hp: CARDS[card].hp, locked: false });
}

function step(s: DuelState, act: DuelAction, side: DuelSide): void {
  if (s.winner) bad('over');
  if (act.a === 'concede') {
    s.winner = other(side);
    s.reason = 'concede';
    return;
  }
  if (side !== s.active) bad('notYourTurn');
  if (act.a === 'end') {
    if (side === 'hacker') {
      hackerStrikes(s);
      checkEnd(s);
      if (!s.winner) startTurn(s, 'corp');
    } else {
      corpActs(s);
      checkEnd(s);
      if (s.winner) return;
      s.round += 1;
      if (s.round > s.maxRounds) {
        s.winner = 'corp';
        s.reason = 'deadline';
        return;
      }
      startTurn(s, 'hacker');
    }
    return;
  }
  const p = s[side];
  const id = p.hand[act.hand] ?? bad('noCard');
  const def = CARDS[id];
  if (def.cost > p.bandwidth) bad('noBandwidth');
  const l = s.lanes[act.lane] ?? bad('badLane');
  switch (id) {
    case 'overload': {
      const t = l.corp[act.target ?? 0] ?? bad('badTarget');
      hacked(s, act.lane, t, def.power, null);
      break;
    }
    case 'reroute': {
      const t = l.hacker[act.target ?? 0] ?? bad('badTarget');
      const dest = s.lanes[act.to ?? -1] ?? bad('badLane');
      if (dest === l || dest.node <= 0 || dest.hacker.length >= MAX_IN_LANE) bad('badLane');
      l.hacker = l.hacker.filter((x) => x !== t);
      dest.hacker.push(t);
      break;
    }
    case 'scrub': s.trace = Math.max(0, s.trace - 2); break;
    case 'cache': p.bandwidth += 2; s.trace += 1; break;
    case 'dredge': draw(p, 2); break;
    case 'zeroday': hitNode(s, act.lane, def.power); s.trace += 2; break;
    case 'repatch':
      if (l.node <= 0) bad('cracked');
      l.node = Math.min(s.nodeMax, l.node + def.power);
      break;
    case 'audit': draw(p, 2); break;
    case 'lockdown': for (const x of l.hacker) x.locked = true; break;
    case 'purge':
      for (const x of l.hacker) x.hp -= def.power;
      l.hacker = l.hacker.filter((x) => x.hp > 0);
      break;
    case 'overtime': {
      p.bandwidth += 2;
      const open = s.lanes.filter((x) => x.node > 0).sort((a, b) => b.node - a.node)[0];
      if (open) open.node -= 1;
      break;
    }
    case 'swarm':
      place(s, side, id, act.lane);
      if (l.hacker.length < MAX_IN_LANE) place(s, side, id, act.lane);
      break;
    default:
      place(s, side, id, act.lane);
  }
  p.bandwidth -= def.cost;
  p.hand.splice(act.hand, 1);
  say(s, 'duel.log.play', { side: `duel.side.${side}`, card: cardKey(id), lane: act.lane + 1 });
  checkEnd(s);
}

export interface DuelResult { ok: boolean; state: DuelState; error?: string }

export function applyDuel(prev: DuelState, action: DuelAction, side: DuelSide): DuelResult {
  const s = structuredClone(prev);
  try {
    step(s, action, side);
  } catch (e) {
    if (e instanceof Bad) return { ok: false, state: prev, error: e.message };
    throw e;
  }
  s.seq += 1;
  return { ok: true, state: s };
}

/** What the computer does next: the most useful card it can afford, or end the turn. */
export function duelAi(s: DuelState, side: DuelSide, rnd: Rand): DuelAction {
  const p = s[side];
  let best: DuelAction = { a: 'end' };
  let top = 0;
  const open = s.lanes.map((l, i) => ({ l, i })).filter((x) => x.l.node > 0);
  p.hand.forEach((id, hand) => {
    const def = CARDS[id];
    if (def.cost > p.bandwidth) return;
    for (const { l, i } of open) {
      let score = 0;
      let target: number | undefined;
      let to: number | undefined;
      const hurt = s.nodeMax - l.node;
      const threat = l.hacker.reduce((n, x) => n + CARDS[x.card].power, 0);
      const wall = l.corp.reduce((n, x) => n + x.hp, 0);
      if (def.kind === 'program') {
        if (l.hacker.length >= MAX_IN_LANE) continue;
        score = def.power + def.hp * 0.5 + hurt * 0.4 - wall * 0.2 + 1;
      } else if (def.kind === 'barrier' || def.kind === 'sentry' || def.kind === 'tracer') {
        if (l.corp.length >= MAX_IN_LANE) continue;
        if (def.kind === 'barrier') score = threat * 0.8 + def.hp * 0.3 + hurt * 0.3 + 0.5 - wall * 0.3;
        else if (def.kind === 'sentry') score = threat ? 2 + def.power + threat * 0.3 : 0.6;
        else score = 3 - l.corp.filter((x) => x.card === 'tracer').length;
      } else switch (id) {
        case 'overload':
          if (!l.corp.length) continue;
          target = 0;
          score = hurt * 0.3 + 2.2;
          break;
        case 'reroute': {
          const dest = open.find((d) => d.i !== i && d.l.corp.length < l.corp.length && d.l.hacker.length < MAX_IN_LANE);
          if (!dest || !l.hacker.length) continue;
          target = 0;
          to = dest.i;
          score = 1.2;
          break;
        }
        case 'scrub': score = s.trace >= 2 ? s.trace * 0.8 : 0; break;
        case 'cache': score = s.trace < s.traceMax - 3 && p.hand.length > 2 ? 1.5 : 0; break;
        case 'dredge': case 'audit': score = p.hand.length <= 3 ? 2.5 : 0.8; break;
        case 'zeroday': score = l.node <= def.power ? 9 : 2 + hurt * 0.3; break;
        case 'repatch': score = hurt >= 2 ? hurt * 0.7 : 0; break;
        case 'lockdown': score = threat >= 4 ? threat * 0.7 : 0; break;
        case 'purge': score = l.hacker.length >= 2 ? 2 + l.hacker.length : 0; break;
        case 'overtime': score = p.hand.length > 2 && l.node > 3 ? 1 : 0; break;
        default: break;
      }
      score += rnd.next() * 0.3;
      if (score > top) {
        top = score;
        best = { a: 'play', hand, lane: i, target, to };
      }
    }
  });
  return best;
}
