// Zero Margin join-code relay.
// It only passes messages between the players in a room. Nothing is written to disk and message
// contents are never logged. The host's game runs the rules; the relay does not understand them.
import crypto from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PROTOCOL = 1;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

/** Loopback and private-network addresses: where a reverse proxy or tunnel in front of the relay connects from. */
export function isPrivate(address) {
  const a = String(address).toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80:')) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
}

export function startRelay(options = {}) {
  const port = options.port ?? 7700;
  const maxRooms = options.maxRooms ?? 500;
  const maxPeers = options.maxPeers ?? 8;
  const maxPayload = options.maxPayload ?? 512 * 1024;
  const hostGraceMs = options.hostGraceMs ?? 5 * 60 * 1000;
  const peerGraceMs = options.peerGraceMs ?? 30 * 60 * 1000;
  const idleMs = options.idleMs ?? 3 * 60 * 60 * 1000;
  const heartbeatMs = options.heartbeatMs ?? 25 * 1000;
  // The one header a proxy in front of the relay sets to the player's address, e.g. "cf-connecting-ip". Off by default.
  const proxyHeader = options.proxyHeader ? String(options.proxyHeader).toLowerCase() : null;
  const limits = { creates: options.createsPerMinute ?? 20, joins: options.joinsPerMinute ?? 40 };
  const maxRoomsPerIp = options.maxRoomsPerIp ?? 6;
  const maxSocketsPerIp = options.maxSocketsPerIp ?? 16;
  const maxSockets = options.maxSockets ?? 1500;
  // Behind a proxy that names no header, every player shares the proxy's private address, so the per-address caps would cap the whole relay.
  const capped = (ip) => options.limitPrivate || !isPrivate(ip);
  // A player who stops reading would otherwise have everything meant for them pile up in memory here.
  const maxBuffered = options.maxBuffered ?? 4 * 1024 * 1024;

  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, {minute:number, creates:number, joins:number}>} */
  const ipUse = new Map();
  /** @type {Map<string, number>} */
  const ipSockets = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Zero Margin relay\n');
  });

  server.maxConnections = maxSockets;
  const wss = new WebSocketServer({ server, maxPayload });

  const send = (ws, msg) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > maxBuffered) return ws.terminate();
    ws.send(JSON.stringify(msg));
  };

  /** The address limits are counted against. A header is only believed when it comes from a proxy on this machine or its private network. */
  function addressOf(req) {
    const direct = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    if (!proxyHeader || !isPrivate(direct)) return direct;
    const value = req.headers[proxyHeader];
    // Proxies add the address they saw at the end of a list; anything before it was sent by the client.
    const last = String(Array.isArray(value) ? value[value.length - 1] : value ?? '').split(',').pop().trim();
    return last || direct;
  }
  const token = () => crypto.randomBytes(18).toString('base64url');
  const cleanName = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Player';

  function newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function allow(ip, kind) {
    const minute = Math.floor(Date.now() / 60000);
    let use = ipUse.get(ip);
    if (!use || use.minute !== minute) {
      use = { minute, creates: 0, joins: 0 };
      ipUse.set(ip, use);
    }
    use[kind] += 1;
    return use[kind] <= limits[kind];
  }

  function closeRoom(room, reason) {
    rooms.delete(room.code);
    clearTimeout(room.hostTimer);
    for (const peer of room.peers.values()) {
      clearTimeout(peer.timer);
      if (peer.ws) {
        peer.ws.room = null;
        send(peer.ws, { op: 'closed', reason });
      }
    }
    if (room.hostWs) {
      room.hostWs.room = null;
      send(room.hostWs, { op: 'closed', reason });
    }
  }

  const peerList = (room) => [...room.peers.values()].map((p) => ({ id: p.id, name: p.name, connected: !!p.ws }));

  function handle(ws, msg) {
    // Keep-alive pings don't count as play, so a room nobody uses still expires.
    if (msg.op !== 'ping' && ws.room) ws.room.lastSeen = Date.now();
    switch (msg.op) {
      case 'ping':
        send(ws, { op: 'pong', t: msg.t });
        return;
      case 'create': {
        if (msg.proto !== PROTOCOL) return send(ws, { op: 'error', code: 'bad-proto' });
        if (ws.room) return send(ws, { op: 'error', code: 'in-room' });
        if (!allow(ws.ip, 'creates')) return send(ws, { op: 'error', code: 'rate' });
        if (rooms.size >= maxRooms) return send(ws, { op: 'error', code: 'server-full' });
        let mine = 0;
        for (const r of rooms.values()) if (r.ip === ws.ip) mine += 1;
        if (mine >= maxRoomsPerIp && capped(ws.ip)) return send(ws, { op: 'error', code: 'rate' });
        const code = newCode();
        if (!code) return send(ws, { op: 'error', code: 'server-full' });
        const room = { code, ip: ws.ip, hostToken: token(), hostWs: ws, hostName: cleanName(msg.name), peers: new Map(), lastSeen: Date.now(), hostTimer: null, nextPeer: 1 };
        rooms.set(code, room);
        ws.room = room;
        ws.role = 'host';
        return send(ws, { op: 'created', code, hostToken: room.hostToken });
      }
      case 'resume': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room || room.hostToken !== msg.hostToken) return send(ws, { op: 'error', code: 'no-room' });
        // One connection sits in one room, or the room it left would never hear that its host had gone.
        if (ws.room && ws.room !== room) return send(ws, { op: 'error', code: 'in-room' });
        if (room.hostWs && room.hostWs !== ws) room.hostWs.close();
        clearTimeout(room.hostTimer);
        room.hostWs = ws;
        ws.room = room;
        ws.role = 'host';
        send(ws, { op: 'resumed', code: room.code, peers: peerList(room) });
        for (const p of room.peers.values()) send(p.ws, { op: 'host', event: 'back' });
        return;
      }
      case 'join': {
        if (msg.proto !== PROTOCOL) return send(ws, { op: 'error', code: 'bad-proto' });
        if (ws.room) return send(ws, { op: 'error', code: 'in-room' });
        if (!allow(ws.ip, 'joins')) return send(ws, { op: 'error', code: 'rate' });
        const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
        if (!room) return send(ws, { op: 'error', code: 'no-room' });
        let peer = msg.peerToken ? [...room.peers.values()].find((p) => p.token === msg.peerToken) : null;
        const rejoined = !!peer;
        if (peer) {
          clearTimeout(peer.timer);
          if (peer.ws && peer.ws !== ws) peer.ws.close();
          peer.ws = ws;
        } else {
          if (room.peers.size >= maxPeers) return send(ws, { op: 'error', code: 'room-full' });
          peer = { id: `p${room.nextPeer++}`, token: token(), name: cleanName(msg.name), ws, timer: null };
          room.peers.set(peer.id, peer);
        }
        ws.room = room;
        ws.role = 'peer';
        ws.peer = peer;
        send(ws, { op: 'joined', code: room.code, peerId: peer.id, peerToken: peer.token, rejoined, hostOnline: !!room.hostWs });
        send(room.hostWs, { op: 'peer', event: rejoined ? 'rejoin' : 'join', peer: { id: peer.id, name: peer.name } });
        return;
      }
      case 'send': {
        const room = ws.room;
        if (!room) return send(ws, { op: 'error', code: 'no-room' });
        if (ws.role === 'host') {
          if (msg.to === 'all') {
            for (const p of room.peers.values()) send(p.ws, { op: 'msg', from: 'host', data: msg.data });
          } else {
            const p = room.peers.get(msg.to);
            if (p) send(p.ws, { op: 'msg', from: 'host', data: msg.data });
          }
        } else {
          // Guests can only talk to the host, which decides what everyone else sees.
          send(room.hostWs, { op: 'msg', from: ws.peer.id, data: msg.data });
        }
        return;
      }
      case 'kick': {
        const room = ws.room;
        if (!room || ws.role !== 'host') return;
        const p = room.peers.get(msg.peer);
        if (!p) return;
        clearTimeout(p.timer);
        room.peers.delete(p.id);
        if (p.ws) {
          p.ws.room = null;
          send(p.ws, { op: 'closed', reason: 'kicked' });
        }
        send(ws, { op: 'peer', event: 'leave', peer: { id: p.id, name: p.name } });
        return;
      }
      case 'close': {
        if (ws.room && ws.role === 'host') closeRoom(ws.room, 'host-closed');
        return;
      }
      case 'leave': {
        const room = ws.room;
        if (!room || ws.role !== 'peer') return;
        clearTimeout(ws.peer.timer);
        room.peers.delete(ws.peer.id);
        send(room.hostWs, { op: 'peer', event: 'leave', peer: { id: ws.peer.id, name: ws.peer.name } });
        ws.room = null;
        return;
      }
      default:
        send(ws, { op: 'error', code: 'bad-op' });
    }
  }

  function onClose(ws) {
    const open = (ipSockets.get(ws.ip) ?? 1) - 1;
    if (open > 0) ipSockets.set(ws.ip, open);
    else ipSockets.delete(ws.ip);
    const room = ws.room;
    if (!room) return;
    if (ws.role === 'host' && room.hostWs === ws) {
      room.hostWs = null;
      for (const p of room.peers.values()) send(p.ws, { op: 'host', event: 'lost' });
      room.hostTimer = setTimeout(() => closeRoom(room, 'host-gone'), hostGraceMs);
    } else if (ws.role === 'peer' && ws.peer.ws === ws) {
      const peer = ws.peer;
      peer.ws = null;
      send(room.hostWs, { op: 'peer', event: 'lost', peer: { id: peer.id, name: peer.name } });
      peer.timer = setTimeout(() => {
        room.peers.delete(peer.id);
        send(room.hostWs, { op: 'peer', event: 'leave', peer: { id: peer.id, name: peer.name } });
      }, peerGraceMs);
    }
  }

  wss.on('connection', (ws, req) => {
    ws.ip = addressOf(req);
    ws.alive = true;
    ws.room = null;
    ws.on('close', () => onClose(ws));
    ws.on('error', () => ws.terminate());
    const open = (ipSockets.get(ws.ip) ?? 0) + 1;
    ipSockets.set(ws.ip, open);
    if (open > maxSocketsPerIp && capped(ws.ip)) {
      send(ws, { op: 'error', code: 'rate' });
      return ws.close();
    }
    ws.tokens = 120;
    ws.tokensAt = Date.now();
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      // A simple token bucket stops one client flooding the room.
      const now = Date.now();
      ws.tokens = Math.min(120, ws.tokens + ((now - ws.tokensAt) / 1000) * 40);
      ws.tokensAt = now;
      if (ws.tokens < 1) return send(ws, { op: 'error', code: 'rate' });
      ws.tokens -= 1;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { op: 'error', code: 'bad-json' });
      }
      if (msg && typeof msg === 'object') handle(ws, msg);
    });
  });

  // Keep-alive also matters for proxies, which drop idle sockets. Quiet rooms expire here too.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const room of rooms.values()) if (now - room.lastSeen > idleMs) closeRoom(room, 'idle');
    const minute = Math.floor(now / 60000);
    for (const [ip, use] of ipUse) if (use.minute !== minute) ipUse.delete(ip);
  }, heartbeatMs);

  return new Promise((resolve) => {
    server.listen(port, options.host, () => {
      resolve({
        port: server.address().port,
        rooms,
        close: () =>
          new Promise((done) => {
            clearInterval(heartbeat);
            for (const room of [...rooms.values()]) closeRoom(room, 'shutdown');
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = await startRelay({
    port: Number(process.env.PORT) || 7700,
    // Only this machine can reach it unless HOST says otherwise; the container sets HOST itself.
    host: process.env.HOST || '127.0.0.1',
    // TRUST_PROXY=1 is the older setting and means a Cloudflare tunnel.
    proxyHeader: process.env.PROXY_HEADER || (process.env.TRUST_PROXY === '1' ? 'cf-connecting-ip' : ''),
  });
  console.log(`Zero Margin relay listening on port ${relay.port}`);
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => console.log(`rooms: ${relay.rooms.size}`), 15 * 60 * 1000).unref();
}
