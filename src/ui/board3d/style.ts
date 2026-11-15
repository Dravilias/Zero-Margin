import * as THREE from 'three';
import type { ThemeId } from '../../engine/types';

/* Colours, sign words and what sets each district apart. The 2D board's palettes are the starting point. */

export const NEON = { pink: '#ff2e88', cyan: '#19e3ff', violet: '#a45cff', amber: '#ffb347', green: '#3dffa2', red: '#ff3b3b', white: '#dff6ff' };
export interface Pal { ground: string; walk: string; line: string; roofs: string[]; walls: string[]; neon: string[]; lamp: string; water: string; sky: string; fog: string }
export const PAL: Record<ThemeId, Pal> = {
  docks: { ground: '#1a2331', walk: '#2c3748', line: '#c9a94a', roofs: ['#39475a', '#434d5c', '#4c4038', '#2d4650'], walls: ['#222a36', '#2a2a30', '#1f2a31'], neon: [NEON.cyan, NEON.amber, NEON.pink, NEON.white], lamp: '#ffb878', water: '#04141d', sky: '#060a12', fog: '#0b1622' },
  market: { ground: '#231a29', walk: '#382b40', line: '#c98a4a', roofs: ['#463848', '#4f3b3e', '#3a3f58', '#533a32'], walls: ['#2a1d27', '#2d2025', '#221f31'], neon: [NEON.pink, NEON.amber, NEON.violet, NEON.red, NEON.cyan], lamp: '#ff9a6b', water: '#10091c', sky: '#0a0610', fog: '#1a0c1a' },
  plaza: { ground: '#172136', walk: '#26355a', line: '#7fa6ff', roofs: ['#2b3855', '#303f60', '#25314d', '#353c58'], walls: ['#18223a', '#1b2640', '#1e2236'], neon: [NEON.cyan, NEON.violet, NEON.white, NEON.pink], lamp: '#a8d8ff', water: '#071325', sky: '#050914', fog: '#0c1630' },
};
export const WORDS: Record<ThemeId, string[]> = {
  docks: ['DOCK 7', 'BERTH', 'SALVAGE', 'CARGO', 'TOLL', 'BAR', 'FUEL', 'SABLE'],
  market: ['SOBA', 'RAMEN', 'PAWN', 'CHROME', 'NOODLE', 'HOTEL', 'KREDYT', '24H', 'CLINIC', 'TATTOO'],
  plaza: ['MERIDIAN', 'ARC', 'HALDEN', 'ASSET', 'CREDIT', 'LOBBY', 'SECURE'],
};
export const OUTER = 7;

/** What sets each district apart, beyond its colours. */
export interface Style {
  /** Height range of buildings inside the board, and of the city around it. */
  inner: [number, number];
  outer: [number, number];
  /** How likely a building is to grow another tier, and how tall tiers get. */
  tierChance: number;
  tierHeight: number;
  facades: number[];
  /** Chance of a neon sign on a street-facing wall, inside the board and outside. */
  signs: [number, number];
  adverts: number;
  fog: [number, number];
  lampPower: number;
}
export const STYLE: Record<ThemeId, Style> = {
  // Low sheds and container yards along open water, cranes over the harbour, the city far behind.
  docks: { inner: [1.3, 2.6], outer: [1.6, 3.4], tierChance: 0.15, tierHeight: 3, facades: [3, 3, 3, 2, 0], signs: [0.1, 0.05], adverts: 3, fog: [32, 72], lampPower: 18 },
  // Packed apartment blocks, signs on every other wall, lights strung across the streets.
  market: { inner: [2.4, 4.2], outer: [5, 10], tierChance: 0.55, tierHeight: 5, facades: [4, 4, 4, 4, 0, 2], signs: [0.55, 0.35], adverts: 10, fog: [36, 80], lampPower: 12 },
  // Glass towers rising straight up, clean and cold, with holograms instead of shop signs.
  plaza: { inner: [2.8, 4.6], outer: [8, 15], tierChance: 0.85, tierHeight: 9, facades: [1, 1, 1, 2], signs: [0.12, 0.06], adverts: 18, fog: [44, 110], lampPower: 10 },
};

export function hash(x: number, y: number, k = 0): number {
  let h = (x * 374761393 + y * 668265263 + k * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
export const pick = <T,>(a: T[], r: number): T => a[Math.floor(r * a.length) % a.length];

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

/** A colour pushed above 1 so the glow pass picks it up. */
export const hot = (hex: string, k = 3): THREE.Color => new THREE.Color(hex).multiplyScalar(k);
