import { DirectLink, parseSignal, type DownReason, type LinkSignal } from './directLink';
import type { AttemptFactory, DirectAttempt } from './rtc';

export const RELAY_PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 10000;

export interface PeerInfo { id: string; name: string; connected?: boolean }

export type RelayStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RelayHandlers {
  onStatus?(status: RelayStatus): void;
  onPeer?(event: 'join' | 'rejoin' | 'lost' | 'leave', peer: PeerInfo): void;
  onHost?(event: 'lost' | 'back'): void;
  onMessage?(from: string, data: unknown): void;
  onClosed?(reason: string): void;
}

/** Set to let this player connect directly to the others at the table. Null keeps everything on the relay. */
export interface DirectConfig { factory: AttemptFactory }

interface PeerLink {
  n: number;
  attempt: DirectAttempt | null;
  link: DirectLink | null;
  /** Links tried with this player so far. */
  tries: number;
  /** The other side broke the rules of the link, so no more are made with it. */
  banned: boolean;
  lastHello: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_TRIES = 3;
const MAX_LINKS = 8;
const HELLO_GAP_MS = 5000;
const RETRY_MS = 20_000;
const ATTEMPT_MS = 30_000;
/** Signals that couldn't go out while the relay was away. */
const MAX_QUEUED_SIGNALS = 600;

interface Pending { resolve(v: any): void; reject(e: Error): void; ops: string[] }

export class RelayError extends Error {
  constructor(public code: string) { super(code); }
}

/** One player's connection to the relay. It reconnects by itself and restores its place in the room. */
export class RelayClient {
  private ws: WebSocket | null = null;
  private pending: Pending | null = null;
  private stopped = false;
  private attempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnecting = false;
  /** Friends this host has heard about, to compare with the relay's list after an outage. */
  private knownPeers = new Map<string, string>();
  role: 'host' | 'peer' | null = null;
  code: string | null = null;
  hostToken: string | null = null;
  peerId: string | null = null;
  peerToken: string | null = null;
  name = 'Player';
  handlers: RelayHandlers = {};
  /** What new connections use. The settings screen sets it; null means the relay carries everything. */
  static defaultDirect: DirectConfig | null = null;
  /** Called whenever a direct link opens or closes, for the status display. */
  static onLinks: (() => void) | null = null;
  /** Connections in use, so the status display can count their links. */
  private static live = new Set<RelayClient>();
  static directTotal(): number {
    let n = 0;
    for (const c of RelayClient.live) n += c.directCount();
    return n;
  }
  static online(): boolean {
    return RelayClient.live.size > 0;
  }
  direct: DirectConfig | null = RelayClient.defaultDirect;
  private links = new Map<string, PeerLink>();
  private queued: { to: string; sig: LinkSignal }[] = [];
  private nextN = Math.floor(Math.random() * 1e9);
  retryMs = RETRY_MS;
  attemptMs = ATTEMPT_MS;
  helloGapMs = HELLO_GAP_MS;

  constructor(public url: string) {}

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new RelayError('unreachable'));
        }
      }, 10000);
      ws.onopen = () => {
        settled = true;
        clearTimeout(timer);
        this.startPing();
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new RelayError('unreachable'));
        }
      };
      ws.onclose = () => {
        if (this.ws === ws) this.onDrop();
      };
      ws.onmessage = (e) => this.onMessage(String(e.data));
    });
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.raw({ op: 'ping', t: Date.now() }), 20000);
  }

  private raw(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private request(msg: unknown, ops: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      // A relay that accepts the connection but never answers mustn't hang the game forever.
      const timer = setTimeout(() => {
        if (this.pending?.resolve !== finish) return;
        this.pending = null;
        reject(new RelayError('unreachable'));
      }, REQUEST_TIMEOUT_MS);
      const finish = (v: unknown) => {
        clearTimeout(timer);
        resolve(v);
      };
      const fail = (e: Error) => {
        clearTimeout(timer);
        reject(e);
      };
      this.pending = { resolve: finish, reject: fail, ops };
      this.raw(msg);
    });
  }

  private onMessage(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (this.pending && (this.pending.ops.includes(m.op) || m.op === 'error')) {
      const p = this.pending;
      this.pending = null;
      if (m.op === 'error') p.reject(new RelayError(m.code));
      else p.resolve(m);
      return;
    }
    switch (m.op) {
      case 'peer':
        if (m.event === 'leave') {
          this.knownPeers.delete(m.peer.id);
          this.dropLink(String(m.peer.id));
        } else this.knownPeers.set(m.peer.id, m.peer.name);
        this.handlers.onPeer?.(m.event, m.peer);
        break;
      case 'host': this.handlers.onHost?.(m.event); break;
      case 'msg':
        if (m.data && typeof m.data === 'object' && '__link' in m.data) this.onSignal(String(m.from), m.data.__link);
        else this.handlers.onMessage?.(m.from, m.data);
        break;
      case 'closed':
        this.dropLinks();
        this.stopped = true;
        this.handlers.onClosed?.(m.reason);
        this.ws?.close();
        break;
      default: break;
    }
  }

  private async onDrop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pending?.reject(new RelayError('unreachable'));
    this.pending = null;
    if (this.stopped || !this.code) {
      this.handlers.onStatus?.('closed');
      return;
    }
    // A failed attempt's socket closes too; only one retry loop may ever run.
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.handlers.onStatus?.('reconnecting');
    try {
      while (!this.stopped) {
        this.attempts += 1;
        await new Promise((res) => setTimeout(res, Math.min(10000, 500 * 2 ** Math.min(this.attempts, 5))));
        if (this.stopped) return;
        try {
          await this.open();
          if (this.role === 'host') {
            const m = await this.request({ op: 'resume', code: this.code, hostToken: this.hostToken }, ['resumed']);
            this.catchUpOnPeers(m.peers ?? []);
          } else {
            const m = await this.request({ op: 'join', proto: RELAY_PROTOCOL, code: this.code, name: this.name, peerToken: this.peerToken }, ['joined']);
            // After a long outage the relay may have given this player a new identity.
            const renamed = this.peerId !== m.peerId;
            this.peerId = m.peerId;
            this.peerToken = m.peerToken;
            if (renamed) {
              // The host knew the old link by the old identity, so it can't be kept.
              this.dropLink('host');
              this.hello();
            }
          }
          this.attempts = 0;
          this.flushSignals();
          this.handlers.onStatus?.('open');
          return;
        } catch (e) {
          if (e instanceof RelayError && (e.code === 'no-room' || e.code === 'room-full')) {
            this.dropLinks();
            this.stopped = true;
            this.handlers.onClosed?.('gone');
            this.ws?.close();
            return;
          }
          // Drop a half-open socket before trying again.
          const old = this.ws;
          this.ws = null;
          old?.close();
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** Friends can come and go while the host is offline, and the relay can't tell the host until it returns. */
  private catchUpOnPeers(peers: PeerInfo[]): void {
    const present = new Map(peers.map((p) => [p.id, p]));
    for (const [id, name] of [...this.knownPeers]) {
      if (!present.has(id)) {
        this.knownPeers.delete(id);
        this.handlers.onPeer?.('leave', { id, name });
      }
    }
    for (const p of peers) {
      const known = this.knownPeers.has(p.id);
      this.knownPeers.set(p.id, p.name);
      if (p.connected === false) this.handlers.onPeer?.('lost', p);
      else if (!known) this.handlers.onPeer?.('join', p);
    }
  }

  async create(name: string): Promise<string> {
    this.name = name;
    await this.open();
    const m = await this.request({ op: 'create', proto: RELAY_PROTOCOL, name }, ['created']);
    this.role = 'host';
    RelayClient.live.add(this);
    this.code = m.code;
    this.hostToken = m.hostToken;
    this.handlers.onStatus?.('open');
    return m.code;
  }

  async join(code: string, name: string, peerToken?: string): Promise<{ peerId: string; rejoined: boolean }> {
    this.name = name;
    await this.open();
    const m = await this.request({ op: 'join', proto: RELAY_PROTOCOL, code, name, peerToken }, ['joined']);
    this.role = 'peer';
    RelayClient.live.add(this);
    this.code = m.code;
    this.peerId = m.peerId;
    this.peerToken = m.peerToken;
    this.handlers.onStatus?.('open');
    this.hello();
    return { peerId: m.peerId, rejoined: m.rejoined };
  }

  send(to: string, data: unknown): void {
    if (to === 'all' && this.role === 'host' && this.directCount() > 0) {
      // Some friends are on direct links, so "everyone" has to be sent one by one.
      for (const id of this.knownPeers.keys()) this.sendOne(id, data);
      return;
    }
    this.sendOne(to, data);
  }

  private sendOne(to: string, data: unknown): void {
    const link = this.links.get(to)?.link;
    if (link && link.send(data)) return;
    this.raw({ op: 'send', to, data });
  }

  /* ---------- Direct links ---------- */

  /** How many players this one is connected to directly. */
  directCount(): number {
    let n = 0;
    for (const e of this.links.values()) if (e.link?.isUp()) n += 1;
    return n;
  }

  isDirect(peer: string): boolean {
    return !!this.links.get(peer)?.link?.isUp();
  }

  private entry(peer: string): PeerLink {
    let e = this.links.get(peer);
    if (!e) {
      e = { n: -1, attempt: null, link: null, tries: 0, banned: false, lastHello: 0, timer: null };
      this.links.set(peer, e);
    }
    return e;
  }

  /** Sends a signal through the relay, or keeps it until the relay is back. */
  private signal(to: string, sig: LinkSignal): void {
    if (this.ws && this.ws.readyState === 1 && !this.queued.length) {
      this.raw({ op: 'send', to, data: { __link: sig } });
    } else if (this.queued.length < MAX_QUEUED_SIGNALS) {
      this.queued.push({ to, sig });
    }
  }

  private flushSignals(): void {
    const queued = this.queued;
    this.queued = [];
    for (const q of queued) this.raw({ op: 'send', to: q.to, data: { __link: q.sig } });
  }

  /** Starts a link with number n. It waits for its wire; signals about it can arrive from now on. */
  private newLink(peer: string, e: PeerLink, n: number): void {
    // Whatever came before is finished: it hands its unconfirmed messages to the relay and goes quiet.
    const old = e.link;
    const oldAttempt = e.attempt;
    e.link = null;
    e.attempt = null;
    const wasUp = !!old?.isUp();
    old?.fail('closed');
    oldAttempt?.abort();
    if (wasUp) RelayClient.onLinks?.();
    if (e.timer) clearTimeout(e.timer);
    e.n = n;
    e.tries += 1;
    const link = new DirectLink({
      n,
      relay: (sig) => this.signal(peer, sig),
      deliver: (data) => this.handlers.onMessage?.(peer, data),
      onDown: (reason) => this.linkDown(e, link, reason),
    });
    e.link = link;
    // An attempt that never opens is given up. The relay keeps carrying the game either way.
    e.timer = setTimeout(() => {
      e.timer = null;
      if (e.link === link && !link.isUp()) link.fail('closed');
    }, this.attemptMs);
  }

  /** A guest asks the host for a direct link. Nothing happens unless the host has them turned on too. */
  private hello(): void {
    if (!this.direct || this.role !== 'peer' || this.stopped) return;
    const e = this.entry('host');
    if (e.banned || e.tries >= MAX_TRIES || (e.link && !e.link.isDown())) return;
    const n = this.nextN++;
    this.newLink('host', e, n);
    this.signal('host', { t: 'hello', n });
  }

  private startAttempt(peer: string, e: PeerLink, role: 'host' | 'guest'): DirectAttempt | null {
    const link = e.link;
    if (!link || link.isDown() || !this.direct) return null;
    const mine = () => e.link === link && this.links.get(peer) === e;
    try {
      e.attempt = this.direct.factory(role, {
        send: (sig) => { if (mine() && !link.isDown()) this.signal(peer, { ...sig, n: link.n }); },
        open: (wire) => {
          if (!mine() || this.stopped) return wire.close();
          link.attach(wire);
          if (link.isUp()) RelayClient.onLinks?.();
        },
        text: (frame) => link.onWire(frame),
        closed: () => link.fail('closed'),
        failed: () => link.fail('closed'),
      });
    } catch {
      // No direct link, then. The relay carries the game as before.
      link.fail('closed');
      return null;
    }
    return e.attempt;
  }

  private linkDown(e: PeerLink, link: DirectLink, reason: DownReason): void {
    if (e.link !== link) return;
    const attempt = e.attempt;
    e.attempt = null;
    attempt?.abort();
    if (reason === 'protocol' || reason === 'flood') e.banned = true;
    if (link.everUp) RelayClient.onLinks?.();
    // A link that worked and then dropped is worth another go; the guest is the one who asks.
    if (this.role === 'peer' && link.everUp && !e.banned && !this.stopped) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = setTimeout(() => {
        e.timer = null;
        this.hello();
      }, this.retryMs);
    }
  }

  private onSignal(from: string, raw: unknown): void {
    const sig = parseSignal(raw);
    if (!sig) return;
    // The relay says who a message is from; a guest only ever hears from the host.
    const peer = this.role === 'host' ? from : 'host';
    if (this.role === 'host' && !this.knownPeers.has(peer)) return;
    if (sig.t === 'switch' || sig.t === 'down' || sig.t === 're') {
      this.links.get(peer)?.link?.onSignal(sig);
      return;
    }
    if (!this.direct || this.stopped) return;
    if (sig.t === 'hello') {
      if (this.role !== 'host') return;
      const e = this.entry(peer);
      const now = Date.now();
      if (e.banned || e.tries >= MAX_TRIES + 2 || now - e.lastHello < this.helloGapMs) return;
      const busy = !!e.link && !e.link.isDown();
      if (!busy && this.busyLinks() >= MAX_LINKS) return;
      e.lastHello = now;
      // The guest only asks when it has no link, so whatever this side still holds is stale.
      this.newLink(peer, e, sig.n);
      this.startAttempt(peer, e, 'host');
    } else if (sig.t === 'offer') {
      if (this.role !== 'peer') return;
      const e = this.links.get('host');
      if (!e || e.n !== sig.n || e.attempt || !e.link || e.link.isDown() || e.link.isUp()) return;
      this.startAttempt('host', e, 'guest')?.signal({ t: 'offer', sdp: sig.sdp });
    } else if (sig.t === 'answer') {
      if (this.role !== 'host') return;
      const e = this.links.get(peer);
      if (!e || e.n !== sig.n || !e.link || e.link.isDown()) return;
      e.attempt?.signal({ t: 'answer', sdp: sig.sdp });
    }
  }

  private busyLinks(): number {
    let n = 0;
    for (const e of this.links.values()) if (e.link && !e.link.isDown()) n += 1;
    return n;
  }

  private dropLink(peer: string): void {
    const e = this.links.get(peer);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    const wasUp = !!e.link?.isUp();
    this.links.delete(peer);
    e.link?.dispose();
    e.attempt?.abort();
    e.attempt = null;
    if (wasUp) RelayClient.onLinks?.();
  }

  private dropLinks(): void {
    for (const peer of [...this.links.keys()]) this.dropLink(peer);
    this.queued = [];
    RelayClient.live.delete(this);
  }

  kick(peer: string): void {
    this.dropLink(peer);
    this.raw({ op: 'kick', peer });
  }

  close(): void {
    this.dropLinks();
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.raw({ op: this.role === 'host' ? 'close' : 'leave' });
    this.pending?.reject(new RelayError('unreachable'));
    this.pending = null;
    this.ws?.close();
    this.ws = null;
  }
}
