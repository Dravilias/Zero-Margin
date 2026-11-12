import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseAction } from '../src/engine/ai';
import { Rand } from '../src/engine/rng';
import { DirectLink, parseSignal, type LinkSignal, type Wire } from '../src/net/directLink';
import { RelayClient } from '../src/net/relayClient';
import { cleanSdp, isLocalAddress, stunOk, type AttemptEvents, type AttemptFactory } from '../src/net/rtc';
import { GuestTable, HostTable, type GameSession } from '../src/net/sessions';
import { newTable } from '../src/net/table';
// @ts-expect-error the relay is plain JavaScript so it can run in a small container
import { startRelay } from '../relay/server.mjs';

const stored = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, v); }, removeItem: (k: string) => { stored.delete(k); } };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

/* ---------- The link on its own, with every delivery order and failure point the test can think of ---------- */

type Side = 'a' | 'b';
const other = (s: Side): Side => (s === 'a' ? 'b' : 'a');

/**
 * Two players exchange numbered messages while a link between them opens at a random moment and dies
 * at another. Relay and wire deliveries are interleaved at random. Whatever happens, each side must
 * receive exactly what the other sent, once, in order.
 */
function storm(seed: number): void {
  const rnd = new Rand(seed);
  const relay: Record<Side, unknown[]> = { a: [], b: [] }; // waiting to arrive at this side
  const wire: Record<Side, string[]> = { a: [], b: [] };
  const sent: Record<Side, number[]> = { a: [], b: [] };
  const got: Record<Side, number[]> = { a: [], b: [] };
  const attached: Record<Side, boolean> = { a: false, b: false };
  let cut = false;
  const mk = (me: Side) => new DirectLink({
    n: 7,
    relay: (sig) => relay[other(me)].push({ sig: JSON.parse(JSON.stringify(sig)) }),
    deliver: (d) => got[me].push((d as { i: number }).i),
    onDown: () => {},
    limits: { ackEvery: 1 + rnd.int(0, 3), ackAfterMs: 1e9, stallMs: 1e9, chunk: 40 },
  });
  const links: Record<Side, DirectLink> = { a: mk('a'), b: mk('b') };
  const wireOf = (me: Side): Wire => ({
    // A dead channel either throws or swallows what it's given, depending on how far the closing has got.
    send: (t) => { if (!cut) wire[other(me)].push(t); else if (rnd.next() < 0.5) throw new Error('closed'); },
    close: () => {},
    buffered: () => 0,
  });
  const say = (me: Side) => {
    const msg = { i: sent[me].length, pad: 'x'.repeat(rnd.int(0, 130)) };
    sent[me].push(msg.i);
    if (!links[me].send(msg)) relay[other(me)].push({ plain: msg });
  };
  const arriveRelay = (to: Side) => {
    const m = relay[to].shift() as { sig?: unknown; plain?: { i: number } } | undefined;
    if (!m) return;
    if (m.plain) got[to].push(m.plain.i);
    else links[to].onSignal(parseSignal(m.sig)!);
  };
  const arriveWire = (to: Side) => {
    if (!attached[to] || !wire[to].length) return;
    links[to].onWire(wire[to].shift()!);
  };
  const steps = 150 + rnd.int(0, 250);
  const openAt = { a: rnd.int(0, steps), b: rnd.int(0, steps) };
  const cutAt = rnd.int(0, steps * 1.3);
  const noticeAt = { a: cutAt + rnd.int(0, 30), b: cutAt + rnd.int(0, 30) };
  for (let step = 0; step < steps; step++) {
    for (const me of ['a', 'b'] as Side[]) {
      if (step === openAt[me] && !cut) { attached[me] = true; links[me].attach(wireOf(me)); }
      if (step === noticeAt[me] && rnd.next() < 0.7) links[me].fail('closed');
    }
    if (step === cutAt) { cut = true; wire.a = []; wire.b = []; }
    const dice = rnd.next();
    const who: Side = rnd.next() < 0.5 ? 'a' : 'b';
    if (dice < 0.4) say(who);
    else if (dice < 0.65) arriveRelay(who);
    else arriveWire(who);
  }
  // The end of the game: a link that's still open carries on working, a cut one is noticed by someone.
  if (cut) links[rnd.next() < 0.5 ? 'a' : 'b'].fail('closed');
  for (let i = 0; i < 20000 && (relay.a.length || relay.b.length || (!cut && attached.a && attached.b && (wire.a.length || wire.b.length))); i++) {
    arriveRelay('a'); arriveRelay('b'); arriveWire('a'); arriveWire('b');
  }
  if (!cut && attached.a !== attached.b) {
    // One side opened and the other never did: giving up on it brings everything back through the relay.
    links[attached.a ? 'b' : 'a'].fail('closed');
    while (relay.a.length || relay.b.length) { arriveRelay('a'); arriveRelay('b'); }
  }
  links.a.dispose();
  links.b.dispose();
  expect(got.b, `seed ${seed}: what b received`).toEqual(sent.a);
  expect(got.a, `seed ${seed}: what a received`).toEqual(sent.b);
}

describe('direct link delivery', () => {
  it('delivers everything exactly once and in order, however the link opens and dies', () => {
    for (let seed = 1; seed <= 600; seed++) storm(seed);
  });

  it('carries a message far larger than one frame', () => {
    const frames: string[] = [];
    const out: unknown[] = [];
    const a = new DirectLink({ n: 1, relay: () => {}, deliver: () => {}, onDown: () => {}, limits: { chunk: 1000 } });
    const b = new DirectLink({ n: 1, relay: () => {}, deliver: (d) => out.push(d), onDown: () => {}, limits: { chunk: 1000 } });
    a.attach({ send: (t) => frames.push(t), close: () => {}, buffered: () => 0 });
    b.attach({ send: () => {}, close: () => {}, buffered: () => 0 });
    b.onSignal({ t: 'switch', n: 1 });
    const big = { text: 'zażółć gęślą jaźń '.repeat(4000) };
    expect(a.send(big)).toBe(true);
    expect(frames.length).toBeGreaterThan(50);
    for (const f of frames) b.onWire(f);
    expect(out).toEqual([big]);
    a.dispose();
    b.dispose();
  });
});

/* ---------- A hostile peer ---------- */

function victim(limits = {}) {
  const signals: LinkSignal[] = [];
  const delivered: unknown[] = [];
  const down: string[] = [];
  let closed = false;
  const link = new DirectLink({ n: 3, relay: (s) => signals.push(s), deliver: (d) => delivered.push(d), onDown: (r) => down.push(r), limits });
  link.attach({ send: () => {}, close: () => { closed = true; }, buffered: () => 0 });
  link.onSignal({ t: 'switch', n: 3 });
  return { link, signals, delivered, down, isClosed: () => closed };
}

describe('a hostile peer on a direct link', () => {
  const bad: [string, unknown][] = [
    ['an unknown frame type', 'X1:{}'],
    ['a frame with no number', 'M:{}'],
    ['a skipped number', 'M2:{}'],
    ['a repeated number', 'M0:{}'],
    ['text that isn\'t JSON', 'M1:{nope'],
    ['binary data', new ArrayBuffer(8)],
    ['a confirmation for messages never sent', 'A5'],
    ['a negative number', 'M-1:{}'],
    ['a number too long to be real', `M${'9'.repeat(20)}:{}`],
    ['a frame larger than the limit', `M1:"${'x'.repeat(20_000)}"`],
  ];
  for (const [what, frame] of bad) {
    it(`closes the link for good on ${what}`, () => {
      const v = victim();
      v.link.onWire(frame);
      expect(v.down).toEqual(['protocol']);
      expect(v.isClosed()).toBe(true);
      expect(v.delivered).toEqual([]);
      expect(v.signals).toContainEqual({ t: 'down', n: 3 });
      // Nothing that arrives afterwards is looked at.
      v.link.onWire('M1:{"k":"action"}');
      expect(v.delivered).toEqual([]);
      expect(v.link.send({ a: 1 })).toBe(false);
    });
  }

  it('closes the link when a message never ends', () => {
    const v = victim({ chunk: 100, maxMessage: 1000 });
    for (let i = 0; i < 20 && v.link.isUp(); i++) v.link.onWire(`C1:${'x'.repeat(100)}`);
    expect(v.down).toEqual(['protocol']);
    expect(v.delivered).toEqual([]);
  });

  it('closes the link on a flood', () => {
    const v = victim({ framesPerWindow: 50, windowMs: 60_000 });
    for (let i = 1; i <= 80 && v.link.isUp(); i++) v.link.onWire(`M${i}:1`);
    expect(v.down).toEqual(['flood']);
    expect(v.delivered.length).toBe(50);
  });

  it('does not let frames pile up before the switch signal', () => {
    const signals: LinkSignal[] = [];
    const down: string[] = [];
    const link = new DirectLink({ n: 3, relay: (s) => signals.push(s), deliver: () => {}, onDown: (r) => down.push(r), limits: { maxHeldChars: 5000 } });
    link.attach({ send: () => {}, close: () => {}, buffered: () => 0 });
    for (let i = 1; i <= 100 && link.isUp(); i++) link.onWire(`M${i}:"${'x'.repeat(200)}"`);
    expect(down).toEqual(['stalled']);
  });

  it('gives up on a peer that stops confirming', async () => {
    const v = victim({ stallMs: 60 });
    v.link.send({ a: 1 });
    await until(() => v.down.length > 0, 2000);
    expect(v.down).toEqual(['stalled']);
    // The unconfirmed message goes through the relay instead.
    expect(v.signals).toContainEqual({ t: 're', n: 3, s: 1, d: { a: 1 } });
  });

  it('ignores a resent message it has already had, and signals for another link', () => {
    const v = victim();
    v.link.onWire('M1:{"i":1}');
    v.link.onSignal({ t: 'down', n: 99 });
    expect(v.link.isUp()).toBe(true);
    v.link.onSignal({ t: 'down', n: 3 });
    v.link.onSignal({ t: 're', n: 3, s: 1, d: { i: 1 } });
    v.link.onSignal({ t: 're', n: 3, s: 2, d: { i: 2 } });
    v.link.onSignal({ t: 're', n: 3, s: 2, d: { i: 2 } });
    expect(v.delivered).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it('only accepts well-formed signals', () => {
    expect(parseSignal({ t: 'hello', n: 4 })).toEqual({ t: 'hello', n: 4 });
    expect(parseSignal({ t: 'offer', n: 4, sdp: 'v=0' })).toEqual({ t: 'offer', n: 4, sdp: 'v=0' });
    for (const raw of [null, 'hello', 7, [], { t: 'hello' }, { t: 'hello', n: -1 }, { t: 'hello', n: 1.5 }, { t: 'hello', n: '4' }, { t: 'offer', n: 1 },
      { t: 'offer', n: 1, sdp: 5 }, { t: 're', n: 1, s: 0 }, { t: 're', n: 1, s: 'x' }, { t: 'eval', n: 1 }, { t: '__proto__', n: 1 }]) {
      expect(parseSignal(raw), JSON.stringify(raw)).toBeNull();
    }
  });
});

/* ---------- What a session description may contain ---------- */

const SDP = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS',
  'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 192.168.1.20',
  'a=candidate:1 1 udp 2113937151 192.168.1.20 54321 typ host generation 0',
  'a=candidate:2 1 udp 2113937151 b3f1c2d4-aaaa-bbbb-cccc-1234567890ab.local 54322 typ host generation 0',
  'a=candidate:3 1 udp 1677729535 203.0.113.9 61000 typ srflx raddr 192.168.1.20 rport 54321 generation 0',
  'a=candidate:4 1 tcp 1518280447 203.0.113.9 9 typ host tcptype active generation 0',
  'a=candidate:5 1 udp 2113937151 fd12:3456:789a::1 54323 typ host generation 0',
  'a=candidate:6 1 udp 2113937151 2001:db8::7 54324 typ host generation 0',
  'a=candidate:7 1 udp 2113937151 evil.example.com 54325 typ host generation 0',
  'a=ice-ufrag:abcd', 'a=ice-pwd:0123456789abcdef01234567', 'a=fingerprint:sha-256 AA:BB', 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000',
].join('\r\n');

describe('session descriptions', () => {
  it('lose every home-network address, name and private detail', () => {
    const out = cleanSdp(SDP, false)!;
    expect(out).toContain('203.0.113.9 61000 typ srflx raddr 0.0.0.0 rport 0');
    expect(out).toContain('2001:db8::7');
    for (const leak of ['192.168.1.20', '.local', 'fd12:', 'evil.example.com', ' tcp ']) expect(out, leak).not.toContain(leak);
    expect(out).toContain('c=IN IP4 0.0.0.0');
    expect(out.split('\r\n').filter((l) => l.startsWith('a=candidate:')).length).toBe(2);
  });

  it('keep local addresses only when trying the game out on one machine', () => {
    const out = cleanSdp(SDP, true)!;
    expect(out).toContain('192.168.1.20 54321 typ host');
    expect(out).toContain('.local 54322');
    expect(out).not.toContain('evil.example.com');
  });

  it('are refused unless they describe one data channel and nothing else', () => {
    expect(cleanSdp(SDP.replace('m=application', 'm=audio'), false)).toBeNull();
    expect(cleanSdp(`${SDP}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96`, false)).toBeNull();
    expect(cleanSdp(SDP.replace('a=fingerprint:sha-256 AA:BB', ''), false)).toBeNull();
    expect(cleanSdp(`${SDP}\r\na=x:${'y'.repeat(20_000)}`, false)).toBeNull();
    expect(cleanSdp(`${SDP}\r\na=x:\u0000`, false)).toBeNull();
    expect(cleanSdp('hello', false)).toBeNull();
    expect(cleanSdp({ sdp: SDP }, false)).toBeNull();
  });

  it('know which addresses are not on the public internet', () => {
    for (const a of ['10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '999.1.1.1',
      '::1', '::', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:192.168.1.1', 'localhost', 'printer.local', 'example.com', '']) {
      expect(isLocalAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '100.128.0.1', '2001:db8::7', '2a00:1450:4001::1']) expect(isLocalAddress(a), a).toBe(false);
  });

  it('accept only plain STUN addresses', () => {
    expect(stunOk('stun:stun.cloudflare.com:3478')).toBe(true);
    expect(stunOk('stuns:stun.example.org')).toBe(true);
    for (const bad of ['turn:evil.example:3478', 'http://x', 'stun:', 'stun:a b', 'stun:x?transport=tcp', 'javascript:alert(1)']) expect(stunOk(bad), bad).toBe(false);
  });
});

/* ---------- The whole thing against a real relay, with wires made of memory in place of WebRTC ---------- */

interface Net {
  factory: AttemptFactory;
  frames: number;
  opened: number;
  /** Kills every open wire. With `quiet`, only the guest finds out. */
  cut(quiet?: boolean): void;
  /** Sends a raw frame to the host as if it came from a guest. */
  inject(frame: unknown): void;
}

function fakeNet(): Net {
  const waiting = new Map<string, { ev: AttemptEvents; open: boolean }>();
  const live: { host: AttemptEvents; guest: AttemptEvents; dead: boolean }[] = [];
  let id = 0;
  const net: Net = {
    frames: 0,
    opened: 0,
    cut(quiet = false) {
      for (const pair of live.splice(0)) {
        pair.dead = true;
        setTimeout(() => pair.guest.closed(), 0);
        if (!quiet) setTimeout(() => pair.host.closed(), 0);
      }
    },
    inject(frame) {
      for (const pair of live) pair.host.text(frame);
    },
    factory: (role, ev) => {
      if (role === 'host') {
        const key = `fake:${++id}`;
        waiting.set(key, { ev, open: false });
        setTimeout(() => ev.send({ t: 'offer', sdp: key }), 0);
        return {
          signal(sig) {
            const w = waiting.get(key);
            const g = waiting.get(`${sig.sdp}:guest`);
            if (!w || !g || sig.sdp !== key) return;
            waiting.delete(key);
            waiting.delete(`${key}:guest`);
            const pair = { host: ev, guest: g.ev, dead: false };
            live.push(pair);
            net.opened += 1;
            const wire = (to: AttemptEvents): Wire => ({
              send: (t) => { if (pair.dead) throw new Error('closed'); net.frames += 1; setTimeout(() => { if (!pair.dead) to.text(t); }, 0); },
              close: () => { pair.dead = true; },
              buffered: () => 0,
            });
            setTimeout(() => { ev.open(wire(g.ev)); g.ev.open(wire(ev)); }, 0);
          },
          abort() { waiting.delete(key); },
        };
      }
      return {
        signal(sig) {
          waiting.set(`${sig.sdp}:guest`, { ev, open: false });
          setTimeout(() => ev.send({ t: 'answer', sdp: sig.sdp }), 0);
        },
        abort() {},
      };
    },
  };
  return net;
}

describe('direct links between players', () => {
  let relay: any;
  let url: string;
  beforeAll(async () => {
    relay = await startRelay({ port: 0, peerGraceMs: 8000, hostGraceMs: 200, createsPerMinute: 500, joinsPerMinute: 500 });
    url = `ws://127.0.0.1:${relay.port}`;
  });
  afterAll(async () => { await relay.close(); });

  async function pair(hostOn: boolean, guestOn: boolean) {
    const net = fakeNet();
    const host = new RelayClient(url);
    const guest = new RelayClient(url);
    if (hostOn) host.direct = { factory: net.factory };
    if (guestOn) guest.direct = { factory: net.factory };
    guest.retryMs = 50;
    host.helloGapMs = 0;
    const atHost: number[] = [];
    const atGuest: number[] = [];
    host.handlers.onMessage = (_f, d) => atHost.push((d as { i: number }).i);
    guest.handlers.onMessage = (_f, d) => atGuest.push((d as { i: number }).i);
    const code = await host.create('Host');
    await guest.join(code, 'Guest');
    await until(() => relay.rooms.get(code)?.peers.size === 1);
    return { net, host, guest, atHost, atGuest, id: guest.peerId! };
  }
  const count = (n: number, from = 0) => Array.from({ length: n }, (_, i) => from + i);

  it('connects two players directly only when both have turned it on', async () => {
    for (const [hostOn, guestOn] of [[true, false], [false, true], [false, false]]) {
      const p = await pair(hostOn, guestOn);
      await wait(120);
      expect(p.net.opened).toBe(0);
      expect(p.host.isDirect(p.id)).toBe(false);
      p.host.send(p.id, { i: 1 });
      p.guest.send('host', { i: 2 });
      await until(() => p.atGuest.length === 1 && p.atHost.length === 1);
      expect(p.net.frames).toBe(0);
      p.host.close();
      p.guest.close();
    }
    const p = await pair(true, true);
    await until(() => p.host.isDirect(p.id) && p.guest.isDirect('host'));
    expect(p.host.directCount()).toBe(1);
    p.host.close();
    p.guest.close();
  });

  it('moves the conversation to the link and back to the relay without losing or repeating anything', async () => {
    for (const quiet of [false, true]) {
      const p = await pair(true, true);
      // Talking starts before the link is open, carries on across the switch, and across the link dying.
      let i = 0;
      const talk = (n: number) => { for (let k = 0; k < n; k++, i++) { p.host.send(k % 2 ? p.id : 'all', { i }); p.guest.send('host', { i }); } };
      talk(20);
      await until(() => p.host.isDirect(p.id) && p.guest.isDirect('host'));
      talk(20);
      await until(() => p.atGuest.length === 40 && p.atHost.length === 40);
      expect(p.net.frames).toBeGreaterThan(20);
      talk(10);
      p.net.cut(quiet);
      talk(30);
      await until(() => p.atGuest.length === i && p.atHost.length === i);
      expect(p.atGuest).toEqual(count(i));
      expect(p.atHost).toEqual(count(i));
      // The guest asks again after a pause, and a new link takes over.
      await until(() => p.net.opened === 2 && p.host.isDirect(p.id) && p.guest.isDirect('host'));
      talk(15);
      await until(() => p.atGuest.length === i && p.atHost.length === i);
      expect(p.atGuest).toEqual(count(i));
      expect(p.atHost).toEqual(count(i));
      p.host.close();
      p.guest.close();
    }
  });

  it('drops a guest who sends rubbish over the link back to the relay, for good', async () => {
    const p = await pair(true, true);
    await until(() => p.host.isDirect(p.id) && p.guest.isDirect('host'));
    p.net.inject('M999:{"k":"action"}');
    await until(() => !p.host.isDirect(p.id) && !p.guest.isDirect('host'));
    expect(p.atHost).toEqual([]);
    p.guest.send('host', { i: 0 });
    p.host.send(p.id, { i: 0 });
    await until(() => p.atHost.length === 1 && p.atGuest.length === 1);
    // The guest asks for a new link, and the host no longer answers.
    await wait(250);
    expect(p.net.opened).toBe(1);
    expect(p.host.isDirect(p.id)).toBe(false);
    p.host.close();
    p.guest.close();
  });

  it('never lets link signals reach the game, and ignores them from strangers', async () => {
    const p = await pair(false, false);
    const seen: unknown[] = [];
    p.host.handlers.onMessage = (_f, d) => seen.push(d);
    p.guest.send('host', { __link: { t: 'hello', n: 1 } });
    p.guest.send('host', { __link: { t: 're', n: 1, s: 1, d: { k: 'action' } } });
    p.guest.send('host', { __link: 'nonsense' });
    p.guest.send('host', { i: 1 });
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ i: 1 }]);
    p.host.close();
    p.guest.close();
  });

  it('plays a whole game over a direct link that dies halfway', async () => {
    const net = fakeNet();
    const hostRelay = new RelayClient(url);
    const guestRelay = new RelayClient(url);
    hostRelay.direct = { factory: net.factory };
    guestRelay.direct = { factory: net.factory };
    guestRelay.retryMs = 1e9;
    const code = await hostRelay.create('Host');
    const table = newTable('Host', true);
    table.settings.mapSize = 'small';
    table.settings.ruleset = 'quick';
    const hostTable = new HostTable(table, hostRelay, 'Host');
    await guestRelay.join(code, 'Guest');
    const guestTable = new GuestTable(guestRelay, code);
    await until(() => guestTable.table.seats[1].peer === guestRelay.peerId);
    await until(() => guestRelay.isDirect('host'));
    guestTable.updateMine({ ready: true, faction: 'choir', roster: hostTable.table.seats[2].roster });
    await until(() => hostTable.table.seats[1].ready);
    let hostSession!: GameSession;
    let guestSession!: GameSession;
    hostTable.onStart = (s) => { hostSession = s; };
    guestTable.onStart = (s) => { guestSession = s; };
    hostTable.start();
    await until(() => !!hostSession && !!guestSession);
    const rnd = new Rand(11);
    let steps = 0;
    while (hostSession.state.phase !== 'over') {
      const side = hostSession.state.activeSide;
      const session = hostSession.localSides.has(side) ? hostSession : guestSession;
      await until(() => guestSession.state.seq === hostSession.state.seq);
      const before = hostSession.state.seq;
      session.submit(chooseAction(hostSession.state, side, 'normal', rnd), side);
      // Halfway through a move is the worst moment for the link to go.
      if (steps === 25) net.cut(true);
      await until(() => hostSession.state.seq > before);
      if (++steps > 2000) throw new Error('game did not finish');
    }
    await until(() => guestSession.state.seq === hostSession.state.seq);
    expect(net.frames).toBeGreaterThan(30);
    expect(steps).toBeGreaterThan(25);
    expect(guestSession.state).toEqual(hostSession.state);
    hostSession.dispose();
    guestSession.dispose();
  }, 60000);
});
