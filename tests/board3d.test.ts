import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/engine/game';
import { tileAt } from '../src/engine/map';
import { defaultRoster } from '../src/engine/data';
import type { GameState, ThemeId } from '../src/engine/types';
import { buildCity, cut, isCut, setClear } from '../src/ui/board3d/city';
import { classifyRenderer, wants3d } from '../src/ui/board3d/support';

/*
 * The 3D city is built from canvases. Under Node there is no canvas, so a stand-in that accepts every
 * drawing call and draws nothing is enough: these tests are about the geometry, not the pixels.
 */
function fakeCanvas(): unknown {
  const ctx: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === 'canvas' ? canvasObj : p === 'width' ? 10 : ctx),
    apply: () => ctx,
    set: () => true,
  });
  const canvasObj = { width: 0, height: 0, getContext: () => ctx, style: {} };
  return canvasObj;
}
(globalThis as any).document ??= { createElement: () => fakeCanvas() };

function game(theme: ThemeId, seed: number): GameState {
  return createGame({
    seed, scenario: 'terminals', ruleset: 'standard', mapSize: 'medium', theme, maxRounds: 8, points: 100,
    sides: (['union', 'meridian'] as const).map((faction, i) => ({ name: '', faction, team: i, control: 'ai' as const, aiLevel: 'normal' as const, roster: defaultRoster(faction, 100) })),
  });
}

/** The camera's view direction for one of the four turns, as the board places it. */
function view(turn: number): THREE.Vector3 {
  const a = Math.PI / 4 + (turn * Math.PI) / 2;
  const e = 0.95;
  return new THREE.Vector3(-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

/** How many squares would hide a figure standing on them, seen from the camera. */
function hiddenSquares(s: GameState, group: THREE.Object3D, dir: THREE.Vector3): number {
  const m = s.map;
  cut.view.value.copy(dir);
  cut.boardMin.value.set(0, 0);
  cut.boardMax.value.set(m.w, m.h);
  const ray = new THREE.Raycaster();
  let hidden = 0;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (tileAt(m, x, y) !== '.') continue;
      setClear([{ x, y }]);
      let blocked = false;
      for (const h of [0.25, 0.6, 0.95, 1.3]) {
        for (const [ox, oz] of [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) {
          const target = new THREE.Vector3(x + 0.5 + ox, h, y + 0.5 + oz);
          ray.set(target.clone().addScaledVector(dir, -120), dir);
          ray.far = 120 - 0.02;
          for (const hit of ray.intersectObject(group, true)) {
            if (hit.point.y < 0.03 || !(hit.object as THREE.Mesh).isMesh || hit.object.userData.cover) continue;
            if (isCut(hit.point)) continue;
            blocked = true;
            break;
          }
          if (blocked) break;
        }
        if (blocked) break;
      }
      if (blocked) hidden += 1;
    }
  }
  return hidden;
}

describe('3D board', () => {
  it('never lets a building, sign or lamp hide a figure, from any of the four camera angles', () => {
    for (const theme of ['docks', 'market', 'plaza'] as const) {
      for (const seed of [7, 1234]) {
        const s = game(theme, seed);
        const city = buildCity(s, false);
        city.group.updateMatrixWorld(true);
        for (let turn = 0; turn < 4; turn++) expect(hiddenSquares(s, city.group, view(turn)), `${theme} ${seed} turn ${turn}`).toBe(0);
        city.dispose();
      }
    }
  }, 120_000);

  it('would notice if the see-through cut stopped working', () => {
    const s = game('market', 7);
    const city = buildCity(s, false);
    city.group.updateMatrixWorld(true);
    const count = cut.clearCount;
    // Pretend no figure is standing anywhere: then plenty of squares are hidden.
    const stuck = { get value() { return 0; }, set value(_v: number) {} };
    (cut as any).clearCount = stuck;
    try {
      expect(hiddenSquares(s, city.group, view(0))).toBeGreaterThan(20);
    } finally {
      (cut as any).clearCount = count;
    }
    city.dispose();
  }, 60_000);

  it('builds a terminal screen for every terminal on the board', () => {
    const s = game('plaza', 3);
    const city = buildCity(s, false);
    for (const term of s.terminals) expect(city.screens.has(`${term.x},${term.y}`)).toBe(true);
    city.dispose();
  });

  it('keeps PCs without graphics acceleration on the flat board unless the player insists', () => {
    expect(classifyRenderer('ANGLE (AMD, AMD Radeon Graphics (radeonsi renoir ACO), OpenGL ES 3.2)')).toBe('hardware');
    expect(classifyRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)')).toBe('hardware');
    for (const sw of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 17.0.6, 256 bits)', 'Microsoft Basic Render Driver']) {
      expect(classifyRenderer(sw), sw).toBe('software');
    }
    expect(wants3d('auto', 'hardware')).toBe(true);
    expect(wants3d('auto', 'software')).toBe(false);
    expect(wants3d('3d', 'software')).toBe(true);
    expect(wants3d('3d', 'none')).toBe(false);
    expect(wants3d('2d', 'hardware')).toBe(false);
  });
});
