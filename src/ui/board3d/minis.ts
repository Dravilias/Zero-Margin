import * as THREE from 'three';
import { FACTIONS } from '../../engine/data';
import type { Unit } from '../../engine/types';
import { ROLE_PATHS, SYMBOL_PATHS, isStroked, pictureOf, symbolOf } from '../icons';
import { radialTexture } from './city';
import { canvas, hot } from './style';

/*
 * The figures on the board: a hex base in the faction's colour, a small figure (or a hovering drone),
 * and the role icon or the character's own picture floating above. Wherever a wall hides part of a
 * figure, its outline shows through in the faction's colour.
 */

export type Look = 'ready' | 'active' | 'selected' | 'spent' | 'down';

export interface Mini {
  id: string;
  /** What the figure was built from; a change rebuilds it. */
  key: string;
  root: THREE.Group;
  body: THREE.Group;
  isDrone: boolean;
  setLook(look: Look, t: number): void;
  dispose(): void;
}

export const miniKey = (u: Unit): string => `${u.faction}|${u.role}|${u.icon ?? ''}|${u.isDrone ? 1 : 0}`;

let pool: THREE.CanvasTexture | null = null;
/** One light-pool texture shared by every figure, never freed. */
function poolTexture(): THREE.CanvasTexture {
  pool ??= radialTexture();
  return pool;
}

const pictures = new Map<string, HTMLImageElement>();

function drawIcon(g: CanvasRenderingContext2D, u: Unit, img: HTMLImageElement | null): void {
  const col = FACTIONS[u.faction].color;
  g.clearRect(0, 0, 128, 128);
  g.save();
  g.translate(64, 64);
  g.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    g[i ? 'lineTo' : 'moveTo'](Math.cos(a) * 58, Math.sin(a) * 58);
  }
  g.closePath();
  g.fillStyle = '#07090f';
  g.fill();
  g.lineWidth = 7;
  g.strokeStyle = col;
  g.stroke();
  if (img) {
    g.beginPath();
    g.arc(0, 0, 44, 0, Math.PI * 2);
    g.clip();
    g.drawImage(img, -44, -44, 88, 88);
    g.restore();
    return;
  }
  g.translate(-36, -36);
  g.scale(3, 3);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.lineCap = 'round';
  const sym = symbolOf(u.icon);
  if (sym) {
    const p = new Path2D(SYMBOL_PATHS[sym].d);
    if (SYMBOL_PATHS[sym].stroke) g.stroke(p);
    else g.fill(p, 'evenodd');
  } else {
    const p = new Path2D(ROLE_PATHS[u.role]);
    if (isStroked(u.role)) {
      g.stroke(p);
      if (u.role === 'sapper') g.fill(p);
    } else {
      g.fill(p);
    }
  }
  g.restore();
}

function iconTexture(u: Unit): THREE.CanvasTexture {
  const [c, g] = canvas(128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const src = pictureOf(u.icon);
  let img = src ? pictures.get(src) ?? null : null;
  if (src && !img) {
    if (pictures.size > 64) pictures.clear();
    img = new Image();
    img.src = src;
    pictures.set(src, img);
  }
  const ready = img && img.complete && img.naturalWidth > 0 ? img : null;
  drawIcon(g, u, ready);
  if (img && !ready) {
    // The role icon shows until the picture has loaded.
    img.addEventListener('load', () => { drawIcon(g, u, img); tex.needsUpdate = true; }, { once: true });
  }
  return tex;
}

export function miniature(u: Unit, shadows: boolean): Mini {
  const col = FACTIONS[u.faction].color;
  const dark = FACTIONS[u.faction].dark;
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  const base = new THREE.Mesh(own(new THREE.CylinderGeometry(0.36, 0.38, 0.07, 6)), own(new THREE.MeshStandardMaterial({ color: '#0a0d14', roughness: 0.4, metalness: 0.6 })));
  base.position.y = 0.035;
  base.rotation.y = Math.PI / 6;
  base.castShadow = shadows;
  root.add(base);
  const ring = own(new THREE.MeshBasicMaterial({ color: hot(col, 2.2), toneMapped: false }));
  const rim = new THREE.Mesh(own(new THREE.TorusGeometry(0.37, 0.018, 4, 6)), ring);
  rim.rotation.x = Math.PI / 2;
  rim.rotation.z = Math.PI / 6;
  rim.position.y = 0.072;
  root.add(rim);
  const glowMat = own(new THREE.MeshBasicMaterial({ map: poolTexture(), color: new THREE.Color(col).multiplyScalar(0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const glow = new THREE.Mesh(own(new THREE.PlaneGeometry(1, 1)), glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.scale.set(1.5, 1.5, 1);
  glow.position.y = 0.015;
  root.add(glow);

  const suitColor = new THREE.Color(dark).lerp(new THREE.Color('#c8d0de'), 0.55);
  const suit = own(new THREE.MeshStandardMaterial({ color: suitColor.clone(), emissive: new THREE.Color(col).multiplyScalar(0.18), roughness: 0.45, metalness: 0.25 }));
  const visorMat = own(new THREE.MeshBasicMaterial({ color: hot(col, 3), toneMapped: false }));
  const parts: THREE.Mesh[] = [];
  if (u.isDrone) {
    const hull = new THREE.Mesh(own(new THREE.BoxGeometry(0.3, 0.08, 0.3)), suit);
    hull.position.y = 0.5;
    parts.push(hull);
    const rotorGeo = own(new THREE.CylinderGeometry(0.09, 0.09, 0.015, 12));
    for (const [x, z] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
      const r = new THREE.Mesh(rotorGeo, visorMat);
      r.position.set(x, 0.55, z);
      body.add(r);
    }
    const eye = new THREE.Mesh(own(new THREE.BoxGeometry(0.08, 0.04, 0.03)), visorMat);
    eye.position.set(0, 0.48, 0.16);
    body.add(eye);
  } else {
    const torso = new THREE.Mesh(own(new THREE.CapsuleGeometry(0.12, 0.22, 4, 10)), suit);
    torso.position.y = 0.36;
    const head = new THREE.Mesh(own(new THREE.SphereGeometry(0.085, 12, 10)), suit);
    head.position.y = 0.6;
    parts.push(torso, head);
    const visor = new THREE.Mesh(own(new THREE.BoxGeometry(0.13, 0.03, 0.06)), visorMat);
    visor.position.set(0, 0.61, 0.06);
    body.add(visor);
    if (u.ranged) {
      const long = u.ranged === 'sniper' || u.ranged === 'rifle';
      const gun = new THREE.Mesh(own(new THREE.BoxGeometry(0.05, 0.05, long ? 0.42 : 0.26)), own(new THREE.MeshStandardMaterial({ color: '#15181e', metalness: 0.8, roughness: 0.3 })));
      gun.position.set(0.13, 0.38, 0.1);
      body.add(gun);
    }
  }
  for (const p of parts) {
    p.castShadow = shadows;
    body.add(p);
  }
  // Seen through walls: wherever the figure is hidden, its shape shows in the faction's colour.
  const ghost = own(new THREE.MeshBasicMaterial({ color: hot(col, 1.4), transparent: true, opacity: 0.55, depthWrite: false, depthFunc: THREE.GreaterDepth, toneMapped: false }));
  for (const part of [...parts, base]) {
    const g = new THREE.Mesh(part.geometry, ghost);
    g.position.copy(part.position);
    g.rotation.copy(part.rotation);
    g.renderOrder = 5;
    (part === base ? root : body).add(g);
  }
  const tagMat = own(new THREE.SpriteMaterial({ map: own(iconTexture(u)), depthTest: false, transparent: true }));
  const tag = new THREE.Sprite(tagMat);
  tag.scale.set(0.34, 0.34, 1);
  tag.position.y = 1.0;
  tag.renderOrder = 10;
  root.add(tag);
  root.scale.setScalar(u.isDrone ? 1.05 : 1.3);
  root.position.set(u.x + 0.5, 0, u.y + 0.5);

  const ringColor = hot(col, 2.2);
  const spentSuit = suitColor.clone().lerp(new THREE.Color('#2a2e36'), 0.6);
  let last: Look | null = null;
  return {
    id: u.id,
    key: miniKey(u),
    root,
    body,
    isDrone: u.isDrone,
    setLook(look, t) {
      if (look === 'active') ring.color.copy(hot(col, 2.2 + Math.sin(t / 150) * 1.4));
      else if (look === 'selected') ring.color.copy(hot(col, 3.2));
      if (u.isDrone && look !== 'down') body.position.y = Math.sin(t / 300 + u.x) * 0.03;
      if (look === last) return;
      last = look;
      const down = look === 'down';
      const spent = look === 'spent';
      // Down: the figure lies on its side, greyed, with a red rim.
      body.rotation.x = down ? -Math.PI / 2 : 0;
      body.position.set(0, down ? 0.12 : 0, down ? 0.3 : 0);
      suit.color.copy(down ? new THREE.Color('#3a3d44') : spent ? spentSuit : suitColor);
      suit.emissive.copy(down || spent ? new THREE.Color(0, 0, 0) : new THREE.Color(col).multiplyScalar(0.18));
      if (look === 'ready') ring.color.copy(ringColor);
      if (spent) ring.color.set('#4a5060');
      if (down) ring.color.copy(hot('#ff3b3b', 1.2));
      glow.visible = !down;
      glowMat.opacity = spent ? 0.35 : 1;
      tag.visible = !down;
      tagMat.opacity = spent ? 0.55 : 1;
    },
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
