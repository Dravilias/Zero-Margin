import { chooseAction } from '../engine/ai';
import { rosterCost } from '../engine/data';
import { applyAction, createGame, setSideControl } from '../engine/game';
import { Rand } from '../engine/rng';
import type { CampaignAction, CampaignState } from '../engine/campaign';
import type { DuelAction, DuelSide, DuelState } from '../engine/duel';
import type { Action, GameEvent, GameState } from '../engine/types';
import { RelayClient, type PeerInfo, type RelayStatus } from './relayClient';
import { newTable, startProblems, tableToConfig, type Seat, type Table } from './table';

/* ---------- Messages exchanged through the relay; the relay itself never reads them ---------- */

export const GAME_VERSION = 3;

export type HostMsg =
  | { k: 'camp'; state: CampaignState; you: number }
  | { k: 'duel'; state: DuelState; you: DuelSide }
  | { k: 'table'; table: Table; you: string }
  | { k: 'start'; state: GameState; sides: number[]; events: GameEvent[]; v: number }
  | { k: 'state'; state: GameState; events: GameEvent[]; sides: number[] }
  | { k: 'reject'; error: string }
  | { k: 'chat'; from: string; text: string }
  | { k: 'notice'; key: string; name: string };

export type GuestMsg =
  | { k: 'campAct'; action: CampaignAction }
  | { k: 'duelAct'; action: DuelAction }
  | { k: 'claim'; seat: number }
  | { k: 'seat'; patch: Partial<Pick<Seat, 'faction' | 'roster' | 'ready' | 'team'>> }
  | { k: 'action'; action: Action; side: number }
  | { k: 'chat'; text: string };

/* ---------- Game sessions: what the game screen talks to, wherever the rules are running ---------- */

export interface GameUpdate { events: GameEvent[]; state: GameState }

export interface GameSession {
  state: GameState;
  localSides: Set<number>;
  online: boolean;
  code: string | null;
  isHost: boolean;
  onUpdate: ((u: GameUpdate) => void) | null;
  onChat: ((from: string, text: string) => void) | null;
  onNotice: ((key: string, name?: string) => void) | null;
  onStatus: ((status: RelayStatus) => void) | null;
  onClosed: ((reason: string) => void) | null;
  submit(action: Action, side: number): void;
  chat(text: string): void;
  /** The interface calls this once its animations finish, which is when the computer may move. */
  idle(): void;
  /** Co-op: whether this player may command this unit. Always true outside a co-op campaign. */
  mayControl(unitId: string): boolean;
  dispose(): void;
}

const SAVE_KEY = 'zm.save.v2';

/* Saving must never interrupt a game, but a player has to hear when it stops working. */
let saveListener: ((ok: boolean) => void) | null = null;
export function setSaveListener(fn: ((ok: boolean) => void) | null): void {
  saveListener = fn;
}
export function reportSave(ok: boolean): void {
  saveListener?.(ok);
}

export interface SaveData { state: GameState; online: boolean; humanNames: string[]; savedAt: number }

export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    return data.state?.v === 1 ? data : null;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch { /* storage may be unavailable */ }
}

function writeSave(state: GameState, online: boolean): void {
  try {
    if (state.phase === 'over') {
      localStorage.removeItem(SAVE_KEY);
      return;
    }
    const data: SaveData = { state, online, humanNames: state.cfg.sides.map((s) => s.name), savedAt: Date.now() };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    reportSave(true);
  } catch {
    reportSave(false);
  }
}

const AI_DELAY_MS = 350;

/** Runs the rules on this machine. Also the base for hosting an online game. */
export class LocalSession implements GameSession {
  localSides: Set<number>;
  online = false;
  code: string | null = null;
  isHost = true;
  onUpdate: GameSession['onUpdate'] = null;
  onChat: GameSession['onChat'] = null;
  onNotice: GameSession['onNotice'] = null;
  onStatus: GameSession['onStatus'] = null;
  onClosed: GameSession['onClosed'] = null;
  protected aiRand: Rand;
  /** The tutorial turns this off so it can't overwrite a real saved game. */
  protected saves = true;
  /** A campaign saves its battles with itself, instead of in the skirmish slot. */
  persist: ((state: GameState) => void) | null = null;
  /** Runs once, after the last update of the battle has gone out. */
  onOver: ((state: GameState) => void) | null = null;
  private overSent = false;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  protected disposed = false;

  constructor(public state: GameState, localSides: number[]) {
    this.localSides = new Set(localSides);
    this.aiRand = new Rand((state.cfg.seed ^ 0x9e3779b9) >>> 0);
  }

  submit(action: Action, side: number): void {
    const res = applyAction(this.state, action, side);
    if (!res.ok) {
      this.rejected(res.error ?? 'illegal');
      return;
    }
    this.state = res.state;
    this.publish(res.events);
  }

  protected rejected(_error: string): void {}

  protected publish(events: GameEvent[]): void {
    if (this.persist) this.persist(this.state);
    else if (this.saves) writeSave(this.state, this.online);
    this.onUpdate?.({ events, state: this.state });
    if (this.state.phase === 'over' && this.onOver && !this.overSent) {
      this.overSent = true;
      void Promise.resolve().then(() => this.onOver?.(this.state));
    }
  }

  mayControl(unitId: string): boolean {
    const owner = this.state.owners?.[unitId];
    return owner === undefined || owner === 'host';
  }

  /** The computer's next move, or null if it should wait for now. */
  protected nextAiAction(side: number): Action | null {
    return chooseAction(this.state, side, this.state.cfg.sides[side].aiLevel, this.aiRand);
  }

  /** One PC: only a game master's narration uses this, and it just goes in the log. */
  chat(text: string): void {
    this.onChat?.('GM', text.slice(0, 300));
  }

  idle(): void {
    if (this.disposed || this.aiTimer || this.state.phase === 'over') return;
    const side = this.state.activeSide;
    if (this.state.cfg.sides[side].control !== 'ai') return;
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      if (this.disposed || this.state.phase === 'over' || this.state.activeSide !== side) return;
      const action = this.nextAiAction(side);
      if (!action) return;
      const res = applyAction(this.state, action, side);
      if (res.ok) {
        this.state = res.state;
        this.publish(res.events);
      } else {
        // The AI only proposes legal moves; if that ever fails, ending its activation keeps the game moving.
        const fallback = applyAction(this.state, this.state.activeUnit ? { type: 'end' } : { type: 'ready' }, side);
        if (fallback.ok) {
          this.state = fallback.state;
          this.publish(fallback.events);
        }
      }
    }, AI_DELAY_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.aiTimer) clearTimeout(this.aiTimer);
  }
}

const TAKEOVER_MS = 45000;

/** How a campaign's battle differs from a skirmish when players come and go. */
export interface CampaignPolicy {
  /** The sides this friend plays in this battle. */
  sidesFor(peer: PeerInfo): number[];
  /** Who controls each unit, given who's connected right now. */
  owners(): Record<string, string>;
  /** Called first for every coming and going, so the campaign knows about it too. */
  peerEvent(event: 'join' | 'rejoin' | 'lost' | 'leave', peer: PeerInfo): void;
}

const OWNED_ACTIONS_BY_UNIT = new Set<Action['type']>(['place', 'select']);

/** Runs the rules on the host's PC and tells the guests what happened. */
export class HostSession extends LocalSession {
  online = true;
  private takeover = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    state: GameState, localSides: number[], private relay: RelayClient,
    /** Which side each connected or expected friend plays. */
    private peerSides: Map<string, number[]>, private hostName: string,
    /** Friends' names, as already known from the table. */
    private names: Map<string, string> = new Map(),
    /** A campaign keeps the connection for the next job, and shares one side between players. */
    private campaign: { keepRelay: boolean; policy: CampaignPolicy } | null = null,
  ) {
    super(state, localSides);
    this.code = relay.code;
    relay.handlers.onMessage = (from, data) => this.onGuest(from, data as GuestMsg);
    relay.handlers.onPeer = (event, peer) => this.onPeer(event, peer);
    relay.handlers.onStatus = (status) => this.onStatus?.(status);
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
    relay.handlers.onHost = undefined;
    for (const [peer, sides] of peerSides) {
      relay.send(peer, { k: 'start', state, sides, events: [], v: GAME_VERSION } satisfies HostMsg);
    }
  }

  protected publish(events: GameEvent[]): void {
    super.publish(events);
    for (const [peer, sides] of this.peerSides) {
      this.relay.send(peer, { k: 'state', state: this.state, events, sides } satisfies HostMsg);
    }
  }

  chat(text: string): void {
    const clean = text.slice(0, 300);
    this.onChat?.(this.hostName, clean);
    this.relay.send('all', { k: 'chat', from: this.hostName, text: clean } satisfies HostMsg);
  }

  private onGuest(from: string, m: GuestMsg): void {
    if (m.k === 'chat') {
      const name = this.nameOfPeer(from);
      const text = String(m.text).slice(0, 300);
      this.onChat?.(name, text);
      this.relay.send('all', { k: 'chat', from: name, text } satisfies HostMsg);
      return;
    }
    if (m.k !== 'action') return;
    const sides = this.peerSides.get(from) ?? [];
    if (!sides.includes(m.side) || !this.ownerAllows(from, m.action, m.side)) {
      this.relay.send(from, { k: 'reject', error: 'notYourSide' } satisfies HostMsg);
      return;
    }
    const res = applyAction(this.state, m.action, m.side);
    if (!res.ok) {
      this.relay.send(from, { k: 'reject', error: res.error ?? 'illegal' } satisfies HostMsg);
      return;
    }
    this.state = res.state;
    this.publish(res.events);
  }

  /** On a shared side, each player only commands their own people. */
  private ownerAllows(from: string, action: Action, side: number): boolean {
    const owners = this.state.owners;
    if (!owners || side !== 0) return true;
    if (action.type === 'ready') return true;
    if (action.type === 'concede') return false;
    const id = OWNED_ACTIONS_BY_UNIT.has(action.type) ? (action as { unitId: string }).unitId : this.state.activeUnit;
    if (!id) return false;
    const owner = owners[id];
    return owner === undefined || owner === from;
  }

  private nameOfPeer(id: string): string {
    return this.names.get(id) ?? 'Player';
  }

  private notify(key: string, name: string): void {
    this.onNotice?.(key, name);
    this.relay.send('all', { k: 'notice', key, name } satisfies HostMsg);
  }

  private onPeer(event: 'join' | 'rejoin' | 'lost' | 'leave', peer: PeerInfo): void {
    this.names.set(peer.id, peer.name);
    const policy = this.campaign?.policy;
    policy?.peerEvent(event, peer);
    if (policy && (event === 'lost' || event === 'leave')) {
      // The host covers a missing friend's characters straight away; only a game master's side goes to the computer.
      this.state = { ...this.state, owners: policy.owners() };
      this.notify('net.playerLostCovered', peer.name);
      if (this.peerSides.get(peer.id)?.includes(1)) this.state = setSideControl(this.state, 1, 'ai');
      this.publish([]);
      this.idle();
      return;
    }
    if (policy) {
      const sides = policy.sidesFor(peer);
      this.peerSides.set(peer.id, sides);
      this.state = { ...this.state, owners: policy.owners() };
      if (sides.includes(1)) this.state = setSideControl(this.state, 1, 'human');
      this.notify('net.playerBack', peer.name);
      this.relay.send(peer.id, { k: 'start', state: this.state, sides, events: [], v: GAME_VERSION } satisfies HostMsg);
      this.publish([]);
      return;
    }
    if (event === 'lost' || event === 'leave') {
      this.notify('net.playerLost', peer.name);
      if (!this.takeover.has(peer.id) && this.peerSides.has(peer.id)) {
        // A dropped player gets time to reconnect; after that the computer covers their squad.
        this.takeover.set(peer.id, setTimeout(() => {
          this.takeover.delete(peer.id);
          for (const side of this.peerSides.get(peer.id) ?? []) this.state = setSideControl(this.state, side, 'ai');
          this.notify('net.aiCovers', peer.name);
          this.publish([]);
          this.idleAfterTakeover();
        }, TAKEOVER_MS));
      }
      return;
    }
    const timer = this.takeover.get(peer.id);
    if (timer) {
      clearTimeout(timer);
      this.takeover.delete(peer.id);
    }
    let sides = this.peerSides.get(peer.id);
    if (!sides) {
      // Someone new joined a running game: give them a squad nobody is playing, if there is one.
      const vacant = this.vacantSide();
      sides = vacant === null ? [] : [vacant];
      this.peerSides.set(peer.id, sides);
    }
    for (const side of sides) this.state = setSideControl(this.state, side, 'human');
    this.notify('net.playerBack', peer.name);
    this.relay.send(peer.id, { k: 'start', state: this.state, sides, events: [], v: GAME_VERSION } satisfies HostMsg);
    this.publish([]);
  }

  private idleAfterTakeover(): void {
    this.idle();
  }

  private vacantSide(): number | null {
    const taken = new Set<number>(this.localSides);
    for (const sides of this.peerSides.values()) sides.forEach((x) => taken.add(x));
    const n = this.state.cfg.sides.length;
    for (let i = 0; i < n; i++) if (!taken.has(i) && !this.state.conceded[i]) return i;
    return null;
  }

  dispose(): void {
    super.dispose();
    for (const t of this.takeover.values()) clearTimeout(t);
    if (!this.campaign?.keepRelay) this.relay.close();
  }
}

/** A friend's view of an online game. The rules run on the host. */
export class GuestSession implements GameSession {
  localSides: Set<number>;
  online = true;
  code: string | null;
  isHost = false;
  onUpdate: GameSession['onUpdate'] = null;
  onChat: GameSession['onChat'] = null;
  onNotice: GameSession['onNotice'] = null;
  onStatus: GameSession['onStatus'] = null;
  onClosed: GameSession['onClosed'] = null;
  onRejected: ((error: string) => void) | null = null;

  constructor(
    public state: GameState, sides: number[], private relay: RelayClient,
    /** A campaign keeps the connection afterwards and handles what isn't about this battle. */
    private campaign: { onOther(m: HostMsg): void } | null = null,
  ) {
    this.localSides = new Set(sides);
    this.code = relay.code;
    relay.handlers.onMessage = (_from, data) => this.onHostMsg(data as HostMsg);
    relay.handlers.onStatus = (status) => this.onStatus?.(status);
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
    relay.handlers.onHost = (event) => this.onNotice?.(event === 'lost' ? 'net.hostLost' : 'net.hostBack');
  }

  private onHostMsg(m: HostMsg): void {
    if (this.campaign && (m.k === 'camp' || (m.k === 'start' && this.state.phase === 'over'))) {
      this.campaign.onOther(m);
      return;
    }
    switch (m.k) {
      case 'state':
      case 'start':
        this.state = m.state;
        this.localSides = new Set(m.sides);
        this.onUpdate?.({ events: m.events, state: m.state });
        break;
      case 'chat': this.onChat?.(m.from, m.text); break;
      case 'notice': this.onNotice?.(m.key, m.name); break;
      case 'reject': this.onRejected?.(m.error); break;
      default: break;
    }
  }

  submit(action: Action, side: number): void {
    this.relay.send('host', { k: 'action', action, side } satisfies GuestMsg);
  }

  chat(text: string): void {
    this.relay.send('host', { k: 'chat', text } satisfies GuestMsg);
  }

  idle(): void {}

  mayControl(unitId: string): boolean {
    const owner = this.state.owners?.[unitId];
    return owner === undefined || owner === this.relay.peerId;
  }

  dispose(): void {
    if (!this.campaign) this.relay.close();
  }
}

/* ---------- Tables: the setup screen before a game starts ---------- */

export interface TableController {
  table: Table;
  /** Null for the host or a hot-seat table; a friend's relay id otherwise. */
  me: string | null;
  isHost: boolean;
  online: boolean;
  status: RelayStatus;
  onChange: (() => void) | null;
  onStart: ((session: GameSession) => void) | null;
  onClosed: ((reason: string) => void) | null;
  /** The code turned out to belong to a campaign instead of a skirmish table. */
  onCampaign?: ((relay: RelayClient, first: Extract<HostMsg, { k: 'camp' }>) => void) | null;
  onDuel?: ((relay: RelayClient, first: Extract<HostMsg, { k: 'duel' }>) => void) | null;
  /** Host only: change anything at the table. */
  update(mutate: (t: Table) => void): void;
  /** Change this player's own seat. */
  updateMine(patch: Partial<Pick<Seat, 'faction' | 'roster' | 'ready' | 'team'>>): void;
  claim(seat: number): void;
  start(): void;
  dispose(): void;
}

export class LocalTable implements TableController {
  me: string | null = null;
  isHost = true;
  online = false;
  status: RelayStatus = 'open';
  onChange: TableController['onChange'] = null;
  onStart: TableController['onStart'] = null;
  onClosed: TableController['onClosed'] = null;

  constructor(public table: Table) {}

  update(mutate: (t: Table) => void): void {
    mutate(this.table);
    this.onChange?.();
  }

  updateMine(): void {}
  claim(): void {}

  start(): void {
    if (startProblems(this.table).length) return;
    const { cfg, seatOfSide } = tableToConfig(this.table);
    const local = seatOfSide.flatMap((seat, side) => (this.table.seats[seat].kind === 'human' ? [side] : []));
    this.onStart?.(new LocalSession(createGame(cfg), local));
  }

  dispose(): void {}
}

export class HostTable implements TableController {
  me: string | null = null;
  isHost = true;
  online = true;
  status: RelayStatus = 'open';
  onChange: TableController['onChange'] = null;
  onStart: TableController['onStart'] = null;
  onClosed: TableController['onClosed'] = null;
  private handedOver = false;
  private peers = new Map<string, string>();

  constructor(public table: Table, private relay: RelayClient, private myName: string) {
    table.code = relay.code;
    relay.handlers.onPeer = (event, peer) => this.onPeer(event, peer);
    relay.handlers.onMessage = (from, data) => this.onGuest(from, data as GuestMsg);
    relay.handlers.onStatus = (status) => { this.status = status; this.onChange?.(); };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
  }

  private broadcast(): void {
    for (const id of this.peers.keys()) {
      this.relay.send(id, { k: 'table', table: this.table, you: id } satisfies HostMsg);
    }
    this.onChange?.();
  }

  private seatOf(peer: string): Seat | undefined {
    return this.table.seats.find((s) => s.peer === peer);
  }

  private onPeer(event: 'join' | 'rejoin' | 'lost' | 'leave', peer: PeerInfo): void {
    if (event === 'join' || event === 'rejoin') {
      this.peers.set(peer.id, peer.name);
      if (!this.seatOf(peer.id)) {
        const open = this.table.seats.find((s) => s.kind === 'open');
        if (open) this.seat(open, peer);
      }
    } else if (event === 'leave') {
      this.peers.delete(peer.id);
      const seat = this.seatOf(peer.id);
      if (seat) Object.assign(seat, { kind: 'open', peer: null, name: '', ready: false });
    }
    this.broadcast();
  }

  private seat(s: Seat, peer: PeerInfo): void {
    Object.assign(s, { kind: 'human', peer: peer.id, name: peer.name, ready: false });
  }

  private onGuest(from: string, m: GuestMsg): void {
    if (m.k === 'claim') {
      const target = this.table.seats[m.seat];
      if (!target || target.kind !== 'open') return;
      const mine = this.seatOf(from);
      if (mine) Object.assign(mine, { kind: 'open', peer: null, name: '', ready: false });
      this.seat(target, { id: from, name: this.peers.get(from) ?? 'Player' });
      this.broadcast();
    } else if (m.k === 'seat') {
      const seat = this.seatOf(from);
      if (!seat) return;
      if (m.patch.faction !== undefined) seat.faction = m.patch.faction;
      if (m.patch.team !== undefined) seat.team = Math.max(0, Math.min(3, Math.floor(m.patch.team)));
      if (m.patch.ready !== undefined) seat.ready = !!m.patch.ready;
      if (m.patch.roster !== undefined && Array.isArray(m.patch.roster) && m.patch.roster.length <= 12) seat.roster = m.patch.roster;
      this.broadcast();
    }
  }

  update(mutate: (t: Table) => void): void {
    mutate(this.table);
    this.broadcast();
  }

  updateMine(): void {}
  claim(): void {}

  start(): void {
    if (startProblems(this.table).length) return;
    for (const s of this.table.seats) {
      if (s.kind !== 'closed' && rosterCost(s.faction, s.roster) > this.table.settings.points) return;
    }
    const { cfg, seatOfSide } = tableToConfig(this.table);
    const local: number[] = [];
    const peerSides = new Map<string, number[]>();
    seatOfSide.forEach((seat, side) => {
      const s = this.table.seats[seat];
      if (s.kind !== 'human') return;
      if (s.peer) peerSides.set(s.peer, [...(peerSides.get(s.peer) ?? []), side]);
      else local.push(side);
    });
    this.handedOver = true;
    this.onStart?.(new HostSession(createGame(cfg), local, this.relay, peerSides, this.myName, new Map(this.peers)));
  }

  dispose(): void {
    if (!this.handedOver) this.relay.close();
  }
}

export class GuestTable implements TableController {
  me: string | null;
  isHost = false;
  online = true;
  status: RelayStatus = 'open';
  onChange: TableController['onChange'] = null;
  onStart: TableController['onStart'] = null;
  onClosed: TableController['onClosed'] = null;
  onCampaign: TableController['onCampaign'] = null;
  onDuel: TableController['onDuel'] = null;
  table: Table;
  private handedOver = false;

  constructor(private relay: RelayClient, code: string) {
    this.me = relay.peerId;
    this.table = { ...newTable('', true), code };
    relay.handlers.onMessage = (_from, data) => this.onHostMsg(data as HostMsg);
    relay.handlers.onStatus = (status) => { this.status = status; this.onChange?.(); };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
  }

  private onHostMsg(m: HostMsg): void {
    if (m.k === 'camp') {
      this.handedOver = true;
      this.onCampaign?.(this.relay, m);
    } else if (m.k === 'duel') {
      this.handedOver = true;
      this.onDuel?.(this.relay, m);
    } else if (m.k === 'table') {
      this.table = m.table;
      this.onChange?.();
    } else if (m.k === 'start') {
      if (m.v !== GAME_VERSION) {
        this.onClosed?.('version');
        return;
      }
      this.handedOver = true;
      this.onStart?.(new GuestSession(m.state, m.sides, this.relay));
    }
  }

  update(): void {}

  updateMine(patch: Partial<Pick<Seat, 'faction' | 'roster' | 'ready' | 'team'>>): void {
    this.relay.send('host', { k: 'seat', patch } satisfies GuestMsg);
  }

  claim(seat: number): void {
    this.relay.send('host', { k: 'claim', seat } satisfies GuestMsg);
  }

  start(): void {}

  dispose(): void {
    if (!this.handedOver) this.relay.close();
  }
}

/** Starts hosting again from an autosave. Friends join with the new code and take over the vacant squads. */
export async function resumeHosted(save: SaveData, relayUrl: string, myName: string): Promise<HostSession> {
  const relay = new RelayClient(relayUrl);
  await relay.create(myName);
  // The first human side is this player's; the rest wait for friends, with the computer covering them.
  let state = save.state;
  const humans = state.cfg.sides.flatMap((s, i) => (s.control === 'human' && !state.conceded[i] ? [i] : []));
  const mine = humans.length ? [humans[0]] : [];
  for (const side of humans.slice(1)) state = setSideControl(state, side, 'ai');
  return new HostSession(state, mine, relay, new Map(), myName);
}
