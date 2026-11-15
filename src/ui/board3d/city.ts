import * as THREE from 'three';
import { FACTIONS } from '../../engine/data';
import { tileAt } from '../../engine/map';
import type { GameState, MapData } from '../../engine/types';
import { NEON, OUTER, PAL, STYLE, WORDS, canvas, hash, hot, pick } from './style';

/*
 * Builds the 3D city for a map: ground, water, buildings, signs, lamps, cover and each district's extras.
 * Everything is derived from the tile layout, so the walls and cover the rules use are what the player sees.
 */

export type Ext = (x: number, y: number) => string;

/**
 * The cutaway: any part of the city outside the board that, seen from the camera, would cover a square
 * of the board is cut off above CUT_HEIGHT. Towers frame the board without ever hiding it, and the cut
 * follows the camera round. The inside walls a cut reveals are drawn dark.
 */
export const CUT_HEIGHT = 1.6;
/** Where units stand (and the square under the cursor): nothing in front of them is drawn. */
export const MAX_CLEAR = 64;
export const CLEAR_RADIUS = 0.62;
export const CLEAR_HEIGHTS = [0.15, 0.6, 1.05, 1.5];
export const cut = {
  view: { value: new THREE.Vector3(0, -1, 0) }, boardMin: { value: new THREE.Vector2() }, boardMax: { value: new THREE.Vector2() },
  clear: { value: Array.from({ length: MAX_CLEAR }, () => new THREE.Vector2(-999, -999)) }, clearCount: { value: 0 },
};
export function setClear(points: { x: number; y: number }[]): void {
  const n = Math.min(MAX_CLEAR, points.length);
  for (let i = 0; i < n; i++) cut.clear.value[i].set(points[i].x + 0.5, points[i].y + 0.5);
  cut.clearCount.value = n;
}
/** The same test the shader does, for checking it from code. */
export function isCut(p: THREE.Vector3): boolean {
  const d = cut.view.value;
  const mn = cut.boardMin.value;
  const mx = cut.boardMax.value;
  if (p.y > CUT_HEIGHT) {
    const onBoard = p.x > mn.x && p.z > mn.y && p.x < mx.x && p.z < mx.y;
    const gx = p.x + d.x * (p.y / -d.y);
    const gz = p.z + d.z * (p.y / -d.y);
    if (!onBoard && gx > mn.x - 0.4 && gz > mn.y - 0.4 && gx < mx.x + 0.4 && gz < mx.y + 0.4) return true;
  }
  for (const h of CLEAR_HEIGHTS) {
    if (p.y <= h) continue;
    const t = (p.y - h) / -d.y;
    const qx = p.x + d.x * t;
    const qz = p.z + d.z * t;
    for (let i = 0; i < cut.clearCount.value; i++) {
      const c = cut.clear.value[i];
      if (Math.hypot(qx - c.x, qz - c.y) < CLEAR_RADIUS) return true;
    }
  }
  return false;
}
export function cutaway<T extends THREE.Material>(mat: T): T {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.cutView = cut.view;
    shader.uniforms.cutMin = cut.boardMin;
    shader.uniforms.cutMax = cut.boardMax;
    shader.uniforms.cutClear = cut.clear;
    shader.uniforms.cutClearCount = cut.clearCount;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCutWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvec4 cutP = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\ncutP = instanceMatrix * cutP;\n#endif\nvCutWorld = (modelMatrix * cutP).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCutWorld;\nuniform vec3 cutView;\nuniform vec2 cutMin;\nuniform vec2 cutMax;\nuniform vec2 cutClear[${MAX_CLEAR}];\nuniform int cutClearCount;`)
      .replace('void main() {', `void main() {
  if (vCutWorld.y > ${CUT_HEIGHT.toFixed(2)}) {
    bool onBoard = all(greaterThan(vCutWorld.xz, cutMin)) && all(lessThan(vCutWorld.xz, cutMax));
    vec2 ground = vCutWorld.xz + cutView.xz * (vCutWorld.y / -cutView.y);
    if (!onBoard && all(greaterThan(ground, cutMin - 0.4)) && all(lessThan(ground, cutMax + 0.4))) discard;
  }
  for (int k = 0; k < ${CLEAR_HEIGHTS.length}; k++) {
    float h = float[${CLEAR_HEIGHTS.length}](${CLEAR_HEIGHTS.map((h) => h.toFixed(2)).join(', ')})[k];
    if (vCutWorld.y <= h) continue;
    vec2 q = vCutWorld.xz + cutView.xz * ((vCutWorld.y - h) / -cutView.y);
    for (int i = 0; i < ${MAX_CLEAR}; i++) {
      if (i >= cutClearCount) break;
      if (distance(q, cutClear[i]) < ${CLEAR_RADIUS.toFixed(2)}) discard;
    }
  }`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor.rgb *= 0.12;');
  };
  return mat;
}

/** Outside the board at the docks: open harbour south of the quay, container yards among the sheds. */
export function harbour(m: MapData, x: number, y: number): boolean {
  return m.theme === 'docks' && y <= -3;
}
export function yard(m: MapData, seed: number, x: number, y: number): boolean {
  if (m.theme !== 'docks' || (x >= -1 && y >= -1 && x <= m.w && y <= m.h) || harbour(m, x, y)) return false;
  return hash(Math.floor((x + 200) / 5), Math.floor((y + 200) / 4), seed + 5) < 0.4;
}

export function extOf(m: MapData, seed: number): Ext {
  return (x, y) => {
    if (x >= 0 && y >= 0 && x < m.w && y < m.h) return tileAt(m, x, y);
    if (harbour(m, x, y)) return '~';
    const d = Math.max(-x, x - m.w + 1, -y, y - m.h + 1);
    if (d <= 1) return '.';
    if (yard(m, seed, x, y)) return '.';
    const gx = Math.floor((x + 200) / 5);
    const gy = Math.floor((y + 200) / 4);
    const street = (x + 200) % 5 === 4 || (y + 200) % 4 === 3;
    if (street || hash(gx, gy, seed) < 0.12) return '.';
    return '#';
  };
}

export const inside = (m: MapData, x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h;

export interface Built {
  group: THREE.Group;
  /** Where street lamps hang, so the board can give the nearest ones real light. */
  lamps: THREE.Vector3[];
  flicker: { mat: THREE.MeshBasicMaterial; base: THREE.Color; seed: number }[];
  blink: THREE.MeshBasicMaterial[];
  /** Each terminal's screen, by "x,y", so it can take the colour of whoever holds it. */
  screens: Map<string, THREE.MeshBasicMaterial>;
  dispose(): void;
}

export function buildCity(s: GameState, shadows: boolean): Built {
  const m = s.map;
  let seed = 0;
  for (let i = 0; i < m.id.length; i++) seed = (seed * 31 + m.id.charCodeAt(i)) | 0;
  seed = Math.abs(seed) % 100000;
  const ext = extOf(m, seed);
  const p = PAL[m.theme];
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };
  const flicker: Built['flicker'] = [];
  const blink: THREE.MeshBasicMaterial[] = [];
  const lamps: THREE.Vector3[] = [];
  const screens = new Map<string, THREE.MeshBasicMaterial>();
  const x0 = -OUTER;
  const y0 = -OUTER;
  const W = m.w + OUTER * 2;
  const H = m.h + OUTER * 2;

  /* Ground: one texture for the whole area, with water cut out of it. */
  const PX = 48;
  const [gc, g] = canvas(W * PX, H * PX);
  const [rc, rg] = canvas(W * 16, H * 16);
  rg.fillStyle = '#d0d0d0';
  rg.fillRect(0, 0, rc.width, rc.height);
  for (let y = y0; y < y0 + H; y++) {
    for (let x = x0; x < x0 + W; x++) {
      const t = ext(x, y);
      const px = (x - x0) * PX;
      const py = (y - y0) * PX;
      if (t === '~') continue;
      const nearWall = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ext(x + dx, y + dy) === '#');
      g.fillStyle = nearWall ? p.walk : p.ground;
      g.fillRect(px, py, PX, PX);
      const n = hash(x, y, seed + 3);
      g.fillStyle = `rgba(255,255,255,${0.015 + n * 0.03})`;
      g.fillRect(px + n * 30, py + hash(x, y, 9) * 30, 14, 10);
      if (nearWall) {
        g.strokeStyle = 'rgba(0,0,0,0.35)';
        g.lineWidth = 1;
        g.strokeRect(px + 0.5, py + 0.5, PX - 1, PX - 1);
      }
      // Puddles: dark on the ground, shiny in the roughness map.
      if (n > 0.78 && !nearWall) {
        const cx = px + PX / 2 + (hash(x, y, 5) - 0.5) * 20;
        const cy = py + PX / 2 + (hash(x, y, 6) - 0.5) * 20;
        const r = 10 + hash(x, y, 7) * 16;
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath(); g.ellipse(cx, cy, r, r * 0.6, 0, 0, Math.PI * 2); g.fill();
        rg.fillStyle = '#101010';
        rg.beginPath(); rg.ellipse(cx / PX * 16, cy / PX * 16, r / PX * 16, r / PX * 16 * 0.6, 0, 0, Math.PI * 2); rg.fill();
      }
    }
  }
  // Road markings on the outer streets.
  g.strokeStyle = p.line;
  g.globalAlpha = 0.35;
  g.lineWidth = 3;
  g.setLineDash([18, 22]);
  for (let y = y0; y < y0 + H; y++) {
    for (let x = x0; x < x0 + W; x++) {
      if (inside(m, x, y) || ext(x, y) !== '.') continue;
      const horiz = ext(x - 1, y) === '.' && ext(x + 1, y) === '.' && ext(x, y - 1) === '#' === false && ext(x, y + 1) === '#' === false;
      if (horiz && hash(x, y, 11) > 0.5) {
        g.beginPath(); g.moveTo((x - x0) * PX, (y - y0 + 0.5) * PX); g.lineTo((x - x0 + 1) * PX, (y - y0 + 0.5) * PX); g.stroke();
      }
    }
  }
  g.setLineDash([]);
  g.globalAlpha = 1;
  // The playing area: a faint grid and the deployment zones.
  g.save();
  g.translate(-x0 * PX, -y0 * PX);
  s.map.zones.forEach((z, i) => {
    const side = s.cfg.sides[i];
    if (!side) return;
    g.fillStyle = FACTIONS[side.faction].color + '14';
    g.fillRect(z.x * PX, z.y * PX, z.w * PX, z.h * PX);
  });
  g.strokeStyle = 'rgba(200,225,255,0.10)';
  g.lineWidth = 1;
  for (let x = 0; x <= m.w; x++) { g.beginPath(); g.moveTo(x * PX, 0); g.lineTo(x * PX, m.h * PX); g.stroke(); }
  for (let y = 0; y <= m.h; y++) { g.beginPath(); g.moveTo(0, y * PX); g.lineTo(m.w * PX, y * PX); g.stroke(); }
  g.strokeStyle = 'rgba(210,235,255,0.55)';
  g.lineWidth = 3;
  g.strokeRect(0, 0, m.w * PX, m.h * PX);
  g.restore();
  // Darken the city outside the board, so the play area reads first.
  g.fillStyle = 'rgba(2,4,8,0.45)';
  g.beginPath();
  g.rect(0, 0, gc.width, gc.height);
  g.rect(-x0 * PX, -y0 * PX, m.w * PX, m.h * PX);
  g.fill('evenodd');

  const groundTex = own(new THREE.CanvasTexture(gc));
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = 4;
  const roughTex = own(new THREE.CanvasTexture(rc));
  // Water tiles are cut out with an alpha map.
  const [ac, ag] = canvas(W * 8, H * 8);
  ag.fillStyle = '#fff';
  ag.fillRect(0, 0, ac.width, ac.height);
  ag.fillStyle = '#000';
  for (let y = y0; y < y0 + H; y++) for (let x = x0; x < x0 + W; x++) if (ext(x, y) === '~') ag.fillRect((x - x0) * 8, (y - y0) * 8, 8, 8);
  const alphaTex = own(new THREE.CanvasTexture(ac));
  alphaTex.magFilter = THREE.NearestFilter;
  const ground = new THREE.Mesh(
    own(new THREE.PlaneGeometry(W, H)),
    own(new THREE.MeshStandardMaterial({ map: groundTex, roughnessMap: roughTex, roughness: 1, metalness: 0.1, alphaMap: alphaTex, alphaTest: 0.5 })),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(x0 + W / 2, 0, y0 + H / 2);
  ground.receiveShadow = shadows;
  group.add(ground);

  const water = new THREE.Mesh(own(new THREE.PlaneGeometry(W * 3, H * 3)), own(new THREE.MeshStandardMaterial({ color: p.water, roughness: 0.08, metalness: 0.6 })));
  water.rotation.x = -Math.PI / 2;
  water.position.set(x0 + W / 2, -0.32, y0 + H / 2);
  water.receiveShadow = shadows;
  group.add(water);

  /* Quay walls where the ground drops into water. */
  const quayMat = own(new THREE.MeshStandardMaterial({ color: '#3a4250', roughness: 0.9 }));
  const quayGeo = own(new THREE.BoxGeometry(1, 0.34, 0.12));
  for (let y = y0; y < y0 + H; y++) {
    for (let x = x0; x < x0 + W; x++) {
      if (ext(x, y) === '~') continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        if (ext(x + dx, y + dy) !== '~') continue;
        const q = new THREE.Mesh(quayGeo, quayMat);
        q.position.set(x + 0.5 + dx * 0.5, -0.16, y + 0.5 + dy * 0.5);
        if (dx) q.rotation.y = Math.PI / 2;
        group.add(q);
      }
    }
  }

  /*
   * Buildings: every connected run of wall squares is one building. Big ones step back as they rise,
   * so the skyline has towers on podiums rather than boxes. Each picks one of four facades.
   */
  const seen = new Set<string>();
  const facades = facadeTextures(seed);
  facades.forEach((f) => { own(f.map); own(f.lit); });
  const facadeGeo = facades.map(() => ({ pos: [] as number[], uv: [] as number[], col: [] as number[] }));
  const roofPos: number[] = [];
  const roofCol: number[] = [];
  const edgePos: number[] = [];
  const edgeCol: number[] = [];
  const signSpots: { x: number; y: number; dx: number; dy: number; h: number }[] = [];
  const roofs: { x: number; y: number; h: number }[] = [];
  const billboards: { x: number; y: number; dx: number; dy: number; y0: number; y1: number }[] = [];
  const st = STYLE[m.theme];
  const STOREY_TEX = 16 * 0.42;
  for (let y = y0; y < y0 + H; y++) {
    for (let x = x0; x < x0 + W; x++) {
      if (ext(x, y) !== '#' || seen.has(`${x},${y}`)) continue;
      const tiles: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      seen.add(`${x},${y}`);
      let isIn = false;
      let near = Infinity;
      while (stack.length) {
        const [a, b] = stack.pop()!;
        tiles.push([a, b]);
        if (inside(m, a, b)) isIn = true;
        near = Math.min(near, Math.max(-a, a - m.w + 1, -b, b - m.h + 1, 0));
        for (const [nx, ny] of [[a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]] as const) {
          if (nx < x0 || ny < y0 || nx >= x0 + W || ny >= y0 + H) continue;
          if (ext(nx, ny) === '#' && !seen.has(`${nx},${ny}`)) { seen.add(`${nx},${ny}`); stack.push([nx, ny]); }
        }
      }
      const r = hash(x, y, seed + 21);
      const r2 = hash(x, y, seed + 22);
      // Inside the board they stay low enough to fight around; the city behind them climbs into the haze.
      const [lo, hi] = isIn ? st.inner : st.outer;
      // At the docks the real city only starts far back; close in it's sheds and warehouses.
      const skyline = false;
      const base = isIn ? lo + Math.floor(r * 5) / 4 * (hi - lo) : skyline ? 7 + r * 9 : lo + r * (hi - lo) + Math.min(4, near) * (hi - lo) * 0.12;
      const facade = skyline ? pick([0, 1, 2], r2) : pick(st.facades, r2);
      const wall = new THREE.Color(pick(p.walls, hash(x, y, 4))).lerp(new THREE.Color('#ffffff'), 0.35);
      const roof = new THREE.Color(pick(p.roofs, hash(x, y, 8))).multiplyScalar(0.55);
      const edgeColor = hash(x, y, 9) > 0.45 ? new THREE.Color(pick(p.neon, hash(x, y, 10))).multiplyScalar(2.6) : null;
      // Tiers: each one stands on the squares of the one below that are surrounded on all sides.
      const tiers: { set: Set<string>; y0: number; y1: number }[] = [];
      let set = new Set(tiles.map(([a, b]) => `${a},${b}`));
      let bottom = 0;
      let top = base;
      for (let level = 0; level < 3 && set.size; level++) {
        tiers.push({ set, y0: bottom, y1: top });
        const innerSet = new Set<string>();
        for (const key of set) {
          const [a, b] = key.split(',').map(Number);
          let all = true;
          for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (!set.has(`${a + dx},${b + dy}`)) { all = false; break; }
          if (all) innerSet.add(key);
        }
        // Low buildings in the board don't grow towers on top.
        if (isIn && level >= 0) break;
        if (!innerSet.size || hash(x, y, 30 + level) > (skyline ? 0.7 : st.tierChance)) break;
        set = innerSet;
        bottom = top;
        top = top + st.tierHeight * (0.5 + hash(x, y, 40 + level)) * (level === 0 ? 1 : 0.6);
      }
      tiers.forEach((tier, ti) => {
        const above = tiers[ti + 1]?.set;
        for (const key of tier.set) {
          const [a, b] = key.split(',').map(Number);
          if (!above?.has(key)) {
            const h = tier.y1;
            roofPos.push(a, h, b, a, h, b + 1, a + 1, h, b, a + 1, h, b, a, h, b + 1, a + 1, h, b + 1);
            for (let i = 0; i < 6; i++) roofCol.push(roof.r, roof.g, roof.b);
            if (hash(a, b, 31 + ti) > 0.8) roofs.push({ x: a, y: b, h });
          }
          const faces: [number, number, number[]][] = [
            [0, 1, [a, b + 1, a + 1, b + 1]],
            [0, -1, [a + 1, b, a, b]],
            [1, 0, [a + 1, b + 1, a + 1, b]],
            [-1, 0, [a, b, a, b + 1]],
          ];
          for (const [dx, dy, [ax, az, bx, bz]] of faces) {
            if (tier.set.has(`${a + dx},${b + dy}`)) continue;
            const g = facadeGeo[facade];
            const u0 = ((dx ? b : a) + 64) / 8;
            const u1 = u0 + 1 / 8;
            const v0 = tier.y0 / STOREY_TEX;
            const v1 = tier.y1 / STOREY_TEX;
            g.pos.push(ax, tier.y0, az, bx, tier.y0, bz, bx, tier.y1, bz, ax, tier.y0, az, bx, tier.y1, bz, ax, tier.y1, az);
            g.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
            for (let i = 0; i < 6; i++) g.col.push(wall.r, wall.g, wall.b);
            // A thin line of light along the top edge of some buildings.
            if (edgeColor) {
              const e = 0.05;
              const ox = dx * 0.006;
              const oz = dy * 0.006;
              edgePos.push(ax + ox, tier.y1 - e, az + oz, bx + ox, tier.y1 - e, bz + oz, bx + ox, tier.y1, bz + oz, ax + ox, tier.y1 - e, az + oz, bx + ox, tier.y1, bz + oz, ax + ox, tier.y1, az + oz);
              for (let i = 0; i < 6; i++) edgeCol.push(edgeColor.r, edgeColor.g, edgeColor.b);
            }
            if (ti === 0) {
              const open = ext(a + dx, b + dy);
              if ((open === '.' || open === 'c') && hash(a, b, dx * 3 + dy + 40) < (inside(m, a + dx, b + dy) ? st.signs[0] : st.signs[1])) signSpots.push({ x: a, y: b, dx, dy, h: tier.y1 });
            }
            if (!isIn && tier.y1 - tier.y0 > 4 && hash(a, b, dx * 5 + dy + 70 + ti) > (m.theme === 'plaza' ? 0.8 : 0.93)) billboards.push({ x: a, y: b, dx, dy, y0: tier.y0 + 1.5, y1: tier.y1 - 1 });
          }
        }
      });
    }
  }
  const facadeMats = facades.map((f, i) => own(cutaway(new THREE.MeshStandardMaterial({
    map: f.map, emissiveMap: f.lit, emissive: new THREE.Color('#ffffff'), emissiveIntensity: f.glow, vertexColors: true,
    roughness: i === 1 ? 0.25 : 0.8, metalness: i === 1 ? 0.6 : 0.15, side: THREE.DoubleSide,
  }))));
  facadeGeo.forEach((g, i) => {
    if (!g.pos.length) return;
    const geo = own(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, facadeMats[i]);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    group.add(mesh);
  });
  const roofGeo = own(new THREE.BufferGeometry());
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
  roofGeo.setAttribute('color', new THREE.Float32BufferAttribute(roofCol, 3));
  roofGeo.computeVertexNormals();
  const roofMesh = new THREE.Mesh(roofGeo, own(cutaway(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }))));
  roofMesh.castShadow = shadows;
  roofMesh.receiveShadow = shadows;
  group.add(roofMesh);
  if (edgePos.length) {
    const edgeGeo = own(new THREE.BufferGeometry());
    edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    edgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(edgeCol, 3));
    group.add(new THREE.Mesh(edgeGeo, own(cutaway(new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide })))));
  }
  /* Giant adverts high up the towers. */
  const adWords = WORDS[m.theme];
  const adGeo = own(new THREE.PlaneGeometry(1, 1));
  for (const bb of billboards.slice(0, st.adverts)) {
    const color = pick(p.neon, hash(bb.x, bb.y, 81));
    const tex = own(signTexture(pick(adWords, hash(bb.x, bb.y, 82)), color, true));
    const mat = own(cutaway(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, color: new THREE.Color(1.6, 1.6, 1.6), side: THREE.DoubleSide })));
    flicker.push({ mat, base: mat.color.clone(), seed: hash(bb.x, bb.y, 83) * 100 });
    const ad = new THREE.Mesh(adGeo, mat);
    const h = Math.min(6, bb.y1 - bb.y0);
    ad.scale.set(0.85, h, 1);
    ad.position.set(bb.x + 0.5 + bb.dx * 0.53, bb.y0 + h / 2, bb.y + 0.5 + bb.dy * 0.53);
    ad.rotation.y = bb.dx ? (bb.dx > 0 ? Math.PI / 2 : -Math.PI / 2) : bb.dy > 0 ? 0 : Math.PI;
    group.add(ad);
  }

  /* Roof clutter: air conditioners, water tanks and blinking aerials. */
  const boxGeo = own(new THREE.BoxGeometry(1, 1, 1));
  const cylGeo = own(new THREE.CylinderGeometry(0.5, 0.5, 1, 12));
  const metal = own(cutaway(new THREE.MeshStandardMaterial({ color: '#59616e', roughness: 0.6, metalness: 0.5 })));
  for (const r of roofs) {
    const k = hash(r.x, r.y, 77);
    if (k < 0.45) {
      const ac = new THREE.Mesh(boxGeo, metal);
      ac.scale.set(0.45, 0.25, 0.35);
      ac.position.set(r.x + 0.5, r.h + 0.125, r.y + 0.5);
      ac.castShadow = shadows;
      group.add(ac);
    } else if (k < 0.75) {
      const tank = new THREE.Mesh(cylGeo, metal);
      tank.scale.set(0.5, 0.55, 0.5);
      tank.position.set(r.x + 0.5, r.h + 0.27, r.y + 0.5);
      tank.castShadow = shadows;
      group.add(tank);
    } else {
      const mast = new THREE.Mesh(cylGeo, metal);
      mast.scale.set(0.04, 1.2, 0.04);
      mast.position.set(r.x + 0.5, r.h + 0.6, r.y + 0.5);
      group.add(mast);
      const mat = own(cutaway(new THREE.MeshBasicMaterial({ color: hot(NEON.red, 4), toneMapped: false })));
      blink.push(mat);
      const tip = new THREE.Mesh(boxGeo, mat);
      tip.scale.setScalar(0.07);
      tip.position.set(r.x + 0.5, r.h + 1.22, r.y + 0.5);
      group.add(tip);
    }
  }

  /* Neon signs on walls that face a street, each with a pool of coloured light below it. */
  const words = WORDS[m.theme];
  const poolTex = own(radialTexture());
  const planeGeo = own(new THREE.PlaneGeometry(1, 1));
  for (const sp of signSpots) {
    const color = pick(p.neon, hash(sp.x, sp.y, 50));
    const vertical = hash(sp.x, sp.y, 51) > 0.5;
    const word = pick(words, hash(sp.x, sp.y, 52));
    const tex = own(signTexture(word, color, vertical));
    const mat = own(cutaway(new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, color: new THREE.Color(1.8, 1.8, 1.8), side: THREE.DoubleSide })));
    flicker.push({ mat, base: mat.color.clone(), seed: hash(sp.x, sp.y, 53) * 100 });
    const sign = new THREE.Mesh(planeGeo, mat);
    const w = vertical ? 0.32 : 0.9;
    const h = vertical ? Math.min(1.3, sp.h * 0.6) : 0.3;
    sign.scale.set(w, h, 1);
    const cy = Math.min(sp.h - 0.2, 0.9 + hash(sp.x, sp.y, 54) * 0.5) ;
    if (vertical) {
      // Blade signs stick out from the wall, so they're seen from both directions.
      sign.position.set(sp.x + 0.5 + sp.dx * 0.62, cy + 0.1, sp.y + 0.5 + sp.dy * 0.62);
      sign.rotation.y = sp.dx ? 0 : Math.PI / 2;
    } else {
      sign.position.set(sp.x + 0.5 + sp.dx * 0.52, cy, sp.y + 0.5 + sp.dy * 0.52);
      sign.rotation.y = sp.dx ? (sp.dx > 0 ? Math.PI / 2 : -Math.PI / 2) : sp.dy > 0 ? 0 : Math.PI;
    }
    group.add(sign);
    const pool = new THREE.Mesh(planeGeo, own(new THREE.MeshBasicMaterial({ map: poolTex, color: new THREE.Color(color).multiplyScalar(0.55), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    pool.rotation.x = -Math.PI / 2;
    pool.scale.set(2.2, 2.2, 1);
    pool.position.set(sp.x + 0.5 + sp.dx * 1.3, 0.01, sp.y + 0.5 + sp.dy * 1.3);
    group.add(pool);
  }

  /* Street lamps along the open squares next to buildings. */
  const poleMat = own(cutaway(new THREE.MeshStandardMaterial({ color: '#2a2f38', roughness: 0.5, metalness: 0.7 })));
  const headMat = own(cutaway(new THREE.MeshBasicMaterial({ color: hot(p.lamp, 3.5), toneMapped: false })));
  for (let y = y0 + 1; y < y0 + H - 1; y++) {
    for (let x = x0 + 1; x < x0 + W - 1; x++) {
      if (ext(x, y) !== '.') continue;
      const wallSide = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dx, dy]) => ext(x + dx, y + dy) === '#');
      if (!wallSide || hash(x, y, seed + 60) < (inside(m, x, y) ? 0.82 : 0.9)) continue;
      if (lamps.some((l) => Math.abs(l.x - x) + Math.abs(l.z - y) < 4)) continue;
      const [dx, dy] = wallSide;
      const px = x + 0.5 + dx * 0.38;
      const pz = y + 0.5 + dy * 0.38;
      const pole = new THREE.Mesh(cylGeo, poleMat);
      pole.scale.set(0.05, 1.7, 0.05);
      pole.position.set(px, 0.85, pz);
      pole.castShadow = shadows;
      group.add(pole);
      const head = new THREE.Mesh(boxGeo, headMat);
      head.scale.set(0.28, 0.06, 0.14);
      head.position.set(px - dx * 0.12, 1.7, pz - dy * 0.12);
      group.add(head);
      const pool = new THREE.Mesh(planeGeo, own(new THREE.MeshBasicMaterial({ map: poolTex, color: new THREE.Color(p.lamp).multiplyScalar(0.7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
      pool.rotation.x = -Math.PI / 2;
      pool.scale.set(3.4, 3.4, 1);
      pool.position.set(px - dx * 0.3, 0.012, pz - dy * 0.3);
      group.add(pool);
      lamps.push(new THREE.Vector3(px - dx * 0.12, 1.6, pz - dy * 0.12));
    }
  }

  /* Cover, glass and terminals inside the board. */
  const crateMat = own(new THREE.MeshStandardMaterial({ color: '#6b5235', roughness: 0.9 }));
  const concrete = own(new THREE.MeshStandardMaterial({ color: '#7a808a', roughness: 0.95 }));
  const stripe = own(new THREE.MeshStandardMaterial({ color: '#c9a531', roughness: 0.7 }));
  const drumMat = own(new THREE.MeshStandardMaterial({ color: '#8c3b2a', roughness: 0.6, metalness: 0.4 }));
  const carMats = ['#2c4f6b', '#6b2c3a', '#3d3d45', '#4f5a2c'].map((c) => own(new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.6 })));
  const glassMat = own(cutaway(new THREE.MeshPhysicalMaterial({ color: '#8fe6ff', transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.1 })));
  const glassEdge = own(cutaway(new THREE.MeshBasicMaterial({ color: hot(NEON.cyan, 2), toneMapped: false })));
  const containerMats = ['#7a2f22', '#25506e', '#2f6b45', '#7a6522'].map((c) => own(new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, metalness: 0.3 })));
  const tailMat = own(new THREE.MeshBasicMaterial({ color: hot(NEON.red, 3), toneMapped: false }));
  const add = (mesh: THREE.Mesh, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0) => {
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.userData.cover = true;
    group.add(mesh);
    return mesh;
  };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const t = tileAt(m, x, y);
      const cx = x + 0.5;
      const cz = y + 0.5;
      const k = hash(x, y, seed + 90);
      if (t === 'c') {
        const horiz = tileAt(m, x - 1, y) === 'c' || tileAt(m, x + 1, y) === 'c';
        const ry = horiz ? 0 : Math.PI / 2;
        const kind = m.theme === 'docks' ? (k < 0.5 ? 'container' : k < 0.75 ? 'crates' : 'drums')
          : m.theme === 'plaza' ? (k < 0.45 ? 'planter' : k < 0.8 ? 'car' : 'barrier')
          : (k < 0.55 ? 'stall' : k < 0.8 ? 'crates' : 'car');
        if (kind === 'container') {
          add(new THREE.Mesh(boxGeo, pick(containerMats, hash(x, y, 91))), cx, 0.32, cz, 1, 0.64, 0.8, ry);
        } else if (kind === 'crates') {
          add(new THREE.Mesh(boxGeo, crateMat), cx - 0.18, 0.2, cz - 0.1, 0.42, 0.4, 0.42, k * 3);
          add(new THREE.Mesh(boxGeo, crateMat), cx + 0.2, 0.17, cz + 0.16, 0.36, 0.34, 0.36, k * 5);
          if (k > 0.5) add(new THREE.Mesh(boxGeo, crateMat), cx - 0.1, 0.55, cz - 0.05, 0.32, 0.3, 0.32, k * 7);
        } else if (kind === 'drums') {
          for (const [ox, oz] of [[-0.18, -0.15], [0.18, -0.1], [0, 0.2]] as const) add(new THREE.Mesh(cylGeo, drumMat), cx + ox, 0.25, cz + oz, 0.3, 0.5, 0.3);
        } else if (kind === 'stall') {
          // A counter under a striped awning, lit from inside.
          add(new THREE.Mesh(boxGeo, crateMat), cx, 0.28, cz, 0.9, 0.56, 0.5, ry);
          const awn = own(new THREE.MeshStandardMaterial({ color: pick(['#b8323c', '#c97a2a', '#2f7d8a', '#8a2f7a'], hash(x, y, 93)), roughness: 0.8, emissive: new THREE.Color(pick(p.neon, hash(x, y, 94))).multiplyScalar(0.25) }));
          add(new THREE.Mesh(boxGeo, awn), cx, 0.78, cz, 1.0, 0.05, 0.75, ry).rotation.x = 0;
          add(new THREE.Mesh(boxGeo, own(new THREE.MeshBasicMaterial({ color: hot(pick(p.neon, hash(x, y, 95)), 2.4), toneMapped: false }))), cx, 0.6, cz, 0.82, 0.04, 0.42, ry).castShadow = false;
        } else if (kind === 'planter') {
          add(new THREE.Mesh(boxGeo, own(new THREE.MeshStandardMaterial({ color: '#c9ced8', roughness: 0.4, metalness: 0.2 }))), cx, 0.25, cz, 0.92, 0.5, 0.92);
          add(new THREE.Mesh(boxGeo, own(new THREE.MeshStandardMaterial({ color: '#1f5a3a', roughness: 0.9, emissive: new THREE.Color('#0b2a18') }))), cx, 0.55, cz, 0.8, 0.12, 0.8);
          add(new THREE.Mesh(boxGeo, own(new THREE.MeshBasicMaterial({ color: hot(NEON.cyan, 1.6), toneMapped: false }))), cx, 0.505, cz, 0.94, 0.02, 0.94).castShadow = false;
        } else if (kind === 'barrier') {
          add(new THREE.Mesh(boxGeo, concrete), cx, 0.22, cz, 0.96, 0.44, 0.3, ry);
          add(new THREE.Mesh(boxGeo, stripe), cx, 0.38, cz, 0.97, 0.06, 0.31, ry);
        } else {
          const mat = pick(carMats, hash(x, y, 92));
          add(new THREE.Mesh(boxGeo, mat), cx, 0.2, cz, 0.95, 0.26, 0.5, ry);
          add(new THREE.Mesh(boxGeo, mat), cx, 0.42, cz, 0.5, 0.2, 0.44, ry);
          const back = new THREE.Vector3(horiz ? -0.48 : 0, 0.24, horiz ? 0 : 0.48);
          add(new THREE.Mesh(boxGeo, tailMat), cx + back.x, back.y, cz + back.z, horiz ? 0.02 : 0.4, 0.05, horiz ? 0.4 : 0.02);
        }
      } else if (t === 'g') {
        add(new THREE.Mesh(boxGeo, glassMat), cx, 0.5, cz, 1, 1, 1);
        add(new THREE.Mesh(boxGeo, glassEdge), cx, 1.0, cz, 1.0, 0.03, 1.0).castShadow = false;
      } else if (t === 'T') {
        add(new THREE.Mesh(boxGeo, metal), cx, 0.35, cz, 0.6, 0.7, 0.45);
        const screenMat = own(cutaway(new THREE.MeshBasicMaterial({ color: hot('#9aa0ac', 1.6), toneMapped: false })));
        screens.set(`${x},${y}`, screenMat);
        const screen = new THREE.Mesh(planeGeo, screenMat);
        screen.scale.set(0.5, 0.32, 1);
        screen.position.set(cx, 0.55, cz + 0.231);
        group.add(screen);
      }
    }
  }

  /* What makes each district its own place. */
  const extra = new THREE.Group();
  group.add(extra);
  const unit = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  if (m.theme === 'docks') {
    // Container yards: stacks of boxes in shipping-line colours.
    const boxes: { pos: THREE.Vector3; scale: THREE.Vector3; color: THREE.Color }[] = [];
    const shipping = ['#7a2f22', '#25506e', '#2f6b45', '#7a6522', '#5a5f66', '#8a4a1c'].map((c) => new THREE.Color(c));
    for (let y = y0; y < y0 + H; y++) {
      for (let x = x0; x < x0 + W; x++) {
        if (!yard(m, seed, x, y) || (x + 200) % 5 === 4 || (y + 200) % 4 === 3) continue;
        const stackH = 1 + Math.floor(hash(x, y, 101) * 5);
        for (let k = 0; k < stackH; k++) {
          boxes.push({ pos: new THREE.Vector3(x + 0.5, 0.29 + k * 0.58, y + 0.5), scale: new THREE.Vector3(0.96, 0.56, 0.9), color: pick(shipping, hash(x, y, 102 + k)) });
        }
      }
    }
    if (boxes.length) {
      const inst = new THREE.InstancedMesh(boxGeo, own(cutaway(new THREE.MeshStandardMaterial({ map: own(ribTexture()), roughness: 0.7, metalness: 0.3 }))), boxes.length);
      boxes.forEach((b, i) => { inst.setMatrixAt(i, unit.compose(b.pos, q, b.scale)); inst.setColorAt(i, b.color); });
      inst.castShadow = shadows;
      inst.receiveShadow = shadows;
      extra.add(inst);
    }
    // Gantry cranes on the quay, booms out over the water, warning lights on top.
    const steel = own(cutaway(new THREE.MeshStandardMaterial({ color: '#c9a531', roughness: 0.6, metalness: 0.5 })));
    const cranes = [Math.round(m.w * 0.15), Math.round(m.w * 0.55), Math.round(m.w * 0.9)];
    for (const cx of cranes) {
      const qy = -1.5;
      const part = (x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
        const b = new THREE.Mesh(boxGeo, steel);
        b.scale.set(sx, sy, sz);
        b.position.set(x, y, z);
        b.castShadow = shadows;
        extra.add(b);
      };
      for (const lx of [-1.2, 1.2]) for (const lz of [-0.9, 0.9]) part(cx + lx, 3.5, qy + lz, 0.22, 7, 0.22);
      part(cx, 7, qy, 2.8, 0.35, 2.2);
      part(cx, 7.6, qy - 4, 0.5, 0.4, 13);
      part(cx, 9, qy - 0.5, 0.3, 3, 0.3);
      const tip = new THREE.Mesh(boxGeo, own(cutaway(new THREE.MeshBasicMaterial({ color: hot(NEON.red, 4), toneMapped: false }))));
      blink.push(tip.material as THREE.MeshBasicMaterial);
      tip.scale.setScalar(0.18);
      tip.position.set(cx, 10.6, qy - 0.5);
      extra.add(tip);
    }
    // The city proper, across the water: towers standing in the haze beyond the harbour.
    const far = new THREE.Group();
    for (let i = 0; i < 16; i++) {
      const w = 2 + Math.floor(hash(i, 1, seed) * 3);
      const d = 2 + Math.floor(hash(i, 2, seed) * 3);
      const h = 9 + hash(i, 3, seed) * 16;
      const fx = x0 - 4 + i * ((W + 8) / 16) + hash(i, 4, seed) * 1.5;
      const fz = y0 - 6 - hash(i, 5, seed) * 10;
      const geo = own(new THREE.BoxGeometry(w, h, d));
      // Scale the facade so its floors and windows keep their size on a box of any shape.
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      for (let v = 0; v < uv.count; v++) {
        const side = Math.abs(nrm.getX(v)) > 0.5 ? d : w;
        uv.setXY(v, uv.getX(v) * side / 8 + i * 0.37, Math.abs(nrm.getY(v)) > 0.5 ? 0 : uv.getY(v) * h / (16 * 0.42));
      }
      const tower = new THREE.Mesh(geo, facadeMats[pick([0, 1, 2], hash(i, 6, seed))]);
      tower.position.set(fx, h / 2 - 0.3, fz);
      far.add(tower);
    }
    extra.add(far);
    // Hazard stripes along the quay edge.
    const hazard = own(new THREE.MeshStandardMaterial({ color: '#d7b21e', roughness: 0.7 }));
    const strip = new THREE.Mesh(boxGeo, hazard);
    strip.scale.set(W, 0.02, 0.18);
    strip.position.set(x0 + W / 2, 0.01, -2.15);
    extra.add(strip);
  }
  if (m.theme === 'market') {
    // Strings of bulbs and paper lanterns across the streets, from wall to facing wall.
    const bulbs: THREE.Vector3[] = [];
    const lanterns: THREE.Vector3[] = [];
    const lineMat = own(cutaway(new THREE.LineBasicMaterial({ color: '#2a2228' })));
    for (let y = y0 + 1; y < y0 + H - 1; y++) {
      for (let x = x0 + 1; x < x0 + W - 1; x++) {
        if (ext(x, y) !== '#' || hash(x, y, 120) < 0.55) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
          let n = 1;
          while (n <= 4 && ext(x + dx * n, y + dy * n) !== '#' && ext(x + dx * n, y + dy * n) !== '~') n += 1;
          if (n < 2 || n > 4 || ext(x + dx * n, y + dy * n) !== '#') continue;
          const a = new THREE.Vector3(x + 0.5 + dx * 0.5, 2.1 + hash(x, y, 121) * 0.5, y + 0.5 + dy * 0.5);
          const b = new THREE.Vector3(x + dx * n + 0.5 - dx * 0.5, 2.1 + hash(x, y, 122) * 0.5, y + dy * n + 0.5 - dy * 0.5);
          const pts: THREE.Vector3[] = [];
          const steps = 6 * n;
          for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const pnt = a.clone().lerp(b, t);
            pnt.y -= Math.sin(t * Math.PI) * 0.45;
            pts.push(pnt);
            if (i % 2 === 1) bulbs.push(pnt.clone().add(new THREE.Vector3(0, -0.04, 0)));
            if (i % 6 === 3 && hash(x + i, y, 123) > 0.4) lanterns.push(pnt.clone().add(new THREE.Vector3(0, -0.22, 0)));
          }
          extra.add(new THREE.Line(own(new THREE.BufferGeometry().setFromPoints(pts)), lineMat));
        }
      }
    }
    const bulbGeo = own(new THREE.SphereGeometry(0.035, 6, 4));
    const bulbMat = own(cutaway(new THREE.MeshBasicMaterial({ color: hot('#ffcf8a', 3.2), toneMapped: false })));
    const bi = new THREE.InstancedMesh(bulbGeo, bulbMat, Math.max(1, bulbs.length));
    bulbs.forEach((v, i) => bi.setMatrixAt(i, unit.compose(v, q, one)));
    bi.count = bulbs.length;
    extra.add(bi);
    const lanternGeo = own(new THREE.SphereGeometry(0.12, 10, 8));
    lanternGeo.scale(1, 1.25, 1);
    const li = new THREE.InstancedMesh(lanternGeo, own(cutaway(new THREE.MeshBasicMaterial({ color: hot('#ff3b2f', 2.4), toneMapped: false }))), Math.max(1, lanterns.length));
    lanterns.forEach((v, i) => li.setMatrixAt(i, unit.compose(v, q, one)));
    li.count = lanterns.length;
    extra.add(li);
  }

  return {
    group,
    lamps,
    flicker,
    blink,
    screens,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}

/**
 * Five facades, each 8 squares wide and 16 storeys tall, with a lit-up copy for the night:
 * 0 glass ribbons, 1 curtain-wall glass, 2 dark monolith with light strips, 3 crowded apartment stacks.
 */
export function facadeTextures(seed: number): { map: THREE.CanvasTexture; lit: THREE.CanvasTexture; glow: number }[] {
  const W = 512;
  const H = 1024;
  const col = W / 8;
  const row = H / 16;
  const rnd = (a: number, b: number, k: number) => hash(a + seed, b, k);
  const make = (paint: (m: CanvasRenderingContext2D, l: CanvasRenderingContext2D) => void, glow: number) => {
    const [mc, mg] = canvas(W, H);
    const [lc, lg] = canvas(W, H);
    lg.fillStyle = '#000';
    lg.fillRect(0, 0, W, H);
    paint(mg, lg);
    const map = new THREE.CanvasTexture(mc);
    const lit = new THREE.CanvasTexture(lc);
    for (const t of [map, lit]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
    }
    return { map, lit, glow };
  };
  const warm = ['#ffcf8a', '#ffb56b', '#fff1d0'];
  const cool = ['#9fe3ff', '#d8f4ff', '#7fb6ff'];
  return [
    // Glass ribbons: a band of glass on every floor, lit in uneven runs.
    make((m, l) => {
      m.fillStyle = '#8c929c';
      m.fillRect(0, 0, W, H);
      for (let f = 0; f < 16; f++) {
        const y = H - (f + 1) * row;
        m.fillStyle = '#20262f';
        m.fillRect(0, y + row * 0.22, W, row * 0.62);
        m.fillStyle = 'rgba(255,255,255,0.10)';
        m.fillRect(0, y + row * 0.22, W, 2);
        let x = 0;
        while (x < W) {
          const run = col * (0.4 + rnd(x, f, 1) * 2.2);
          const k = rnd(x, f, 2);
          if (k > 0.55) {
            l.fillStyle = k > 0.92 ? pick(['#ff5ab4', '#38e8ff', '#9a6bff'], rnd(x, f, 3)) : pick(k > 0.75 ? cool : warm, rnd(x, f, 4));
            l.globalAlpha = 0.25 + rnd(x, f, 5) * 0.6;
            l.fillRect(x, y + row * 0.24, run - 3, row * 0.58);
            l.globalAlpha = 1;
          }
          x += run;
        }
      }
    }, 1.1),
    // Curtain wall: glass from top to bottom, with thin frames and the odd lit office.
    make((m, l) => {
      const g = m.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2a4a5c');
      g.addColorStop(1, '#152430');
      m.fillStyle = g;
      m.fillRect(0, 0, W, H);
      m.strokeStyle = 'rgba(190,220,235,0.35)';
      m.lineWidth = 2;
      for (let x = 0; x <= W; x += col / 3) { m.beginPath(); m.moveTo(x, 0); m.lineTo(x, H); m.stroke(); }
      for (let y = 0; y <= H; y += row) { m.beginPath(); m.moveTo(0, y); m.lineTo(W, y); m.stroke(); }
      l.fillStyle = 'rgba(70,140,180,0.10)';
      l.fillRect(0, 0, W, H);
      for (let f = 0; f < 16; f++) {
        const allOn = rnd(0, f, 6) > 0.9;
        for (let c = 0; c < 24; c++) {
          if (!allOn && rnd(c, f, 7) < 0.86) continue;
          l.fillStyle = pick(cool, rnd(c, f, 8));
          l.globalAlpha = allOn ? 0.55 : 0.75;
          l.fillRect(c * (col / 3) + 2, H - (f + 1) * row + 3, col / 3 - 4, row - 6);
          l.globalAlpha = 1;
        }
      }
    }, 1.3),
    // Monolith: dark panels, no windows to speak of, and thin strips of light running up it.
    make((m, l) => {
      m.fillStyle = '#2b2f36';
      m.fillRect(0, 0, W, H);
      for (let y = 0; y < H; y += row * 2) {
        m.fillStyle = 'rgba(0,0,0,0.25)';
        m.fillRect(0, y, W, 3);
      }
      for (let c = 0; c < 8; c++) {
        if (rnd(c, 0, 9) < 0.45) continue;
        const color = pick(['#38e8ff', '#ff3d9a', '#9a6bff', '#ffb347'], rnd(c, 0, 10));
        const x = c * col + col * (0.2 + rnd(c, 0, 11) * 0.6);
        l.fillStyle = color;
        l.fillRect(x, 0, 4, H);
        m.fillStyle = '#5b6070';
        m.fillRect(x, 0, 4, H);
      }
      for (let i = 0; i < 40; i++) {
        l.fillStyle = '#ff3b3b';
        l.fillRect(rnd(i, 1, 12) * W, rnd(i, 2, 13) * H, 3, 3);
      }
    }, 1.6),
    // Corrugated sheds: metal ribs, rust, a roller door and a couple of lit office windows.
    make((m, l) => {
      m.fillStyle = '#7d858c';
      m.fillRect(0, 0, W, H);
      for (let x = 0; x < W; x += 8) { m.fillStyle = 'rgba(0,0,0,0.22)'; m.fillRect(x, 0, 3, H); }
      for (let i = 0; i < 60; i++) {
        m.fillStyle = `rgba(120,60,30,${0.15 + rnd(i, 3, 19) * 0.25})`;
        m.fillRect(rnd(i, 4, 20) * W, rnd(i, 5, 21) * H, 4 + rnd(i, 6, 22) * 10, 30 + rnd(i, 7, 23) * 120);
      }
      for (let c = 0; c < 8; c++) {
        if (rnd(c, 8, 24) > 0.5) { m.fillStyle = '#3a3f46'; m.fillRect(c * col + 8, H - row * 2.4, col - 16, row * 2.4); }
        if (rnd(c, 9, 25) > 0.6) {
          const y = H - row * (3.5 + Math.floor(rnd(c, 10, 26) * 3));
          m.fillStyle = '#1b1f27';
          m.fillRect(c * col + 14, y, col - 28, row * 0.6);
          l.fillStyle = pick(warm, rnd(c, 11, 27));
          l.globalAlpha = 0.8;
          l.fillRect(c * col + 14, y, col - 28, row * 0.6);
          l.globalAlpha = 1;
        }
      }
      // Sodium floodlights under the eaves.
      for (let c = 0; c < 8; c += 2) { l.fillStyle = '#ffb347'; l.fillRect(c * col + col / 2 - 6, H - row * 3, 12, 6); }
    }, 1.2),
    // Stacks: small apartments packed tight, mostly lit, in every colour people paint a room.
    make((m, l) => {
      m.fillStyle = '#7d7468';
      m.fillRect(0, 0, W, H);
      for (let f = 0; f < 16; f++) {
        const y = H - (f + 1) * row;
        m.fillStyle = 'rgba(0,0,0,0.35)';
        m.fillRect(0, y + row - 5, W, 5);
        for (let c = 0; c < 24; c++) {
          const x = c * (col / 3);
          m.fillStyle = '#1d1b1f';
          m.fillRect(x + 4, y + 9, col / 3 - 8, row - 20);
          const k = rnd(c, f, 14);
          if (k > 0.35) {
            l.fillStyle = k > 0.88 ? pick(['#ff5ab4', '#38e8ff', '#7dff9a', '#ff8a3d'], rnd(c, f, 15)) : pick(warm, rnd(c, f, 16));
            l.globalAlpha = 0.35 + rnd(c, f, 17) * 0.55;
            l.fillRect(x + 4, y + 9, col / 3 - 8, row - 20);
            l.globalAlpha = 1;
          }
          // Air conditioners under some of the windows.
          if (rnd(c, f, 18) > 0.7) { m.fillStyle = '#9a9a9a'; m.fillRect(x + 6, y + row - 14, col / 3 - 14, 7); }
        }
      }
    }, 1.0),
  ];
}

export function signTexture(word: string, color: string, vertical: boolean): THREE.CanvasTexture {
  const [c, g] = vertical ? canvas(96, 384) : canvas(384, 128);
  g.fillStyle = 'rgba(5,6,10,0.85)';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.strokeRect(5, 5, c.width - 10, c.height - 10);
  g.fillStyle = color;
  g.shadowColor = color;
  g.shadowBlur = 12;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (vertical) {
    g.font = '800 54px "Barlow Condensed", "Arial Narrow", sans-serif';
    const letters = word.replace(/\s/g, '').slice(0, 6).split('');
    letters.forEach((ch, i) => g.fillText(ch, c.width / 2, 40 + i * ((c.height - 70) / Math.max(1, letters.length - 1 || 1))));
  } else {
    g.font = '800 82px "Barlow Condensed", "Arial Narrow", sans-serif';
    g.fillText(word, c.width / 2, c.height / 2 + 4, c.width - 30);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function ribTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  for (let x = 0; x < 64; x += 8) { g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(x, 0, 3, 64); }
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.fillRect(0, 0, 64, 3);
  g.fillRect(0, 61, 64, 3);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function radialTexture(): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

