/*
 * The WebRTC side of a direct link: one data channel, no audio or video, nothing else.
 *
 * Two rules keep it from telling the other player more than it must:
 *  - Home-network and loopback addresses never go out, and none are accepted, so a link can neither
 *    map this player's network nor be pointed at devices inside it. (The desktop app also tells
 *    Chromium to use only the default route, so a VPN's address is the only one offered.)
 *  - The whole description is sent at once, checked, and cut down to what a data channel needs.
 */
import type { Wire } from './directLink';

export interface DirectAttempt {
  signal(sig: { t: 'offer' | 'answer'; sdp: string }): void;
  abort(): void;
}

export interface AttemptEvents {
  send(sig: { t: 'offer' | 'answer'; sdp: string }): void;
  open(wire: Wire): void;
  text(frame: unknown): void;
  closed(): void;
  failed(): void;
}

export type AttemptFactory = (role: 'host' | 'guest', ev: AttemptEvents) => DirectAttempt;

export interface RtcOptions {
  /** Servers that tell a player their own public address. Empty means only directly reachable addresses work. */
  stun: string[];
  /** Allow home-network addresses. Only for trying the game out in a browser on one machine. */
  allowLocal: boolean;
  gatherMs?: number;
  connectMs?: number;
}

const MAX_SDP = 12_000;
const MAX_CANDIDATES = 24;
const STUN_URL = /^stuns?:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

export const stunOk = (url: string): boolean => STUN_URL.test(url);

/** True for anything that isn't a public internet address: private ranges, loopback, link-local, names. */
export function isLocalAddress(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const [p, q] = [Number(v4[1]), Number(v4[2])];
    if ([v4[1], v4[2], v4[3], v4[4]].some((x) => Number(x) > 255)) return true;
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224;
  }
  // Anything that isn't an IPv6 literal is a name, and names are never accepted.
  if (!/^[0-9a-f:]+$/.test(a) || !a.includes(':')) return true;
  if (a === '::' || a === '::1') return true;
  const first = parseInt(a.split(':')[0] || '0', 16);
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8.
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/**
 * Checks a session description and returns it with local addresses removed, or null if it isn't
 * a plain data-channel description. Used on what we send and on what we receive.
 */
export function cleanSdp(sdp: unknown, allowLocal: boolean): string | null {
  if (typeof sdp !== 'string' || sdp.length > MAX_SDP || !sdp.startsWith('v=0')) return null;
  const lines = sdp.split(/\r?\n/).filter((l) => l.length > 0);
  const media = lines.filter((l) => l.startsWith('m='));
  if (media.length !== 1 || !media[0].startsWith('m=application ')) return null;
  if (!lines.some((l) => l.startsWith('a=fingerprint:')) || !lines.some((l) => l.startsWith('a=ice-ufrag:'))) return null;
  const out: string[] = [];
  let candidates = 0;
  for (const line of lines) {
    if (/[^\x20-\x7e]/.test(line)) return null;
    if (line.startsWith('a=candidate:')) {
      const f = line.split(' ');
      const typ = f.indexOf('typ');
      if (f.length < 8 || typ !== 6) return null;
      const address = f[4];
      const mdns = /^[a-z0-9-]{1,63}\.local$/i.test(address);
      const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(address) || (address.includes(':') && /^[0-9a-f:.]+$/i.test(address));
      if (!literal && !mdns) continue;
      if (!allowLocal && (mdns || isLocalAddress(address))) continue;
      if (f[2].toLowerCase() !== 'udp') continue;
      candidates += 1;
      if (candidates > MAX_CANDIDATES) continue;
      // The "related address" of a public candidate is the private one behind it. Nobody needs it.
      const r = f.indexOf('raddr');
      if (r > 0 && f[r + 1]) f[r + 1] = '0.0.0.0';
      const rp = f.indexOf('rport');
      if (rp > 0 && f[rp + 1]) f[rp + 1] = '0';
      out.push(f.join(' '));
    } else if (line.startsWith('c=')) {
      // The connection line repeats one address; connectivity checks ignore it.
      out.push('c=IN IP4 0.0.0.0');
    } else if (line.startsWith('m=application ')) {
      const f = line.split(' ');
      f[1] = '9';
      out.push(f.join(' '));
    } else {
      out.push(line);
    }
  }
  return `${out.join('\r\n')}\r\n`;
}

export const rtcSupported = (): boolean => typeof RTCPeerConnection === 'function';

/** Builds real WebRTC attempts. The host makes the offer as soon as its attempt is created. */
export function rtcFactory(opts: RtcOptions): AttemptFactory {
  const gatherMs = opts.gatherMs ?? 4000;
  const connectMs = opts.connectMs ?? 20_000;
  return (role, ev) => {
    let done = false;
    let opened = false;
    const pc = new RTCPeerConnection({
      iceServers: opts.stun.filter(stunOk).slice(0, 2).map((urls) => ({ urls })),
      iceCandidatePoolSize: 0,
    });
    // Both sides declare the same channel, so neither accepts channels the other invents.
    const ch = pc.createDataChannel('zm', { negotiated: true, id: 0, ordered: true });
    const end = (how: 'failed' | 'closed') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ch.close(); } catch { /* gone */ }
      try { pc.close(); } catch { /* gone */ }
      if (opened && how === 'closed') ev.closed();
      else if (!opened) ev.failed();
    };
    const timer = setTimeout(() => { if (!opened) end('failed'); }, connectMs);
    const wire: Wire = {
      send: (text) => ch.send(text),
      close: () => end('closed'),
      buffered: () => ch.bufferedAmount,
    };
    ch.onopen = () => {
      if (done) return;
      opened = true;
      clearTimeout(timer);
      ev.open(wire);
    };
    ch.onmessage = (e) => { if (!done) ev.text(e.data); };
    ch.onclose = () => end('closed');
    ch.onerror = () => end('closed');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') end('closed');
    };
    pc.ondatachannel = (e) => { try { e.channel.close(); } catch { /* gone */ } };

    const gathered = () => new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      const t = setTimeout(resolve, gatherMs);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(t);
          resolve();
        }
      };
    });
    const sendLocal = async (t: 'offer' | 'answer') => {
      await gathered();
      if (done) return;
      const sdp = cleanSdp(pc.localDescription?.sdp, opts.allowLocal);
      if (!sdp) return end('failed');
      ev.send({ t, sdp });
    };
    if (role === 'host') {
      void (async () => {
        try {
          await pc.setLocalDescription(await pc.createOffer());
          await sendLocal('offer');
        } catch {
          end('failed');
        }
      })();
    }
    let answered = false;
    return {
      signal(sig) {
        if (done || answered) return;
        // The host only takes an answer and a guest only takes an offer, once.
        if ((role === 'host') !== (sig.t === 'answer')) return;
        const sdp = cleanSdp(sig.sdp, opts.allowLocal);
        if (!sdp) return end('failed');
        answered = true;
        void (async () => {
          try {
            await pc.setRemoteDescription({ type: sig.t, sdp });
            if (role === 'guest') {
              await pc.setLocalDescription(await pc.createAnswer());
              await sendLocal('answer');
            }
          } catch {
            end('failed');
          }
        })();
      },
      abort: () => end('failed'),
    };
  };
}
