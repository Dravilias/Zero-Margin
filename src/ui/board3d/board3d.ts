import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FACTIONS } from '../../engine/data';
import type { GameState, Unit } from '../../engine/types';
import { sfx } from '../audio';
import { NO_HIGHLIGHTS, type Highlights } from '../board';
import type { BoardView } from '../boardView';
import { afterPaint, el, loadingBar } from '../dom';
import { t } from '../i18n';
import { settings, speedFactor } from '../settings';
import { buildCity, cut, radialTexture, setClear, type Built } from './city';
import { miniKey, miniature, type Look, type Mini } from './minis';
import { PAL, STYLE, hot } from './style';

/*
 * The 3D board. It shows the same game as the flat board and takes the same calls from the battle
 * screen. The city is built once per map; figures, highlights and effects change on top of it.
 * Flat things the player reads (health, odds, names, damage numbers) are drawn on a 2D layer above it.
 */

export type Quality = 'high' | 'low';

/** Camera angle above the ground, in radians, and its distance from the point it looks at. */
const ELEV = 0.95;
const CAM_DIST = 60;
/** Overlay pixels per square for highlights painted on the ground. */
const OS = 40;

interface Fx { start: number; dur: number; tick(k: number): void; done(): void }
interface Float { x: number; y: number; text: string; color: string; start: number; dur: number; big: boolean }

export class Board3D implements BoardView {
  onTileClick: ((x: number, y: number) => void) | null = null;
  onTileHover: ((x: number, y: number) => void) | null = null;
  onFail: (() => void) | null = null;

  private glCanvas: HTMLCanvasElement;
  private ui: HTMLCanvasElement;
  private uc: CanvasRenderingContext2D;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
  private composer: EffectComposer | null = null;
  private moon: THREE.DirectionalLight;
  private flash: THREE.PointLight;
  private lampLights: THREE.PointLight[] = [];
  private city: Built | null = null;
  private building = false;
  private state: GameState | null = null;
  private mapId = '';
  private minis = new Map<string, Mini>();
  private tokenPos = new Map<string, { x: number; y: number; facing: number }>();
  private lunge = new Map<string, { dx: number; dz: number; start: number; dur: number }>();
  private shake = new Map<string, number>();
  private hl: Highlights = NO_HIGHLIGHTS;
  private selected: string | null = null;
  private active: string | null = null;
  private spot: { unit?: string; tile?: [number, number] } = {};
  private hover: { x: number; y: number } | null = null;
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };
  private userCam = false;
  private azimuth = Math.PI / 4;
  private azimuthTarget = Math.PI / 4;
  private focus = new THREE.Vector3();
  private zoom = 1;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private fx: Fx[] = [];
  private floats: Float[] = [];
  private rain: { x: number; y: number; v: number; l: number }[] = [];
  private overlay: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture } | null = null;
  private overlayDirty = true;
  private overlayAt = 0;
  private smoke: { key: string; group: THREE.Group } = { key: '', group: new THREE.Group() };
  private smokeMat: THREE.SpriteMaterial;
  private core: THREE.Mesh;
  private pool: THREE.CanvasTexture;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private destroyed = false;
  private failed = false;
  private frameId = 0;
  private lastDraw = 0;
  private checked = false;
  private observer: ResizeObserver;
  private endDrag = () => { this.drag = null; };
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  constructor(private container: HTMLElement, private quality: Quality) {
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.className = 'board-gl';
    this.ui = document.createElement('canvas');
    // The top layer takes the mouse, and keeps the class the rest of the game knows the board by.
    this.ui.className = 'board-canvas';
    // Throws on a PC with no WebGL at all; the battle screen then uses the flat board.
    this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: quality === 'high', powerPreference: 'high-performance' });
    container.append(this.glCanvas, this.ui);
    this.uc = this.ui.getContext('2d')!;
    const r = this.renderer;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.shadowMap.enabled = quality === 'high';
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    if (quality === 'high') {
      this.composer = new EffectComposer(r);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.85, 0.55, 0.82));
      this.composer.addPass(new OutputPass());
    }
    this.scene.add(new THREE.HemisphereLight('#5a6f9f', '#160e0a', quality === 'high' ? 0.9 : 1.3));
    this.moon = new THREE.DirectionalLight('#8ea8ff', 0.9);
    this.moon.castShadow = quality === 'high';
    this.moon.shadow.mapSize.set(2048, 2048);
    this.moon.shadow.bias = -0.0008;
    this.moon.shadow.normalBias = 0.02;
    this.scene.add(this.moon, this.moon.target);
    // One light, always present, for muzzle flashes and blasts: adding and removing lights would make
    // every material recompile mid-fight.
    this.flash = new THREE.PointLight('#ffd9a0', 0, 6, 1.5);
    this.scene.add(this.flash);
    this.pool = radialTexture();
    this.smokeMat = new THREE.SpriteMaterial({ map: this.pool, color: new THREE.Color('#9aa0ac'), transparent: true, opacity: 0.55, depthWrite: false });
    this.scene.add(this.smoke.group);
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), new THREE.MeshBasicMaterial({ color: hot('#ffd86b', 2.6), toneMapped: false }));
    this.core.visible = false;
    this.scene.add(this.core);
    for (let i = 0; i < 140; i++) this.rain.push({ x: Math.random(), y: Math.random(), v: 0.5 + Math.random(), l: 8 + Math.random() * 16 });

    this.glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fail();
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.bindInput();
    window.addEventListener('keydown', this.keyHandler);
    this.frameId = requestAnimationFrame((n) => this.frame(n));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.frameId);
    this.observer.disconnect();
    window.removeEventListener('mouseup', this.endDrag);
    window.removeEventListener('keydown', this.keyHandler);
    this.onTileClick = null;
    this.onTileHover = null;
    this.onFail = null;
    this.city?.dispose();
    this.city = null;
    for (const m of this.minis.values()) m.dispose();
    this.minis.clear();
    this.overlay?.tex.dispose();
    (this.overlay?.mesh.geometry as THREE.BufferGeometry | undefined)?.dispose();
    (this.overlay?.mesh.material as THREE.Material | undefined)?.dispose();
    this.pool.dispose();
    this.smokeMat.dispose();
    this.core.geometry.dispose();
    (this.core.material as THREE.Material).dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    // Hands the graphics memory back at once instead of whenever the browser gets round to it.
    this.renderer.forceContextLoss();
    this.glCanvas.remove();
    this.ui.width = 0;
    this.ui.height = 0;
    this.ui.remove();
    this.state = null;
    this.fx = [];
    this.floats = [];
  }

  private fail(): void {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    console.error('The 3D board lost its graphics context');
    setTimeout(() => this.onFail?.(), 0);
  }

  /* ---------- Size, camera and input ---------- */

  private resize(): void {
    const r = this.container.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.dpr = this.quality === 'high' ? Math.min(2, window.devicePixelRatio || 1) : 1;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.composer?.setPixelRatio(this.dpr);
    this.composer?.setSize(this.w, this.h);
    const uiDpr = window.devicePixelRatio || 1;
    this.ui.width = Math.max(1, this.w * uiDpr);
    this.ui.height = Math.max(1, this.h * uiDpr);
    this.uc.setTransform(uiDpr, 0, 0, uiDpr, 0, 0);
    const size = 10;
    this.camera.left = (-size * this.w) / this.h;
    this.camera.right = (size * this.w) / this.h;
    this.camera.top = size;
    this.camera.bottom = -size;
    if (this.state && !this.userCam) this.fit();
    else this.placeCamera();
  }

  private placeCamera(): void {
    const f = this.focus;
    const a = this.azimuth;
    this.camera.position.set(f.x + Math.sin(a) * Math.cos(ELEV) * CAM_DIST, f.y + Math.sin(ELEV) * CAM_DIST, f.z + Math.cos(a) * Math.cos(ELEV) * CAM_DIST);
    this.camera.lookAt(f);
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this.camera.getWorldDirection(cut.view.value);
    if (this.state) {
      cut.boardMin.value.set(0, 0);
      cut.boardMax.value.set(this.state.map.w, this.state.map.h);
    }
    this.moon.position.set(f.x - 16, 40, f.z + 8);
    this.moon.target.position.copy(f);
    const sc = this.moon.shadow.camera;
    sc.left = -34;
    sc.right = 34;
    sc.top = 34;
    sc.bottom = -34;
    sc.near = 1;
    sc.far = 120;
    sc.updateProjectionMatrix();
  }

  /** Moves the view so the picture shifts by this many pixels. */
  private panPixels(dx: number, dy: number): void {
    const perPixel = (this.camera.right - this.camera.left) / this.zoom / this.w;
    const a = this.azimuth;
    const right = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
    const forward = new THREE.Vector3(-Math.sin(a), 0, -Math.cos(a));
    this.focus.addScaledVector(right, -dx * perPixel);
    this.focus.addScaledVector(forward, (dy * perPixel) / Math.sin(ELEV));
    this.placeCamera();
  }

  private toScreen(x: number, y: number, z: number): [number, number] {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return [((v.x + 1) / 2) * this.w, ((1 - v.y) / 2) * this.h];
  }

  /** Fits the board into the space the interface leaves free, the same as the flat board does. */
  private fit(): void {
    if (!this.state) return;
    const m = this.state.map;
    const i = this.insets;
    const availW = Math.max(120, this.w - i.left - i.right);
    const availH = Math.max(120, this.h - i.top - i.bottom);
    this.focus.set(m.w / 2, 0, m.h / 2);
    this.zoom = 1;
    this.placeCamera();
    const pts = [[0, 0], [m.w, 0], [0, m.h], [m.w, m.h]].flatMap(([x, z]) => [this.toScreen(x, 0, z), this.toScreen(x, 1.6, z)]);
    const spanX = Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]));
    const spanY = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
    this.zoom = Math.max(0.3, Math.min(availW / spanX, availH / spanY) * 0.97);
    this.placeCamera();
    const c = this.toScreen(m.w / 2, 0.5, m.h / 2);
    this.panPixels(i.left + availW / 2 - c[0], i.top + availH / 2 - c[1]);
  }

  private groundAt(px: number, py: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit);
  }

  private bindInput(): void {
    const c = this.ui;
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    c.addEventListener('mousemove', (e) => {
      const p = pos(e);
      if (this.drag) {
        const dx = p.x - this.drag.x;
        const dy = p.y - this.drag.y;
        if (dx || dy) {
          this.drag.moved = true;
          this.userCam = true;
        }
        this.drag.x = p.x;
        this.drag.y = p.y;
        this.panPixels(dx, dy);
        return;
      }
      const g = this.groundAt(p.x, p.y);
      const tile = g ? { x: Math.floor(g.x), y: Math.floor(g.z) } : { x: -1, y: -1 };
      if (!this.hover || this.hover.x !== tile.x || this.hover.y !== tile.y) {
        this.hover = tile;
        this.overlayDirty = true;
        this.onTileHover?.(tile.x, tile.y);
      }
    });
    c.addEventListener('mouseleave', () => {
      this.hover = null;
      this.overlayDirty = true;
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
      const g = this.groundAt(p.x, p.y);
      if (g) this.onTileClick?.(Math.floor(g.x), Math.floor(g.z));
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      // Zoom towards the point under the mouse.
      const before = this.groundAt(p.x, p.y);
      this.zoom = Math.max(0.3, Math.min(5, this.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      this.placeCamera();
      const after = this.groundAt(p.x, p.y);
      if (before && after) {
        this.focus.add(before.sub(after));
        this.placeCamera();
      }
      this.userCam = true;
    }, { passive: false });
    c.addEventListener('dblclick', (e) => {
      if (e.shiftKey) {
        this.userCam = false;
        this.fit();
      }
    });
  }

  private onKey(e: KeyboardEvent): void {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'q' || e.key === 'Q') this.azimuthTarget += Math.PI / 2;
    else if (e.key === 'e' || e.key === 'E') this.azimuthTarget -= Math.PI / 2;
  }

  /* ---------- State ---------- */

  setState(s: GameState): void {
    if (this.destroyed) return;
    this.state = s;
    if (s.map.id !== this.mapId) {
      this.mapId = s.map.id;
      this.buildMap();
      if (!this.userCam) this.fit();
    }
    this.syncMinis();
    this.syncTerminals();
    this.syncSmoke();
    this.overlayDirty = true;
  }

  /** The city can take a moment on a slow PC, so the loading panel goes up before it starts. */
  private buildMap(): void {
    const s = this.state!;
    this.building = true;
    if (this.city) {
      this.scene.remove(this.city.group);
      this.city.dispose();
      this.city = null;
    }
    for (const l of this.lampLights) this.scene.remove(l);
    this.lampLights = [];
    for (const m of this.minis.values()) {
      this.scene.remove(m.root);
      m.dispose();
    }
    this.minis.clear();
    this.makeOverlay();
    const panel = el('div.board-loading', {}, el('div', {}, t('game.loading'), loadingBar()));
    this.container.appendChild(panel);
    afterPaint(() => {
      if (this.destroyed || !this.state || this.state.map.id !== s.map.id) {
        panel.remove();
        return;
      }
      try {
        this.city = buildCity(this.state, this.quality === 'high');
      } catch (err) {
        console.error('Could not build the 3D city', err);
        panel.remove();
        this.fail();
        return;
      }
      this.scene.add(this.city.group);
      const p = PAL[s.map.theme];
      const st = STYLE[s.map.theme];
      this.scene.background = new THREE.Color(p.sky);
      this.scene.fog = new THREE.Fog(p.fog, st.fog[0] + CAM_DIST - 40, st.fog[1] + CAM_DIST - 40);
      // Only the lamps nearest the board get a real light; the rest rely on their painted pools.
      const m = s.map;
      const centre = new THREE.Vector3(m.w / 2, 0, m.h / 2);
      const count = this.quality === 'high' ? 10 : 4;
      for (const at of [...this.city.lamps].sort((a, b) => a.distanceTo(centre) - b.distanceTo(centre)).slice(0, count)) {
        const l = new THREE.PointLight(p.lamp, st.lampPower, 7, 1.4);
        l.position.copy(at);
        this.scene.add(l);
        this.lampLights.push(l);
      }
      this.building = false;
      this.syncMinis();
      this.syncTerminals();
      requestAnimationFrame(() => requestAnimationFrame(() => panel.remove()));
      setTimeout(() => panel.remove(), 1000);
    });
  }

  private syncMinis(): void {
    const s = this.state;
    if (!s || this.building) return;
    const shadows = this.quality === 'high';
    const present = new Set<string>();
    for (const u of s.units) {
      if (u.state === 'dead' || u.retreated) continue;
      present.add(u.id);
      let mini = this.minis.get(u.id);
      if (mini && mini.key !== miniKey(u)) {
        this.scene.remove(mini.root);
        mini.dispose();
        mini = undefined;
      }
      if (!mini) {
        mini = miniature(u, shadows);
        this.minis.set(u.id, mini);
        this.scene.add(mini.root);
      }
    }
    for (const [id, mini] of this.minis) {
      if (!present.has(id)) {
        this.scene.remove(mini.root);
        mini.dispose();
        this.minis.delete(id);
      }
    }
  }

  private syncTerminals(): void {
    const s = this.state;
    if (!s || !this.city) return;
    for (const term of s.terminals) {
      const mat = this.city.screens.get(`${term.x},${term.y}`);
      if (!mat) continue;
      const side = term.owner === null ? null : s.cfg.sides.find((x) => x.team === term.owner);
      mat.color.copy(side ? hot(FACTIONS[side.faction].color, 2.4) : hot('#9aa0ac', 1.4));
    }
  }

  private syncSmoke(): void {
    const s = this.state!;
    const key = s.smoke.map((m) => `${m.x},${m.y}`).join(';');
    if (key === this.smoke.key) return;
    this.smoke.key = key;
    this.smoke.group.clear();
    for (const m of s.smoke) {
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(this.smokeMat);
        sp.scale.set(1.5, 1.5, 1);
        sp.position.set(m.x + 0.5, 0.4 + i * 0.35, m.y + 0.5);
        sp.userData = { seed: i * 2.1 + m.x, x: m.x + 0.5, z: m.y + 0.5, y: 0.4 + i * 0.35 };
        this.smoke.group.add(sp);
      }
    }
  }

  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void {
    this.insets = insets;
    if (!this.userCam) this.fit();
  }

  setHighlights(h: Highlights): void {
    this.hl = h;
    this.overlayDirty = true;
  }

  setSpot(spot: { unit?: string; tile?: [number, number] }): void {
    this.spot = spot;
    this.overlayDirty = true;
  }

  setSelection(selected: string | null, active: string | null): void {
    this.selected = selected;
    this.active = active;
  }

  /* ---------- Highlights painted on the ground ---------- */

  private makeOverlay(): void {
    const m = this.state!.map;
    if (this.overlay) {
      this.scene.remove(this.overlay.mesh);
      this.overlay.tex.dispose();
      this.overlay.mesh.geometry.dispose();
      (this.overlay.mesh.material as THREE.Material).dispose();
    }
    const canvas = document.createElement('canvas');
    canvas.width = m.w * OS;
    canvas.height = m.h * OS;
    const ctx = canvas.getContext('2d')!;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(m.w, m.h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(m.w / 2, 0.025, m.h / 2);
    mesh.renderOrder = 2;
    this.scene.add(mesh);
    this.overlay = { mesh, canvas, ctx, tex };
    this.overlayDirty = true;
  }

  private paintOverlay(time: number): void {
    const o = this.overlay;
    const s = this.state;
    if (!o || !s) return;
    const c = o.ctx;
    const m = s.map;
    const hl = this.hl;
    const S = OS;
    c.clearRect(0, 0, o.canvas.width, o.canvas.height);
    const edge = (ax: number, ay: number, bx: number, by: number) => { c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); };
    if (hl.zone) {
      const pulse = 0.14 + Math.sin(time / 400) * 0.05;
      c.fillStyle = `${hl.zone.color}${Math.round(pulse * 255).toString(16).padStart(2, '0')}`;
      c.fillRect(hl.zone.x * S, hl.zone.y * S, hl.zone.w * S, hl.zone.h * S);
    }
    if (hl.move) {
      c.fillStyle = 'rgba(25,227,255,0.22)';
      c.strokeStyle = 'rgba(25,227,255,1)';
      c.lineWidth = 3;
      for (const k of hl.move) {
        const x = k % m.w;
        const y = Math.floor(k / m.w);
        c.fillRect(x * S + 1, y * S + 1, S - 2, S - 2);
        if (!hl.move.has(k - m.w)) edge(x * S, y * S, x * S + S, y * S);
        if (!hl.move.has(k + m.w)) edge(x * S, y * S + S, x * S + S, y * S + S);
        if (x === 0 || !hl.move.has(k - 1)) edge(x * S, y * S, x * S, y * S + S);
        if (x === m.w - 1 || !hl.move.has(k + 1)) edge(x * S + S, y * S, x * S + S, y * S + S);
      }
    }
    if (hl.tiles) {
      c.fillStyle = 'rgba(240,56,60,0.22)';
      for (const k of hl.tiles) c.fillRect((k % m.w) * S + 1, Math.floor(k / m.w) * S + 1, S - 2, S - 2);
    }
    const hv = this.hover;
    if (hv && hl.tiles && hl.tiles.has(hv.x + hv.y * m.w) && hl.radius >= 0) {
      const r = hl.radius;
      c.fillStyle = 'rgba(240,56,60,0.3)';
      c.strokeStyle = 'rgba(240,56,60,1)';
      c.lineWidth = 3;
      c.fillRect((hv.x - r) * S, (hv.y - r) * S, (r * 2 + 1) * S, (r * 2 + 1) * S);
      c.strokeRect((hv.x - r) * S, (hv.y - r) * S, (r * 2 + 1) * S, (r * 2 + 1) * S);
    }
    if (hl.path && hl.path.length > 1) {
      c.strokeStyle = '#eaffff';
      c.lineWidth = 5;
      c.setLineDash([12, 10]);
      c.lineDashOffset = -time / 30;
      c.beginPath();
      hl.path.forEach(([x, y], i) => (i ? c.lineTo((x + 0.5) * S, (y + 0.5) * S) : c.moveTo((x + 0.5) * S, (y + 0.5) * S)));
      c.stroke();
      c.setLineDash([]);
      const [lx, ly] = hl.path[hl.path.length - 1];
      c.fillStyle = '#eaffff';
      c.beginPath();
      c.arc((lx + 0.5) * S, (ly + 0.5) * S, 7, 0, Math.PI * 2);
      c.fill();
    } else if (hv && hl.move && hl.move.has(hv.x + hv.y * m.w)) {
      c.fillStyle = 'rgba(255,255,255,0.2)';
      c.fillRect(hv.x * S, hv.y * S, S, S);
    }
    // Terminals: corner brackets on the ground in the colour of whoever holds them.
    for (const term of s.terminals) {
      const side = term.owner === null ? null : s.cfg.sides.find((x) => x.team === term.owner);
      c.strokeStyle = side ? FACTIONS[side.faction].color : '#9aa0ac';
      c.lineWidth = 4;
      const x0 = term.x * S + 3;
      const y0 = term.y * S + 3;
      const x1 = x0 + S - 6;
      const y1 = y0 + S - 6;
      const l = 10;
      c.beginPath();
      c.moveTo(x0, y0 + l); c.lineTo(x0, y0); c.lineTo(x0 + l, y0);
      c.moveTo(x1 - l, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + l);
      c.moveTo(x1, y1 - l); c.lineTo(x1, y1); c.lineTo(x1 - l, y1);
      c.moveTo(x0 + l, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - l);
      c.stroke();
    }
    if (this.spot.tile) {
      c.fillStyle = 'rgba(240,56,60,0.38)';
      c.fillRect(this.spot.tile[0] * S + 1, this.spot.tile[1] * S + 1, S - 2, S - 2);
    }
    o.tex.needsUpdate = true;
  }

  /* ---------- Animations: each one resolves on a timer, never on animation frames ---------- */

  private run(dur: number, tick: (k: number) => void, done: () => void = () => {}): Promise<void> {
    const scaled = dur * speedFactor();
    this.fx.push({ start: performance.now(), dur: scaled, tick, done });
    return new Promise((res) => setTimeout(res, scaled));
  }

  private flashAt(x: number, y: number, z: number, color: string, power: number): void {
    this.flash.color.set(color);
    this.flash.position.set(x, y, z);
    this.flash.intensity = power;
  }

  async moveToken(id: string, path: [number, number][]): Promise<void> {
    if (path.length < 2) return;
    const per = 120 * speedFactor();
    const total = per * (path.length - 1);
    const start = performance.now();
    sfx.move();
    const pos = { x: path[0][0], y: path[0][1], facing: 0 };
    this.tokenPos.set(id, pos);
    await new Promise<void>((res) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / total);
        const f = k * (path.length - 1);
        const i = Math.min(path.length - 2, Math.floor(f));
        const local = f - i;
        pos.x = path[i][0] + (path[i + 1][0] - path[i][0]) * local;
        pos.y = path[i][1] + (path[i + 1][1] - path[i][1]) * local;
        pos.facing = Math.atan2(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
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

  private face(fromX: number, fromY: number, toX: number, toY: number): void {
    for (const [id, m] of this.minis) {
      const u = this.state?.units.find((v) => v.id === id);
      if (u && u.x === fromX && u.y === fromY) m.body.rotation.y = Math.atan2(toX - fromX, toY - fromY);
    }
  }

  shot(fromX: number, fromY: number, toX: number, toY: number, hit: boolean, heavy: boolean, color: string): Promise<void> {
    const from = new THREE.Vector3(fromX + 0.5, 0.55, fromY + 0.5);
    const to = new THREE.Vector3(toX + 0.5, 0.5, toY + 0.5);
    if (!hit) to.add(new THREE.Vector3((Math.random() - 0.5) * 1.3, Math.random() * 0.5, (Math.random() - 0.5) * 1.3));
    this.face(fromX, fromY, toX, toY);
    sfx.shot(heavy);
    if (hit) setTimeout(() => sfx.hit(), 90);
    const mat = new THREE.MeshBasicMaterial({ color: hot(color, 4), toneMapped: false, transparent: true });
    const geo = new THREE.CylinderGeometry(heavy ? 0.03 : 0.018, heavy ? 0.03 : 0.018, 1, 6);
    geo.rotateX(Math.PI / 2);
    const tracer = new THREE.Mesh(geo, mat);
    this.scene.add(tracer);
    const impact = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.pool, color: hot('#ffe2b0', 3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    impact.position.copy(to);
    impact.scale.setScalar(0.01);
    this.scene.add(impact);
    return this.run(heavy ? 320 : 240, (k) => {
      const head = Math.min(1, k * 2.2);
      const tail = Math.max(0, k * 2.2 - 0.6);
      const p0 = from.clone().lerp(to, tail);
      const p1 = from.clone().lerp(to, head);
      tracer.position.copy(p0).lerp(p1, 0.5);
      tracer.scale.set(1, 1, Math.max(0.01, p0.distanceTo(p1)));
      tracer.lookAt(p1);
      mat.opacity = 1 - k * 0.5;
      this.flashAt(from.x, from.y + 0.2, from.z, '#ffd9a0', (heavy ? 14 : 8) * Math.max(0, 1 - k * 3));
      if (hit && k > 0.42) {
        const ik = (k - 0.42) / 0.58;
        impact.scale.setScalar(0.2 + ik * 0.9);
        (impact.material as THREE.SpriteMaterial).opacity = 1 - ik;
      }
    }, () => {
      this.scene.remove(tracer, impact);
      geo.dispose();
      mat.dispose();
      (impact.material as THREE.Material).dispose();
      this.flash.intensity = 0;
    });
  }

  melee(fromId: string, fromX: number, fromY: number, toX: number, toY: number, hit: boolean): Promise<void> {
    sfx.melee();
    if (hit) setTimeout(() => sfx.hit(), 120);
    this.face(fromX, fromY, toX, toY);
    this.lunge.set(fromId, { dx: toX - fromX, dz: toY - fromY, start: performance.now(), dur: 280 * speedFactor() });
    return new Promise((res) => setTimeout(res, 280 * speedFactor()));
  }

  blast(x: number, y: number, radius: number, kind: 'frag' | 'smoke' | 'emp', fromX: number, fromY: number): Promise<void> {
    const a = new THREE.Vector3(fromX + 0.5, 0.6, fromY + 0.5);
    const b = new THREE.Vector3(x + 0.5, 0.15, y + 0.5);
    this.face(fromX, fromY, x, y);
    const grenade = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: '#d7d9de', metalness: 0.6, roughness: 0.4 }));
    this.scene.add(grenade);
    const flight = this.run(360, (k) => {
      grenade.position.copy(a).lerp(b, k);
      grenade.position.y += Math.sin(k * Math.PI) * 1.6;
    }, () => {
      this.scene.remove(grenade);
      grenade.geometry.dispose();
      (grenade.material as THREE.Material).dispose();
    });
    return flight.then(() => {
      if (kind === 'frag') sfx.blast();
      else if (kind === 'emp') sfx.hack();
      else sfx.move();
      const color = kind === 'frag' ? '#ff9d3c' : kind === 'emp' ? '#7fd6ff' : '#b8bcc6';
      const reach = radius + 0.5;
      const mat = new THREE.MeshBasicMaterial({ color: kind === 'smoke' ? new THREE.Color(color) : hot(color, 3), transparent: true, depthWrite: false, toneMapped: false, blending: kind === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending });
      const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), mat);
      ball.position.copy(b);
      this.scene.add(ball);
      const ringMat = new THREE.MeshBasicMaterial({ color: hot(color, 2.5), transparent: true, toneMapped: false, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 4, 32), ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(b.x, 0.06, b.z);
      this.scene.add(ring);
      return this.run(kind === 'frag' ? 480 : 400, (k) => {
        const r = reach * (0.3 + k * 0.8);
        ball.scale.set(r, r * 0.7, r);
        mat.opacity = (kind === 'smoke' ? 0.55 : 0.8) * (1 - k);
        ring.scale.setScalar(reach * k);
        ringMat.opacity = 1 - k;
        if (kind !== 'smoke') this.flashAt(b.x, 0.8, b.z, color, 26 * (1 - k));
      }, () => {
        this.scene.remove(ball, ring);
        ball.geometry.dispose();
        ring.geometry.dispose();
        mat.dispose();
        ringMat.dispose();
        this.flash.intensity = 0;
      });
    });
  }

  arc(fromX: number, fromY: number, toX: number, toY: number, color: string): Promise<void> {
    const a = new THREE.Vector3(fromX + 0.5, 0.75, fromY + 0.5);
    const b = new THREE.Vector3(toX + 0.5, 0.6, toY + 0.5);
    sfx.hack();
    const n = 14;
    const geo = new THREE.BufferGeometry().setFromPoints(Array.from({ length: n + 1 }, () => new THREE.Vector3()));
    const mat = new THREE.LineBasicMaterial({ color: hot(color, 3.5), transparent: true, toneMapped: false });
    const line = new THREE.Line(geo, mat);
    this.scene.add(line);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    return this.run(440, (k) => {
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        const p = a.clone().lerp(b, f);
        const j = i === 0 || i === n ? 0 : 0.18;
        p.x += (Math.random() - 0.5) * j;
        p.y += (Math.random() - 0.5) * j + Math.sin(f * Math.PI) * 0.6;
        p.z += (Math.random() - 0.5) * j;
        pos.setXYZ(i, p.x, p.y, p.z);
      }
      pos.needsUpdate = true;
      mat.opacity = 1 - k * 0.7;
    }, () => {
      this.scene.remove(line);
      geo.dispose();
      mat.dispose();
    });
  }

  float(x: number, y: number, text: string, color: string, big = false): void {
    const jitter = ((this.floats.length % 3) - 1) * 0.25;
    this.floats.push({ x: x + 0.5 + jitter, y: y + 0.5, text, color, start: performance.now(), dur: 1250 * speedFactor(), big });
  }

  hitShake(id: string): void {
    this.shake.set(id, performance.now());
  }

  /* ---------- Each frame ---------- */

  private frame(time: number): void {
    if (this.destroyed) return;
    this.frameId = requestAnimationFrame((n) => this.frame(n));
    if (this.failed) return;
    const animating = this.fx.length > 0 || this.floats.length > 0 || this.tokenPos.size > 0 || this.shake.size > 0 || this.lunge.size > 0 || Math.abs(this.azimuthTarget - this.azimuth) > 0.001;
    // A still board only needs a lower frame rate for its rain and signs.
    if (!animating && time - this.lastDraw < 33) return;
    this.lastDraw = time;
    if (Math.abs(this.azimuthTarget - this.azimuth) > 0.001) {
      this.azimuth += (this.azimuthTarget - this.azimuth) * 0.15;
      if (Math.abs(this.azimuthTarget - this.azimuth) <= 0.001) this.azimuth = this.azimuthTarget;
      this.placeCamera();
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      const k = Math.min(1, (time - f.start) / f.dur);
      if (k >= 0) f.tick(k);
      if (k >= 1) {
        this.fx.splice(i, 1);
        f.done();
      }
    }
    this.placeFigures(time);
    if (this.city) {
      for (const f of this.city.flicker) {
        const v = Math.sin(time / 90 + f.seed) * Math.sin(time / 370 + f.seed * 2);
        f.mat.color.copy(f.base).multiplyScalar(v > 0.93 ? 0.25 : 1);
      }
      const on = Math.floor(time / 700) % 2 === 0;
      for (const b of this.city.blink) b.color.setRGB(on ? 4 : 0.3, 0, 0);
    }
    for (const sp of this.smoke.group.children) {
      const d = sp.userData as { seed: number; x: number; z: number; y: number };
      const a = time / 2200 + d.seed;
      sp.position.set(d.x + Math.cos(a) * 0.18, d.y + Math.sin(a * 0.7) * 0.08, d.z + Math.sin(a * 1.2) * 0.18);
    }
    if (this.overlayDirty || ((this.hl.zone || this.hl.path) && time - this.overlayAt > 50)) {
      this.overlayDirty = false;
      this.overlayAt = time;
      this.paintOverlay(time);
    }
    try {
      if (this.composer) this.composer.render();
      else this.renderer.render(this.scene, this.camera);
    } catch (err) {
      console.error('The 3D board failed to draw', err);
      this.fail();
      return;
    }
    if (!this.checked && this.city) this.checkDrawn();
    this.drawUi(time);
  }

  /** Records once that the board really drew something, for the desktop app's self-check. */
  private checkDrawn(): void {
    this.checked = true;
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    this.glCanvas.dataset.drawn = px[0] + px[1] + px[2] > 0 ? '1' : '0';
  }

  private lookOf(u: Unit): Look {
    if (u.state === 'down') return 'down';
    if (this.active === u.id) return 'active';
    if (this.selected === u.id) return 'selected';
    if (u.activated && this.state?.phase === 'battle') return 'spent';
    return 'ready';
  }

  private placeFigures(time: number): void {
    const s = this.state;
    if (!s) return;
    const clear: { x: number; y: number }[] = [];
    for (const u of s.units) {
      const mini = this.minis.get(u.id);
      if (!mini) continue;
      const moving = this.tokenPos.get(u.id);
      const x = moving ? moving.x : u.x;
      const y = moving ? moving.y : u.y;
      mini.root.position.set(x + 0.5, moving ? Math.abs(Math.sin(time / 60)) * 0.05 : 0, y + 0.5);
      if (moving) mini.body.rotation.y = moving.facing;
      mini.setLook(this.lookOf(u), time);
      const l = this.lunge.get(u.id);
      if (l) {
        const k = (time - l.start) / l.dur;
        if (k >= 1) this.lunge.delete(u.id);
        const reach = k >= 1 ? 0 : Math.sin(k * Math.PI) * 0.45;
        mini.root.position.x += l.dx * reach;
        mini.root.position.z += l.dz * reach;
      }
      const shook = this.shake.get(u.id);
      if (shook !== undefined) {
        const k = (time - shook) / 300;
        if (k >= 1) this.shake.delete(u.id);
        else mini.root.position.x += Math.sin(k * 40) * 0.08 * (1 - k);
      }
      clear.push({ x: mini.root.position.x - 0.5, y: mini.root.position.z - 0.5 });
    }
    if (this.hover) clear.push(this.hover);
    if (this.spot.tile) clear.push({ x: this.spot.tile[0], y: this.spot.tile[1] });
    setClear(clear);
    // The data core floats over its square, or over whoever carries it.
    const core = s.core;
    this.core.visible = !!core;
    if (core) {
      const carrier = core.carrier ? this.minis.get(core.carrier) : null;
      if (carrier) this.core.position.set(carrier.root.position.x, 1.75, carrier.root.position.z);
      else this.core.position.set(core.x + 0.5, 0.55 + Math.sin(time / 420) * 0.06, core.y + 0.5);
      this.core.rotation.y = time / 700;
    }
  }

  /* ---------- The flat layer on top ---------- */

  /** Screen pixels per square at the current zoom, for sizing what's drawn on top. */
  private tilePixels(): number {
    const a = this.toScreen(0, 0, 0);
    const b = this.toScreen(1, 0, 0);
    const c = this.toScreen(0, 0, 1);
    return Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.hypot(c[0] - a[0], c[1] - a[1]));
  }

  private headOf(id: string): [number, number] | null {
    const m = this.minis.get(id);
    if (!m) return null;
    const p = m.root.position;
    return this.toScreen(p.x, (m.isDrone ? 0.85 : 1.25) * m.root.scale.y, p.z);
  }

  private bracket(c: CanvasRenderingContext2D, cx: number, cy: number, half: number, len: number): void {
    c.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      c.moveTo(cx + sx * half, cy + sy * (half - len));
      c.lineTo(cx + sx * half, cy + sy * half);
      c.lineTo(cx + sx * (half - len), cy + sy * half);
    }
  }

  private chip(c: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
    c.font = '900 20px "Big Shoulders Display", sans-serif';
    const w = c.measureText(text).width + 12;
    c.fillStyle = color;
    c.fillRect(x - w / 2, y - 11, w, 22);
    c.fillStyle = '#05070c';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(text, x, y + 1);
  }

  private drawUi(time: number): void {
    const c = this.uc;
    c.clearRect(0, 0, this.w, this.h);
    const s = this.state;
    if (!s || !this.city) return;
    const tile = this.tilePixels();
    for (const u of s.units) {
      if (u.state !== 'ok') continue;
      const head = this.headOf(u.id);
      if (!head) continue;
      const [cx, cy] = head;
      const col = FACTIONS[u.faction].color;
      // Health: a segmented bar over the figure.
      const barW = Math.max(26, Math.min(56, tile * 0.75));
      const frac = Math.max(0, u.hp / u.hpMax);
      const segments = Math.max(3, Math.round(u.hpMax / 3));
      const gap = 1.5;
      const segW = (barW - gap * (segments - 1)) / segments;
      const barX = cx - barW / 2;
      const barY = cy - 4;
      c.fillStyle = 'rgba(3,5,10,0.9)';
      c.fillRect(barX - 2, barY - 2, barW + 4, 8);
      const barColor = frac > 0.5 ? '#3dffa2' : frac > 0.25 ? '#ffb347' : '#ff4d4d';
      const lit = Math.ceil(frac * segments);
      for (let i = 0; i < segments; i++) {
        c.fillStyle = i < lit ? barColor : 'rgba(255,255,255,0.14)';
        c.fillRect(barX + i * (segW + gap), barY, segW, 4);
      }
      const active = this.active === u.id;
      if (active && u.ap > 0) {
        for (let i = 0; i < u.ap; i++) {
          const dx = cx - (u.ap - 1) * 7 + i * 14;
          const dy = barY - 12;
          c.fillStyle = '#ffffff';
          c.beginPath();
          c.moveTo(dx, dy - 5); c.lineTo(dx + 5, dy); c.lineTo(dx, dy + 5); c.lineTo(dx - 5, dy);
          c.closePath();
          c.fill();
        }
      }
      const marks: { col: string; ch: string }[] = [];
      if (u.overwatch) marks.push({ col: '#ffb347', ch: 'O' });
      if (u.braced) marks.push({ col: '#19e3ff', ch: 'B' });
      if (u.pinned) marks.push({ col: '#ff4d4d', ch: '!' });
      if (u.glitch || u.seized) marks.push({ col: '#b583ff', ch: '#' });
      if (u.jammed) marks.push({ col: '#ff4d4d', ch: 'J' });
      if (u.injuries.includes('bleeding')) marks.push({ col: '#ff4d4d', ch: '+' });
      marks.forEach((m, i) => {
        const mx = barX + barW + 4 + i * 15;
        const my = barY - 6;
        c.fillStyle = m.col;
        c.fillRect(mx, my, 13, 13);
        c.fillStyle = '#05070c';
        c.font = '700 11px "IBM Plex Mono", monospace';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(m.ch, mx + 6.5, my + 7);
      });
      const hovered = this.hover && this.hover.x === u.x && this.hover.y === u.y;
      if (this.selected === u.id || active || hovered) {
        c.font = '800 16px "Big Shoulders Display", sans-serif';
        const label = u.name.toUpperCase();
        const w = c.measureText(label).width + 10;
        const ty = barY - (active && u.ap > 0 ? 32 : 18);
        c.fillStyle = col;
        c.fillRect(cx - w / 2, ty - 9, w, 18);
        c.fillStyle = '#05070c';
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(label, cx, ty + 1);
      }
    }
    // Targets: brackets round the figure and the chance to hit above it.
    for (const [id, info] of this.hl.targets) {
      const m = this.minis.get(id);
      if (!m) continue;
      const p = m.root.position;
      const [bx, by] = this.toScreen(p.x, 0.5, p.z);
      const u = s.units.find((v) => v.id === id);
      const hovered = u && this.hover && this.hover.x === u.x && this.hover.y === u.y;
      c.strokeStyle = info.color;
      c.lineWidth = hovered ? 4 : 3;
      c.shadowColor = info.color;
      c.shadowBlur = 10;
      this.bracket(c, bx, by, tile * 0.5 + (hovered ? Math.sin(time / 120) * 2 : 0), Math.max(8, tile * 0.18));
      c.stroke();
      c.shadowBlur = 0;
      const head = this.headOf(id);
      if (info.chance >= 0 && head) this.chip(c, head[0], head[1] - 30, `${Math.round(info.chance * 100)}%`, info.color);
    }
    for (const term of s.terminals) {
      const chance = this.hl.terminals.get(term.id);
      if (chance === undefined) continue;
      const [tx, ty] = this.toScreen(term.x + 0.5, 1.2, term.y + 0.5);
      this.chip(c, tx, ty, `${Math.round(chance * 100)}%`, '#b583ff');
    }
    // The tutorial's pointer.
    let spotAt: [number, number] | null = null;
    if (this.spot.unit) {
      const u = s.units.find((v) => v.id === this.spot.unit);
      if (u && u.state !== 'dead') spotAt = this.headOf(u.id);
    } else if (this.spot.tile) {
      spotAt = this.toScreen(this.spot.tile[0] + 0.5, 0.3, this.spot.tile[1] + 0.5);
    }
    if (spotAt) {
      const [sx, sy] = spotAt;
      const bob = Math.sin(time / 210) * 6;
      const tip = sy - 26 + bob;
      c.beginPath();
      c.moveTo(sx, tip);
      c.lineTo(sx - 17, tip - 22); c.lineTo(sx - 7, tip - 22); c.lineTo(sx - 7, tip - 40);
      c.lineTo(sx + 7, tip - 40); c.lineTo(sx + 7, tip - 22); c.lineTo(sx + 17, tip - 22);
      c.closePath();
      c.lineJoin = 'round';
      c.lineWidth = 6;
      c.strokeStyle = '#12020a';
      c.stroke();
      c.fillStyle = '#f0383c';
      c.fill();
    }
    this.floats = this.floats.filter((f) => {
      const k = (time - f.start) / f.dur;
      if (k >= 1) return false;
      if (k < 0) return true;
      const [fx, fy] = this.toScreen(f.x, 1.5 + k * 0.6, f.y);
      c.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      c.font = `900 ${f.big ? 32 : 24}px "Big Shoulders Display", sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(0,0,0,0.9)';
      c.strokeText(f.text, fx, fy);
      c.fillStyle = f.color;
      c.fillText(f.text, fx, fy);
      c.globalAlpha = 1;
      return true;
    });
    if (settings.rain) {
      c.strokeStyle = 'rgba(190,220,255,0.11)';
      c.lineWidth = 1;
      c.beginPath();
      for (const d of this.rain) {
        d.y += 0.012 * d.v;
        d.x -= 0.0016 * d.v;
        if (d.y > 1) { d.y = 0; d.x = Math.random() * 1.1; }
        if (d.x < 0) d.x += 1;
        c.moveTo(d.x * this.w, d.y * this.h);
        c.lineTo(d.x * this.w - d.l * 0.14, d.y * this.h + d.l);
      }
      c.stroke();
    }
  }
}
