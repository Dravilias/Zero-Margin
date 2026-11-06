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
        if (m.event === 'leave') this.knownPeers.delete(m.peer.id);
        else this.knownPeers.set(m.peer.id, m.peer.name);
        this.handlers.onPeer?.(m.event, m.peer);
        break;
      case 'host': this.handlers.onHost?.(m.event); break;
      case 'msg': this.handlers.onMessage?.(m.from, m.data); break;
      case 'closed':
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
            this.peerId = m.peerId;
            this.peerToken = m.peerToken;
          }
          this.attempts = 0;
          this.handlers.onStatus?.('open');
          return;
        } catch (e) {
          if (e instanceof RelayError && (e.code === 'no-room' || e.code === 'room-full')) {
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
    this.code = m.code;
    this.peerId = m.peerId;
    this.peerToken = m.peerToken;
    this.handlers.onStatus?.('open');
    return { peerId: m.peerId, rejoined: m.rejoined };
  }

  send(to: string, data: unknown): void {
    this.raw({ op: 'send', to, data });
  }

  kick(peer: string): void {
    this.raw({ op: 'kick', peer });
  }

  close(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.raw({ op: this.role === 'host' ? 'close' : 'leave' });
    this.pending?.reject(new RelayError('unreachable'));
    this.pending = null;
    this.ws?.close();
    this.ws = null;
  }
}
