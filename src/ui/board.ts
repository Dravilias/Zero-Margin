import { FACTIONS } from '../engine/data';
import type { GameState, RoleId, Unit } from '../engine/types';
import { sfx } from './audio';
import { ART_SCALE, OUTER, T, renderBoardArt, type BoardArt } from './boardArt';
import { ROLE_PATHS, isStroked } from './icons';
import { settings, speedFactor } from './settings';

const iconPaths = new Map<RoleId, Path2D>();
function icon(role: RoleId): Path2D {
  let p = iconPaths.get(role);
  if (!p) {
    p = new Path2D(ROLE_PATHS[role]);
    iconPaths.set(role, p);
  }
  return p;
}

export interface Highlights {
  move: Set<number> | null;
  tiles: Set<number> | null;
  /** Blast or area radius to preview under the mouse in tile-target modes. */
  radius: number;
  targets: Map<string, { chance: number; color: string }>;
  terminals: Map<number, number>;
  zone: { x: number; y: number; w: number; h: number; color: string } | null;
  path: [number, number][] | null;
}

export const NO_HIGHLIGHTS: Highlights = { move: null, tiles: null, radius: 0, targets: new Map(), terminals: new Map(), zone: null, path: null };

interface Anim { start: number; dur: number; draw(c: CanvasRenderingContext2D, k: number): void }

interface Float { x: number; y: number; text: string; color: string; start: number; dur: number; big: boolean }

export class Board {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private art: BoardArt | null = null;
  private viewLayer: HTMLCanvasElement | null = null;
  private viewKey = '';
  private shadowLayer: HTMLCanvasElement | null = null;
  private state: GameState | null = null;
  private mapId = '';
  private anims: Anim[] = [];
  private floats: Float[] = [];
  private tokenPos = new Map<string, { x: number; y: number; lift: number }>();
  private shake = new Map<string, number>();
  private hl: Highlights = NO_HIGHLIGHTS;
  private selected: string | null = null;
  private spot: { unit?: string; tile?: [number, number] } = {};
  private active: string | null = null;
  private hover: { x: number; y: number } | null = null;
  private cam = { x: 0, y: 0, z: 1 };
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private userCam = false;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private rain: { x: number; y: number; v: number; l: number }[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;
  private destroyed = false;
  private lastDraw = 0;
  private observer: ResizeObserver;
  private frameId = 0;
  private endDrag = () => { this.drag = null; };

  onTileClick: ((x: number, y: number) => void) | null = null;
  onTileHover: ((x: number, y: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'board-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    for (let i = 0; i < 90; i++) this.rain.push({ x: Math.random(), y: Math.random(), v: 0.5 + Math.random(), l: 8 + Math.random() * 16 });
    this.bindInput();
    this.frameId = requestAnimationFrame((t) => this.frame(t));
  }

  /** Lets go of everything, so a finished battle's big art canvases don't outlive it. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    this.observer.disconnect();
    window.removeEventListener('mouseup', this.endDrag);
    this.onTileClick = null;
    this.onTileHover = null;
    // Shrinking a canvas frees its pixels right away, without waiting for garbage collection.
    for (const canvas of [this.art?.canvas, this.viewLayer, this.canvas]) {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    this.art = null;
    this.viewLayer = null;
    this.state = null;
    this.anims = [];
    this.floats = [];
  }

  private resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, r.width * this.dpr);
    this.canvas.height = Math.max(1, r.height * this.dpr);
    if (!this.userCam) this.fit();
  }

  private fit(): void {
    if (!this.state) return;
    const m = this.state.map;
    const i = this.insets;
    const availW = Math.max(100, this.w - i.left - i.right);
    const availH = Math.max(100, this.h - i.top - i.bottom);
    const z = Math.min(availW / (m.w * T), availH / (m.h * T));
    this.cam.z = z;
    this.cam.x = i.left + (availW - m.w * T * z) / 2;
    this.cam.y = i.top + (availH - m.h * T * z) / 2;
  }

  private toTile(px: number, py: number): { x: number; y: number } {
    return { x: Math.floor((px - this.cam.x) / this.cam.z / T), y: Math.floor((py - this.cam.y) / this.cam.z / T) };
  }

  private bindInput(): void {
    const c = this.canvas;
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('mousemove', (e) => {
      const p = pos(e);
      if (this.drag) {
        this.cam.x += p.x - this.drag.x;
        this.cam.y += p.y - this.drag.y;
        if (Math.abs(p.x - this.drag.x) + Math.abs(p.y - this.drag.y) > 0) {
          this.drag.moved = true;
          this.userCam = true;
        }
        this.drag.x = p.x;
        this.drag.y = p.y;
        return;
      }
      const t = this.toTile(p.x, p.y);
      if (!this.hover || this.hover.x !== t.x || this.hover.y !== t.y) {
        this.hover = t;
        this.onTileHover?.(t.x, t.y);
      }
    });
    c.addEventListener('mouseleave', () => {
      this.hover = null;
      this.onTileHover?.(-1, -1);
    });
    c.addEventListener('mousedown', (e) => {
      if (e.button === 2 || e.button === 1) {
        const p = pos(e);
        this.drag = { x: p.x, y: p.y, moved: false };
        e.preventDefault();
      }
    });
    window.addEventListener('mouseup', this.endDrag);
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('click', (e) => {
      const p = pos(e);
      const t = this.toTile(p.x, p.y);
      this.onTileClick?.(t.x, t.y);
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const z = Math.max(0.3, Math.min(2.6, this.cam.z * factor));
      this.cam.x = p.x - ((p.x - this.cam.x) / this.cam.z) * z;
      this.cam.y = p.y - ((p.y - this.cam.y) / this.cam.z) * z;
      this.cam.z = z;
      this.userCam = true;
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      if (e.detail >= 2 && e.shiftKey) {
        this.userCam = false;
        this.fit();
      }
    });
  }

  setState(s: GameState): void {
    if (this.destroyed) return;
    this.state = s;
    if (s.map.id !== this.mapId) {
      this.mapId = s.map.id;
      this.viewKey = '';
      this.art = renderBoardArt(s);
      if (!this.userCam) this.fit();
    }
    // A token with no running animation sits exactly on its square.
    for (const key of [...this.tokenPos.keys()]) if (!this.state.units.some((u) => u.id === key)) this.tokenPos.delete(key);
  }

  /** Space the interface covers on each side; the board fits inside it and the city runs on behind. */
  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void {
    this.insets = insets;
    if (!this.userCam) this.fit();
  }

  setHighlights(h: Highlights): void { this.hl = h; }
  setSpot(spot: { unit?: string; tile?: [number, number] }): void { this.spot = spot; }
  setSelection(selected: string | null, active: string | null): void { this.selected = selected; this.active = active; }

  /* ---------- Animations: each resolves on a timer, never on animation frames ---------- */

  private play(dur: number, draw: Anim['draw']): Promise<void> {
    const scaled = dur * speedFactor();
    this.anims.push({ start: performance.now(), dur: scaled, draw });
    return new Promise((res) => setTimeout(res, scaled));
  }

  private center(x: number, y: number): [number, number] {
    return [x * T + T / 2, y * T + T / 2];
  }

  async moveToken(id: string, path: [number, number][]): Promise<void> {
    if (path.length < 2) return;
    const per = 95 * speedFactor();
    const total = per * (path.length - 1);
    const start = performance.now();
    sfx.move();
    const pos = { x: path[0][0], y: path[0][1], lift: 1 };
    this.tokenPos.set(id, pos);
    await new Promise<void>((res) => {
      const step = () => {
        const elapsed = performance.now() - start;
        const k = Math.min(1, elapsed / total);
        const f = k * (path.length - 1);
        const i = Math.min(path.length - 2, Math.floor(f));
        const local = f - i;
        pos.x = path[i][0] + (path[i + 1][0] - path[i][0]) * local;
        pos.y = path[i][1] + (path[i + 1][1] - path[i][1]) * local;
        pos.lift = Math.sin(k * Math.PI);
        if (k >= 1) {
          this.tokenPos.delete(id);
          res();
        } else {
          setTimeout(step, 16);
        }
      };
      step();
    });
  }

  shot(fromX: number, fromY: number, toX: number, toY: number, hit: boolean, heavy: boolean, color: string): Promise<void> {
    const [ax, ay] = this.center(fromX, fromY);
    let [bx, by] = this.center(toX, toY);
    if (!hit) {
      const off = T * 0.55;
      bx += (Math.random() - 0.5) * off * 2;
      by += (Math.random() - 0.5) * off * 2;
    }
    sfx.shot(heavy);
    if (hit) setTimeout(() => sfx.hit(), 90);
    return this.play(heavy ? 320 : 230, (c, k) => {
      const head = Math.min(1, k * 2.2);
      const tail = Math.max(0, k * 2.2 - 0.5);
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.lineCap = 'round';
      c.strokeStyle = color;
      c.shadowColor = color;
      c.shadowBlur = 14;
      c.lineWidth = heavy ? 4.5 : 2.6;
      c.globalAlpha = 1 - k * 0.6;
      c.beginPath();
      c.moveTo(ax + (bx - ax) * tail, ay + (by - ay) * tail);
      c.lineTo(ax + (bx - ax) * head, ay + (by - ay) * head);
      c.stroke();
      if (k < 0.3) {
        c.fillStyle = '#fff4cc';
        c.beginPath();
        c.arc(ax, ay, (heavy ? 15 : 10) * (1 - k * 3), 0, Math.PI * 2);
        c.fill();
      }
      if (hit && k > 0.42) {
        const ik = (k - 0.42) / 0.58;
        c.globalAlpha = 1 - ik;
        c.fillStyle = '#ffe2b0';
        for (let i = 0; i < 7; i++) {
          const a = (i * Math.PI * 2) / 7 + 0.4;
          c.beginPath();
          c.arc(bx + Math.cos(a) * ik * 26, by + Math.sin(a) * ik * 26, 2.4 * (1 - ik) + 0.6, 0, Math.PI * 2);
          c.fill();
        }
      }
      c.restore();
    });
  }

  melee(fromId: string, fromX: number, fromY: number, toX: number, toY: number, hit: boolean): Promise<void> {
    sfx.melee();
    if (hit) setTimeout(() => sfx.hit(), 120);
    const pos = { x: fromX, y: fromY, lift: 0.4 };
    this.tokenPos.set(fromId, pos);
    const start = performance.now();
    const total = 280 * speedFactor();
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / total);
      const lunge = Math.sin(k * Math.PI) * 0.55;
      pos.x = fromX + (toX - fromX) * lunge;
      pos.y = fromY + (toY - fromY) * lunge;
      if (k >= 1) this.tokenPos.delete(fromId);
      else setTimeout(step, 16);
    };
    step();
    return new Promise((res) => setTimeout(res, total));
  }

  blast(x: number, y: number, radius: number, kind: 'frag' | 'smoke' | 'emp', fromX: number, fromY: number): Promise<void> {
    const [ax, ay] = this.center(fromX, fromY);
    const [bx, by] = this.center(x, y);
    const flight = this.play(340, (c, k) => {
      const px = ax + (bx - ax) * k;
      const py = ay + (by - ay) * k - Math.sin(k * Math.PI) * 70;
      c.fillStyle = '#d7d9de';
      c.beginPath();
      c.arc(px, py, 6, 0, Math.PI * 2);
      c.fill();
    });
    return flight.then(() => {
      if (kind === 'frag') sfx.blast();
      else if (kind === 'emp') sfx.hack();
      else sfx.move();
      const reach = (radius + 0.5) * T;
      const color = kind === 'frag' ? '#ff9d3c' : kind === 'emp' ? '#7fd6ff' : '#b8bcc6';
      return this.play(kind === 'frag' ? 460 : 380, (c, k) => {
        c.save();
        c.globalCompositeOperation = kind === 'smoke' ? 'source-over' : 'lighter';
        const g = c.createRadialGradient(bx, by, 0, bx, by, reach * (0.35 + k * 0.75));
        g.addColorStop(0, `${color}${kind === 'frag' ? 'dd' : '88'}`);
        g.addColorStop(1, `${color}00`);
        c.globalAlpha = 1 - k;
        c.fillStyle = g;
        c.beginPath();
        c.arc(bx, by, reach * (0.35 + k * 0.75), 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = color;
        c.lineWidth = 3;
        c.beginPath();
        c.arc(bx, by, reach * k, 0, Math.PI * 2);
        c.stroke();
        c.restore();
      });
    });
  }

  arc(fromX: number, fromY: number, toX: number, toY: number, color: string): Promise<void> {
    const [ax, ay] = this.center(fromX, fromY);
    const [bx, by] = this.center(toX, toY);
    sfx.hack();
    return this.play(420, (c, k) => {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.strokeStyle = color;
      c.shadowColor = color;
      c.shadowBlur = 12;
      c.lineWidth = 2;
      c.globalAlpha = 1 - k * 0.7;
      c.beginPath();
      c.moveTo(ax, ay);
      const n = 9;
      for (let i = 1; i < n; i++) {
        const f = i / n;
        c.lineTo(ax + (bx - ax) * f + (Math.random() - 0.5) * 22, ay + (by - ay) * f + (Math.random() - 0.5) * 22);
      }
      c.lineTo(bx, by);
      c.stroke();
      c.restore();
    });
  }

  float(x: number, y: number, text: string, color: string, big = false): void {
    const [cx, cy] = this.center(x, y);
    const jitter = (this.floats.length % 3) * 16 - 16;
    this.floats.push({ x: cx + jitter, y: cy - T * 0.45, text, color, start: performance.now(), dur: 1250 * speedFactor(), big });
  }

  hitShake(id: string): void {
    this.shake.set(id, performance.now());
  }

  /* ---------- Drawing ---------- */

  private frame(t: number): void {
    if (this.destroyed) return;
    this.frameId = requestAnimationFrame((n) => this.frame(n));
    const animating = this.anims.length > 0 || this.floats.length > 0 || this.tokenPos.size > 0 || this.shake.size > 0;
    // A still board with rain only needs a lower frame rate.
    if (!animating && t - this.lastDraw < 33) return;
    this.lastDraw = t;
    this.draw(t);
  }

  private draw(t: number): void {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    if (!this.state || !this.art) return;
    const s = this.state;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.boardView(), 0, 0);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.translate(this.cam.x, this.cam.y);
    c.scale(this.cam.z, this.cam.z);

    this.drawCityLife(c, t);
    this.drawHighlights(c, t);
    this.drawObjectives(c, s, t);

    const drawOrder = [...s.units].sort((a, b) => a.y - b.y);
    for (const u of drawOrder) if (u.state === 'down') this.drawDown(c, u);
    for (const u of drawOrder) if (u.state === 'ok') this.drawToken(c, s, u, t);

    this.drawSmoke(c, s, t);
    this.drawTargets(c, s, t);
    this.drawSpot(c, s, t);

    this.anims = this.anims.filter((a) => {
      const k = (t - a.start) / a.dur;
      if (k >= 1) return false;
      if (k >= 0) a.draw(c, k);
      return true;
    });
    this.drawFloats(c, t);
    c.restore();

    if (settings.rain) this.drawRain(c);
  }

  /** A few signs that buzz and some steam, so the city isn't a still picture. Kept cheap on purpose. */
  private drawCityLife(c: CanvasRenderingContext2D, t: number): void {
    if (!settings.rain || !this.art) return;
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (const f of this.art.flickers) {
      const v = Math.sin(t / 90 + f.seed) * Math.sin(t / 370 + f.seed * 2);
      if (v < 0.5) continue;
      c.fillStyle = `${f.color}2e`;
      c.fillRect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
    }
    c.restore();
    for (const v of this.art.steam.slice(0, 6)) {
      for (let i = 0; i < 2; i++) {
        const k = ((t / 2600 + v.seed * 0.37 + i * 0.5) % 1 + 1) % 1;
        c.fillStyle = `rgba(190,205,225,${0.09 * (1 - k)})`;
        c.beginPath();
        c.arc(v.x + Math.sin(k * 4 + v.seed) * 6, v.y - k * 34, 9 + k * 16, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  /** The printed board at screen resolution. Scaling the big layer every frame is slow without a GPU. */
  private boardView(): HTMLCanvasElement {
    const key = `${this.mapId}|${this.cam.x}|${this.cam.y}|${this.cam.z}|${this.canvas.width}|${this.canvas.height}`;
    if (this.viewKey !== key || !this.viewLayer) {
      const view = this.viewLayer ?? document.createElement('canvas');
      view.width = this.canvas.width;
      view.height = this.canvas.height;
      const v = view.getContext('2d')!;
      v.imageSmoothingQuality = 'high';
      v.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      v.translate(this.cam.x, this.cam.y);
      v.scale(this.cam.z, this.cam.z);
      const art = this.art!.canvas;
      v.drawImage(art, -OUTER * T, -OUTER * T, art.width / ART_SCALE, art.height / ART_SCALE);
      this.viewLayer = view;
      this.viewKey = key;
    }
    return this.viewLayer;
  }

  private shadowSprite(): HTMLCanvasElement {
    if (!this.shadowLayer) {
      const size = 96;
      const layer = document.createElement('canvas');
      layer.width = size;
      layer.height = size;
      const s = layer.getContext('2d')!;
      const g = s.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.72)');
      g.addColorStop(0.62, 'rgba(0,0,0,0.62)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      s.fillStyle = g;
      s.fillRect(0, 0, size, size);
      this.shadowLayer = layer;
    }
    return this.shadowLayer;
  }

  /** Strokes the current path with a soft halo, without the cost of a shadow blur. */
  private glowStroke(c: CanvasRenderingContext2D, core: string, halo: string, width: number): void {
    const alpha = c.globalAlpha;
    c.strokeStyle = halo;
    c.lineWidth = width + 7;
    c.globalAlpha = alpha * 0.22;
    c.stroke();
    c.lineWidth = width + 3;
    c.globalAlpha = alpha * 0.35;
    c.stroke();
    c.strokeStyle = core;
    c.lineWidth = width;
    c.globalAlpha = alpha;
    c.stroke();
  }

  private drawHighlights(c: CanvasRenderingContext2D, t: number): void {
    const hl = this.hl;
    const m = this.state!.map;
    if (hl.zone) {
      const pulse = 0.12 + Math.sin(t / 400) * 0.05;
      c.fillStyle = `${hl.zone.color}${Math.round(pulse * 255).toString(16).padStart(2, '0')}`;
      c.fillRect(hl.zone.x * T, hl.zone.y * T, hl.zone.w * T, hl.zone.h * T);
    }
    if (hl.move) {
      c.fillStyle = 'rgba(25,227,255,0.16)';
      c.strokeStyle = 'rgba(25,227,255,0.95)';
      c.lineWidth = 2;
      for (const k of hl.move) {
        const x = k % m.w;
        const y = Math.floor(k / m.w);
        c.fillRect(x * T + 1, y * T + 1, T - 2, T - 2);
        if (!hl.move.has(k - m.w)) this.edge(c, x * T, y * T, x * T + T, y * T);
        if (!hl.move.has(k + m.w)) this.edge(c, x * T, y * T + T, x * T + T, y * T + T);
        if (x === 0 || !hl.move.has(k - 1)) this.edge(c, x * T, y * T, x * T, y * T + T);
        if (x === m.w - 1 || !hl.move.has(k + 1)) this.edge(c, x * T + T, y * T, x * T + T, y * T + T);
      }
    }
    if (hl.tiles) {
      c.fillStyle = 'rgba(240,56,60,0.16)';
      for (const k of hl.tiles) c.fillRect((k % m.w) * T + 1, Math.floor(k / m.w) * T + 1, T - 2, T - 2);
    }
    if (this.hover && hl.tiles && hl.tiles.has(this.hover.x + this.hover.y * m.w) && hl.radius >= 0) {
      c.fillStyle = 'rgba(240,56,60,0.25)';
      c.strokeStyle = 'rgba(240,56,60,0.95)';
      c.lineWidth = 2;
      const r = hl.radius;
      const rx = (this.hover.x - r) * T;
      const ry = (this.hover.y - r) * T;
      const size = (r * 2 + 1) * T;
      c.fillRect(rx, ry, size, size);
      c.strokeRect(rx, ry, size, size);
    }
    if (hl.path && hl.path.length > 1) {
      c.save();
      c.strokeStyle = '#eaffff';
      c.lineWidth = 3;
      c.setLineDash([8, 8]);
      c.lineDashOffset = -t / 40;
      c.beginPath();
      hl.path.forEach(([x, y], i) => {
        const [px, py] = this.center(x, y);
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      });
      c.stroke();
      c.setLineDash([]);
      const [lx, ly] = this.center(hl.path[hl.path.length - 1][0], hl.path[hl.path.length - 1][1]);
      c.fillStyle = '#eaffff';
      c.beginPath();
      c.arc(lx, ly, 7, 0, Math.PI * 2);
      c.fill();
      c.restore();
    } else if (this.hover && hl.move && hl.move.has(this.hover.x + this.hover.y * m.w)) {
      c.fillStyle = 'rgba(255,255,255,0.15)';
      c.fillRect(this.hover.x * T, this.hover.y * T, T, T);
    }
  }

  private edge(c: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number): void {
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.stroke();
  }

  private drawObjectives(c: CanvasRenderingContext2D, s: GameState, t: number): void {
    for (const term of s.terminals) {
      const [cx, cy] = this.center(term.x, term.y);
      let col = '#9aa0ac';
      if (term.owner !== null) {
        const side = s.cfg.sides.find((x) => x.team === term.owner);
        if (side) col = FACTIONS[side.faction].color;
      }
      c.save();
      c.globalAlpha = 0.65 + Math.sin(t / 500 + term.id) * 0.25;
      this.bracket(c, cx, cy, T * 0.48, 14);
      if (term.owner !== null) {
        this.glowStroke(c, col, col, 3);
      } else {
        c.strokeStyle = col;
        c.lineWidth = 3;
        c.stroke();
      }
      c.restore();
      const chance = this.hl.terminals.get(term.id);
      if (chance !== undefined) this.chip(c, cx, cy - T * 0.62, `${Math.round(chance * 100)}%`, '#b583ff');
    }
    if (s.core && !s.core.carrier) this.drawCore(c, s.core.x * T + T / 2, s.core.y * T + T / 2, t, 15);
  }

  private drawCore(c: CanvasRenderingContext2D, x: number, y: number, t: number, size: number): void {
    const a = t / 700;
    c.save();
    c.translate(x, y - 4 + Math.sin(t / 420) * 2);
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(0, 0, 0, 0, 0, size * 2.8);
    g.addColorStop(0, 'rgba(255,240,150,0.7)');
    g.addColorStop(1, 'rgba(255,200,60,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, size * 2.8, 0, Math.PI * 2);
    c.fill();
    c.globalCompositeOperation = 'source-over';
    c.rotate(a);
    c.fillStyle = '#ffd86b';
    c.strokeStyle = '#fff6d0';
    c.lineWidth = 2;
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const ang = (i * Math.PI) / 3;
      const px = Math.cos(ang) * size;
      const py = Math.sin(ang) * size;
      if (i === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  private tokenAt(u: Unit): { x: number; y: number; lift: number } {
    const p = this.tokenPos.get(u.id);
    return p ?? { x: u.x, y: u.y, lift: 0 };
  }

  private hexPath(c: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  }

  /** Corner brackets around a square, the shared language for "this one" on the board. */
  private bracket(c: CanvasRenderingContext2D, cx: number, cy: number, half: number, len: number): void {
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      c.moveTo(cx + sx * half, cy + sy * (half - len));
      c.lineTo(cx + sx * half, cy + sy * half);
      c.lineTo(cx + sx * (half - len), cy + sy * half);
    }
  }

  private drawToken(c: CanvasRenderingContext2D, s: GameState, u: Unit, t: number): void {
    const pos = this.tokenAt(u);
    const r = u.isDrone ? T * 0.31 : T * 0.42;
    let cx = pos.x * T + T / 2;
    let cy = pos.y * T + T / 2;
    const col = FACTIONS[u.faction].color;
    const dark = FACTIONS[u.faction].dark;
    const started = this.shake.get(u.id);
    if (started !== undefined) {
      const k = (t - started) / 300;
      if (k >= 1) this.shake.delete(u.id);
      else cx += Math.sin(k * 40) * 6 * (1 - k);
    }
    const lift = pos.lift * 15;
    const selected = this.selected === u.id;
    const active = this.active === u.id;
    const spent = u.activated && !active && s.phase === 'battle';

    // Contact shadow; it spreads as the piece is picked up.
    const shadowSize = r * (1.3 + pos.lift * 0.22);
    c.save();
    c.globalAlpha = 0.95 - pos.lift * 0.3;
    c.drawImage(this.shadowSprite(), cx + 3 + lift * 0.45 - shadowSize, cy + 5 + lift * 0.7 - shadowSize, shadowSize * 2, shadowSize * 2);
    c.restore();
    cy -= lift;

    if (active || selected) {
      const pulse = active ? Math.sin(t / 200) * 2.5 : 0;
      this.bracket(c, cx, cy, T * 0.5 + pulse, 13);
      this.glowStroke(c, active ? '#ffffff' : col, col, 3);
    }

    c.save();
    c.globalAlpha = spent ? 0.58 : 1;
    // A thick chip with a beveled edge.
    this.hexPath(c, cx, cy + 3, r);
    c.fillStyle = '#05070c';
    c.fill();
    this.hexPath(c, cx, cy, r);
    const g = c.createLinearGradient(cx, cy - r, cx, cy + r);
    g.addColorStop(0, spent ? '#2b3140' : this.lighten(dark));
    g.addColorStop(1, spent ? '#141823' : '#06080e');
    c.fillStyle = g;
    c.fill();
    if (!spent) {
      this.glowStroke(c, col, col, 3);
    } else {
      c.strokeStyle = '#6b7588';
      c.lineWidth = 2.5;
      c.stroke();
    }

    // Role icon
    c.save();
    const iconScale = (r * 1.18) / 24;
    c.translate(cx - 12 * iconScale, cy - 12 * iconScale);
    c.scale(iconScale, iconScale);
    const ink = spent ? '#aeb6c4' : '#ffffff';
    c.fillStyle = ink;
    c.strokeStyle = ink;
    c.lineWidth = 2;
    c.lineJoin = 'miter';
    if (isStroked(u.role)) {
      c.stroke(icon(u.role));
      if (u.role === 'sapper') c.fill(icon(u.role));
    } else {
      c.fill(icon(u.role));
    }
    c.restore();
    c.restore();

    // Health: a segmented bar under the chip.
    const frac = Math.max(0, u.hp / u.hpMax);
    const barW = r * 1.72;
    const barX = cx - barW / 2;
    const barY = cy + r + 3;
    const segments = Math.max(3, Math.round(u.hpMax / 3));
    const gap = 1.5;
    const segW = (barW - gap * (segments - 1)) / segments;
    c.fillStyle = 'rgba(3,5,10,0.92)';
    c.fillRect(barX - 2, barY - 2, barW + 4, 9);
    const barColor = frac > 0.5 ? '#3dffa2' : frac > 0.25 ? '#ffb347' : '#ff4d4d';
    const lit = Math.ceil(frac * segments);
    for (let i = 0; i < segments; i++) {
      c.fillStyle = i < lit ? barColor : 'rgba(255,255,255,0.12)';
      c.fillRect(barX + i * (segW + gap), barY, segW, 5);
    }

    // Actions left, as diamonds over the chip.
    if (active && u.ap > 0) {
      for (let i = 0; i < u.ap; i++) {
        const dx = cx - (u.ap - 1) * 8 + i * 16;
        const dy = cy - r - 12;
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(dx, dy - 6);
        c.lineTo(dx + 6, dy);
        c.lineTo(dx, dy + 6);
        c.lineTo(dx - 6, dy);
        c.closePath();
        c.fill();
      }
    }

    // Status tags down the right-hand side.
    const marks: { col: string; ch: string }[] = [];
    if (u.overwatch) marks.push({ col: '#ffb347', ch: 'O' });
    if (u.braced) marks.push({ col: '#19e3ff', ch: 'B' });
    if (u.pinned) marks.push({ col: '#ff4d4d', ch: '!' });
    if (u.glitch || u.seized) marks.push({ col: '#b583ff', ch: '#' });
    if (u.jammed) marks.push({ col: '#ff4d4d', ch: 'J' });
    if (u.injuries.includes('bleeding')) marks.push({ col: '#ff4d4d', ch: '+' });
    marks.forEach((m, i) => {
      const mx = cx + r - 2;
      const my = cy - r + 4 + i * 17;
      c.fillStyle = m.col;
      c.fillRect(mx, my, 15, 15);
      c.fillStyle = '#05070c';
      c.font = '700 12px "IBM Plex Mono", monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(m.ch, mx + 7.5, my + 8);
    });

    if (s.core && s.core.carrier === u.id) this.drawCore(c, cx - r * 0.85, cy - r * 0.8, t, 9);

    // Name tag on hover or selection
    const hovered = this.hover && this.hover.x === u.x && this.hover.y === u.y;
    if (selected || active || hovered) {
      c.font = '800 18px "Big Shoulders Display", sans-serif';
      const label = u.name.toUpperCase();
      const w = c.measureText(label).width + 12;
      c.fillStyle = col;
      c.fillRect(cx - w / 2, barY + 8, w, 20);
      c.fillStyle = '#05070c';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(label, cx, barY + 19);
    }
  }

  private lighten(hex: string): string {
    const n = parseInt(hex.slice(1), 16);
    const f = (v: number) => Math.min(255, v + 34);
    return `rgb(${f((n >> 16) & 255)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }

  private drawDown(c: CanvasRenderingContext2D, u: Unit): void {
    const [cx, cy] = this.center(u.x, u.y);
    const r = T * 0.34;
    c.save();
    this.hexPath(c, cx + 2, cy + 3, r);
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fill();
    this.hexPath(c, cx, cy, r);
    c.fillStyle = '#1a1e28';
    c.fill();
    c.strokeStyle = `${FACTIONS[u.faction].color}80`;
    c.lineWidth = 2.5;
    c.stroke();
    c.strokeStyle = '#ff4d4d';
    c.lineWidth = 4.5;
    c.beginPath();
    c.moveTo(cx - r * 0.42, cy - r * 0.42);
    c.lineTo(cx + r * 0.42, cy + r * 0.42);
    c.moveTo(cx + r * 0.42, cy - r * 0.42);
    c.lineTo(cx - r * 0.42, cy + r * 0.42);
    c.stroke();
    c.restore();
  }

  private drawSmoke(c: CanvasRenderingContext2D, s: GameState, t: number): void {
    for (const m of s.smoke) {
      const [cx, cy] = this.center(m.x, m.y);
      for (let i = 0; i < 3; i++) {
        const a = t / 2200 + i * 2.1 + m.x;
        const px = cx + Math.cos(a) * 11;
        const py = cy + Math.sin(a * 1.2) * 11;
        const g = c.createRadialGradient(px, py, 3, px, py, T * 0.72);
        g.addColorStop(0, 'rgba(180,184,196,0.5)');
        g.addColorStop(1, 'rgba(180,184,196,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(px, py, T * 0.72, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  private drawTargets(c: CanvasRenderingContext2D, s: GameState, t: number): void {
    for (const [id, info] of this.hl.targets) {
      const u = s.units.find((v) => v.id === id);
      if (!u) continue;
      const [cx, cy] = this.center(u.x, u.y);
      const hovered = this.hover && this.hover.x === u.x && this.hover.y === u.y;
      this.bracket(c, cx, cy, T * 0.56 + (hovered ? Math.sin(t / 120) * 2 : 0), 14);
      this.glowStroke(c, info.color, info.color, hovered ? 4 : 3);
      if (info.chance >= 0) this.chip(c, cx, cy - T * 0.74, `${Math.round(info.chance * 100)}%`, info.color);
    }
  }

  /** The tutorial's pointer: a bouncing arrow over whatever the player should click next. */
  private drawSpot(c: CanvasRenderingContext2D, s: GameState, t: number): void {
    let cx: number;
    let cy: number;
    if (this.spot.unit) {
      const u = s.units.find((v) => v.id === this.spot.unit);
      if (!u || u.state === 'dead') return;
      const p = this.tokenAt(u);
      cx = p.x * T + T / 2;
      cy = p.y * T + T / 2;
    } else if (this.spot.tile) {
      [cx, cy] = this.center(this.spot.tile[0], this.spot.tile[1]);
      c.fillStyle = 'rgba(240,56,60,0.34)';
      c.fillRect(cx - T / 2 + 1, cy - T / 2 + 1, T - 2, T - 2);
    } else {
      return;
    }
    const bob = Math.sin(t / 210) * 6;
    this.bracket(c, cx, cy, T * 0.56 + bob * 0.4, 16);
    this.glowStroke(c, '#f0383c', '#f0383c', 4);
    const tip = cy - T * 0.98 + bob;
    c.beginPath();
    c.moveTo(cx, tip);
    c.lineTo(cx - 17, tip - 22);
    c.lineTo(cx - 7, tip - 22);
    c.lineTo(cx - 7, tip - 40);
    c.lineTo(cx + 7, tip - 40);
    c.lineTo(cx + 7, tip - 22);
    c.lineTo(cx + 17, tip - 22);
    c.closePath();
    c.lineJoin = 'round';
    c.lineWidth = 6;
    c.strokeStyle = '#12020a';
    c.stroke();
    c.fillStyle = '#f0383c';
    c.fill();
  }

  private chip(c: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
    c.font = '900 22px "Big Shoulders Display", sans-serif';
    const w = c.measureText(text).width + 12;
    c.fillStyle = color;
    c.fillRect(x - w / 2, y - 12, w, 24);
    c.fillStyle = '#05070c';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, y + 1);
  }

  private drawFloats(c: CanvasRenderingContext2D, t: number): void {
    this.floats = this.floats.filter((f) => {
      const k = (t - f.start) / f.dur;
      if (k >= 1) return false;
      if (k < 0) return true;
      c.save();
      c.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      c.font = `900 ${f.big ? 34 : 25}px "Big Shoulders Display", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(0,0,0,0.9)';
      const y = f.y - k * 36;
      c.strokeText(f.text, f.x, y);
      c.fillStyle = f.color;
      c.fillText(f.text, f.x, y);
      c.restore();
      return true;
    });
  }

  private drawRain(c: CanvasRenderingContext2D): void {
    c.save();
    c.strokeStyle = 'rgba(190,220,255,0.1)';
    c.lineWidth = 1;
    c.beginPath();
    for (const d of this.rain) {
      d.y += 0.012 * d.v;
      d.x -= 0.0016 * d.v;
      if (d.y > 1) { d.y = 0; d.x = Math.random() * 1.1; }
      if (d.x < 0) d.x += 1;
      const px = d.x * this.w;
      const py = d.y * this.h;
      c.moveTo(px, py);
      c.lineTo(px - d.l * 0.14, py + d.l);
    }
    c.stroke();
    c.restore();
  }
}

