import { FACTIONS } from '../engine/data';
import { tileAt } from '../engine/map';
import type { GameState, MapData, ThemeId } from '../engine/types';

/*
 * Paints a board as a slice of night-time city. All of it is drawn by code, once per map, into one
 * big image that the board then just copies; see Board.boardView. Everything is keyed off the tile
 * layout, so the same streets, walls and cover the rules use are what the player sees.
 */

export const T = 64;
/** How many tiles of out-of-play city to draw around the board. */
export const OUTER = 6;
export const ART_SCALE = 1.5;
/** A building's south wall is drawn inside its own bottom row, so nothing overlaps a neighboring square. */
const FACE = 30;

export interface SignFlicker { x: number; y: number; w: number; h: number; color: string; seed: number }
export interface SteamVent { x: number; y: number; seed: number }
export interface BoardArt {
  canvas: HTMLCanvasElement;
  flickers: SignFlicker[];
  steam: SteamVent[];
}

interface Palette {
  ground: string; ground2: string; walk: string; walkLine: string; curb: string;
  roofs: string[]; faces: string[]; neon: string[]; lamp: string; water: string; haze: [string, string];
}

export const NEON = { pink: '#ff2e88', cyan: '#19e3ff', violet: '#a45cff', amber: '#ffb347', green: '#3dffa2', red: '#ff3b3b', white: '#dff6ff' };

const PALETTES: Record<ThemeId, Palette> = {
  docks: {
    ground: '#1a2331', ground2: '#212c3c', walk: '#334054', walkLine: '#171f2b', curb: '#6d7f99',
    roofs: ['#39475a', '#434d5c', '#4c4038', '#2d4650'], faces: ['#141a24', '#1b1a1e', '#121c22'],
    neon: [NEON.cyan, NEON.amber, NEON.pink, NEON.white], lamp: '#ffb878', water: '#04141d', haze: ['#0d3a4d', '#3a1f10'],
  },
  market: {
    ground: '#231a29', ground2: '#2d2233', walk: '#3e3047', walkLine: '#1b1420', curb: '#7a648a',
    roofs: ['#463848', '#4f3b3e', '#3a3f58', '#533a32'], faces: ['#1a1219', '#1e1418', '#151523'],
    neon: [NEON.pink, NEON.amber, NEON.violet, NEON.red, NEON.cyan], lamp: '#ff9a6b', water: '#10091c', haze: ['#4d0d38', '#3d2308'],
  },
  plaza: {
    ground: '#172136', ground2: '#1f2c47', walk: '#2a3958', walkLine: '#141c2f', curb: '#6079a8',
    roofs: ['#2b3855', '#303f60', '#25314d', '#353c58'], faces: ['#0e1626', '#101a2e', '#141a2a'],
    neon: [NEON.cyan, NEON.violet, NEON.white, NEON.pink], lamp: '#a8d8ff', water: '#071325', haze: ['#16245f', '#3d1064'],
  },
};

const WORDS: Record<ThemeId, string[]> = {
  docks: ['DOCK 7', 'BERTH', 'SALVAGE', 'CARGO', 'TOLL', 'BAR', 'FUEL', 'NO EXIT', 'SABLE'],
  market: ['SOBA', 'RAMEN', 'PAWN', 'CHROME', 'NOODLE', 'BAR', 'HOTEL', 'KREDYT', '24H', 'CLINIC', 'TATTOO', 'DEBT'],
  plaza: ['MERIDIAN', 'ARC', 'HALDEN', 'ASSET', 'CREDIT', 'LOBBY', 'SECURE', 'OYAMA'],
};

const DISPLAY = '"Big Shoulders Display", "Barlow Condensed", sans-serif';

function hash(x: number, y: number, k = 0): number {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const pick = <V,>(items: readonly V[], v: number): V => items[Math.floor(v * items.length) % items.length];

function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

const alpha = (hex: string, a: number) => `${hex}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')}`;

function noiseCanvas(size: number, strength: number): HTMLCanvasElement {
  const n = document.createElement('canvas');
  n.width = size;
  n.height = size;
  const ctx = n.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = hash(i, 91, 3);
    const light = v > 0.5;
    img.data[i * 4] = light ? 255 : 0;
    img.data[i * 4 + 1] = light ? 255 : 0;
    img.data[i * 4 + 2] = light ? 255 : 0;
    img.data[i * 4 + 3] = Math.abs(v - 0.5) * 2 * strength * 255;
  }
  ctx.putImageData(img, 0, 0);
  return n;
}

/* ---------- Invented neon script: it reads like signage but isn't any real language ---------- */

export function glyph(c: CanvasRenderingContext2D, x: number, y: number, size: number, seed: number): void {
  const g = size / 4;
  const pt = (i: number) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    return [x + col * g, y + row * g] as const;
  };
  c.beginPath();
  // A frame stroke plus a few inner strokes gives the dense, boxy look of street signage.
  const frame = hash(seed, 1);
  if (frame < 0.45) {
    c.moveTo(...pt(1));
    c.lineTo(...pt(3));
    c.moveTo(...pt(5));
    c.lineTo(...pt(9));
  } else if (frame < 0.75) {
    c.moveTo(...pt(0));
    c.lineTo(...pt(4));
    c.lineTo(...pt(24));
  } else {
    c.moveTo(...pt(2));
    c.lineTo(...pt(22));
  }
  const strokes = 2 + Math.floor(hash(seed, 2) * 3);
  for (let i = 0; i < strokes; i++) {
    const a = Math.floor(hash(seed, 10 + i) * 25);
    const horizontal = hash(seed, 20 + i) < 0.55;
    const len = 1 + Math.floor(hash(seed, 30 + i) * 3);
    const col = a % 5;
    const row = Math.floor(a / 5);
    const b = horizontal ? row * 5 + Math.min(4, col + len) : Math.min(4, row + len) * 5 + col;
    c.moveTo(...pt(a));
    c.lineTo(...pt(b));
  }
  c.stroke();
}

interface Ctx {
  c: CanvasRenderingContext2D;
  /** Everything that glows goes here too, and gets blurred back over the image. */
  neon: CanvasRenderingContext2D;
  m: MapData;
  s: GameState;
  p: Palette;
  theme: ThemeId;
  seed: number;
  flickers: SignFlicker[];
  steam: SteamVent[];
}

function verticalSign(cx: Ctx, x: number, y: number, count: number, color: string, seed: number): void {
  const w = 17;
  const cell = 15;
  const h = count * cell + 6;
  const { c, neon } = cx;
  c.fillStyle = '#07090f';
  c.fillRect(x, y, w, h);
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.fillRect(x + w, y + 3, 3, h);
  for (const t of [c, neon]) {
    t.strokeStyle = color;
    t.lineWidth = 1.6;
    t.strokeRect(x + 0.8, y + 0.8, w - 1.6, h - 1.6);
    t.lineWidth = 1.9;
    t.lineCap = 'butt';
    for (let i = 0; i < count; i++) glyph(t, x + 3.5, y + 4 + i * cell, 10, seed + i * 7);
  }
  if (hash(seed, 77) < 0.5) cx.flickers.push({ x, y, w, h, color, seed });
}

function wordSign(cx: Ctx, x: number, y: number, w: number, h: number, word: string, color: string, seed: number): void {
  const { c, neon } = cx;
  c.fillStyle = '#06080e';
  c.fillRect(x, y, w, h);
  c.fillStyle = alpha(color, 0.12);
  c.fillRect(x, y, w, h);
  for (const t of [c, neon]) {
    t.fillStyle = color;
    t.font = `800 ${Math.round(h * 0.86)}px ${DISPLAY}`;
    t.textAlign = 'center';
    t.textBaseline = 'middle';
    t.fillText(word, x + w / 2, y + h / 2 + 1, w - 4);
    t.fillRect(x, y, w, 1.5);
    t.fillRect(x, y + h - 1.5, w, 1.5);
  }
  if (hash(seed, 79) < 0.35) cx.flickers.push({ x, y, w, h, color, seed });
}

/* ---------- Ground ---------- */

type Ext = (x: number, y: number) => string;

function isOpen(t: string): boolean {
  return t !== '#' && t !== '~';
}

function paintGround(cx: Ctx, ext: Ext, noise: HTMLCanvasElement): void {
  const { c, p, m, theme } = cx;
  const left = -OUTER;
  const top = -OUTER;
  const right = m.w + OUTER;
  const bottom = m.h + OUTER;
  c.fillStyle = p.ground;
  c.fillRect(left * T, top * T, (right - left) * T, (bottom - top) * T);

  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const t = ext(x, y);
      if (!isOpen(t)) continue;
      const px = x * T;
      const py = y * T;
      const walk = ext(x - 1, y) === '#' || ext(x + 1, y) === '#' || ext(x, y - 1) === '#' || ext(x, y + 1) === '#';
      if (theme === 'plaza') {
        // Polished stone: big slabs, each catching the light a little differently.
        const sx = Math.floor((x + 200) / 2);
        const sy = Math.floor((y + 200) / 2);
        c.fillStyle = shade(p.ground2, 0.86 + hash(sx, sy, 2) * 0.34);
        c.fillRect(px, py, T, T);
      } else if (walk) {
        c.fillStyle = shade(p.walk, 0.9 + hash(x, y, 4) * 0.22);
        c.fillRect(px, py, T, T);
        c.strokeStyle = p.walkLine;
        c.lineWidth = 1.5;
        c.strokeRect(px + 0.5, py + 0.5, T / 2, T / 2);
        c.strokeRect(px + T / 2 + 0.5, py + T / 2 + 0.5, T / 2, T / 2);
      } else if (theme === 'market') {
        // Worn cobbles in the alleys.
        c.fillStyle = p.ground2;
        c.fillRect(px, py, T, T);
        for (let j = 0; j < 4; j++) {
          for (let i = 0; i < 4; i++) {
            const ox = (j % 2) * 8;
            c.fillStyle = shade(p.ground2, 0.85 + hash(x * 7 + i, y * 7 + j, 8) * 0.55);
            c.beginPath();
            c.roundRect(px + i * 16 + ox - 8, py + j * 16 + 1, 14, 14, 4);
            c.fill();
          }
        }
      } else {
        c.fillStyle = shade(p.ground2, 0.92 + hash(Math.floor((x + 90) / 3), Math.floor((y + 90) / 2), 5) * 0.16);
        c.fillRect(px, py, T, T);
      }
    }
  }

  // Curbs, where a sidewalk meets the road.
  if (theme !== 'plaza') {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        if (!isOpen(ext(x, y))) continue;
        const walk = (a: number, b: number) => ext(a - 1, b) === '#' || ext(a + 1, b) === '#' || ext(a, b - 1) === '#' || ext(a, b + 1) === '#';
        if (!walk(x, y)) continue;
        const px = x * T;
        const py = y * T;
        c.fillStyle = p.curb;
        if (isOpen(ext(x, y + 1)) && !walk(x, y + 1)) c.fillRect(px, py + T - 4, T, 4);
        if (isOpen(ext(x, y - 1)) && !walk(x, y - 1)) c.fillRect(px, py, T, 3);
        if (isOpen(ext(x + 1, y)) && !walk(x + 1, y)) c.fillRect(px + T - 3, py, 3, T);
        if (isOpen(ext(x - 1, y)) && !walk(x - 1, y)) c.fillRect(px, py, 3, T);
      }
    }
  }

  // Grit over everything.
  const pattern = c.createPattern(noise, 'repeat');
  if (pattern) {
    c.save();
    c.globalCompositeOperation = 'overlay';
    c.fillStyle = pattern;
    c.fillRect(left * T, top * T, (right - left) * T, (bottom - top) * T);
    c.restore();
  }

  paintMarkings(cx, ext);
  paintWear(cx, ext);
}

function paintMarkings(cx: Ctx, ext: Ext): void {
  const { c, m, theme } = cx;
  const midX = (m.w - 1) / 2;
  const midY = (m.h - 1) / 2;
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, width: number, dash: number[]) => {
    c.save();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.setLineDash(dash);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.restore();
  };

  if (theme === 'plaza') {
    // Inlaid light strips and a seal in the middle of the plaza.
    const cxp = (midX + 0.5) * T;
    const cyp = (midY + 0.5) * T;
    c.save();
    c.strokeStyle = alpha(NEON.cyan, 0.32);
    c.lineWidth = 2;
    for (const r of [T * 1.35, T * 2.3]) {
      c.beginPath();
      c.arc(cxp, cyp, r, 0, Math.PI * 2);
      c.stroke();
    }
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      c.beginPath();
      c.moveTo(cxp + Math.cos(a) * T * 1.35, cyp + Math.sin(a) * T * 1.35);
      c.lineTo(cxp + Math.cos(a) * T * 2.3, cyp + Math.sin(a) * T * 2.3);
      c.stroke();
    }
    c.restore();
    for (const dir of [-1, 1]) {
      line(cxp + dir * T * 2.5, cyp, dir > 0 ? (m.w + OUTER) * T : -OUTER * T, cyp, alpha(NEON.cyan, 0.2), 3, []);
      line(cxp, cyp + dir * T * 2.5, cxp, dir > 0 ? (m.h + OUTER) * T : -OUTER * T, alpha(NEON.cyan, 0.2), 3, []);
    }
    return;
  }

  if (theme === 'docks') {
    // Yellow lane paint down the north-south road, and rails set in the concrete.
    const lane = '#c9a227';
    const cxp = (midX + 0.5) * T;
    for (const dir of [-1, 1]) {
      line(cxp - 8, (midY + 0.5 + dir * 2) * T, cxp - 8, dir > 0 ? m.h * T : 0, alpha(lane, 0.5), 3.5, []);
      line(cxp + 8, (midY + 0.5 + dir * 2) * T, cxp + 8, dir > 0 ? m.h * T : 0, alpha(lane, 0.5), 3.5, []);
    }
    for (let y = -OUTER; y < m.h + OUTER; y += 11) {
      const ry = (y + 2.5) * T;
      for (const off of [-11, 11]) line(-OUTER * T, ry + off, (m.w + OUTER) * T, ry + off, 'rgba(120,140,165,0.2)', 3, []);
      for (let x = -OUTER * T; x < (m.w + OUTER) * T; x += 22) {
        c.fillStyle = 'rgba(0,0,0,0.22)';
        c.fillRect(x, ry - 16, 7, 32);
      }
    }
    return;
  }

  // Market: painted crossing where the alleys meet.
  const px = (midX + 0.5) * T;
  const py = (midY + 0.5) * T;
  c.fillStyle = 'rgba(230,220,200,0.16)';
  for (let i = -3; i <= 3; i++) {
    if (i === 0) continue;
    c.fillRect(px + i * 13 - 4, py - T * 1.45, 8, T * 0.5);
    c.fillRect(px + i * 13 - 4, py + T * 0.95, 8, T * 0.5);
  }
  void ext;
}

function paintWear(cx: Ctx, ext: Ext): void {
  const { c, m, seed } = cx;
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) {
      if (!isOpen(ext(x, y))) continue;
      const px = x * T;
      const py = y * T;
      const v = hash(x + seed, y, 11);
      if (v < 0.05) {
        // Oil stain
        const g = c.createRadialGradient(px + 32, py + 32, 2, px + 32, py + 32, 26);
        g.addColorStop(0, 'rgba(0,0,0,0.55)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(px, py, T, T);
      } else if (v < 0.09) {
        // Manhole
        const hx = px + 14 + hash(x, y, 12) * 36;
        const hy = py + 14 + hash(x, y, 13) * 36;
        c.fillStyle = '#0a0d13';
        c.beginPath();
        c.arc(hx, hy, 11, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = 'rgba(150,165,190,0.32)';
        c.lineWidth = 1.5;
        c.stroke();
        c.beginPath();
        c.moveTo(hx - 7, hy);
        c.lineTo(hx + 7, hy);
        c.moveTo(hx, hy - 7);
        c.lineTo(hx, hy + 7);
        c.stroke();
        if (hash(x, y, 14) < 0.5 && x >= 0 && y >= 0 && x < m.w && y < m.h) cx.steam.push({ x: hx, y: hy, seed: x * 13 + y });
      } else if (v < 0.17) {
        // Litter: flattened cans, wrappers
        for (let i = 0; i < 4; i++) {
          c.fillStyle = pick(['rgba(190,200,215,0.28)', 'rgba(255,46,136,0.22)', 'rgba(25,227,255,0.18)', 'rgba(0,0,0,0.4)'], hash(x, y, 20 + i));
          c.save();
          c.translate(px + hash(x, y, 30 + i) * T, py + hash(x, y, 40 + i) * T);
          c.rotate(hash(x, y, 50 + i) * 3);
          c.fillRect(-3, -2, 6 + hash(x, y, 60 + i) * 5, 3.5);
          c.restore();
        }
      }
      if (hash(x, y, 70) < 0.14) {
        // Cracks
        let ax = px + hash(x, y, 71) * T;
        let ay = py + hash(x, y, 72) * T;
        c.strokeStyle = 'rgba(0,0,0,0.5)';
        c.lineWidth = 1.3;
        c.beginPath();
        c.moveTo(ax, ay);
        for (let k = 0; k < 5; k++) {
          ax += (hash(x, y, 73 + k) - 0.5) * 34;
          ay += (hash(x, y, 83 + k) - 0.5) * 34;
          c.lineTo(ax, ay);
        }
        c.stroke();
      }
    }
  }
}

function paintWater(cx: Ctx, ext: Ext): void {
  const { c, p, m } = cx;
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) {
      if (ext(x, y) !== '~') continue;
      const px = x * T;
      const py = y * T;
      const g = c.createLinearGradient(0, py, 0, py + T);
      g.addColorStop(0, shade(p.water, 1.3));
      g.addColorStop(1, p.water);
      c.fillStyle = g;
      c.fillRect(px, py, T, T);
      c.save();
      c.beginPath();
      c.rect(px, py, T, T);
      c.clip();
      for (let i = 0; i < 5; i++) {
        const ly = py + 6 + i * 12 + hash(x, y, i) * 6;
        const lx = px + hash(y, x, i) * 26 - 6;
        const lw = 16 + hash(x, i, y) * 30;
        c.strokeStyle = i % 2 ? alpha(NEON.cyan, 0.3) : alpha(NEON.pink, 0.2);
        c.lineWidth = 1.5;
        c.beginPath();
        c.moveTo(lx, ly);
        c.quadraticCurveTo(lx + lw / 2, ly - 2, lx + lw, ly);
        c.stroke();
      }
      c.restore();
      // Quay edges, with hazard paint where the ground drops away.
      const edge = (a: number, b: number) => isOpen(ext(a, b)) && ext(a, b) !== '~';
      c.fillStyle = '#2d3744';
      if (edge(x, y - 1)) c.fillRect(px, py, T, 6);
      if (edge(x, y + 1)) c.fillRect(px, py + T - 6, T, 6);
      if (edge(x - 1, y)) c.fillRect(px, py, 6, T);
      if (edge(x + 1, y)) c.fillRect(px + T - 6, py, 6, T);
      if (edge(x, y - 1)) hazard(c, px, py + 1, T, 4);
      if (edge(x, y + 1)) hazard(c, px, py + T - 5, T, 4);
    }
  }
}

function hazard(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  c.fillStyle = '#d8a51f';
  c.fillRect(x, y, w, h);
  c.fillStyle = '#14161c';
  const step = Math.max(10, h * 2.2);
  for (let i = -2; i < w / step + 2; i++) {
    c.beginPath();
    c.moveTo(x + i * step, y + h);
    c.lineTo(x + i * step + step / 2, y + h);
    c.lineTo(x + i * step + step / 2 + h, y);
    c.lineTo(x + i * step + h, y);
    c.fill();
  }
  c.restore();
}

/* ---------- Buildings ---------- */

interface Building { tiles: [number, number][]; x0: number; y0: number; x1: number; y1: number; id: number; outside: boolean }

function findBuildings(cx: Ctx, ext: Ext): Building[] {
  const { m } = cx;
  const seen = new Set<string>();
  const out: Building[] = [];
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) {
      if (ext(x, y) !== '#' || seen.has(`${x},${y}`)) continue;
      const b: Building = { tiles: [], x0: x, y0: y, x1: x, y1: y, id: out.length, outside: true };
      const stack: [number, number][] = [[x, y]];
      seen.add(`${x},${y}`);
      while (stack.length) {
        const [a, d] = stack.pop()!;
        b.tiles.push([a, d]);
        b.x0 = Math.min(b.x0, a);
        b.y0 = Math.min(b.y0, d);
        b.x1 = Math.max(b.x1, a);
        b.y1 = Math.max(b.y1, d);
        if (a >= 0 && d >= 0 && a < m.w && d < m.h) b.outside = false;
        for (const [nx, ny] of [[a + 1, d], [a - 1, d], [a, d + 1], [a, d - 1]] as const) {
          if (nx < -OUTER || ny < -OUTER || nx >= m.w + OUTER || ny >= m.h + OUTER) continue;
          if (ext(nx, ny) === '#' && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            stack.push([nx, ny]);
          }
        }
      }
      out.push(b);
    }
  }
  return out;
}

interface Bay { x: number; y: number; kind: 'shop' | 'shutter' | 'windows' | 'door' | 'blank'; color: string; seed: number }

function planBays(cx: Ctx, ext: Ext, buildings: Building[]): Bay[] {
  const { p, seed, theme } = cx;
  const bays: Bay[] = [];
  for (const b of buildings) {
    for (const [x, y] of b.tiles) {
      if (ext(x, y + 1) === '#') continue;
      const v = hash(x + seed, y, 100);
      const shopChance = theme === 'market' ? 0.62 : theme === 'plaza' ? 0.34 : 0.3;
      const kind: Bay['kind'] = v < shopChance ? 'shop' : v < shopChance + 0.16 ? 'shutter' : v < shopChance + 0.34 ? 'windows' : v < shopChance + 0.42 ? 'door' : 'blank';
      bays.push({ x, y, kind, color: pick(p.neon, hash(x, y + seed, 101)), seed: x * 31 + y * 17 + seed });
    }
  }
  return bays;
}

function paintLight(cx: Ctx, ext: Ext, bays: Bay[]): void {
  const { c, p, m, seed } = cx;
  // Shadows from everything tall come first, so lights can lift them again.
  c.save();
  c.filter = 'blur(9px)';
  c.fillStyle = 'rgba(0,0,0,0.75)';
  // One shape for all of it: a separate blurred fill per tile took seconds on a board this size.
  c.beginPath();
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) if (ext(x, y) === '#') c.rect(x * T + 8, y * T + 12, T, T);
  }
  c.fill();
  c.restore();

  c.save();
  c.globalCompositeOperation = 'lighter';
  const pool = (x: number, y: number, r: number, color: string, a: number) => {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, alpha(color, a));
    g.addColorStop(0.55, alpha(color, a * 0.4));
    g.addColorStop(1, alpha(color, 0));
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // Shop light falling on the pavement, and the long streak a wet street makes of a neon sign.
  for (const b of bays) {
    if (b.kind !== 'shop' && b.kind !== 'door') continue;
    const px = b.x * T + T / 2;
    const py = (b.y + 1) * T;
    pool(px, py + 8, T * 1.05, b.kind === 'shop' ? b.color : p.lamp, 0.33);
    const g = c.createLinearGradient(0, py, 0, py + T * 2.2);
    g.addColorStop(0, alpha(b.color, 0.26));
    g.addColorStop(1, alpha(b.color, 0));
    c.fillStyle = g;
    c.fillRect(px - 9, py, 18, T * 2.2);
  }

  // Street lamps
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) {
      if (!isOpen(ext(x, y)) || hash(x + seed, y, 110) > 0.075) continue;
      pool(x * T + T / 2, y * T + T / 2, T * 2.1, p.lamp, 0.24);
    }
  }
  // Big soft washes of color, so the whole district feels lit by something off-screen.
  pool(m.w * T * 0.25, m.h * T * 0.3, T * 7, p.haze[0], 0.3);
  pool(m.w * T * 0.75, m.h * T * 0.75, T * 7, p.haze[1], 0.3);
  c.restore();

  // Rain puddles mirror whatever light is around them.
  for (let y = -OUTER; y < m.h + OUTER; y++) {
    for (let x = -OUTER; x < m.w + OUTER; x++) {
      if (!isOpen(ext(x, y)) || ext(x, y) === 'c' || hash(x + seed, y, 120) > 0.13) continue;
      const hx = x * T + T / 2 + (hash(x, y, 121) - 0.5) * 22;
      const hy = y * T + T / 2 + (hash(x, y, 122) - 0.5) * 22;
      const color = pick(p.neon, hash(x, y, 123));
      c.save();
      c.beginPath();
      for (let i = 0; i < 3; i++) {
        c.ellipse(hx + (hash(x, y, 124 + i) - 0.5) * 24, hy + (hash(x, y, 128 + i) - 0.5) * 12, 12 + hash(x, y, 132 + i) * 15, 6 + hash(x, y, 136 + i) * 7, 0, 0, Math.PI * 2);
      }
      c.fillStyle = 'rgba(4,7,14,0.42)';
      c.fill();
      c.clip();
      c.globalCompositeOperation = 'lighter';
      const g = c.createLinearGradient(hx, hy - 16, hx, hy + 16);
      g.addColorStop(0, alpha(color, 0.2));
      g.addColorStop(1, alpha(color, 0.02));
      c.fillStyle = g;
      c.fillRect(hx - 44, hy - 20, 88, 40);
      c.restore();
    }
  }
}

function drawFace(cx: Ctx, bay: Bay, wall: string): void {
  const { c } = cx;
  const x = bay.x * T;
  const top = (bay.y + 1) * T - FACE;
  const g = c.createLinearGradient(0, top, 0, top + FACE);
  g.addColorStop(0, shade(wall, 1.25));
  g.addColorStop(1, shade(wall, 0.6));
  c.fillStyle = g;
  c.fillRect(x, top, T, FACE);
  c.fillStyle = 'rgba(0,0,0,0.6)';
  c.fillRect(x, top, T, 2);

  const s = bay.seed;
  switch (bay.kind) {
    case 'shop': {
      const glass = c.createLinearGradient(0, top + 12, 0, top + FACE);
      glass.addColorStop(0, alpha(bay.color, 0.72));
      glass.addColorStop(1, alpha(bay.color, 0.2));
      c.fillStyle = '#04060a';
      c.fillRect(x + 4, top + 12, T - 8, FACE - 12);
      c.fillStyle = glass;
      c.fillRect(x + 5, top + 13, T - 10, FACE - 14);
      c.fillStyle = 'rgba(0,0,0,0.75)';
      for (let i = 1; i < 3; i++) c.fillRect(x + 4 + (i * (T - 8)) / 3, top + 12, 2, FACE - 12);
      break;
    }
    case 'shutter':
      c.fillStyle = '#242a35';
      c.fillRect(x + 4, top + 6, T - 8, FACE - 6);
      c.fillStyle = 'rgba(0,0,0,0.5)';
      for (let i = 0; i < 6; i++) c.fillRect(x + 4, top + 8 + i * 4, T - 8, 1.5);
      // A bit of spray paint.
      c.strokeStyle = alpha(pick([NEON.pink, NEON.green, NEON.cyan], hash(s, 2)), 0.7);
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + 12, top + 22);
      c.quadraticCurveTo(x + 22, top + 6, x + 30, top + 20);
      c.quadraticCurveTo(x + 38, top + 28, x + 48, top + 12);
      c.stroke();
      break;
    case 'windows':
      for (let i = 0; i < 4; i++) {
        const lit = hash(s, 10 + i) < 0.55;
        c.fillStyle = lit ? pick(['#ffcf87', '#9fe6ff', '#ff9ec8'], hash(s, 20 + i)) : '#070a11';
        c.fillRect(x + 6 + i * 14, top + 7, 10, 13);
        if (lit) {
          c.fillStyle = 'rgba(0,0,0,0.3)';
          c.fillRect(x + 6 + i * 14, top + 13, 10, 1.5);
        }
      }
      break;
    case 'door':
      c.fillStyle = '#ffd9a0';
      c.fillRect(x + 22, top + 7, 20, FACE - 7);
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(x + 31, top + 7, 2, FACE - 7);
      c.fillStyle = '#d43b3b';
      c.fillRect(x + 26, top + 3, 12, 3);
      break;
    default:
      c.fillStyle = 'rgba(255,255,255,0.05)';
      for (let i = 0; i < 2; i++) c.fillRect(x + 8 + hash(s, 30 + i) * 40, top + 6, 2.5, FACE - 6);
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.fillRect(x + 12, top + 10, 16, 11);
  }
}

function drawRoofDetail(cx: Ctx, b: Building, x: number, y: number, v: number, seed: number): void {
  const { c, neon, theme, p } = cx;
  const px = x * T;
  const py = y * T;
  const box = (ax: number, ay: number, w: number, h: number, top: string, lift: number) => {
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(ax + 3, ay + 4, w, h);
    c.fillStyle = shade(top, 0.55);
    c.fillRect(ax, ay + lift, w, h);
    c.fillStyle = top;
    c.fillRect(ax, ay, w, h);
    c.fillStyle = 'rgba(255,255,255,0.14)';
    c.fillRect(ax, ay, w, 1.5);
  };
  if (v < 0.3) {
    // Air-conditioning unit with a fan
    const ax = px + 10;
    const ay = py + 8;
    box(ax, ay, 40, 32, '#3b4655', 5);
    c.fillStyle = '#10151d';
    c.beginPath();
    c.arc(ax + 20, ay + 15, 12, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(190,205,225,0.55)';
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = hash(seed, 2) * 3 + (i * Math.PI) / 2;
      c.moveTo(ax + 20, ay + 15);
      c.lineTo(ax + 20 + Math.cos(a) * 10, ay + 15 + Math.sin(a) * 10);
    }
    c.stroke();
  } else if (v < 0.48) {
    // Water tank
    const ax = px + 32;
    const ay = py + 26;
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.beginPath();
    c.arc(ax + 4, ay + 6, 17, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#4a4238';
    c.beginPath();
    c.arc(ax, ay, 17, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#5e5346';
    c.beginPath();
    c.arc(ax, ay, 12, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 1.5;
    c.stroke();
  } else if (v < 0.64) {
    // Skylight, lit from below
    const color = pick(['#ffd28c', '#a9e8ff'], hash(seed, 3));
    const ax = px + 12;
    const ay = py + 10;
    for (const t of [c, neon]) {
      t.fillStyle = alpha(color, 0.85);
      t.fillRect(ax, ay, 38, 26);
    }
    c.strokeStyle = '#0b0f16';
    c.lineWidth = 2.5;
    c.strokeRect(ax, ay, 38, 26);
    c.beginPath();
    c.moveTo(ax + 19, ay);
    c.lineTo(ax + 19, ay + 26);
    c.moveTo(ax, ay + 13);
    c.lineTo(ax + 38, ay + 13);
    c.stroke();
  } else if (v < 0.78) {
    // Solar panels
    c.fillStyle = '#0d1a33';
    c.fillRect(px + 8, py + 8, 46, 32);
    c.strokeStyle = 'rgba(120,175,255,0.45)';
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      c.beginPath();
      c.moveTo(px + 8 + (i * 46) / 4, py + 8);
      c.lineTo(px + 8 + (i * 46) / 4, py + 40);
      c.stroke();
    }
    for (let i = 1; i < 3; i++) {
      c.beginPath();
      c.moveTo(px + 8, py + 8 + (i * 32) / 3);
      c.lineTo(px + 54, py + 8 + (i * 32) / 3);
      c.stroke();
    }
  } else {
    // Antenna mast with a warning light
    c.strokeStyle = '#6a7686';
    c.lineWidth = 2.5;
    c.beginPath();
    c.moveTo(px + 30, py + 34);
    c.lineTo(px + 30, py + 8);
    c.moveTo(px + 21, py + 14);
    c.lineTo(px + 39, py + 14);
    c.moveTo(px + 24, py + 22);
    c.lineTo(px + 36, py + 22);
    c.stroke();
    for (const t of [c, neon]) {
      t.fillStyle = NEON.red;
      t.beginPath();
      t.arc(px + 30, py + 7, 3.5, 0, Math.PI * 2);
      t.fill();
    }
  }
  void b;
  void theme;
  void p;
}

function drawBuilding(cx: Ctx, ext: Ext, b: Building, bays: Bay[], noise: HTMLCanvasElement): void {
  const { c, p, seed, theme, neon } = cx;
  const key = hash(b.x0 + seed, b.y0, 200);
  const roofColor = pick(p.roofs, key);
  const wall = pick(p.faces, hash(b.x0, b.y0 + seed, 201));
  const isWall = (x: number, y: number) => ext(x, y) === '#';

  // South walls first.
  for (const bay of bays) if (b.tiles.some(([x, y]) => x === bay.x && y === bay.y)) drawFace(cx, bay, wall);

  const roof = new Path2D();
  for (const [x, y] of b.tiles) roof.rect(x * T, y * T, T, T - (isWall(x, y + 1) ? 0 : FACE));

  c.save();
  c.clip(roof);
  c.fillStyle = roofColor;
  c.fillRect(b.x0 * T, b.y0 * T, (b.x1 - b.x0 + 1) * T, (b.y1 - b.y0 + 1) * T);
  // Tar patches and panel seams, so a roof doesn't read as a flat rectangle.
  for (let i = 0; i < b.tiles.length * 2; i++) {
    const [tx, ty] = b.tiles[Math.floor(hash(b.id, i, 202) * b.tiles.length)];
    c.fillStyle = hash(b.id, i, 203) < 0.5 ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.03)';
    c.fillRect(tx * T + hash(b.id, i, 204) * 30, ty * T + hash(b.id, i, 205) * 30, 18 + hash(b.id, i, 206) * 34, 12 + hash(b.id, i, 207) * 26);
  }
  c.strokeStyle = 'rgba(0,0,0,0.35)';
  c.lineWidth = 1.5;
  for (let x = b.x0; x <= b.x1 + 1; x++) {
    c.beginPath();
    c.moveTo(x * T, b.y0 * T);
    c.lineTo(x * T, (b.y1 + 1) * T);
    c.stroke();
  }
  const pattern = c.createPattern(noise, 'repeat');
  if (pattern) {
    c.globalCompositeOperation = 'overlay';
    c.fillStyle = pattern;
    c.fillRect(b.x0 * T, b.y0 * T, (b.x1 - b.x0 + 1) * T, (b.y1 - b.y0 + 1) * T);
    c.globalCompositeOperation = 'source-over';
  }
  c.restore();

  // Rooftop equipment, kept to squares with room for it.
  const w = b.x1 - b.x0 + 1;
  const h = b.y1 - b.y0 + 1;
  if (theme === 'plaza' && w >= 3 && h >= 3 && hash(b.id, seed, 210) < 0.7) {
    // Corporate tower: helipad on top
    const hx = (b.x0 + w / 2) * T;
    const hy = (b.y0 + h / 2) * T - FACE / 2;
    c.fillStyle = '#0b1120';
    c.beginPath();
    c.arc(hx, hy, T * 0.85, 0, Math.PI * 2);
    c.fill();
    for (const t of [c, neon]) {
      t.strokeStyle = NEON.cyan;
      t.lineWidth = 3;
      t.beginPath();
      t.arc(hx, hy, T * 0.85, 0, Math.PI * 2);
      t.stroke();
    }
    c.fillStyle = 'rgba(220,235,255,0.75)';
    c.font = `900 ${T * 0.9}px ${DISPLAY}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('H', hx, hy + 2);
  } else {
    for (const [x, y] of b.tiles) {
      if (isWall(x, y + 1) === false) continue;
      const v = hash(x + seed, y, 211);
      if (v < 0.75) drawRoofDetail(cx, b, x, y, hash(x, y + seed, 212), x * 13 + y * 7 + seed);
    }
    // Low buildings have no spare squares; a vent along the back still breaks up the roof.
    if (h === 1 || b.tiles.every(([x, y]) => !isWall(x, y + 1))) {
      for (const [x, y] of b.tiles) {
        c.fillStyle = '#39424f';
        c.fillRect(x * T + 14, y * T + 8, 22, 12);
        c.fillStyle = 'rgba(0,0,0,0.55)';
        for (let i = 0; i < 3; i++) c.fillRect(x * T + 16, y * T + 10 + i * 3.2, 18, 1.5);
      }
    }
  }

  // A parapet makes the roof read as the top of a real wall.
  c.save();
  c.clip(roof);
  for (const [x, y] of b.tiles) {
    const px = x * T;
    const py = y * T;
    const bottom = isWall(x, y + 1) ? py + T : py + T - FACE;
    const rim = shade(roofColor, 1.9);
    const dark = 'rgba(0,0,0,0.5)';
    if (!isWall(x, y - 1)) {
      c.fillStyle = rim;
      c.fillRect(px, py, T, 4);
      c.fillStyle = dark;
      c.fillRect(px, py + 4, T, 3);
    }
    if (!isWall(x - 1, y)) {
      c.fillStyle = rim;
      c.fillRect(px, py, 4, bottom - py);
      c.fillStyle = dark;
      c.fillRect(px + 4, py, 3, bottom - py);
    }
    if (!isWall(x + 1, y)) {
      c.fillStyle = shade(roofColor, 1.35);
      c.fillRect(px + T - 4, py, 4, bottom - py);
      c.fillStyle = dark;
      c.fillRect(px + T - 7, py, 3, bottom - py);
    }
    if (!isWall(x, y + 1)) {
      c.fillStyle = shade(roofColor, 1.55);
      c.fillRect(px, bottom - 4, T, 4);
      c.fillStyle = dark;
      c.fillRect(px, bottom - 7, T, 3);
    }
  }
  c.restore();

  // Signs go on last, over the wall tops.
  const signBays = bays.filter((bay) => b.tiles.some(([x, y]) => x === bay.x && y === bay.y));
  for (const bay of signBays) {
    const top = (bay.y + 1) * T - FACE;
    if (bay.kind === 'shop') {
      const word = pick(WORDS[theme], hash(bay.seed, 5));
      wordSign(cx, bay.x * T + 5, top + 1, T - 10, 12, word, bay.color, bay.seed);
    }
    if (hash(bay.seed, 6) < (theme === 'market' ? 0.5 : 0.28)) {
      const count = 2 + Math.floor(hash(bay.seed, 7) * 3);
      const h2 = count * 15 + 6;
      verticalSign(cx, bay.x * T + (hash(bay.seed, 8) < 0.5 ? 2 : T - 19), top + FACE - h2 - 3, count, pick(p.neon, hash(bay.seed, 9)), bay.seed);
    }
  }
}

/* ---------- Cover: every piece has to read at a glance as a real object ---------- */

/**
 * Blurs one small shape on a scrap of canvas just big enough for it, then pastes that in.
 * With ctx.filter set on the board itself, the browser works through the whole 8-megapixel canvas for every shape.
 */
function soft(c: CanvasRenderingContext2D, blur: number, x: number, y: number, w: number, h: number, paint: (t: CanvasRenderingContext2D) => void): void {
  const m = c.getTransform();
  const corners = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => m.transformPoint({ x: px, y: py }));
  const reach = blur * 3;
  const left = Math.floor(Math.min(...corners.map((p) => p.x))) - reach;
  const top = Math.floor(Math.min(...corners.map((p) => p.y))) - reach;
  const scrap = document.createElement('canvas');
  scrap.width = Math.ceil(Math.max(...corners.map((p) => p.x))) + reach - left;
  scrap.height = Math.ceil(Math.max(...corners.map((p) => p.y))) + reach - top;
  const t = scrap.getContext('2d')!;
  t.setTransform(m.a, m.b, m.c, m.d, m.e - left, m.f - top);
  t.filter = `blur(${blur}px)`;
  paint(t);
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.drawImage(scrap, left, top);
  c.restore();
}

function contact(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  soft(c, 4, x + 2, y + 5, w, h, (t) => {
    t.fillStyle = 'rgba(0,0,0,0.8)';
    t.fillRect(x + 2, y + 5, w, h);
  });
}

function barrierRun(cx: Ctx, x: number, y: number, len: number, horizontal: boolean): void {
  const { c } = cx;
  if (horizontal) {
    const px = x * T + 4;
    const py = y * T + 20;
    const w = len * T - 8;
    contact(c, px, py + 14, w, 18);
    c.fillStyle = '#8c94a0';
    c.fillRect(px, py, w, 14);
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.fillRect(px, py, w, 2);
    c.fillStyle = '#4a505a';
    c.fillRect(px, py + 14, w, 14);
    hazard(c, px, py + 15, w, 12);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 1; i < len; i++) c.fillRect(px + i * T - 4, py, 3, 28);
  } else {
    const px = x * T + 21;
    const py = y * T + 3;
    const h = len * T - 8;
    contact(c, px, py, 22, h + 12);
    c.fillStyle = '#8c94a0';
    c.fillRect(px, py, 22, h);
    c.fillStyle = 'rgba(255,255,255,0.22)';
    c.fillRect(px, py, 2, h);
    c.fillStyle = '#4a505a';
    c.fillRect(px, py + h, 22, 12);
    hazard(c, px + 1, py + h + 1, 20, 10);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 1; i < len; i++) c.fillRect(px, py + i * T - 2, 22, 3);
  }
}

function car(cx: Ctx, x: number, y: number, horizontal: boolean, seed: number): void {
  const { c, neon } = cx;
  const colors = ['#b5323f', '#2a6f97', '#3f4a59', '#7a5a2a', '#47306e', '#c9c9c9'];
  const body = pick(colors, hash(seed, 1));
  const cxp = horizontal ? (x + 1) * T : (x + 0.5) * T;
  const cyp = horizontal ? (y + 0.5) * T + 2 : (y + 1) * T;
  const facing = hash(seed, 2) < 0.5 ? 1 : -1;
  const len = T * 1.72;
  const wid = T * 0.72;
  const orient = (t: CanvasRenderingContext2D) => {
    t.translate(cxp, cyp);
    t.rotate(horizontal ? 0 : Math.PI / 2);
    t.scale(facing, 1);
  };
  c.save();
  orient(c);
  // Under-car glow and shadow
  soft(c, 7, -len / 2 - 2, -wid / 2 - 3, len + 4, wid + 6, (t) => {
    t.fillStyle = alpha(pick([NEON.pink, NEON.cyan, NEON.violet], hash(seed, 3)), 0.6);
    t.fillRect(-len / 2 - 2, -wid / 2 - 3, len + 4, wid + 6);
  });
  c.fillStyle = 'rgba(0,0,0,0.85)';
  c.beginPath();
  c.roundRect(-len / 2, -wid / 2, len, wid, 13);
  c.fill();
  // Wheels
  c.fillStyle = '#06070a';
  for (const wx of [-len * 0.3, len * 0.3]) for (const wy of [-wid / 2 - 1.5, wid / 2 - 5]) c.fillRect(wx - 8, wy, 16, 6.5);
  // Body
  const g = c.createLinearGradient(0, -wid / 2, 0, wid / 2);
  g.addColorStop(0, shade(body, 1.2));
  g.addColorStop(0.5, body);
  g.addColorStop(1, shade(body, 0.55));
  c.fillStyle = g;
  c.beginPath();
  c.roundRect(-len / 2 + 2, -wid / 2 + 3, len - 4, wid - 6, 11);
  c.fill();
  // Cabin
  c.fillStyle = '#0a1018';
  c.beginPath();
  c.roundRect(-len * 0.2, -wid / 2 + 8, len * 0.46, wid - 16, 7);
  c.fill();
  c.fillStyle = 'rgba(150,215,255,0.32)';
  c.beginPath();
  c.moveTo(len * 0.26 - 2, -wid / 2 + 10);
  c.lineTo(len * 0.26 - 9, wid / 2 - 10);
  c.lineTo(len * 0.26 - 16, wid / 2 - 10);
  c.lineTo(len * 0.26 - 9, -wid / 2 + 10);
  c.fill();
  c.fillStyle = shade(body, 0.8);
  c.fillRect(-len * 0.13, -wid / 2 + 11, len * 0.26, wid - 22);
  // Hood line
  c.strokeStyle = 'rgba(0,0,0,0.4)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(len * 0.33, -wid / 2 + 6);
  c.lineTo(len * 0.33, wid / 2 - 6);
  c.stroke();
  c.restore();

  neon.save();
  orient(neon);
  for (const wy of [-wid * 0.3, wid * 0.3]) {
    neon.fillStyle = '#fff4d0';
    neon.fillRect(len / 2 - 6, wy - 3, 5, 6);
    neon.fillStyle = NEON.red;
    neon.fillRect(-len / 2 + 2, wy - 4, 4, 8);
  }
  neon.restore();
  c.save();
  orient(c);
  for (const wy of [-wid * 0.3, wid * 0.3]) {
    c.fillStyle = '#fff4d0';
    c.fillRect(len / 2 - 6, wy - 3, 5, 6);
    c.fillStyle = NEON.red;
    c.fillRect(-len / 2 + 2, wy - 4, 4, 8);
  }
  c.restore();
}

function crates(cx: Ctx, x: number, y: number, seed: number): void {
  const { c } = cx;
  const px = x * T;
  const py = y * T;
  contact(c, px + 7, py + 30, 50, 26);
  const crate = (ax: number, ay: number, w: number, top: string) => {
    c.fillStyle = shade(top, 0.5);
    c.fillRect(ax, ay + w * 0.72, w, 13);
    c.fillStyle = top;
    c.fillRect(ax, ay, w, w * 0.72);
    c.strokeStyle = 'rgba(0,0,0,0.5)';
    c.lineWidth = 2;
    c.strokeRect(ax + 2, ay + 2, w - 4, w * 0.72 - 4);
    c.beginPath();
    c.moveTo(ax + 3, ay + 3);
    c.lineTo(ax + w - 3, ay + w * 0.72 - 3);
    c.moveTo(ax + w - 3, ay + 3);
    c.lineTo(ax + 3, ay + w * 0.72 - 3);
    c.stroke();
    c.fillStyle = 'rgba(255,255,255,0.2)';
    c.fillRect(ax, ay, w, 1.5);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(ax + 3, ay + w * 0.72 + 3, w - 6, 2);
  };
  const tone = pick(['#a97a42', '#8d6a3c', '#3f7f88', '#7c8a4a'], hash(seed, 1));
  crate(px + 6, py + 20, 36, tone);
  crate(px + 28, py + 26, 28, shade(tone, 0.8));
  crate(px + 12, py + 4, 28, shade(tone, 1.12));
}

function dumpster(cx: Ctx, x: number, y: number, seed: number): void {
  const { c } = cx;
  const px = x * T + 7;
  const py = y * T + 14;
  const w = T - 14;
  contact(c, px, py + 22, w, 22);
  const body = pick(['#2f6a4f', '#31577d', '#7a3a2c'], hash(seed, 1));
  c.fillStyle = shade(body, 0.55);
  c.fillRect(px, py + 22, w, 16);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  for (let i = 1; i < 5; i++) c.fillRect(px + (i * w) / 5, py + 22, 2, 16);
  c.fillStyle = body;
  c.fillRect(px, py, w, 22);
  c.fillStyle = shade(body, 1.35);
  c.fillRect(px + 2, py + 2, w / 2 - 3, 18);
  c.fillRect(px + w / 2 + 1, py + 2, w / 2 - 3, 18);
  c.fillStyle = 'rgba(255,255,255,0.28)';
  c.fillRect(px, py, w, 1.5);
  // A trash bag that didn't make it in.
  c.fillStyle = '#10131a';
  c.beginPath();
  c.ellipse(px + w - 4, py + 37, 11, 8, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.14)';
  c.beginPath();
  c.ellipse(px + w - 7, py + 34, 4, 2.5, 0, 0, Math.PI * 2);
  c.fill();
}

function drums(cx: Ctx, x: number, y: number, seed: number): void {
  const { c } = cx;
  const px = x * T;
  const py = y * T;
  const tone = pick(['#2f7f8c', '#a2552f', '#59616e'], hash(seed, 1));
  const drum = (ax: number, ay: number) => {
    soft(c, 3, ax - 11, ay + 8, 26, 16, (t) => {
      t.fillStyle = 'rgba(0,0,0,0.8)';
      t.beginPath();
      t.ellipse(ax + 2, ay + 16, 13, 8, 0, 0, Math.PI * 2);
      t.fill();
    });
    c.fillStyle = shade(tone, 0.55);
    c.fillRect(ax - 12, ay, 24, 14);
    c.beginPath();
    c.ellipse(ax, ay + 14, 12, 6, 0, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#d8a51f';
    c.fillRect(ax - 12, ay + 5, 24, 3.5);
    c.fillStyle = tone;
    c.beginPath();
    c.ellipse(ax, ay, 12, 7, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.lineWidth = 1.5;
    c.stroke();
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.beginPath();
    c.arc(ax + 4, ay - 1, 2.2, 0, Math.PI * 2);
    c.fill();
  };
  drum(px + 20, py + 16);
  drum(px + 44, py + 20);
  drum(px + 28, py + 36);
}

function vending(cx: Ctx, x: number, y: number, seed: number): void {
  const { c, neon, p } = cx;
  const px = x * T + 13;
  const py = y * T + 6;
  const w = T - 26;
  const color = pick(p.neon, hash(seed, 1));
  contact(c, px, py + 40, w, 16);
  c.fillStyle = '#2a303c';
  c.fillRect(px, py, w, 10);
  c.fillStyle = 'rgba(255,255,255,0.2)';
  c.fillRect(px, py, w, 1.5);
  c.fillStyle = '#10141c';
  c.fillRect(px, py + 10, w, 40);
  for (const t of [c, neon]) {
    t.fillStyle = alpha(color, 0.8);
    t.fillRect(px + 3, py + 13, w - 6, 25);
  }
  c.fillStyle = 'rgba(0,0,0,0.55)';
  for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) c.fillRect(px + 5 + i * 7, py + 15 + j * 8, 4.5, 5.5);
  c.fillStyle = '#05070b';
  c.fillRect(px + 4, py + 41, w - 8, 6);
}

function planter(cx: Ctx, x: number, y: number, seed: number): void {
  const { c, neon, p } = cx;
  const px = x * T + 8;
  const py = y * T + 14;
  const w = T - 16;
  contact(c, px, py + 24, w, 20);
  c.fillStyle = '#39445c';
  c.fillRect(px, py + 24, w, 13);
  c.fillStyle = '#5a6885';
  c.fillRect(px, py, w, 25);
  c.fillStyle = '#0b1420';
  c.fillRect(px + 4, py + 4, w - 8, 17);
  const leaf = pick([NEON.green, NEON.cyan, NEON.pink], hash(seed, 1));
  for (let i = 0; i < 14; i++) {
    const ax = px + 7 + hash(seed, 10 + i) * (w - 14);
    const ay = py + 4 + hash(seed, 30 + i) * 15;
    for (const t of [c, neon]) {
      t.fillStyle = alpha(leaf, 0.35 + hash(seed, 50 + i) * 0.5);
      t.beginPath();
      t.ellipse(ax, ay, 6, 3, hash(seed, 70 + i) * 3, 0, Math.PI * 2);
      t.fill();
    }
  }
  void p;
}

function stall(cx: Ctx, x: number, y: number, len: number, horizontal: boolean, seed: number): void {
  const { c, neon, p } = cx;
  const color = pick(p.neon, hash(seed, 1));
  const px = x * T + 2;
  const py = y * T + 4;
  const w = (horizontal ? len : 1) * T - 4;
  const h = (horizontal ? 1 : len) * T - 12;
  contact(c, px, py + h - 10, w, 16);
  // Counter under the awning
  c.fillStyle = '#17121c';
  c.fillRect(px + 4, py + h - 12, w - 8, 14);
  // Striped awning
  c.save();
  c.beginPath();
  c.rect(px, py, w, h - 10);
  c.clip();
  const stripes = Math.max(5, Math.round(w / 11));
  for (let i = 0; i < stripes; i++) {
    c.fillStyle = i % 2 ? '#e9dfca' : color;
    c.fillRect(px + (i * w) / stripes, py, w / stripes + 1, h);
  }
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.fillRect(px, py, w, 4);
  c.restore();
  // Scalloped edge
  for (let i = 0; i < stripes; i++) {
    c.fillStyle = i % 2 ? '#c9bfaa' : shade(color, 0.8);
    c.beginPath();
    c.arc(px + ((i + 0.5) * w) / stripes, py + h - 10, w / stripes / 2, 0, Math.PI);
    c.fill();
  }
  // Lanterns hanging off the front
  for (let i = 0; i < Math.max(1, Math.floor(w / 42)); i++) {
    const lx = px + 16 + i * 42;
    for (const t of [c, neon]) {
      t.fillStyle = NEON.amber;
      t.beginPath();
      t.ellipse(lx, py + h - 1, 5, 6.5, 0, 0, Math.PI * 2);
      t.fill();
    }
  }
}

function container(cx: Ctx, x: number, y: number, len: number, horizontal: boolean, seed: number): void {
  const { c } = cx;
  const color = pick(['#8c3d2d', '#27576e', '#3e6b4f', '#7a6423'], hash(seed, 1));
  const px = x * T + 3;
  const py = y * T + 5;
  const w = (horizontal ? len : 1) * T - 6;
  const h = (horizontal ? 1 : len) * T - 26;
  contact(c, px, py + h + 6, w, 18);
  c.fillStyle = shade(color, 0.5);
  c.fillRect(px, py + h, w, 15);
  c.fillStyle = color;
  c.fillRect(px, py, w, h);
  // Corrugation
  c.strokeStyle = 'rgba(0,0,0,0.32)';
  c.lineWidth = 2;
  for (let i = 5; i < (horizontal ? w : h); i += 7) {
    c.beginPath();
    if (horizontal) {
      c.moveTo(px + i, py + 2);
      c.lineTo(px + i, py + h - 2);
    } else {
      c.moveTo(px + 2, py + i);
      c.lineTo(px + w - 2, py + i);
    }
    c.stroke();
  }
  c.fillStyle = 'rgba(255,255,255,0.25)';
  c.fillRect(px, py, w, 1.5);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  for (let i = 4; i < w; i += 7) c.fillRect(px + i, py + h, 2, 15);
  c.fillStyle = 'rgba(235,235,225,0.72)';
  c.font = `800 13px ${DISPLAY}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (horizontal) c.fillText(pick(['OYAMA', 'SABLE', 'MRDN', 'K-LINE'], hash(seed, 2)), px + w / 2, py + h / 2);
}

function sandbags(cx: Ctx, x: number, y: number, seed: number): void {
  const { c } = cx;
  const px = x * T + 6;
  const py = y * T + 22;
  contact(c, px, py + 14, T - 12, 18);
  for (let row = 0; row < 3; row++) {
    const count = 4 - (row % 2);
    for (let i = 0; i < count; i++) {
      const ax = px + 6 + (row % 2) * 6 + i * 13;
      const ay = py + 20 - row * 9;
      c.fillStyle = shade('#7f7458', 0.8 + hash(seed, row * 5 + i) * 0.3);
      c.beginPath();
      c.ellipse(ax, ay, 8, 5.5, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.45)';
      c.lineWidth = 1.2;
      c.stroke();
    }
  }
}

function drawCover(cx: Ctx, ext: Ext): void {
  const { m, theme, seed } = cx;
  const done = new Set<number>();
  const key = (x: number, y: number) => x + y * m.w;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (tileAt(m, x, y) !== 'c' || done.has(key(x, y))) continue;
      let lenH = 1;
      while (tileAt(m, x + lenH, y) === 'c') lenH += 1;
      let lenV = 1;
      while (tileAt(m, x, y + lenV) === 'c') lenV += 1;
      const horizontal = lenH >= lenV;
      const len = horizontal ? lenH : lenV;
      for (let i = 0; i < len; i++) done.add(horizontal ? key(x + i, y) : key(x, y + i));
      const v = hash(x + seed, y, 300);
      const s = x * 29 + y * 41 + seed;
      const touchesWall = ext(x - 1, y) === '#' || ext(x + 1, y) === '#' || ext(x, y - 1) === '#';
      if (len >= 2) {
        if (theme === 'market') stall(cx, x, y, len, horizontal, s);
        else if (theme === 'docks' && v < 0.6) container(cx, x, y, len, horizontal, s);
        else if (len === 2 && v < 0.72) car(cx, x, y, horizontal, s);
        else barrierRun(cx, x, y, len, horizontal);
      } else if (theme === 'market') {
        if (touchesWall && v < 0.35) vending(cx, x, y, s);
        else if (v < 0.55) stall(cx, x, y, 1, true, s);
        else if (v < 0.78) dumpster(cx, x, y, s);
        else crates(cx, x, y, s);
      } else if (theme === 'plaza') {
        if (touchesWall && v < 0.4) vending(cx, x, y, s);
        else if (v < 0.8) planter(cx, x, y, s);
        else barrierRun(cx, x, y, 1, true);
      } else {
        if (v < 0.34) crates(cx, x, y, s);
        else if (v < 0.58) drums(cx, x, y, s);
        else if (touchesWall && v < 0.8) dumpster(cx, x, y, s);
        else if (v < 0.9) sandbags(cx, x, y, s);
        else barrierRun(cx, x, y, 1, true);
      }
    }
  }
}

function drawGlass(cx: Ctx): void {
  const { c, neon, m } = cx;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (tileAt(m, x, y) !== 'g') continue;
      const px = x * T;
      const py = y * T;
      // A hard-light security screen: you can see through it, but can't walk through it.
      c.fillStyle = alpha(NEON.cyan, 0.14);
      c.fillRect(px + 3, py + 3, T - 6, T - 6);
      c.strokeStyle = alpha(NEON.cyan, 0.4);
      c.lineWidth = 1;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const hx = px + 10 + i * 15 + (j % 2) * 7;
          const hy = py + 12 + j * 13;
          c.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k * Math.PI) / 3;
            const qx = hx + Math.cos(a) * 6;
            const qy = hy + Math.sin(a) * 6;
            if (k === 0) c.moveTo(qx, qy);
            else c.lineTo(qx, qy);
          }
          c.closePath();
          c.stroke();
        }
      }
      for (const t of [c, neon]) {
        t.strokeStyle = NEON.cyan;
        t.lineWidth = 2.5;
        t.strokeRect(px + 3, py + 3, T - 6, T - 6);
      }
    }
  }
}

function drawTerminals(cx: Ctx): void {
  const { c, neon, m } = cx;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (tileAt(m, x, y) !== 'T') continue;
      const px = x * T + 12;
      const py = y * T + 6;
      const w = T - 24;
      contact(c, px, py + 36, w, 20);
      c.fillStyle = '#1b2230';
      c.fillRect(px, py + 34, w, 18);
      c.fillStyle = '#343f52';
      c.fillRect(px, py, w, 36);
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.fillRect(px, py, w, 1.5);
      c.fillStyle = '#040810';
      c.fillRect(px + 4, py + 4, w - 8, 24);
      for (const t of [c, neon]) {
        t.fillStyle = NEON.green;
        for (let i = 0; i < 5; i++) t.fillRect(px + 7, py + 7 + i * 4, (w - 14) * (0.35 + hash(x, y, i + 40) * 0.65), 2);
      }
      c.fillStyle = '#596479';
      for (let i = 0; i < 4; i++) c.fillRect(px + 5 + i * 7, py + 39, 4.5, 4);
    }
  }
}

function drawZones(cx: Ctx): void {
  const { c, m, s } = cx;
  m.zones.forEach((z, i) => {
    const side = s.cfg.sides[i];
    if (!side) return;
    const color = FACTIONS[side.faction].color;
    const x = z.x * T;
    const y = z.y * T;
    const w = z.w * T;
    const h = z.h * T;
    // Painted on the road: a faint tint, a line, and chevrons pointing into the fight.
    c.fillStyle = alpha(color, 0.03);
    c.fillRect(x, y, w, h);
    c.strokeStyle = alpha(color, 0.75);
    c.lineWidth = 2.5;
    c.setLineDash([16, 10]);
    c.strokeRect(x + 2, y + 2, w - 4, h - 4);
    c.setLineDash([]);
    const b = 22;
    c.lineWidth = 5;
    c.beginPath();
    for (const [ax, ay, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]] as const) {
      c.moveTo(ax + dx * b, ay + dy * 2);
      c.lineTo(ax + dx * 2, ay + dy * 2);
      c.lineTo(ax + dx * 2, ay + dy * b);
    }
    c.stroke();
  });
}

function drawGrid(cx: Ctx): void {
  const { c, m } = cx;
  c.strokeStyle = 'rgba(190,225,255,0.05)';
  c.lineWidth = 1;
  for (let x = 0; x <= m.w; x++) {
    c.beginPath();
    c.moveTo(x * T, 0);
    c.lineTo(x * T, m.h * T);
    c.stroke();
  }
  for (let y = 0; y <= m.h; y++) {
    c.beginPath();
    c.moveTo(0, y * T);
    c.lineTo(m.w * T, y * T);
    c.stroke();
  }
  // Small crosses at the corners keep squares countable without ruling lines across the art.
  c.fillStyle = 'rgba(210,235,255,0.3)';
  for (let y = 0; y <= m.h; y++) {
    for (let x = 0; x <= m.w; x++) {
      c.fillRect(x * T - 3.5, y * T - 0.75, 7, 1.5);
      c.fillRect(x * T - 0.75, y * T - 3.5, 1.5, 7);
    }
  }
}

/* ---------- Putting it together ---------- */

export function renderBoardArt(s: GameState): BoardArt {
  const m = s.map;
  const W = (m.w + OUTER * 2) * T;
  const H = (m.h + OUTER * 2) * T;
  const layer = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const canvas = document.createElement('canvas');
    canvas.width = W * ART_SCALE;
    canvas.height = H * ART_SCALE;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(ART_SCALE, ART_SCALE);
    ctx.translate(OUTER * T, OUTER * T);
    return [canvas, ctx];
  };
  const [canvas, c] = layer();
  const [neonCanvas, neon] = layer();
  let seed = 0;
  for (let i = 0; i < m.id.length; i++) seed = (seed * 31 + m.id.charCodeAt(i)) | 0;
  seed = Math.abs(seed) % 100000;

  // Out of play, the city just carries on: a street around the board, then blocks of rooftops.
  const ext: Ext = (x, y) => {
    if (x >= 0 && y >= 0 && x < m.w && y < m.h) return tileAt(m, x, y);
    const dist = Math.max(-x, x - m.w + 1, -y, y - m.h + 1);
    if (dist <= 1) return '.';
    const gx = Math.floor((x + 200) / 5);
    const gy = Math.floor((y + 200) / 4);
    const street = (x + 200) % 5 === 4 || (y + 200) % 4 === 3;
    if (street || hash(gx, gy, seed) < 0.12) return '.';
    return '#';
  };

  const cx: Ctx = { c, neon, m, s, p: PALETTES[m.theme], theme: m.theme, seed, flickers: [], steam: [] };
  const noise = noiseCanvas(160, 0.2);

  paintGround(cx, ext, noise);
  paintWater(cx, ext);
  const buildings = findBuildings(cx, ext);
  const bays = planBays(cx, ext, buildings);
  paintLight(cx, ext, bays);
  drawGrid(cx);
  drawZones(cx);
  for (const b of buildings) {
    const own = bays.filter((bay) => b.tiles.some(([x, y]) => x === bay.x && y === bay.y));
    drawBuilding(cx, ext, b, own, noise);
  }
  drawGlass(cx);
  drawCover(cx, ext);
  drawTerminals(cx);

  // Bloom: everything that glows gets a blurred copy added on top.
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalCompositeOperation = 'lighter';
  c.filter = 'blur(18px)';
  c.globalAlpha = 0.9;
  c.drawImage(neonCanvas, 0, 0);
  c.filter = 'blur(5px)';
  c.globalAlpha = 0.7;
  c.drawImage(neonCanvas, 0, 0);
  c.restore();

  // Night grade: colder shadows, and a dimmed, hazy city outside the area of play.
  c.save();
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = 'rgba(176,186,226,1)';
  c.fillRect(-OUTER * T, -OUTER * T, W, H);
  c.restore();
  c.save();
  c.fillStyle = 'rgba(4,6,12,0.62)';
  c.beginPath();
  c.rect(-OUTER * T, -OUTER * T, W, H);
  c.rect(0, 0, m.w * T, m.h * T);
  c.fill('evenodd');
  c.restore();
  // The playable edge, as a hard line with brackets at the corners.
  c.strokeStyle = 'rgba(210,235,255,0.5)';
  c.lineWidth = 2;
  c.strokeRect(0, 0, m.w * T, m.h * T);

  return { canvas, flickers: cx.flickers.filter((f) => f.x >= 0 && f.y >= 0 && f.x < m.w * T && f.y < m.h * T), steam: cx.steam };
}
