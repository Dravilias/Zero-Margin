import {
  applyCampaign, buildMission, freeLeft, missionResult, nodeOf, MAX_PLAYERS, type Arc, type CampaignAction, type CampaignState, type Player, type Txt,
} from '../engine/campaign';
import type { GameState } from '../engine/types';
import {
  debriefRequest, judgeRequest, outcomeRequest, parseJudgement, sceneRequest, usableNarration, writeArc, type GmLang, type LlmFailure, type LlmTransport, type RunnerContext,
} from './gm';
import { RelayClient, type PeerInfo, type RelayStatus } from './relayClient';
import { GuestSession, HostSession, LocalSession, reportSave, type CampaignPolicy, type GameSession, type GuestMsg, type HostMsg } from './sessions';

/* ---------- Saves: several campaigns can run side by side ---------- */

const INDEX_KEY = 'zm.campaigns.v1';
const slotKey = (id: string) => `zm.campaign.${id}`;
export const MAX_SAVES = 8;

export interface CampaignSave { camp: CampaignState; game: GameState | null; online: boolean }
export interface CampaignSaveInfo { id: string; crewName: string; mode: CampaignState['mode']; title: Txt | null; chapter: number; chapters: number; gigsDone: number; arcsDone: number; cash: number; online: boolean; savedAt: number }

export function listCampaignSaves(): CampaignSaveInfo[] {
  try {
    const list = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as CampaignSaveInfo[];
    return Array.isArray(list) ? list.sort((a, b) => b.savedAt - a.savedAt) : [];
  } catch {
    return [];
  }
}

export function loadCampaign(id: string): CampaignSave | null {
  try {
    const raw = localStorage.getItem(slotKey(id));
    if (!raw) return null;
    const data = JSON.parse(raw) as CampaignSave;
    if (data.camp?.v !== 1) return null;
    // Saves from before humanity and lasting injuries existed.
    for (const m of data.camp.crew) {
      m.humanity ??= 50;
      m.humanityMax ??= 50;
      m.injuries ??= [];
    }
    return data;
  } catch {
    return null;
  }
}

export function deleteCampaign(id: string): void {
  try {
    localStorage.removeItem(slotKey(id));
    localStorage.setItem(INDEX_KEY, JSON.stringify(listCampaignSaves().filter((x) => x.id !== id)));
  } catch { /* storage may be unavailable */ }
}

export function saveCampaign(camp: CampaignState, game: GameState | null, online: boolean): void {
  try {
    localStorage.setItem(slotKey(camp.id), JSON.stringify({ camp, game, online } satisfies CampaignSave));
    const info: CampaignSaveInfo = {
      id: camp.id, crewName: camp.crewName, mode: camp.mode, title: camp.arc?.title ?? null, chapter: nodeOf(camp)?.chapter ?? 0, chapters: camp.arc?.chapters ?? 0,
      gigsDone: camp.gigsDone, arcsDone: camp.arcsDone, cash: camp.cash, online, savedAt: Date.now(),
    };
    const rest = listCampaignSaves().filter((x) => x.id !== camp.id);
    localStorage.setItem(INDEX_KEY, JSON.stringify([info, ...rest]));
    reportSave(true);
  } catch {
    reportSave(false);
  }
}

/* ---------- What the campaign screens talk to, wherever the campaign is running ---------- */

export interface CampaignController {
  state: CampaignState;
  mySlot: number;
  isHost: boolean;
  online: boolean;
  code: string | null;
  status: RelayStatus;
  session: GameSession | null;
  hasLlm: boolean;
  onChange: (() => void) | null;
  /** A battle is starting and this player should be looking at it. */
  onMission: ((session: GameSession) => void) | null;
  onClosed: ((reason: string) => void) | null;
  onChat: ((from: string, text: string) => void) | null;
  onNotice: ((key: string, name?: string) => void) | null;
  dispatch(action: CampaignAction): void;
  chat(text: string): void;
  /** Goes back to the campaign after the battle screen closes. */
  leaveMission(): void;
  /** Host only: the next story for this crew. */
  startStory(make: () => Promise<Arc> | Arc): Promise<void>;
  dispose(): void;
}

export interface HostOptions {
  relay: RelayClient | null;
  name: string;
  llm: LlmTransport | null;
  lang: () => GmLang;
  resolve: (t: Txt) => string;
  /** A battle saved in the middle, to pick back up. */
  game?: GameState | null;
  /** Saving is skipped in tests and for a table nobody wants kept. */
  save?: (camp: CampaignState, game: GameState | null, online: boolean) => void;
}

export class CampaignHost implements CampaignController {
  mySlot = 0;
  isHost = true;
  online: boolean;
  code: string | null;
  status: RelayStatus = 'open';
  session: GameSession | null = null;
  onChange: CampaignController['onChange'] = null;
  onMission: CampaignController['onMission'] = null;
  onClosed: CampaignController['onClosed'] = null;
  onChat: CampaignController['onChat'] = null;
  onNotice: CampaignController['onNotice'] = null;
  /** The last reason a language model call failed, for the screen to mention. */
  lastLlmFailure: LlmFailure | null = null;
  private relay: RelayClient | null;
  private llm: LlmTransport | null;
  private names = new Map<string, string>();
  private asked = new Set<string>();
  private game: GameState | null;
  private disposed = false;

  constructor(public state: CampaignState, private o: HostOptions) {
    this.relay = o.relay;
    this.llm = o.llm;
    this.online = !!o.relay;
    this.code = o.relay?.code ?? null;
    this.game = o.game ?? null;
    this.attachHub();
    this.save();
  }

  get hasLlm(): boolean {
    return !!this.llm && this.state.llm;
  }

  /** Call once the screens are listening, so a mission in progress or a scene to narrate isn't missed. */
  begin(): void {
    if (this.state.phase === 'mission' && !this.session) this.startMission();
    this.react();
  }

  private save(): void {
    this.o.save?.(this.state, this.game, this.online);
  }

  private attachHub(): void {
    const relay = this.relay;
    if (!relay) return;
    relay.handlers.onMessage = (from, data) => this.onGuest(from, data as GuestMsg);
    relay.handlers.onPeer = (event, peer) => this.peerEvent(event, peer);
    relay.handlers.onStatus = (status) => {
      this.status = status;
      this.onChange?.();
    };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
    relay.handlers.onHost = undefined;
  }

  /* ---------- Applying actions ---------- */

  dispatch(action: CampaignAction): void {
    this.apply(action, 0);
  }

  private apply(action: CampaignAction, slot: number, from?: string): void {
    if (action.a === 'freeAsk') {
      void this.freeAsk(slot, action.text, action.actor);
      return;
    }
    const res = applyCampaign(this.state, action, slot);
    if (!res.ok) {
      if (from) this.relay?.send(from, { k: 'reject', error: res.error ?? 'illegal' } satisfies HostMsg);
      return;
    }
    this.commit(res.state);
  }

  private internal(action: CampaignAction): boolean {
    const res = applyCampaign(this.state, action, 0);
    if (res.ok) this.commit(res.state);
    return res.ok;
  }

  private commit(state: CampaignState): void {
    this.state = state;
    if (state.phase !== 'mission') this.game = null;
    this.save();
    this.broadcast();
    this.onChange?.();
    if (state.phase === 'mission' && !this.session) this.startMission();
    this.react();
  }

  private broadcast(): void {
    if (!this.relay) return;
    this.state.players.forEach((p, you) => {
      if (p.peer && p.connected) this.relay!.send(p.peer, { k: 'camp', state: this.state, you } satisfies HostMsg);
    });
  }

  chat(text: string): void {
    const clean = text.slice(0, 300);
    this.onChat?.(this.o.name, clean);
    this.relay?.send('all', { k: 'chat', from: this.o.name, text: clean } satisfies HostMsg);
  }

  /* ---------- Friends coming and going ---------- */

  private onGuest(from: string, m: GuestMsg): void {
    if (m.k === 'chat') {
      const name = this.names.get(from) ?? 'Player';
      const text = String(m.text).slice(0, 300);
      this.onChat?.(name, text);
      this.relay?.send('all', { k: 'chat', from: name, text } satisfies HostMsg);
    } else if (m.k === 'campAct') {
      const slot = this.state.players.findIndex((p) => p.peer === from);
      if (slot > 0 && m.action && typeof m.action === 'object') this.apply(m.action, slot, from);
    }
  }

  private peerEvent(event: 'join' | 'rejoin' | 'lost' | 'leave', peer: PeerInfo): void {
    this.names.set(peer.id, peer.name);
    const players: Player[] = this.state.players.map((p) => ({ ...p }));
    let slot = players.findIndex((p) => p.peer === peer.id);
    if (event === 'join' || event === 'rejoin') {
      if (slot < 0) {
        // Someone coming back, after a reload or when a saved campaign resumes, gets their own seat back by name.
        slot = players.findIndex((p, i) => i > 0 && !p.connected && p.name === peer.name);
        if (slot < 0) slot = players.findIndex((p, i) => i > 0 && !p.peer);
        if (slot < 0 && players.length < MAX_PLAYERS) slot = players.push({ name: peer.name, peer: peer.id, connected: true }) - 1;
      }
      if (slot < 0) {
        this.relay?.kick(peer.id);
        return;
      }
      players[slot] = { name: peer.name, peer: peer.id, connected: true };
      this.onNotice?.('net.playerBack', peer.name);
    } else if (slot >= 0) {
      players[slot] = { ...players[slot], connected: false, peer: event === 'leave' ? null : peer.id };
      if (!this.session) this.onNotice?.('net.playerLostCovered', peer.name);
    }
    this.internal({ a: 'setPlayers', players });
  }

  /* ---------- Battles ---------- */

  private ownerMap(): Record<string, string> {
    const m = this.state.mission;
    const owners: Record<string, string> = {};
    if (!m) return owners;
    m.squad.forEach((id, i) => {
      const c = this.state.crew.find((x) => x.id === id);
      const p = c ? this.state.players[c.owner] : null;
      owners[`s0u${i}`] = c && c.owner > 0 && p?.peer && p.connected ? p.peer : 'host';
    });
    return owners;
  }

  private startMission(): void {
    const game = this.game ?? buildMission(this.state);
    this.game = game;
    const gmIsMe = this.state.gmSlot === 0;
    const gmIsLocal = gmIsMe || (this.state.gmSlot !== null && !this.state.players[this.state.gmSlot]?.peer);
    const local = gmIsLocal ? [0, 1] : [0];
    const persist = (s: GameState) => {
      this.game = s;
      this.save();
    };
    const finished = (s: GameState) => this.finishMission(s);
    let session: LocalSession;
    if (this.relay) {
      const started: GameState = { ...game, owners: this.ownerMap() };
      const peerSides = new Map<string, number[]>();
      this.state.players.forEach((p, i) => {
        if (i > 0 && p.peer && p.connected) peerSides.set(p.peer, i === this.state.gmSlot ? [1] : [0]);
      });
      const policy: CampaignPolicy = {
        sidesFor: (peer) => (this.state.players.findIndex((p) => p.peer === peer.id) === this.state.gmSlot ? [1] : [0]),
        owners: () => this.ownerMap(),
        peerEvent: (event, peer) => this.peerEvent(event, peer),
      };
      session = new HostSession(started, local, this.relay, peerSides, this.o.name, new Map(this.names), { keepRelay: true, policy });
    } else {
      session = new LocalSession(game, local);
    }
    session.persist = persist;
    session.onOver = finished;
    this.session = session;
    this.onMission?.(session);
  }

  private finishMission(game: GameState): void {
    // The connection goes back to the campaign now; the battle screen stays up until this player closes it.
    this.session = null;
    this.attachHub();
    this.internal({ a: 'finishMission', result: missionResult(game) });
  }

  leaveMission(): void {
    this.onChange?.();
  }

  /* ---------- The language-model game master ---------- */

  private ctx(): RunnerContext {
    return { lang: this.o.lang(), state: this.state, resolve: this.o.resolve };
  }

  /** Looks for narration that's due. Written text stays on screen until, and unless, better text arrives. */
  private react(): void {
    if (!this.hasLlm || this.disposed) return;
    const s = this.state;
    const node = nodeOf(s);
    if (s.phase === 'scene' && node?.kind === 'scene' && !s.narration[node.id] && !this.asked.has(`${s.arc?.id}/${node.id}`)) {
      this.asked.add(`${s.arc?.id}/${node.id}`);
      void this.narrate(async () => {
        const reply = await this.llm!.generate(sceneRequest(this.ctx(), node));
        if (!reply.ok) {
          this.lastLlmFailure = reply.reason;
          return;
        }
        const text = usableNarration(reply.text);
        if (text) this.internal({ a: 'narrate', node: node.id, text });
      });
    } else if (s.phase === 'debrief' && s.debrief && !s.debrief.narration && !this.asked.has(`d${s.gigsDone}`)) {
      this.asked.add(`d${s.gigsDone}`);
      const d = s.debrief;
      void this.narrate(async () => {
        const reply = await this.llm!.generate(debriefRequest(this.ctx(), d));
        if (!reply.ok) {
          this.lastLlmFailure = reply.reason;
          return;
        }
        const text = usableNarration(reply.text, 900);
        if (text) this.internal({ a: 'narrateDebrief', text });
      });
    }
  }

  private async narrate(work: () => Promise<void>): Promise<void> {
    this.internal({ a: 'setBusy', busy: true });
    try {
      await work();
    } finally {
      if (!this.disposed) this.internal({ a: 'setBusy', busy: false });
    }
  }

  /** A player tried something the written choices don't cover. The model judges it, the engine rolls it. */
  private async freeAsk(slot: number, raw: string, actorId: number): Promise<void> {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const s = this.state;
    const actor = s.crew.find((m) => m.id === actorId && m.status !== 'dead');
    if (!this.hasLlm || s.busy || !text || !actor || freeLeft(s) <= 0 || (s.phase !== 'scene' && s.phase !== 'hub')) return;
    if (slot === s.gmSlot) return;
    const node = nodeOf(s);
    const situation = node?.kind === 'scene' ? (s.narration[node.id] ?? this.o.resolve(node.text)) : `Between jobs at the crew's base. Cash ${s.cash}.`;
    await this.narrate(async () => {
      const judged = await this.llm!.generate(judgeRequest(this.ctx(), text, { name: actor.name, role: actor.role }, situation));
      if (!judged.ok) this.lastLlmFailure = judged.reason;
      const j = parseJudgement(judged.ok ? judged.text : '{}');
      const res = applyCampaign(this.state, { a: 'freeRoll', text, actor: actor.id, stat: j.stat, tn: j.tn, from: this.state.players[slot]?.name ?? '' }, 0);
      if (!res.ok || !res.roll) return;
      this.commit(res.state);
      const r = res.roll;
      if (!judged.ok) return;
      const effect = r.cash ? `The crew comes out ${r.cash} credits ahead.` : r.threat ? 'Someone dangerous now knows the crew is coming, so the next fight is harder.' : r.rep ? 'It costs the crew some reputation.' : '';
      const told = await this.llm!.generate(outcomeRequest(this.ctx(), text, actor.name, r.ok, effect, situation));
      if (!told.ok) {
        this.lastLlmFailure = told.reason;
        return;
      }
      const said = usableNarration(told.text, 700);
      if (said) this.internal({ a: 'transcript', line: { kind: 'narration', text: said } });
    });
  }

  async startStory(make: () => Promise<Arc> | Arc): Promise<void> {
    this.internal({ a: 'setBusy', busy: true });
    try {
      const arc = await make();
      this.internal({ a: 'nextArc', arc });
    } finally {
      if (!this.disposed) this.internal({ a: 'setBusy', busy: false });
    }
  }

  /** Asks the writer model for this crew's next story. */
  async writeStory(id: string): Promise<{ arc: Arc } | { reason: LlmFailure }> {
    if (!this.llm) return { reason: 'nokey' };
    const s = this.state;
    return writeArc(this.llm, {
      lang: this.o.lang(), crewName: s.crewName, crew: s.crew.filter((m) => m.status !== 'dead').map((m) => ({ name: m.name, role: m.role })),
      chronicle: s.chronicle.map((c) => ({ title: this.o.resolve(c.title), ending: this.o.resolve(c.ending) })),
    }, id);
  }

  dispose(): void {
    this.disposed = true;
    this.session?.dispose();
    this.relay?.close();
  }
}

export class CampaignGuest implements CampaignController {
  isHost = false;
  online = true;
  code: string | null;
  status: RelayStatus = 'open';
  session: GameSession | null = null;
  hasLlm = false;
  state: CampaignState;
  mySlot: number;
  onChange: CampaignController['onChange'] = null;
  onMission: CampaignController['onMission'] = null;
  onClosed: CampaignController['onClosed'] = null;
  onChat: CampaignController['onChat'] = null;
  onNotice: CampaignController['onNotice'] = null;
  onRejected: ((error: string) => void) | null = null;

  constructor(private relay: RelayClient, first: Extract<HostMsg, { k: 'camp' }>) {
    this.state = first.state;
    this.mySlot = first.you;
    this.code = relay.code;
    this.hasLlm = first.state.llm;
    this.attachHub();
  }

  private attachHub(): void {
    const relay = this.relay;
    relay.handlers.onMessage = (_from, data) => this.onHostMsg(data as HostMsg);
    relay.handlers.onStatus = (status) => {
      this.status = status;
      this.onChange?.();
    };
    relay.handlers.onClosed = (reason) => this.onClosed?.(reason);
    relay.handlers.onHost = (event) => this.onNotice?.(event === 'lost' ? 'net.hostLost' : 'net.hostBack');
  }

  private onHostMsg(m: HostMsg): void {
    switch (m.k) {
      case 'camp':
        this.state = m.state;
        this.mySlot = m.you;
        this.hasLlm = m.state.llm;
        this.onChange?.();
        break;
      case 'start': {
        const session = new GuestSession(m.state, m.sides, this.relay, { onOther: (x) => this.onHostMsg(x) });
        this.session = session;
        this.onMission?.(session);
        break;
      }
      case 'chat':
        this.onChat?.(m.from, m.text);
        break;
      case 'notice':
        this.onNotice?.(m.key, m.name);
        break;
      case 'reject':
        this.onRejected?.(m.error);
        break;
      default:
        break;
    }
  }

  dispatch(action: CampaignAction): void {
    this.relay.send('host', { k: 'campAct', action } satisfies GuestMsg);
  }

  chat(text: string): void {
    this.relay.send('host', { k: 'chat', text } satisfies GuestMsg);
  }

  leaveMission(): void {
    this.session = null;
    this.attachHub();
    this.onChange?.();
  }

  async startStory(): Promise<void> { /* only the host starts stories */ }

  dispose(): void {
    this.session?.dispose();
    this.relay.close();
  }
}

