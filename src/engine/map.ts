import { Rand } from './rng';
import type { MapData, MapSize, Rect, ScenarioId, ThemeId } from './types';

const SIZES: Record<MapSize, [number, number]> = { small: [17, 13], medium: [21, 15], large: [25, 19] };

export function tileAt(m: MapData, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return '#';
  return m.tiles[y * m.w + x];
}

/** Walls, glass and terminals cannot be walked through. Low cover can be vaulted. */
export function isSolid(t: string): boolean {
  return t === '#' || t === 'g' || t === 'T';
}

export function isLowCover(t: string): boolean {
  return t === 'c' || t === 'g' || t === 'T';
}

/** Can a unit finish its move on this tile? */
export function canStand(t: string): boolean {
  return !isSolid(t) && t !== 'c';
}

/** Tabletop 1-2-1 distance: every second diagonal costs double. */
export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
}

export function cheb(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

export function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function zonesFor(w: number, h: number, sides: number): Rect[] {
  if (sides === 2) {
    return [{ x: 0, y: 0, w: 3, h }, { x: w - 3, y: 0, w: 3, h }];
  }
  const zw = Math.max(4, Math.round(w * 0.2));
  const zh = Math.max(4, Math.round(h * 0.28));
  const corners: Rect[] = [
    { x: 0, y: 0, w: zw, h: zh },
    { x: w - zw, y: h - zh, w: zw, h: zh },
    { x: w - zw, y: 0, w: zw, h: zh },
    { x: 0, y: h - zh, w: zw, h: zh },
  ];
  return corners.slice(0, sides);
}

function canWalkBetween(grid: string[], w: number, h: number, x: number, y: number, tx: number, ty: number): number {
  // Count of tiles reachable from x,y is not needed; returns 1 if the target is reachable.
  const seen = new Uint8Array(w * h);
  const stack = [x + y * w];
  seen[x + y * w] = 1;
  while (stack.length) {
    const c = stack.pop()!;
    const cx = c % w;
    const cy = Math.floor(c / w);
    if (Math.abs(cx - tx) <= 1 && Math.abs(cy - ty) <= 1) return 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const i = nx + ny * w;
      if (seen[i] || isSolid(grid[i])) continue;
      seen[i] = 1;
      stack.push(i);
    }
  }
  return 0;
}

interface Lot { x: number; y: number; w: number; h: number }

function splitLot(r: Rand, lot: Lot, out: Lot[], maxW: number, maxH: number, wideChance: number): void {
  // Most gaps between buildings are streets two tiles wide; a few stay as tight one-tile alleys.
  const alley = r.next() < wideChance ? 2 : 1;
  const tooWide = lot.w > maxW;
  const tooTall = lot.h > maxH;
  const canX = lot.w >= 2 + alley + 2;
  const canY = lot.h >= 2 + alley + 2;
  if ((!tooWide && !tooTall && r.next() < 0.45) || (!canX && !canY)) {
    out.push(lot);
    return;
  }
  const splitX = canX && (!canY || tooWide || (!tooTall && r.next() < 0.5));
  if (splitX) {
    const cut = r.int(2, lot.w - 2 - alley);
    splitLot(r, { x: lot.x, y: lot.y, w: cut, h: lot.h }, out, maxW, maxH, wideChance);
    splitLot(r, { x: lot.x + cut + alley, y: lot.y, w: lot.w - cut - alley, h: lot.h }, out, maxW, maxH, wideChance);
  } else {
    const cut = r.int(2, lot.h - 2 - alley);
    splitLot(r, { x: lot.x, y: lot.y, w: lot.w, h: cut }, out, maxW, maxH, wideChance);
    splitLot(r, { x: lot.x, y: lot.y + cut + alley, w: lot.w, h: lot.h - cut - alley }, out, maxW, maxH, wideChance);
  }
}

/**
 * Lays out the top-left quarter of the board like a city block: a crossroads through the middle,
 * buildings on lots separated by alleys, and cover where a street would really have it.
 * The result is mirrored afterwards, so every deployment zone gets the same terrain.
 */
function planQuadrant(r: Rand, theme: ThemeId, size: MapSize, qw: number, qh: number, zones: Rect[], sides: number): string[] {
  const g: string[] = new Array(qw * qh).fill('.');
  const mx = qw - 1;
  const my = qh - 1;
  const halfRoad = size === 'large' && theme !== 'market' ? 2 : 1;
  const zone: Rect = sides === 2 ? { x: 0, y: 0, w: zones[0].w, h: qh } : zones[0];

  // Buildings go wherever is left once the crossroads and the deployment zone, plus a street around it, are taken out.
  const gapX = zone.x + zone.w + 1;
  const gapY = zone.y + zone.h + 1;
  const right = mx - halfRoad;
  const bottom = my - halfRoad;
  const areas: Lot[] = [{ x: gapX, y: 0, w: right - gapX, h: bottom }];
  if (sides > 2) areas.push({ x: 0, y: gapY, w: gapX - 1, h: bottom - gapY });
  const maxW = theme === 'market' ? 3 : 4;
  const maxH = theme === 'market' ? 2 : 3;
  const lots: Lot[] = [];
  for (const a of areas) if (a.w >= 2 && a.h >= 2) splitLot(r, a, lots, maxW, maxH, 0.75);
  const yards: Lot[] = [];
  const openChance = theme === 'plaza' ? 0.3 : theme === 'market' ? 0.14 : 0.2;
  for (const lot of lots) {
    if (lot.w < 2 || lot.h < 2) continue;
    if (r.next() < openChance) {
      yards.push(lot);
      continue;
    }
    for (let yy = lot.y; yy < lot.y + lot.h; yy++) for (let xx = lot.x; xx < lot.x + lot.w; xx++) g[xx + yy * qw] = '#';
  }

  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= qw || y >= qh ? '.' : g[x + y * qw]);
  const nearCenter = (x: number, y: number) => Math.abs(x - mx) <= 1 && Math.abs(y - my) <= 1;
  const clearFor = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > mx || y > my || nearCenter(x, y) || at(x, y) !== '.') return false;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy) === 'c' || at(x + dx, y + dy) === 'g') return false;
    return true;
  };
  const placeRun = (x: number, y: number, len: number, horizontal: boolean, c = 'c') => {
    const cells: [number, number][] = [];
    for (let k = 0; k < len; k++) cells.push(horizontal ? [x + k, y] : [x, y + k]);
    if (!cells.every(([a, b]) => clearFor(a, b))) return false;
    // Cover can be vaulted, but nobody can stand on it, so it must never close a gap from wall to wall.
    const blocked = (a: number, b: number) => a < 0 || b < 0 || at(a, b) === '#';
    const before = horizontal ? blocked(x - 1, y) || blocked(x - 2, y) : blocked(x, y - 1) || blocked(x, y - 2);
    const after = horizontal ? blocked(x + len, y) || blocked(x + len + 1, y) : blocked(x, y + len) || blocked(x, y + len + 1);
    if (before && after) return false;
    for (const [a, b] of cells) g[a + b * qw] = c;
    return true;
  };

  // A flooded channel along the docks' east-west road, with crossings so it never cuts the board in two.
  if (theme === 'docks') {
    for (let x = 0; x < qw; x++) {
      if (Math.abs(x - mx) <= 1 || x % 6 === 2) continue;
      g[x + my * qw] = '~';
      if (size === 'large') g[x + (my - 1) * qw] = '~';
    }
  }

  // Vehicles and roadblocks on the main roads. These are what stop a road being one long firing lane.
  const roadRuns = theme === 'market' ? 0 : size === 'small' ? 2 : 3;
  for (let i = 0, tries = 0; i < roadRuns && tries < 40; tries++) {
    const onEastWest = r.next() < 0.6;
    const placed = onEastWest
      ? placeRun(r.int(zone.w, mx - 3), r.int(my - halfRoad - 1, my - 1), 2, true)
      : placeRun(r.int(mx - halfRoad, mx - 1), r.int(0, my - 3), 2, false);
    if (placed) i += 1;
  }

  // Cover just outside the deployment zone, so nobody has to step straight into the open.
  const frontier = size === 'small' ? 2 : 3;
  for (let i = 0, tries = 0; i < frontier && tries < 40; tries++) {
    const x = sides === 2 ? zone.w + r.int(0, 1) : r.int(0, zone.w + 1);
    const y = sides === 2 ? r.int(0, my - 1) : zone.h + r.int(0, 1);
    if (placeRun(x, y, r.int(1, 2), r.next() < 0.3)) i += 1;
  }

  // Yards: open lots with whatever got left there.
  for (const yard of yards) {
    const count = Math.max(1, Math.round((yard.w * yard.h) / (theme === 'market' ? 3 : 5)));
    for (let i = 0, tries = 0; i < count && tries < 16; tries++) {
      const x = r.int(yard.x, yard.x + yard.w - 1);
      const y = r.int(yard.y, yard.y + yard.h - 1);
      if (theme === 'plaza' && i === 0 && placeRun(x, y, r.int(2, 3), r.next() < 0.5, 'g')) i += 1;
      else if (placeRun(x, y, r.int(1, 2), r.next() < 0.5)) i += 1;
    }
  }

  // Things against walls and in alleys: bins, stalls, vending machines.
  const alleyProps = Math.round((qw * qh) / (theme === 'market' ? 7 : 11));
  for (let i = 0, tries = 0; i < alleyProps && tries < 80; tries++) {
    const x = r.int(zone.w, mx - 1);
    const y = r.int(0, my - 1);
    if (at(x, y) !== '.') continue;
    const touchesWall = at(x - 1, y) === '#' || at(x + 1, y) === '#' || at(x, y - 1) === '#' || at(x, y + 1) === '#';
    if (!touchesWall) continue;
    const alongRow = at(x, y - 1) === '#' || at(x, y + 1) === '#';
    // A prop needs room left beside it, or it plugs the alley it stands in.
    const leavesRoom = alongRow
      ? (at(x, y - 1) !== '#' && at(x, y - 2) !== '#') || (at(x, y + 1) !== '#' && at(x, y + 2) !== '#')
      : (at(x - 1, y) !== '#' && at(x - 2, y) !== '#') || (at(x + 1, y) !== '#' && at(x + 2, y) !== '#');
    if (!leavesRoom) continue;
    if (placeRun(x, y, theme === 'market' ? r.int(1, 2) : 1, alongRow)) i += 1;
  }
  return g;
}

/**
 * How many people can cross from one zone to another at once without sharing a tile. Stops counting at the limit.
 * Only clear ground counts: low cover can be vaulted, but it costs extra and nobody can stop on it.
 */
export function passWidth(g: ArrayLike<string>, w: number, h: number, a: Rect, b: Rect, limit: number): number {
  const n = w * h;
  const source = n * 2;
  const sink = n * 2 + 1;
  const edges: number[][] = Array.from({ length: sink + 1 }, () => []);
  const to: number[] = [];
  const room: number[] = [];
  const link = (from: number, target: number, cap: number) => {
    edges[from].push(to.length);
    to.push(target);
    room.push(cap);
    edges[target].push(to.length);
    to.push(from);
    room.push(0);
  };
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && canStand(g[x + y * w]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!open(x, y)) continue;
      const i = x + y * w;
      const inA = inRect(a, x, y);
      const inB = inRect(b, x, y);
      // Each tile fits one person, except in the zones where everyone starts and finishes.
      link(i * 2, i * 2 + 1, inA || inB ? limit : 1);
      if (inA) link(source, i * 2, limit);
      if (inB) link(i * 2 + 1, sink, limit);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || !open(x + dx, y + dy)) continue;
          if (dx && dy && (!open(x + dx, y) || !open(x, y + dy))) continue;
          link(i * 2 + 1, (x + dx + (y + dy) * w) * 2, 1);
        }
      }
    }
  }
  let flow = 0;
  while (flow < limit) {
    const came = new Int32Array(sink + 1).fill(-1);
    came[source] = -2;
    const queue = [source];
    for (let q = 0; q < queue.length && came[sink] === -1; q++) {
      for (const e of edges[queue[q]]) {
        if (room[e] > 0 && came[to[e]] === -1) {
          came[to[e]] = e;
          queue.push(to[e]);
        }
      }
    }
    if (came[sink] === -1) break;
    for (let v = sink; v !== source; v = to[came[v] ^ 1]) {
      room[came[v]] -= 1;
      room[came[v] ^ 1] += 1;
    }
    flow += 1;
  }
  return flow;
}

/** The narrowest clear route from the first zone to any other. Zones mirror each other, so that covers them all. */
function narrowestPass(g: string[], w: number, h: number, zones: Rect[], limit: number): number {
  let width = limit;
  for (const z of zones.slice(1, 3)) width = Math.min(width, passWidth(g, w, h, zones[0], z, limit));
  return width;
}

/**
 * Takes away just enough cover to leave clear routes across the board, keeping it symmetrical for every player.
 * Pieces that widen the route go first, so the cover that remains is the cover nobody has to climb over.
 */
function openUpCover(r: Rand, g: string[], w: number, h: number, zones: Rect[], target: number): void {
  const set = new Set<string>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[x + y * w] === 'c') set.add(`${Math.min(x, w - 1 - x)},${Math.min(y, h - 1 - y)}`);
    }
  }
  const pieces = [...set].map((key) => {
    const [x, y] = key.split(',').map(Number);
    return [...new Set([x + y * w, w - 1 - x + y * w, x + (h - 1 - y) * w, w - 1 - x + (h - 1 - y) * w])];
  });
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [pieces[i], pieces[j]] = [pieces[j], pieces[i]];
  }
  let width = narrowestPass(g, w, h, zones, target);
  while (width < target && pieces.length) {
    let chosen = pieces.length - 1;
    for (let i = 0; i < pieces.length; i++) {
      for (const k of pieces[i]) g[k] = '.';
      const wider = narrowestPass(g, w, h, zones, target) > width;
      for (const k of pieces[i]) g[k] = 'c';
      if (wider) {
        chosen = i;
        break;
      }
    }
    for (const k of pieces[chosen]) g[k] = '.';
    pieces.splice(chosen, 1);
    width = narrowestPass(g, w, h, zones, target);
  }
}

/** No board may funnel a whole crew through a gap narrower than this. */
const MIN_PASS_WIDTH: Record<MapSize, number> = { small: 4, medium: 5, large: 6 };

export function generateMap(seed: number, size: MapSize, theme: ThemeId, sides: number, scenario: ScenarioId): MapData {
  const [w, h] = SIZES[size];
  const r = new Rand((seed ^ 0x51ed270b) >>> 0);
  const zones = zonesFor(w, h, sides);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const qw = Math.ceil(w / 2);
  const qh = Math.ceil(h / 2);

  for (let attempt = 0; attempt < 60; attempt++) {
    const g: string[] = new Array(w * h).fill('.');
    const planned = planQuadrant(r, theme, size, qw, qh, zones, sides);
    for (let y = 0; y < qh; y++) for (let x = 0; x < qw; x++) g[x + y * w] = planned[x + y * qw];

    // Mirror across both axes so all deployment zones are equal.
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        const c = g[x + y * w];
        g[w - 1 - x + y * w] = c;
        g[x + (h - 1 - y) * w] = c;
        g[w - 1 - x + (h - 1 - y) * w] = c;
      }
    }

    // Deployment zones stay free of anything solid and keep a little low cover.
    for (const z of zones) {
      for (let y = z.y; y < z.y + z.h; y++) {
        for (let x = z.x; x < z.x + z.w; x++) {
          const i = x + y * w;
          if (isSolid(g[i]) || g[i] === '~') g[i] = '.';
        }
      }
    }

    // Objectives
    const mx = Math.floor(cx);
    const my = Math.floor(cy);
    const terminals: { x: number; y: number }[] = [];
    if (scenario === 'terminals') {
      terminals.push({ x: mx, y: my });
      const ox = Math.round(w * 0.22);
      const oy = Math.round(h * 0.28);
      if (sides === 2) {
        terminals.push({ x: mx, y: my - oy - 1 }, { x: mx, y: my + oy + 1 });
      } else {
        terminals.push({ x: mx - ox, y: my }, { x: mx + ox, y: my }, { x: mx, y: my - oy }, { x: mx, y: my + oy });
      }
      for (const t of terminals) {
        g[t.x + t.y * w] = 'T';
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const i = t.x + dx + (t.y + dy) * w;
          if (isSolid(g[i])) g[i] = '.';
        }
      }
    }
    const core = scenario === 'heist' ? { x: mx, y: my } : null;
    if (core) g[core.x + core.y * w] = '.';

    openUpCover(r, g, w, h, zones, MIN_PASS_WIDTH[size]);

    // Everything has to be reachable, and the board needs some substance.
    const start = zones[0];
    const sx = start.x + Math.floor(start.w / 2);
    const sy = start.y + Math.floor(start.h / 2);
    let ok = g.filter((c) => c === 'c').length >= 8;
    for (const z of zones.slice(1)) {
      if (!canWalkBetween(g, w, h, sx, sy, z.x + Math.floor(z.w / 2), z.y + Math.floor(z.h / 2))) ok = false;
    }
    for (const t of terminals) if (!canWalkBetween(g, w, h, sx, sy, t.x, t.y)) ok = false;
    if (core && !canWalkBetween(g, w, h, sx, sy, core.x, core.y)) ok = false;
    const solid = g.filter((c) => c === '#').length / (w * h);
    if (solid > 0.32 || solid < 0.12) ok = false;
    if (ok && narrowestPass(g, w, h, zones, MIN_PASS_WIDTH[size]) < MIN_PASS_WIDTH[size]) ok = false;
    if (!ok && attempt < 59) continue;

    return {
      id: `${seed}-${size}-${theme}-${sides}-${scenario}`,
      w, h, tiles: g.join(''), theme, zones, terminals, core,
    };
  }
  throw new Error('map generation failed');
}

export interface LosInfo { visible: boolean; cover: 0 | 1 | 2 }

const losCache = new Map<string, Map<number, LosInfo>>();

function rayClear(m: MapData, smoke: Set<number> | null, ax: number, ay: number, px: number, py: number, tx: number, ty: number): { clear: boolean; low: boolean } {
  const fromX = ax + 0.5;
  const fromY = ay + 0.5;
  const dx = px - fromX;
  const dy = py - fromY;
  const len = Math.hypot(dx, dy);
  const steps = Math.max(1, Math.ceil(len / 0.2));
  let low = false;
  for (let i = 1; i < steps; i++) {
    const sx = Math.floor(fromX + (dx * i) / steps);
    const sy = Math.floor(fromY + (dy * i) / steps);
    if (sx === ax && sy === ay) continue;
    if (sx === tx && sy === ty) continue;
    const t = tileAt(m, sx, sy);
    if (t === '#') return { clear: false, low };
    if (smoke && smoke.has(sx + sy * m.w)) return { clear: false, low };
    if (isLowCover(t) && cheb(sx, sy, tx, ty) <= 1) low = true;
  }
  return { clear: true, low };
}

const OFFSETS: [number, number][] = [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];

function computeLos(m: MapData, smoke: Set<number> | null, ax: number, ay: number, bx: number, by: number): LosInfo {
  let clear = 0;
  let low = false;
  for (let i = 0; i < OFFSETS.length; i++) {
    const res = rayClear(m, smoke, ax, ay, bx + OFFSETS[i][0], by + OFFSETS[i][1], bx, by);
    if (res.clear) clear++;
    if (i === 0 && res.low) low = true;
  }
  if (clear === 0) return { visible: false, cover: 0 };
  let cover: 0 | 1 | 2 = clear === 5 ? 0 : clear >= 3 ? 1 : 2;
  if (low && cover === 0) cover = 1;
  return { visible: true, cover };
}

export function los(m: MapData, smoke: Set<number> | null, ax: number, ay: number, bx: number, by: number): LosInfo {
  if (smoke && smoke.size) return computeLos(m, smoke, ax, ay, bx, by);
  let cache = losCache.get(m.id);
  if (!cache) {
    if (losCache.size > 8) losCache.clear();
    cache = new Map();
    losCache.set(m.id, cache);
  }
  const key = ax + ay * 64 + bx * 4096 + by * 262144;
  let hit = cache.get(key);
  if (!hit) {
    hit = computeLos(m, null, ax, ay, bx, by);
    cache.set(key, hit);
  }
  return hit;
}
