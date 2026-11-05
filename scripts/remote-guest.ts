// Joins a real online table as a friend, from Node, and plays with the computer's move chooser.
// Used to test a host running on another machine or operating system:
//   npx esbuild scripts/remote-guest.ts --bundle --platform=node --outfile=<temp file>
//   node <temp file> <JOIN CODE> [relay url]
// It prints one JSON summary, so the result can be compared with what the host's screen shows.
import { chooseAction } from '../src/engine/ai';
import { Rand } from '../src/engine/rng';
import { RelayClient } from '../src/net/relayClient';
import { GuestSession, GuestTable } from '../src/net/sessions';

(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const code = process.argv[2];
const url = process.argv[3] ?? 'wss://relay.dravilias.me';
const TARGET_ROUND = 3;

const relay = new RelayClient(url);
await relay.join(code, 'Linux Friend');
console.error(`joined ${code} as ${relay.peerId}`);

const table = new GuestTable(relay, code);
const heard: string[] = [];
let session: GuestSession | null = null;
table.onStart = (s) => { session = s as GuestSession; };
table.onChange = () => {
  const mine = table.table.seats.find((x) => x.peer === relay.peerId);
  if (mine && !mine.ready) table.updateMine({ ready: true });
};
table.onClosed = (reason) => { console.error(`table closed: ${reason}`); process.exit(2); };

const started = Date.now();
while (!session && Date.now() - started < 180000) await new Promise((r) => setTimeout(r, 100));
if (!session) { console.error('host never started'); process.exit(3); }
const s: GuestSession = session;
console.error(`game started, I play sides ${[...s.localSides]}`);
s.onChat = (from, text) => heard.push(`${from}: ${text}`);
s.chat('hello from linux');

const rnd = new Rand(4242);
let actions = 0;
let waitingForSeq = -1;
const deadline = Date.now() + 240000;
while (s.state.phase !== 'over' && s.state.round < TARGET_ROUND && Date.now() < deadline) {
  const st = s.state;
  if (s.localSides.has(st.activeSide) && st.seq !== waitingForSeq) {
    waitingForSeq = st.seq;
    s.submit(chooseAction(st, st.activeSide, 'normal', rnd), st.activeSide);
    actions += 1;
  }
  await new Promise((r) => setTimeout(r, 60));
}
// Stay long enough for the host's last messages to arrive.
await new Promise((r) => setTimeout(r, 2500));

console.log(JSON.stringify({
  round: s.state.round,
  phase: s.state.phase,
  seq: s.state.seq,
  actionsSent: actions,
  heard,
  vp: s.state.vp,
  units: s.state.units.filter((u) => !u.isDrone).map((u) => `${u.name}:${u.state === 'ok' ? u.hp : u.state}`),
}));
relay.close();
process.exit(0);
