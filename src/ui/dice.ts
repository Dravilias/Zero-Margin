import { sfx } from './audio';
import { speedFactor } from './settings';

/* Dice tray: a very small 3D renderer on a 2D canvas, so each die really tumbles and lands on its result. */

type V3 = [number, number, number];
type Quat = [number, number, number, number];

interface Face { idx: number[]; value: number; up: V3; normal: V3; center: V3 }
interface Solid { verts: V3[]; faces: Face[] }

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function qMul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function qAxis(axis: V3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

function qRotate(q: Quat, v: V3): V3 {
  const u: V3 = [q[0], q[1], q[2]];
  const t = cross(u, v).map((x) => x * 2) as V3;
  const c = cross(u, t);
  return [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]];
}

/** Rotation that takes the orthonormal frame (right, up, normal) onto the screen axes (x, y, z). */
function qFromFrame(right: V3, up: V3, normal: V3): Quat {
  // Those three vectors are the rows of the rotation matrix.
  const m = [right, up, normal];
  const trace = m[0][0] + m[1][1] + m[2][2];
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s, s / 4];
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    q = [s / 4, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s, (m[2][1] - m[1][2]) / s];
  } else if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    q = [(m[0][1] + m[1][0]) / s, s / 4, (m[1][2] + m[2][1]) / s, (m[0][2] - m[2][0]) / s];
  } else {
    const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
    q = [(m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, s / 4, (m[1][0] - m[0][1]) / s];
  }
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function finishFace(verts: V3[], idx: number[], value: number, apex: V3 | null): Face {
  const pts = idx.map((i) => verts[i]);
  const center = pts.reduce<V3>((c, p) => [c[0] + p[0] / pts.length, c[1] + p[1] / pts.length, c[2] + p[2] / pts.length], [0, 0, 0]);
  let normal = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
  if (dot(normal, center) < 0) {
    normal = [-normal[0], -normal[1], -normal[2]];
    idx = [...idx].reverse();
  }
  const towards = apex ? sub(apex, center) : sub(pts[0], pts[1]);
  const along = dot(towards, normal);
  const up = norm([towards[0] - normal[0] * along, towards[1] - normal[1] * along, towards[2] - normal[2] * along]);
  return { idx, value, up, normal, center };
}

function makeD10(): Solid {
  const verts: V3[] = [];
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI * 2) / 10;
    verts.push([Math.cos(a), Math.sin(a), i % 2 === 0 ? 0.1 : -0.1]);
  }
  const top: V3 = [0, 0, 1.05];
  const bottom: V3 = [0, 0, -1.05];
  verts.push(top, bottom);
  const faces: Face[] = [];
  const order = [10, 1, 8, 3, 6, 7, 4, 9, 2, 5];
  for (let i = 0; i < 5; i++) {
    const a = i * 2;
    faces.push(finishFace(verts, [10, a, a + 1, a + 2 > 9 ? (a + 2) % 10 : a + 2], order[i * 2], top));
    const b = i * 2 + 1;
    faces.push(finishFace(verts, [11, b, (b + 1) % 10, (b + 2) % 10], order[i * 2 + 1], bottom));
  }
  return { verts, faces };
}

function makeD6(): Solid {
  const s = 0.72;
  const verts: V3[] = [
    [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
    [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
  ];
  const quads: [number[], number][] = [
    [[4, 5, 6, 7], 1], [[0, 3, 2, 1], 6], [[0, 1, 5, 4], 2], [[2, 3, 7, 6], 5], [[1, 2, 6, 5], 3], [[0, 4, 7, 3], 4],
  ];
  return { verts, faces: quads.map(([idx, v]) => finishFace(verts, idx, v, null)) };
}

const D10 = makeD10();
const D6 = makeD6();

/** For tests: the rotation a die ends on to show this value, and where that face then points. */
export function landing(sides: 10 | 6, value: number): { normal: V3; up: V3; found: number } {
  const solid = sides === 10 ? D10 : D6;
  const matches = solid.faces.filter((f) => f.value === value);
  const face = matches[0];
  const q = qFromFrame(cross(face.up, face.normal), face.up, face.normal);
  return { normal: qRotate(q, face.normal), up: qRotate(q, face.up), found: matches.length };
}

export interface DieRequest { sides: 10 | 6; value: number; color: string; ink?: string }

interface LiveDie {
  req: DieRequest;
  solid: Solid;
  x: number; y: number; sx: number; sy: number;
  target: Quat; axis: V3; spin: number; start: number; dur: number; size: number;
}

function hexShade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f);
  const g = Math.min(255, ((n >> 8) & 255) * f);
  const b = Math.min(255, (n & 255) * f);
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

export class DiceTray {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dice: LiveDie[] = [];
  private running = false;
  private w = 0;
  private h = 0;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dice-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  private resize(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, r.width * dpr);
    this.canvas.height = Math.max(1, r.height * dpr);
    this.draw(performance.now());
  }

  /** Resolves when the dice have landed. It uses a timer, so a hidden window never stalls the game. */
  roll(requests: DieRequest[]): Promise<void> {
    const now = performance.now();
    const base = 620 * speedFactor();
    const n = requests.length;
    const size = n > 4 ? 19 : n > 2 ? 24 : 30;
    const cols = Math.min(n, 4);
    const rows = Math.ceil(n / cols);
    this.dice = requests.map((req, i) => {
      const solid = req.sides === 10 ? D10 : D6;
      const face = solid.faces.find((f) => f.value === req.value) ?? solid.faces[0];
      const right = cross(face.up, face.normal);
      const col = i % cols;
      const row = Math.floor(i / cols);
      const lastRow = Math.ceil((i + 1) / cols) === rows && n % cols !== 0;
      const span = lastRow ? n % cols : cols;
      return {
        req, solid,
        x: this.w * ((col + 0.5 + (cols - span) / 2) / cols),
        y: this.h * ((row + 0.55) / rows),
        sx: -40 - Math.random() * 60,
        sy: this.h * Math.random(),
        target: qFromFrame(right, face.up, face.normal),
        axis: norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        spin: 7 + Math.random() * 6,
        start: now + i * 45,
        dur: base + Math.random() * 120,
        size,
      };
    });
    sfx.dice(n);
    if (!this.running) {
      this.running = true;
      requestAnimationFrame((t) => this.loop(t));
    }
    const total = base + 120 + n * 45;
    return new Promise((res) => setTimeout(res, total));
  }

  clear(): void {
    this.dice = [];
    this.draw(performance.now());
  }

  private loop(t: number): void {
    this.draw(t);
    if (this.dice.some((d) => t < d.start + d.dur)) {
      requestAnimationFrame((n) => this.loop(n));
    } else {
      this.running = false;
      this.draw(t + 1);
    }
  }

  private draw(t: number): void {
    const c = this.ctx;
    const dpr = this.canvas.width / Math.max(1, this.w);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    for (const d of this.dice) {
      const raw = (t - d.start) / d.dur;
      if (raw < 0) continue;
      const k = Math.min(1, raw);
      const ease = 1 - (1 - k) ** 3;
      const x = d.sx + (d.x - d.sx) * ease;
      const bounce = Math.abs(Math.sin(k * Math.PI * 3)) * (1 - k) * 18;
      const y = d.sy + (d.y - d.sy) * ease - bounce;
      const q = qMul(qAxis(d.axis, d.spin * (1 - ease)), d.target);
      this.drawDie(c, d, q, x, y, k >= 1);
    }
  }

  private drawDie(c: CanvasRenderingContext2D, d: LiveDie, q: Quat, x: number, y: number, settled: boolean): void {
    const pts = d.solid.verts.map((v) => qRotate(q, v));
    const px = (p: V3): [number, number] => [x + p[0] * d.size, y - p[1] * d.size];
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.4)';
    c.beginPath();
    c.ellipse(x + 3, y + d.size * 0.92, d.size * 0.85, d.size * 0.22, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();

    const faces = d.solid.faces
      .map((f) => ({ f, n: qRotate(q, f.normal), z: qRotate(q, f.center)[2] }))
      .filter((f) => f.n[2] > 0)
      .sort((a, b) => a.z - b.z);
    const light = norm([-0.4, 0.6, 0.7]);
    for (const { f, n } of faces) {
      const shade = 0.42 + Math.max(0, dot(n, light)) * 0.72;
      c.beginPath();
      f.idx.forEach((i, j) => {
        const [sx, sy] = px(pts[i]);
        if (j === 0) c.moveTo(sx, sy);
        else c.lineTo(sx, sy);
      });
      c.closePath();
      c.fillStyle = hexShade(d.req.color, shade);
      c.fill();
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      c.stroke();
      if (n[2] < 0.45) continue;
      // Draw the number in the plane of the face, so it tilts with the die.
      const cen = qRotate(q, f.center);
      const up = qRotate(q, f.up);
      const right = cross(up, n);
      const [cx, cy] = px(cen);
      const s = d.size / 18;
      c.save();
      c.transform(right[0] * s, -right[1] * s, -up[0] * s, up[1] * s, cx, cy);
      c.fillStyle = d.req.ink ?? '#14151a';
      c.font = '900 16px "Big Shoulders Display", sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.globalAlpha = Math.min(1, (n[2] - 0.45) * 3);
      c.fillText(String(f.value), 0, 0);
      c.restore();
    }
    if (settled) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      const glow = c.createRadialGradient(x, y, 0, x, y, d.size * 1.4);
      glow.addColorStop(0, `${d.req.color}33`);
      glow.addColorStop(1, `${d.req.color}00`);
      c.fillStyle = glow;
      c.fillRect(x - d.size * 1.5, y - d.size * 1.5, d.size * 3, d.size * 3);
      c.restore();
    }
  }
}
