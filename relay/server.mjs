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

export function startRelay(options = {}) {
  const port = options.port ?? 7700;
  const maxRooms = options.maxRooms ?? 500;
  const maxPeers = options.maxPeers ?? 8;
  const maxPayload = options.maxPayload ?? 512 * 1024;
  const hostGraceMs = options.hostGraceMs ?? 5 * 60 * 1000;
  const peerGraceMs = options.peerGraceMs ?? 30 * 60 * 1000;
  const idleMs = options.idleMs ?? 3 * 60 * 60 * 1000;
  const heartbeatMs = options.heartbeatMs ?? 25 * 1000;
  const trustProxy = options.trustProxy ?? false;
  const limits = { creates: options.createsPerMinute ?? 20, joins: options.joinsPerMinute ?? 40 };

  /** @type {Map<string, any>} */
  const rooms = new Map();
  /** @type {Map<string, {minute:number, creates:number, joins:number}>} */
  const ipUse = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, protocol: PROTOCOL, rooms: rooms.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Zero Margin relay\n');
  });

  const wss = new WebSocketServer({ server, maxPayload });

  const send = (ws, msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
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
    room_touch(ws);
    switch (msg.op) {
      case 'ping':
        send(ws, { op: 'pong', t: msg.t });
        return;
      case 'create': {
        if (msg.proto !== PROTOCOL) return send(ws, { op: 'error', code: 'bad-proto' });
        if (ws.room) return send(ws, { op: 'error', code: 'in-room' });
        if (!allow(ws.ip, 'creates')) return send(ws, { op: 'error', code: 'rate' });
        if (rooms.size >= maxRooms) return send(ws, { op: 'error', code: 'server-full' });
        const code = newCode();
        if (!code) return send(ws, { op: 'error', code: 'server-full' });
        const room = { code, hostToken: token(), hostWs: ws, hostName: cleanName(msg.name), peers: new Map(), lastSeen: Date.now(), hostTimer: null, nextPeer: 1 };
        rooms.set(code, room);
        ws.room = room;
        ws.role = 'host';
        return send(ws, { op: 'created', code, hostToken: room.hostToken });
      }
      case 'resume': {
        const room = rooms.get(String(msg.code ?? '').toUpperCase());
        if (!room || room.hostToken !== msg.hostToken) return send(ws, { op: 'error', code: 'no-room' });
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

  function room_touch(ws) {
    if (ws.room) ws.room.lastSeen = Date.now();
  }

  function onClose(ws) {
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
    const forwarded = trustProxy ? req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] : null;
    ws.ip = String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    ws.alive = true;
    ws.room = null;
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
    ws.on('close', () => onClose(ws));
    ws.on('error', () => ws.terminate());
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
    server.listen(port, () => {
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
    trustProxy: process.env.TRUST_PROXY === '1',
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
