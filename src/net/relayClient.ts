export const RELAY_PROTOCOL = 1;

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
      this.pending = { resolve, reject, ops };
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
      case 'peer': this.handlers.onPeer?.(m.event, m.peer); break;
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
    this.handlers.onStatus?.('reconnecting');
    while (!this.stopped) {
      this.attempts += 1;
      await new Promise((res) => setTimeout(res, Math.min(10000, 500 * 2 ** Math.min(this.attempts, 5))));
      if (this.stopped) return;
      try {
        await this.open();
        if (this.role === 'host') {
          await this.request({ op: 'resume', code: this.code, hostToken: this.hostToken }, ['resumed']);
        } else {
          await this.request({ op: 'join', proto: RELAY_PROTOCOL, code: this.code, name: this.name, peerToken: this.peerToken }, ['joined']);
        }
        this.attempts = 0;
        this.handlers.onStatus?.('open');
        return;
      } catch (e) {
        if (e instanceof RelayError && e.code === 'no-room') {
          this.stopped = true;
          this.handlers.onClosed?.('gone');
          this.ws?.close();
          return;
        }
      }
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
    this.ws?.close();
    this.ws = null;
  }
}
