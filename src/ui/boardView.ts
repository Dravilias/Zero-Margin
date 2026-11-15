import type { GameState } from '../engine/types';
import type { Highlights } from './board';

/** What the battle screen needs from a board. The flat board and the 3D board both provide it. */
export interface BoardView {
  onTileClick: ((x: number, y: number) => void) | null;
  onTileHover: ((x: number, y: number) => void) | null;
  /** Called if the board stops working, so the screen can put a different one in its place. */
  onFail: (() => void) | null;
  destroy(): void;
  setState(s: GameState): void;
  setInsets(insets: { left: number; right: number; top: number; bottom: number }): void;
  setHighlights(h: Highlights): void;
  setSpot(spot: { unit?: string; tile?: [number, number] }): void;
  setSelection(selected: string | null, active: string | null): void;
  moveToken(id: string, path: [number, number][]): Promise<void>;
  shot(fromX: number, fromY: number, toX: number, toY: number, hit: boolean, heavy: boolean, color: string): Promise<void>;
  melee(fromId: string, fromX: number, fromY: number, toX: number, toY: number, hit: boolean): Promise<void>;
  blast(x: number, y: number, radius: number, kind: 'frag' | 'smoke' | 'emp', fromX: number, fromY: number): Promise<void>;
  arc(fromX: number, fromY: number, toX: number, toY: number, color: string): Promise<void>;
  float(x: number, y: number, text: string, color: string, big?: boolean): void;
  hitShake(id: string): void;
}
