import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RelayClient, RelayError } from '../src/net/relayClient';
import { GuestSession, GuestTable, HostSession, HostTable, setSaveListener, type GameSession } from '../src/net/sessions';
import { newTable } from '../src/net/table';
// @ts-expect-error the relay is plain JavaScript so it can run in a small container
import { startRelay } from '../relay/server.mjs';
import { chooseAction } from '../src/engine/ai';
import { Rand } from '../src/engine/rng';
import { createCampaign, starterCrew } from '../src/engine/campaign';
import { CampaignGuest, CampaignHost, saveCampaign } from '../src/net/campaignNet';
import { DuelGuest, DuelHost } from '../src/net/duelNet';

// Sessions autosave through localStorage, which does not exist under Node.
(globalThis as any).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

let relay: any;
let url: string;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

beforeAll(async () => {
  relay = await startRelay({ port: 0, peerGraceMs: 8000, hostGraceMs: 200, createsPerMinute: 500, joinsPerMinute: 500 });
  // Set ZM_TEST_RELAY to run these against a deployed relay instead of a local one.
  url = process.env.ZM_TEST_RELAY ?? `ws://127.0.0.1:${relay.port}`;
});
afterAll(async () => { await relay.close(); });

describe('relay', () => {
  it('connects a host and a guest by code and passes messages both ways', async () => {
    const host = new RelayClient(url);
    const guest = new RelayClient(url);
    const code = await host.create('Host');
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    const peers: string[] = [];
    host.handlers.onPeer = (e, p) => { if (e === 'join') peers.push(p.name); };
    let atHost: unknown;
    let atGuest: unknown;
    host.handlers.onMessage = (_f, d) => { atHost = d; };
    guest.handlers.onMessage = (_f, d) => { atGuest = d; };
    await guest.join(code.toLowerCase(), 'Guest');
    await until(() => peers.length === 1);
    guest.send('host', { hello: 1 });
    await until(() => atHost !== undefined);
    host.send('all', { hello: 2 });
    await until(() => atGuest !== undefined);
    expect(atHost).toEqual({ hello: 1 });
    expect(atGuest).toEqual({ hello: 2 });
    host.close();
    await wait(30);
  });

  it('refuses an unknown code', async () => {
    const guest = new RelayClient(url);
    await expect(guest.join('ZZZZZZ', 'Guest')).rejects.toBeInstanceOf(RelayError);
    guest.close();
  });

  it('lets a dropped guest come back into the same seat', async () => {
    const host = new RelayClient(url);
    const code = await host.create('Host');
    const events: string[] = [];
    host.handlers.onPeer = (e) => events.push(e);
    const guest = new RelayClient(url);
    const { peerId } = await guest.join(code, 'Guest');
    (guest as any).ws.close(); // simulate a lost connection, not a deliberate leave
    await until(() => events.includes('lost'));
    await until(() => events.includes('rejoin'), 5000);
    expect(guest.peerId).toBe(peerId);
    guest.close();
    host.close();
    await wait(30);
  }, 8000);

  it('closes the room for guests when the host leaves for good', async () => {
    const host = new RelayClient(url);
    const code = await host.create('Host');
    const guest = new RelayClient(url);
    await guest.join(code, 'Guest');
    let closed = '';
    guest.handlers.onClosed = (r) => { closed = r; };
    host.close();
    await until(() => closed !== '');
    expect(closed).toBe('host-closed');
    expect(relay.rooms.has(code)).toBe(false);
  });
});

describe('online game through a real relay', () => {
  it('plays a whole game: table, claim seat, start, actions from both players, same final state', async () => {
    const hostRelay = new RelayClient(url);
    const guestRelay = new RelayClient(url);
    const code = await hostRelay.create('Host');
    const table = newTable('Host', true);
    table.settings.mapSize = 'small';
    table.settings.ruleset = 'quick';
    const hostTable = new HostTable(table, hostRelay, 'Host');
    await guestRelay.join(code, 'Guest');
    const guestTable = new GuestTable(guestRelay, code);

    await until(() => hostTable.table.seats[1].kind === 'human');
    expect(hostTable.table.seats[1].name).toBe('Guest');
    await until(() => guestTable.table.seats[1].peer === guestRelay.peerId);

    guestTable.updateMine({ ready: true, faction: 'choir', roster: hostTable.table.seats[2].roster });
    await until(() => hostTable.table.seats[1].ready);

    let hostSession!: GameSession;
    let guestSession!: GameSession;
    hostTable.onStart = (s) => { hostSession = s; };
    guestTable.onStart = (s) => { guestSession = s; };
    hostTable.start();
    await until(() => !!hostSession && !!guestSession);
    expect(hostSession).toBeInstanceOf(HostSession);
    expect(guestSession).toBeInstanceOf(GuestSession);
    expect(guestSession.state.seq).toBe(hostSession.state.seq);
    expect([...guestSession.localSides]).toEqual([1]);

    const heard: string[] = [];
    hostSession.onChat = (from, text) => heard.push(`host saw ${from}: ${text}`);
    guestSession.onChat = (from, text) => heard.push(`guest saw ${from}: ${text}`);
    guestSession.chat('hi');
    await until(() => heard.length === 2);
    expect(heard.sort()).toEqual(['guest saw Guest: hi', 'host saw Guest: hi']);

    // Both players are driven by the AI's move chooser, but each sends moves through its own session.
    const rnd = new Rand(11);
    let steps = 0;
    while (hostSession.state.phase !== 'over') {
      const side = hostSession.state.activeSide;
      const session = hostSession.localSides.has(side) ? hostSession : guestSession;
      await until(() => guestSession.state.seq === hostSession.state.seq);
      const before = hostSession.state.seq;
      session.submit(chooseAction(hostSession.state, side, 'normal', rnd), side);
      await until(() => hostSession.state.seq > before);
      if (++steps > 2000) throw new Error('game did not finish');
    }
    await until(() => guestSession.state.seq === hostSession.state.seq);
    expect(guestSession.state).toEqual(hostSession.state);
    expect(guestSession.state.phase).toBe('over');
    hostSession.dispose();
    guestSession.dispose();
  }, 60000);

  it('refuses a guest acting for a squad that is not theirs', async () => {
    const hostRelay = new RelayClient(url);
    const guestRelay = new RelayClient(url);
    const code = await hostRelay.create('Host');
    const table = newTable('Host', true);
    const hostTable = new HostTable(table, hostRelay, 'Host');
    await guestRelay.join(code, 'Guest');
    const guestTable = new GuestTable(guestRelay, code);
    await until(() => hostTable.table.seats[1].kind === 'human');
    guestTable.updateMine({ ready: true });
    await until(() => hostTable.table.seats[1].ready);
    let hostSession!: GameSession;
    let guestSession!: GuestSession;
    hostTable.onStart = (s) => { hostSession = s; };
    guestTable.onStart = (s) => { guestSession = s as GuestSession; };
    hostTable.start();
    await until(() => !!hostSession && !!guestSession);
    let rejected = '';
    guestSession.onRejected = (e) => { rejected = e; };
    // The host deploys first; the guest tries to end the host's deployment.
    guestSession.submit({ type: 'ready' }, 0);
    await until(() => rejected !== '');
    expect(rejected).toBe('notYourSide');
    expect(hostSession.state.ready[0]).toBe(false);
    hostSession.dispose();
    guestSession.dispose();
  });
});

describe('an online campaign', () => {
  const start = async (guests: string[]) => {
    const relayHost = new RelayClient(url);
    await relayHost.create('Host');
    const camp = createCampaign({
      id: 'o', mode: 'endless', ruleset: 'quick', crewName: 'Berth 9', seed: 21, hostName: 'Host', crew: starterCrew(21), arc: null, llm: false, online: true, gm: 'computer',
    });
    const host = new CampaignHost(camp, { relay: relayHost, name: 'Host', llm: null, lang: () => 'en', resolve: String });
    const out: CampaignGuest[] = [];
    for (const name of guests) {
      const r = new RelayClient(url);
      await r.join(relayHost.code!, name);
      const table = new GuestTable(r, relayHost.code!);
      const got = new Promise<CampaignGuest>((res) => { table.onCampaign = (rc, first) => res(new CampaignGuest(rc, first)); });
      out.push(await got);
    }
    await until(() => host.state.players.length === guests.length + 1);
    return { host, guests: out };
  };

  it('shares one crew between players, each commanding only their own people, then carries on to another job', async () => {
    const { host, guests: [friend] } = await start(['Friend']);
    expect(friend.mySlot).toBe(1);
    expect(friend.state.crew).toHaveLength(4);

    // A friend takes a character, spends on them, and can't touch anyone else's.
    friend.dispatch({ a: 'setOwner', id: 2, slot: 1 });
    await until(() => host.state.crew.find((m) => m.id === 2)!.owner === 1);
    await until(() => friend.state.crew.find((m) => m.id === 2)!.owner === 1);
    let rejected = '';
    friend.onRejected = (e) => { rejected = e; };
    friend.dispatch({ a: 'chrome', id: 1, chrome: 'stim' });
    await until(() => rejected === 'notYours');
    friend.dispatch({ a: 'finishMission', result: { won: true, members: [] } });
    await until(() => rejected === 'hostOnly');

    // Either player can pick the job; everyone goes to the battle.
    let hostSession: any = null;
    let friendSession: any = null;
    host.onMission = (s) => { hostSession = s; };
    friend.onMission = (s) => { friendSession = s; };
    friend.dispatch({ a: 'takeGig', gig: friend.state.offers[0].id, squad: [1, 2] });
    await until(() => !!hostSession && !!friendSession);
    expect(hostSession.state.owners).toEqual({ s0u0: 'host', s0u1: friend['relay'].peerId });
    expect(hostSession.mayControl('s0u0')).toBe(true);
    expect(hostSession.mayControl('s0u1')).toBe(false);
    expect(friendSession.mayControl('s0u0')).toBe(false);
    expect(friendSession.mayControl('s0u1')).toBe(true);

    // The friend can't command the host's character, even by sending the action by hand.
    const rnd = new Rand(5);
    const seen = () => friendSession.state.seq === hostSession.state.seq;
    let refused = false;
    friendSession.onRejected = () => { refused = true; };
    const sideOfCrew = 0;
    let steps = 0;
    while (hostSession.state.phase !== 'over') {
      await until(seen);
      const s = hostSession.state;
      const side = s.activeSide;
      if (side === sideOfCrew && s.phase === 'battle' && !s.activeUnit && !refused) {
        friendSession.submit({ type: 'select', unitId: 's0u0' }, 0);
        await until(() => refused);
      }
      if (side !== sideOfCrew) {
        await new Promise((r) => setTimeout(r, 2));
        hostSession.idle();
        await until(() => hostSession.state.seq > s.seq || hostSession.state.phase === 'over', 3000);
      } else {
        const action = chooseAction(s, side, 'normal', rnd);
        const unit = s.activeUnit ?? (action.type === 'select' ? action.unitId : null);
        const session = unit && !hostSession.mayControl(unit) ? friendSession : hostSession;
        session.submit(action, side);
        await until(() => hostSession.state.seq > s.seq);
      }
      if (++steps > 4000) throw new Error('battle did not finish');
    }
    expect(refused).toBe(true);
    await until(() => host.state.phase === 'debrief');
    await until(() => friend.state.phase === 'debrief');
    expect(friend.state.debrief!.lines).toHaveLength(2);

    // The battle screens close, and the same connection carries on with the campaign.
    hostSession.dispose();
    friendSession.dispose();
    friend.leaveMission();
    host.leaveMission();
    friend.dispatch({ a: 'closeDebrief' });
    await until(() => host.state.phase === 'hub');
    await until(() => friend.state.phase === 'hub');
    hostSession = null;
    friendSession = null;
    host.dispatch({ a: 'rest' });
    const squad = host.state.crew.filter((m) => m.status === 'ok').map((m) => m.id).slice(0, 2);
    host.dispatch({ a: 'takeGig', gig: host.state.offers[0].id, squad });
    await until(() => !!hostSession && !!friendSession);
    expect(friendSession.state.seq).toBe(hostSession.state.seq);
    host.dispose();
    friend.dispose();
  }, 60000);

  it('gives a player back their seat and characters after a reload', async () => {
    const { host, guests: [friend] } = await start(['Friend']);
    friend.dispatch({ a: 'setOwner', id: 1, slot: 1 });
    await until(() => host.state.crew.find((m) => m.id === 1)!.owner === 1);
    let hostSession: any = null;
    host.onMission = (s) => { hostSession = s; };
    host.dispatch({ a: 'takeGig', gig: host.state.offers[0].id, squad: [1, 2] });
    await until(() => !!hostSession);
    // A reload cuts the connection without saying goodbye, then joins again under a new id.
    const old = friend['relay'] as any;
    old.onDrop = () => {};
    old.ws.close();
    await until(() => hostSession.state.owners.s0u0 === 'host');
    const r = new RelayClient(url);
    await r.join(host.code!, 'Friend');
    const table = new GuestTable(r, host.code!);
    const back = await new Promise<CampaignGuest>((res) => { table.onCampaign = (rc, first) => res(new CampaignGuest(rc, first)); });
    expect(back.mySlot).toBe(1);
    await until(() => !!back.session);
    expect(host.state.players).toHaveLength(2);
    expect(hostSession.state.owners.s0u0).toBe(r.peerId);
    expect(back.session!.mayControl('s0u0')).toBe(true);
    expect(back.session!.mayControl('s0u1')).toBe(false);
    host.dispose();
    back.dispose();
  }, 20000);

  it('hands a friend game master the enemy side, and covers a player who drops', async () => {
    const { host, guests: [gm, player] } = await start(['Gamemaster', 'Player']);
    host.dispatch({ a: 'setGm', slot: 1 });
    await until(() => gm.state.gmSlot === 1);
    gm.dispatch({ a: 'gmSay', text: 'The rain gets worse.' });
    await until(() => host.state.transcript.some((l) => l.kind === 'gm'));
    gm.dispatch({ a: 'gmEvent', kind: 'ambush' });
    await until(() => host.state.threatMod === 1);
    player.dispatch({ a: 'setOwner', id: 3, slot: 2 });
    await until(() => host.state.crew.find((m) => m.id === 3)!.owner === 2);

    let hostSession: any = null;
    let gmSession: any = null;
    let playerSession: any = null;
    host.onMission = (s) => { hostSession = s; };
    gm.onMission = (s) => { gmSession = s; };
    player.onMission = (s) => { playerSession = s; };
    host.dispatch({ a: 'takeGig', gig: host.state.offers[0].id, squad: [1, 3] });
    await until(() => !!hostSession && !!gmSession && !!playerSession);
    expect([...gmSession.localSides]).toEqual([1]);
    expect([...playerSession.localSides]).toEqual([0]);
    expect(hostSession.state.cfg.sides[1].control).toBe('human');
    expect(hostSession.state.gmBudget[1]).toBeGreaterThan(0);
    expect(hostSession.state.owners.s0u1).toBe(player['relay'].peerId);

    // The game master's move comes through their own session.
    const side = hostSession.state.activeSide;
    const before = hostSession.state.seq;
    (side === 1 ? gmSession : hostSession).submit({ type: 'ready' }, side);
    await until(() => hostSession.state.seq > before);

    // A dropped player's character goes to the host until they return.
    await until(() => playerSession.state.seq === hostSession.state.seq);
    player['relay'].close();
    await until(() => hostSession.state.owners.s0u1 === 'host');
    expect(hostSession.mayControl('s0u1')).toBe(true);
    host.dispose();
    gm.dispose();
  }, 30000);
});

describe('an online duel', () => {
  it('runs through the relay, and each player only moves their own side', async () => {
    const hr = new RelayClient(url);
    await hr.create('Host');
    const host = new DuelHost(hr, 11, 'quick', 'hacker');
    const gr = new RelayClient(url);
    await gr.join(hr.code!, 'Guest');
    const table = new GuestTable(gr, hr.code!);
    const guest = await new Promise<DuelGuest>((res) => { table.onDuel = (r, first) => res(new DuelGuest(r, first)); });
    expect(guest.me).toBe('corp');
    guest.act({ a: 'end' });
    await wait(100);
    expect(host.state!.active).toBe('hacker');
    host.act({ a: 'end' }, 'hacker');
    await until(() => guest.state.active === 'corp');
    guest.act({ a: 'end' });
    await until(() => host.state!.round === 2);
    host.dispose();
    guest.dispose();
  });
});

describe('saving', () => {
  it('tells the player when saving stops working, and when it recovers', () => {
    const results: boolean[] = [];
    setSaveListener((ok) => results.push(ok));
    const camp = createCampaign({ id: 's', mode: 'endless', ruleset: 'quick', crewName: 'B', seed: 1, hostName: 'H', crew: starterCrew(1), arc: null, llm: false, online: false, gm: 'computer' });
    const store = (globalThis as any).localStorage;
    (globalThis as any).localStorage = { getItem: () => null, removeItem: () => {}, setItem: () => { throw new Error('full'); } };
    saveCampaign(camp, null, false);
    (globalThis as any).localStorage = store;
    saveCampaign(camp, null, false);
    setSaveListener(null);
    expect(results).toEqual([false, true]);
  });
});

