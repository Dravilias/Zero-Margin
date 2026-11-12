/*
 * A direct, peer-to-peer link between the host and one guest, used in place of the relay once it's open.
 *
 * This file is the part that has to be right whatever is at the other end, so it knows nothing about
 * WebRTC: it gets a wire that carries text, and it treats everything arriving on it as hostile.
 *
 *  - Every message is numbered and kept until the other side confirms it. If the wire dies, whatever
 *    wasn't confirmed goes through the relay instead, and numbers on both sides stop anything arriving
 *    twice or out of order. Nothing is lost when a link drops mid-game.
 *  - Any frame that breaks the format, the numbering, the size limit or the rate limit closes the link
 *    for good. The game then carries on through the relay as if the link had never existed.
 */

/** What a link needs from its transport. */
export interface Wire {
  send(text: string): void;
  close(): void;
  /** Characters queued but not yet sent. */
  buffered(): number;
}

/** Messages about a link that travel through the relay. */
export type LinkSignal =
  | { t: 'hello'; n: number }
  | { t: 'offer'; n: number; sdp: string }
  | { t: 'answer'; n: number; sdp: string }
  /** "Everything after this comes over the direct link." */
  | { t: 'switch'; n: number }
  /** "The direct link is gone; everything comes through the relay again." */
  | { t: 'down'; n: number }
  /** A message sent over the link that was never confirmed, sent again through the relay. */
  | { t: 're'; n: number; s: number; d: unknown };

export type DownReason = 'closed' | 'stalled' | 'protocol' | 'flood' | 'remote';

export interface LinkLimits {
  /** Characters per frame. Data channels handle 256 KB; this stays far below it. */
  chunk: number;
  /** Characters in one whole message, the same as the relay allows. */
  maxMessage: number;
  maxUnacked: number;
  maxUnackedChars: number;
  maxBuffered: number;
  /** Frames held while waiting for the other side's switch signal. */
  maxHeldChars: number;
  ackEvery: number;
  ackAfterMs: number;
  /** How long a message may wait for confirmation before the link counts as dead. */
  stallMs: number;
  framesPerWindow: number;
  windowMs: number;
}

export const LINK_LIMITS: LinkLimits = {
  chunk: 16_000,
  maxMessage: 512 * 1024,
  maxUnacked: 256,
  maxUnackedChars: 8 * 1024 * 1024,
  maxBuffered: 8 * 1024 * 1024,
  maxHeldChars: 2 * 1024 * 1024,
  ackEvery: 8,
  ackAfterMs: 400,
  stallMs: 12_000,
  framesPerWindow: 1500,
  windowMs: 2000,
};

export interface LinkOptions {
  n: number;
  /** Sends a signal to the other side through the relay. */
  relay(signal: LinkSignal): void;
  /** Hands a received message to the game. */
  deliver(data: unknown): void;
  onDown(reason: DownReason): void;
  limits?: Partial<LinkLimits>;
}

interface Unacked { s: number; text: string; at: number }

const FRAME = /^([MCE])(\d{1,12}):/;
const ACK = /^A(\d{1,12})$/;

/**
 * A link exists from the moment one is asked for, so signals about it always have somewhere to go.
 * It is "waiting" until its wire opens, "up" while it carries the game, and "down" for good after that.
 */
export class DirectLink {
  readonly n: number;
  private wire: Wire | null = null;
  private opts: LinkOptions;
  private lim: LinkLimits;
  private state: 'waiting' | 'up' | 'down' = 'waiting';
  /** Whether this link ever carried anything, which is what makes it worth trying again. */
  everUp = false;
  private outSeq = 0;
  private unacked: Unacked[] = [];
  private unackedChars = 0;
  private inSeq = 0;
  private sinceAck = 0;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  /** Until the other side says it has switched, its frames wait, so nothing overtakes what's still in the relay. */
  private gated = true;
  private held: string[] = [];
  private heldChars = 0;
  private partial: { s: number; parts: string[]; size: number } | null = null;
  private windowStart = Date.now();
  private windowFrames = 0;

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.n = opts.n;
    this.lim = { ...LINK_LIMITS, ...opts.limits };
  }

  /** The wire is open: from here on, this side sends over it. */
  attach(wire: Wire): void {
    if (this.state !== 'waiting') {
      try {
        wire.close();
      } catch { /* already gone */ }
      return;
    }
    this.wire = wire;
    this.state = 'up';
    this.everUp = true;
    this.opts.relay({ t: 'switch', n: this.n });
    this.stallTimer = setInterval(() => {
      if (this.unacked.length && Date.now() - this.unacked[0].at > this.lim.stallMs) this.fail('stalled');
    }, Math.max(20, Math.min(2000, this.lim.stallMs / 4)));
  }

  isUp(): boolean {
    return this.state === 'up';
  }

  isDown(): boolean {
    return this.state === 'down';
  }

  /** Sends a message over the link. False means the link is down and the relay has to carry it. */
  send(data: unknown): boolean {
    if (this.state !== 'up' || !this.wire) return false;
    const text = JSON.stringify(data);
    if (text === undefined) return true;
    // The relay refuses anything this large too, so there is nowhere to send it.
    if (text.length > this.lim.maxMessage) return true;
    const s = ++this.outSeq;
    this.unacked.push({ s, text, at: Date.now() });
    this.unackedChars += text.length;
    try {
      if (text.length <= this.lim.chunk) {
        this.wire.send(`M${s}:${text}`);
      } else {
        for (let i = 0; i < text.length; i += this.lim.chunk) {
          const last = i + this.lim.chunk >= text.length;
          this.wire.send(`${last ? 'E' : 'C'}${s}:${text.slice(i, i + this.lim.chunk)}`);
        }
      }
    } catch {
      this.fail('closed');
      return true;
    }
    if (this.unacked.length > this.lim.maxUnacked || this.unackedChars > this.lim.maxUnackedChars || this.wire.buffered() > this.lim.maxBuffered) {
      this.fail('stalled');
    }
    // Either way the message is safe: a failed link sends everything unconfirmed through the relay.
    return true;
  }

  /** A frame arrived on the wire. */
  onWire(frame: unknown): void {
    if (this.state !== 'up') return;
    if (typeof frame !== 'string') return this.fail('protocol');
    const now = Date.now();
    if (now - this.windowStart > this.lim.windowMs) {
      this.windowStart = now;
      this.windowFrames = 0;
    }
    this.windowFrames += 1;
    if (this.windowFrames > this.lim.framesPerWindow) return this.fail('flood');
    if (this.gated) {
      this.held.push(frame);
      this.heldChars += frame.length;
      if (this.heldChars > this.lim.maxHeldChars) this.fail('stalled');
      return;
    }
    this.process(frame);
  }

  /** A signal about this link arrived through the relay. */
  onSignal(sig: LinkSignal): void {
    if (sig.n !== this.n) return;
    if (sig.t === 'switch') {
      if (this.state === 'down' || !this.gated) return;
      this.gated = false;
      const held = this.held;
      this.held = [];
      this.heldChars = 0;
      for (const frame of held) {
        if (this.state !== 'up') return;
        this.process(frame);
      }
    } else if (sig.t === 'down') {
      this.fail('remote');
    } else if (sig.t === 're') {
      // Only ever comes after the sender's link went down, so ours has to be down too.
      this.fail('remote');
      if (!Number.isSafeInteger(sig.s) || sig.s <= this.inSeq) return;
      this.inSeq = sig.s;
      this.hand(sig.d);
    }
  }

  private process(frame: string): void {
    const ack = ACK.exec(frame);
    if (ack) {
      const upTo = Number(ack[1]);
      if (upTo > this.outSeq) return this.fail('protocol');
      while (this.unacked.length && this.unacked[0].s <= upTo) this.unackedChars -= this.unacked.shift()!.text.length;
      return;
    }
    const m = FRAME.exec(frame);
    if (!m) return this.fail('protocol');
    const kind = m[1];
    const s = Number(m[2]);
    const body = frame.slice(m[0].length);
    if (s !== this.inSeq + 1 || body.length > this.lim.chunk) return this.fail('protocol');
    if (kind === 'M') {
      if (this.partial) return this.fail('protocol');
      return this.complete(s, body);
    }
    this.partial ??= { s, parts: [], size: 0 };
    this.partial.parts.push(body);
    this.partial.size += body.length;
    if (this.partial.size > this.lim.maxMessage) return this.fail('protocol');
    if (kind === 'E') {
      const text = this.partial.parts.join('');
      this.partial = null;
      this.complete(s, text);
    }
  }

  private complete(s: number, text: string): void {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return this.fail('protocol');
    }
    this.inSeq = s;
    this.sinceAck += 1;
    if (this.sinceAck >= this.lim.ackEvery) this.ack();
    else this.ackTimer ??= setTimeout(() => this.ack(), this.lim.ackAfterMs);
    this.hand(data);
  }

  private ack(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.sinceAck = 0;
    if (this.state !== 'up' || !this.wire) return;
    try {
      this.wire.send(`A${this.inSeq}`);
    } catch {
      this.fail('closed');
    }
  }

  private hand(data: unknown): void {
    // A game error on one message mustn't stop the ones behind it.
    try {
      this.opts.deliver(data);
    } catch (err) {
      console.error('Could not handle a message from the direct link', err);
    }
  }

  private stop(): void {
    this.state = 'down';
    if (this.ackTimer) clearTimeout(this.ackTimer);
    if (this.stallTimer) clearInterval(this.stallTimer);
    this.ackTimer = null;
    this.stallTimer = null;
    this.held = [];
    this.partial = null;
    try {
      this.wire?.close();
    } catch { /* already gone */ }
  }

  /** Closes the link, or gives up on opening it, and moves everything unconfirmed to the relay. */
  fail(reason: DownReason): void {
    if (this.state === 'down') return;
    this.stop();
    if (reason !== 'remote') this.opts.relay({ t: 'down', n: this.n });
    const pending = this.unacked;
    this.unacked = [];
    this.unackedChars = 0;
    for (const u of pending) this.opts.relay({ t: 're', n: this.n, s: u.s, d: JSON.parse(u.text) });
    this.opts.onDown(reason);
  }

  /** Closes the link without telling anyone, for when the other player has left. */
  dispose(): void {
    if (this.state === 'down') return;
    this.stop();
    this.unacked = [];
  }
}

/** Checks a signal that arrived through the relay before anything acts on it. */
export function parseSignal(raw: unknown): LinkSignal | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.n !== 'number' || !Number.isSafeInteger(r.n) || r.n < 0) return null;
  switch (r.t) {
    case 'hello': case 'switch': case 'down': return { t: r.t, n: r.n };
    case 'offer': case 'answer': return typeof r.sdp === 'string' ? { t: r.t, n: r.n, sdp: r.sdp } : null;
    case 're': return typeof r.s === 'number' && Number.isSafeInteger(r.s) && r.s > 0 ? { t: 're', n: r.n, s: r.s, d: r.d } : null;
    default: return null;
  }
}
