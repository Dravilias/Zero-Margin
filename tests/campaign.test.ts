import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/engine/ai';
import {
  END, applyCampaign, availableGigs, buildMission, createCampaign, enemyPoints, makeCrew, missionResult, nodeOf, starterCrew,
  type Arc, type CampaignAction, type CampaignState, type MissionResult, type Txt,
} from '../src/engine/campaign';
import { ROLES } from '../src/engine/data';
import { applyAction, createGame } from '../src/engine/game';
import { Rand } from '../src/engine/rng';
import { THE_NOTE, generateArc } from '../src/engine/story';
import { LocalSession } from '../src/net/sessions';
import { DICTIONARIES } from '../src/ui/i18n';

function newCamp(over: Partial<Parameters<typeof createCampaign>[0]> = {}): CampaignState {
  return createCampaign({
    id: 't', mode: 'story', ruleset: 'standard', crewName: 'Berth 9', seed: 77, hostName: 'Host', crew: starterCrew(77), arc: THE_NOTE,
    llm: false, online: false, gm: 'computer', ...over,
  });
}

function act(s: CampaignState, action: CampaignAction, slot = 0): CampaignState {
  const r = applyCampaign(s, action, slot);
  if (!r.ok) throw new Error(`${action.a} refused: ${r.error}`);
  return r.state;
}

const refused = (s: CampaignState, action: CampaignAction, slot = 0) => applyCampaign(s, action, slot).error;

function win(squad: number): MissionResult {
  return { won: true, members: Array.from({ length: squad }, () => ({ state: 'ok', kills: 1, dealt: 5 })) };
}

/** Walks a story to its end, taking whichever allowed choice `pick` says and winning every job. */
function playThrough(start: CampaignState, pick: (ids: string[]) => string): CampaignState {
  let s = start;
  for (let guard = 0; guard < 80 && s.phase !== 'ending'; guard++) {
    if (s.phase === 'scene') {
      const n = nodeOf(s);
      if (n?.kind !== 'scene') throw new Error('scene without a node');
      const open = n.choices.filter((c) => (c.needCash === undefined || s.cash >= c.needCash) && (!c.needFlag || s.flags.includes(c.needFlag)));
      expect(open.length).toBeGreaterThan(0);
      s = act(s, { a: 'choose', choice: pick(open.map((c) => c.id)) });
    } else if (s.phase === 'hub') {
      const gig = availableGigs(s).find((g) => g.story);
      if (!gig) throw new Error(`no story job at ${s.node}`);
      const squad = s.crew.filter((m) => m.status === 'ok').slice(0, 4).map((m) => m.id);
      s = act(s, { a: 'takeGig', gig: gig.id, squad });
      expect(s.phase).toBe('mission');
      s = act(s, { a: 'finishMission', result: win(squad.length) });
      s = act(s, { a: 'closeDebrief' });
    } else throw new Error(`stuck in ${s.phase}`);
  }
  return s;
}

function resolve(dict: Record<string, string>, x: Txt): string {
  const lookup = (k: string) => dict[k] ?? k;
  if (typeof x === 'string') return lookup(x);
  let out = lookup(x.k);
  for (const [k, v] of Object.entries(x.v)) out = out.split(`{${k}}`).join(typeof v === 'string' ? lookup(v) : String(v));
  return out;
}

function arcTexts(arc: Arc): Txt[] {
  const out: Txt[] = [arc.title, arc.premise];
  for (const n of arc.nodes) {
    if (n.kind === 'scene') {
      out.push(n.text);
      if (n.speaker) out.push(n.speaker);
      for (const c of n.choices) {
        out.push(c.label);
        if (c.result) out.push(c.result);
      }
    } else out.push(n.gig.title, n.gig.brief, n.gig.won, n.gig.lost);
  }
  for (const e of arc.endings) out.push(e.title, e.text);
  return out;
}

function checkTexts(arc: Arc): void {
  for (const lang of ['en', 'pl'] as const) {
    for (const x of arcTexts(arc)) {
      const text = resolve(DICTIONARIES[lang], x);
      expect(text, JSON.stringify(x)).not.toMatch(/[{}]/);
      expect(text, `${lang} is missing ${JSON.stringify(x)}`).not.toMatch(/^(note|gen|gig|gigt|gigb)\.[a-z0-9.]+$/);
    }
  }
}

function checkGraph(arc: Arc): void {
  const ids = new Set(arc.nodes.map((n) => n.id));
  expect(ids.size).toBe(arc.nodes.length);
  expect(ids.has(arc.start)).toBe(true);
  const reached = new Set<string>();
  const walk = (id: string) => {
    if (id === END || reached.has(id)) return;
    expect(ids.has(id), `missing node ${id}`).toBe(true);
    reached.add(id);
    const i = arc.nodes.findIndex((n) => n.id === id);
    const after = arc.nodes[i + 1]?.id ?? END;
    const n = arc.nodes[i];
    if (n.kind === 'gig') walk(n.next ?? after);
    else for (const c of n.choices) walk(c.next ?? after);
  };
  walk(arc.start);
  expect([...ids].filter((id) => !reached.has(id))).toEqual([]);
  expect(arc.endings[arc.endings.length - 1].needFlag).toBeUndefined();
}

describe('stories', () => {
  it('The Note has no dead ends, and its text exists in both languages', () => {
    checkGraph(THE_NOTE);
    checkTexts(THE_NOTE);
  });

  it('every ending of The Note can be reached', () => {
    const endings = new Set<string>();
    for (const c4 of ['broadcast', 'leverage', 'sell']) {
      let t = newCamp();
      for (let i = 0; i < 80 && t.phase !== 'ending'; i++) {
        if (t.phase === 'scene') {
          const n = nodeOf(t)!;
          t = act(t, { a: 'choose', choice: n.id === 'c4' ? c4 : n.id === 'c3' ? 'take' : (n as { choices: { id: string }[] }).choices[0].id });
        } else {
          const gig = availableGigs(t).find((g) => g.story)!;
          t = act(t, { a: 'takeGig', gig: gig.id, squad: [1] });
          t = act(t, { a: 'finishMission', result: win(1) });
          t = act(t, { a: 'closeDebrief' });
        }
      }
      endings.add(resolve(DICTIONARIES.en, t.ending!.title));
    }
    expect([...endings].sort()).toEqual(['Low Tide', 'Paid in Full', 'The Note Holder']);
  });

  it('generated stories differ, run to an end, and read properly in both languages', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const arc = generateArc(seed * 7919);
      checkGraph(arc);
      checkTexts(arc);
      seen.add(JSON.stringify(arc.nodes.map((n) => (n.kind === 'scene' ? n.text : n.gig.scenario + n.gig.enemy))));
    }
    expect(seen.size).toBeGreaterThan(250);
    const done = playThrough(newCamp({ arc: generateArc(123) }), (open) => open[open.length - 1]);
    expect(done.ending).not.toBeNull();
  });

  it('a generated story avoids what this crew has already done', () => {
    const first = generateArc(5);
    const notes = JSON.parse(first.bible!) as { patron: string; stake: string };
    for (let seed = 0; seed < 50; seed++) {
      const next = JSON.parse(generateArc(seed, { patrons: [notes.patron], stakes: [notes.stake] }).bible!) as { patron: string; stake: string };
      expect(next.patron).not.toBe(notes.patron);
      expect(next.stake).not.toBe(notes.stake);
    }
  });

  it('the same crew carries on into another story, and the next one is harder', () => {
    let s = playThrough(newCamp(), (open) => open[0]);
    expect(s.phase).toBe('ending');
    expect(s.arcsDone).toBe(1);
    expect(s.chronicle).toHaveLength(1);
    const crewBefore = s.crew.map((m) => [m.id, m.level]);
    const arc = generateArc(9, s.used);
    s = act(s, { a: 'nextArc', arc });
    expect(s.crew.map((m) => [m.id, m.level])).toEqual(crewBefore);
    expect(s.flags).toEqual([]);
    s = playThrough(s, (open) => open[0]);
    expect(s.chronicle).toHaveLength(2);
    expect(s.used.patrons).toHaveLength(1);
    s = act(s, { a: 'toEndless' });
    expect(s.mode).toBe('endless');
    expect(availableGigs(s)).toHaveLength(3);
  });
});

describe('between jobs', () => {
  it('charges for hiring, gear and chrome, and refuses what you can’t afford', () => {
    let s = act(newCamp(), { a: 'choose', choice: 'take' });
    const start = s.cash;
    s = act(s, { a: 'hire', role: 'punk', name: 'Test' });
    expect(s.cash).toBe(start - ROLES.punk.cost * 50);
    expect(s.crew).toHaveLength(5);
    s = { ...s, phase: 'hub', cash: 10 };
    expect(refused(s, { a: 'hire', role: 'breaker', name: '' })).toBe('noCash');
    s = { ...s, cash: 1000 };
    const id = s.crew.find((m) => m.role === 'breaker')!.id;
    s = act(s, { a: 'weapon', id, kind: 'ranged', weapon: 'smg' });
    expect(s.cash).toBe(850);
    expect(refused(s, { a: 'weapon', id, kind: 'ranged', weapon: 'sniper' })).toBe('badWeapon');
    s = act(s, { a: 'chrome', id, chrome: 'dermal' });
    expect(s.crew.find((m) => m.id === id)!.chrome).toEqual(['dermal']);
    expect(s.cash).toBe(600);
  });

  it('fits one person with up to four pieces of chrome and takes them all into battle', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    s = { ...s, cash: 5000 };
    const pieces = ['dermal', 'stim', 'dashlegs', 'smartlink'] as const;
    for (const chrome of pieces) s = act(s, { a: 'chrome', id: 1, chrome });
    expect(s.crew.find((m) => m.id === 1)!.chrome).toEqual(pieces);
    expect(refused(s, { a: 'chrome', id: 1, chrome: 'claws' })).toBe('chromeFull');
    s = act(s, { a: 'takeGig', gig: s.offers[1].id, squad: [1, 3] });
    const unit = buildMission(s).units.find((u) => u.id === 's0u0')!;
    expect(unit.chrome).toEqual(pieces);
  });

  it('heals by clinic, by sitting out, or by resting', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1, 2] });
    s = act(s, { a: 'finishMission', result: { won: false, members: [{ state: 'down', kills: 0, dealt: 0 }, { state: 'dead', kills: 0, dealt: 0 }] } });
    expect(s.debrief!.lines.map((l) => l.outcome)).toEqual(['wounded', 'wounded']);
    s = act(s, { a: 'closeDebrief' });
    expect(refused(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] })).toBe('badSquad');
    const cash = s.cash;
    s = act(s, { a: 'clinic', id: 1 });
    expect(s.cash).toBeLessThan(cash);
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
    s = act(s, { a: 'finishMission', result: win(1) });
    expect(s.crew.find((m) => m.id === 2)!.status).toBe('ok');
    s = act(s, { a: 'closeDebrief' });
    const broke = { ...s, cash: 0, crew: s.crew.map((m) => ({ ...m, status: 'wounded' as const })) };
    const rested = act(broke, { a: 'rest' });
    expect(rested.cash).toBe(0);
    expect(rested.crew.every((m) => m.status === 'ok')).toBe(true);
  });

  it('keeps the dead dead only under full rules, and ends the game if nobody is left', () => {
    for (const ruleset of ['quick', 'standard', 'full'] as const) {
      let s = newCamp({ mode: 'endless', arc: null, ruleset });
      s = { ...s, crew: [makeCrew(1, 'breaker', 'Solo')], cash: 0 };
      s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
      s = { ...s, mission: { ...s.mission!, gig: { ...s.mission!.gig, pay: 0 } } };
      s = act(s, { a: 'finishMission', result: { won: false, members: [{ state: 'dead', kills: 0, dealt: 0 }] } });
      expect(s.crew[0].status).toBe(ruleset === 'full' ? 'dead' : 'wounded');
      s = act(s, { a: 'closeDebrief' });
      expect(s.phase).toBe(ruleset === 'full' ? 'over' : 'hub');
    }
  });

  it('levels people up and spends advances', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
    s = act(s, { a: 'finishMission', result: { won: true, members: [{ state: 'ok', kills: 6, dealt: 40 }] } });
    expect(s.debrief!.lines[0].levelUp).toBe(true);
    const m = () => s.crew.find((c) => c.id === 1)!;
    expect(m().level).toBeGreaterThan(1);
    const before = m().points;
    s = act(s, { a: 'advance', id: 1, pick: 'aim' });
    expect(m().bonus.stats.aim).toBe(1);
    expect(m().points).toBe(before - 1);
  });

  it('never gives a story nothing to choose: a job lost can be taken again', () => {
    let s = newCamp();
    s = act(s, { a: 'choose', choice: 'take' });
    const gig = availableGigs(s).find((g) => g.story)!;
    s = act(s, { a: 'takeGig', gig: gig.id, squad: [1] });
    s = act(s, { a: 'finishMission', result: { won: false, members: [{ state: 'ok', kills: 0, dealt: 0 }] } });
    s = act(s, { a: 'closeDebrief' });
    expect(s.node).toBe(gig.id);
    expect(availableGigs(s).find((g) => g.story)!.id).toBe(gig.id);
    expect(availableGigs(s).find((g) => g.story)!.mapSeed).not.toBe(gig.mapSeed);
  });
});

describe('players', () => {
  it('only lets the host do host things, and players only touch their own people', () => {
    let s = newCamp({ online: true });
    s = act(s, { a: 'choose', choice: 'take' });
    s = act(s, { a: 'setPlayers', players: [...s.players, { name: 'Friend', peer: 'p1', connected: true }, { name: 'Other', peer: 'p2', connected: true }] });
    expect(refused(s, { a: 'finishMission', result: win(1) }, 1)).toBe('hostOnly');
    expect(refused(s, { a: 'setPlayers', players: [] }, 1)).toBe('hostOnly');
    expect(refused(s, { a: 'narrate', node: 'c1', text: 'x' }, 1)).toBe('hostOnly');
    expect(refused(s, { a: 'clinic', id: 99 }, 1)).toBe('noCrew');
    // A friend can take a character the host is covering, but not move it to someone else.
    expect(refused(s, { a: 'setOwner', id: 1, slot: 2 }, 1)).toBe('notYours');
    s = act(s, { a: 'setOwner', id: 1, slot: 1 }, 1);
    expect(refused(s, { a: 'setOwner', id: 1, slot: 2 }, 2)).toBe('notYours');
    expect(refused(s, { a: 'chrome', id: 2, chrome: 'stim' }, 1)).toBe('notYours');
    expect(refused(s, { a: 'icon', id: 2, icon: 'sym:star' }, 1)).toBe('notYours');
    s = act(s, { a: 'chrome', id: 1, chrome: 'stim' }, 1);
    // The game master can't also play the crew.
    s = act(s, { a: 'setGm', slot: 1 });
    expect(s.crew.find((m) => m.id === 1)!.owner).toBe(0);
    const gig = availableGigs(s)[0];
    expect(refused(s, { a: 'takeGig', gig: gig.id, squad: [1] }, 1)).toBe('gmOnly');
    s = act(s, { a: 'gmEvent', kind: 'ambush' }, 1);
    expect(s.threatMod).toBe(1);
    expect(refused(s, { a: 'gmEvent', kind: 'windfall' }, 1)).toBe('eventUsed');
    expect(refused(s, { a: 'gmEvent', kind: 'windfall' }, 2)).toBe('gmOnly');
  });

  it('lets each character wear a symbol or a small picture of their own into battle', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    const pic = `img:data:image/webp;base64,${'A'.repeat(4000)}`;
    s = act(s, { a: 'icon', id: 1, icon: 'sym:skull' });
    expect(s.crew.find((m) => m.id === 1)!.icon).toBe('sym:skull');
    s = act(s, { a: 'icon', id: 2, icon: pic });
    for (const bad of ['sym:nope', 'img:https://example.com/a.png', 'img:data:image/svg+xml;base64,AAAA', 'img:data:image/png;base64,<script>', `img:data:image/png;base64,${'A'.repeat(30000)}`, '']) {
      expect(refused(s, { a: 'icon', id: 1, icon: bad }), bad.slice(0, 40)).toBe('badIcon');
    }
    s = act(s, { a: 'takeGig', gig: s.offers[1].id, squad: [1, 2, 3] });
    const units = buildMission(s).units.filter((u) => u.side === 0);
    expect(units.find((u) => u.id === 's0u0')!.icon).toBe('sym:skull');
    expect(units.find((u) => u.id === 's0u1')!.icon).toBe(pic);
    expect(units.find((u) => u.id === 's0u2')!.icon).toBeUndefined();
    // Taking it off goes back to the role icon.
    const back = act(newCamp({ mode: 'endless', arc: null }), { a: 'icon', id: 1, icon: 'sym:star' });
    expect(act(back, { a: 'icon', id: 1, icon: null }).crew.find((m) => m.id === 1)!.icon).toBeUndefined();
  });

  it('lets about half of all failed free actions pass without a penalty', () => {
    let failed = 0;
    let quiet = 0;
    let threat = 0;
    let rep = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const r = applyCampaign(newCamp({ llm: true, seed }), { a: 'freeRoll', text: 'I bluff the guard', actor: 1, stat: 'wire', tn: 20, from: 'Host' }, 0).roll!;
      if (r.ok) {
        expect(r.cash).toBeGreaterThanOrEqual(100);
        expect(r.threat + r.rep).toBe(0);
        continue;
      }
      failed++;
      expect(r.cash).toBe(0);
      expect(r.threat && r.rep).toBe(0);
      if (r.threat) threat++;
      else if (r.rep) rep++;
      else quiet++;
    }
    expect(failed).toBeGreaterThan(300);
    expect(quiet / failed).toBeGreaterThan(0.4);
    expect(quiet / failed).toBeLessThan(0.6);
    expect(threat).toBeGreaterThan(0);
    expect(rep).toBeGreaterThan(0);
  });

  it('rolls free actions with the engine and limits them', () => {
    let s = newCamp({ llm: true });
    const one = applyCampaign(s, { a: 'freeRoll', text: 'I bluff the guard', actor: 1, stat: 'nerve', tn: 99, from: 'Host' }, 0);
    expect(one.ok).toBe(true);
    // However hard the model calls it, a 10 on the die still gets there.
    expect(one.roll!.tn).toBe(one.roll!.mod + 10);
    s = one.state;
    s = act(s, { a: 'freeRoll', text: 'Again', actor: 1, stat: 'aim', tn: 1, from: 'Host' });
    expect(refused(s, { a: 'freeRoll', text: 'Once more', actor: 1, stat: 'aim', tn: 10, from: 'Host' })).toBe('freeUsed');
    expect(s.transcript.filter((l) => l.kind === 'free')).toHaveLength(2);
    expect(refused(newCamp({ llm: true }), { a: 'freeRoll', text: 'x', actor: 1, stat: 'luck' as never, tn: 10, from: '' })).toBe('badStat');
  });
});

describe('battles from the campaign', () => {
  it('builds a fight from the crew, their gear and what they’ve earned', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    const id = 1;
    s = { ...s, cash: 5000, crew: s.crew.map((m) => (m.id === id ? { ...m, points: 1 } : m)) };
    s = act(s, { a: 'advance', id, pick: 'grit' });
    s = act(s, { a: 'chrome', id, chrome: 'dermal' });
    s = act(s, { a: 'takeGig', gig: s.offers[1].id, squad: [1, 3] });
    const game = buildMission(s);
    const unit = game.units.find((u) => u.id === 's0u0')!;
    const member = s.crew.find((m) => m.id === id)!;
    expect(unit.name).toBe(member.name);
    expect(unit.chrome).toEqual(['dermal']);
    expect(unit.stats.grit).toBe(ROLES[member.role].stats.grit + 1);
    expect(game.units.filter((u) => u.side === 0)).toHaveLength(2);
    expect(game.units.filter((u) => u.side === 1).length).toBeGreaterThan(0);
    expect(game.cfg.sides[1].control).toBe('ai');
    expect(game.gmBudget).toBeUndefined();
    const members = [member, s.crew.find((m) => m.id === 3)!];
    const value = game.units.filter((u) => u.side === 1).reduce((sum, u) => sum + u.value, 0);
    expect(value).toBeLessThanOrEqual(enemyPoints(members, s.mission!.gig.threat));
  });

  it('plays a real fight with the rules engine and reads the result back to the right people', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [4, 2] });
    let game = buildMission(s);
    const rnd = new Rand(4);
    for (let i = 0; i < 3000 && game.phase !== 'over'; i++) {
      const side = game.activeSide;
      const res = applyAction(game, chooseAction(game, side, 'normal', rnd), side);
      game = res.ok ? res.state : applyAction(game, game.activeUnit ? { type: 'end' } : { type: 'ready' }, side).state;
    }
    expect(game.phase).toBe('over');
    const result = missionResult(game);
    expect(result.members).toHaveLength(2);
    s = act(s, { a: 'finishMission', result });
    expect(s.debrief!.lines.map((l) => l.id)).toEqual([4, 2]);
    expect(s.debrief!.lines.map((l) => l.name)).toEqual([s.crew.find((m) => m.id === 4)!.name, s.crew.find((m) => m.id === 2)!.name]);
    expect(s.debrief!.won).toBe(game.winner === 0);
  });

  it('counts pulling out as hurt, not dead, even under full rules', () => {
    let s = newCamp({ mode: 'endless', arc: null, ruleset: 'full' });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
    const game = applyAction(buildMission(s), { type: 'concede' }, 0).state;
    s = act(s, { a: 'finishMission', result: missionResult(game) });
    expect(s.crew.find((m) => m.id === 1)!.status).toBe('wounded');
    expect(s.debrief!.won).toBe(false);
    // Walking away straight away mustn't be a way to farm money or experience.
    expect(s.debrief!.pay).toBe(0);
    expect(s.debrief!.lines[0].xp).toBe(0);
  });

  it('lets a human game master bring in reinforcements, within budget and on their own ground', () => {
    let s = newCamp({ mode: 'endless', arc: null, gm: 'local' });
    s = act(s, { a: 'takeGig', gig: s.offers[1].id, squad: [1, 2] });
    let game = buildMission(s);
    expect(game.cfg.sides[1].control).toBe('human');
    const budget = game.gmBudget![1];
    expect(budget).toBeGreaterThan(0);
    game = applyAction(game, { type: 'ready' }, game.activeSide).state;
    game = applyAction(game, { type: 'ready' }, game.activeSide).state;
    if (game.activeSide !== 1) {
      const u = game.units.find((x) => x.side === 0)!;
      game = applyAction(game, { type: 'select', unitId: u.id }, 0).state;
      game = applyAction(game, { type: 'end' }, 0).state;
    }
    expect(game.activeSide).toBe(1);
    const z = game.map.zones[1];
    const taken = (x: number, y: number) => game.units.some((u) => u.x === x && u.y === y);
    let spot: [number, number] | null = null;
    for (let y = z.y; y < z.y + z.h && !spot; y++) for (let x = z.x; x < z.x + z.w && !spot; x++) if ('.'.includes(game.map.tiles[y * game.map.w + x]) && !taken(x, y)) spot = [x, y];
    const units = game.units.length;
    const ok = applyAction(game, { type: 'reinforce', role: 'punk', x: spot![0], y: spot![1] }, 1);
    expect(ok.ok).toBe(true);
    expect(ok.state.units).toHaveLength(units + 1);
    expect(ok.state.gmBudget![1]).toBe(budget - ROLES.punk.cost);
    expect(ok.state.units[units].activated).toBe(true);
    const outside = applyAction(game, { type: 'reinforce', role: 'punk', x: game.map.zones[0].x, y: game.map.zones[0].y }, 1);
    expect(outside.ok).toBe(false);
    const broke = applyAction({ ...game, gmBudget: { 1: 1 } }, { type: 'reinforce', role: 'punk', x: spot![0], y: spot![1] }, 1);
    expect(broke.error).toBe('noBudget');
    const computer = createGame({ ...game.cfg, sides: game.cfg.sides.map((c) => ({ ...c, control: 'ai' as const })) });
    expect(applyAction(computer, { type: 'ready' }, computer.activeSide).state.gmBudget).toBeUndefined();
  });
});

describe('depth rules', () => {
  const hub = () => newCamp({ mode: 'endless', arc: null });

  it('charges humanity for chrome, wears down nerve, and makes people unstable at zero', () => {
    let s = { ...hub(), cash: 99999 };
    const before = s.crew[0].humanity;
    s = act(s, { a: 'chrome', id: 1, chrome: 'stim' });
    expect(s.crew[0].humanity).toBeLessThan(before);
    expect(s.crew[0].humanityMax).toBe(before - 2);
    const lost = s.crew[0].humanity;
    s = act(s, { a: 'therapy', id: 1 });
    expect(s.crew[0].humanity).toBeGreaterThan(lost);
    s = { ...s, crew: s.crew.map((m) => (m.id === 1 ? { ...m, humanity: 0 } : m)) };
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1, 2] });
    const game = buildMission(s);
    const u = game.units.find((x) => x.id === 's0u0')!;
    expect(u.unstable).toBe(true);
    expect(u.stats.nerve).toBeLessThan(ROLES[u.role].stats.nerve);
  });

  it('keeps lasting injuries until treated', () => {
    let s = hub();
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
    s = act(s, { a: 'finishMission', result: { won: true, members: [{ state: 'ok', kills: 0, dealt: 0, injuries: ['brokenLeg'] }] } });
    s = act(s, { a: 'closeDebrief' });
    s = act(s, { a: 'rest' });
    expect(s.crew[0].injuries).toEqual(['brokenLeg']);
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1] });
    expect(buildMission(s).units[0].injuries).toEqual(['brokenLeg']);
    s = act(s, { a: 'finishMission', result: win(1) });
    s = act(s, { a: 'closeDebrief' });
    s = act(s, { a: 'treat', id: 1, injury: 'brokenLeg' });
    expect(s.crew[0].injuries).toEqual([]);
  });

  it('gives the non-combat roles their effects', () => {
    let s = createCampaign({ id: 't', mode: 'story', ruleset: 'standard', crewName: 'B', seed: 1, hostName: 'H', arc: THE_NOTE, llm: false, online: false, gm: 'computer',
      crew: [{ role: 'suit', name: 'S' }, { role: 'broker', name: 'B' }, { role: 'face', name: 'F' }] });
    s = act(s, { a: 'roleMove', role: 'broker' });
    expect(refused(s, { a: 'roleMove', role: 'face' })).toBe('freeUsed');
    expect(refused(s, { a: 'roleMove', role: 'breaker' })).toBe('badRole');
    s = act(s, { a: 'choose', choice: 'take' });
    const gig = availableGigs(s).find((g) => g.story)!;
    s = act(s, { a: 'takeGig', gig: gig.id, squad: [1] });
    const game = buildMission(s);
    expect(game.units.filter((u) => u.side === 0)).toHaveLength(2);
    s = act(s, { a: 'finishMission', result: missionResult({ ...game, winner: 0 }) });
    expect(s.debrief!.lines).toHaveLength(1);
    expect(s.debrief!.pay).toBeGreaterThan(gig.pay);
    expect(s.debrief!.rep).toBe(2);
  });

  it('runs luck, focus, jacking in and snapping in a real fight', () => {
    const base = { faction: 'union' as const, aiLevel: 'normal' as const };
    const load = (role: 'breaker' | 'wire', extra = {}) => ({ role, ranged: 'pistol' as const, melee: 'shiv' as const, chrome: [], extra: { frag: 0, smoke: 0, emp: 0 }, rank: 3, ...extra });
    let g = createGame({ seed: 5, scenario: 'flatline', ruleset: 'full', mapSize: 'small', theme: 'docks', maxRounds: 8, points: 999, sides: [
      { ...base, name: 'A', team: 0, control: 'human', roster: [load('breaker'), load('wire')] },
      { ...base, faction: 'meridian', name: 'B', team: 1, control: 'human', roster: [load('wire')] },
    ] });
    g = applyAction(g, { type: 'ready' }, 0).state;
    g = applyAction(g, { type: 'ready' }, 1).state;
    const side = g.activeSide;
    const breaker = g.units.find((u) => u.role === 'breaker')!;
    if (side === 0) {
      g = applyAction(g, { type: 'select', unitId: breaker.id }, 0).state;
      const u = () => g.units.find((x) => x.id === breaker.id)!;
      expect(u().focus.aim).toBe(3);
      g = applyAction(g, { type: 'focus', kind: 'guard' }, 0).state;
      expect(u().focus.guard).toBe(1);
      const luck = u().luck;
      g = applyAction(g, { type: 'luck' }, 0).state;
      expect(u().luck).toBe(luck - 1);
      expect(u().luckBonus).toBe(2);
    }
    const rnd = new Rand(9);
    // Two AI-driven hackers and a breaker must always finish, whatever network actions they take.
    for (let i = 0; i < 4000 && g.phase !== 'over'; i++) {
      const res = applyAction(g, chooseAction(g, g.activeSide, 'normal', rnd), g.activeSide);
      expect(res.ok, res.error).toBe(true);
      g = res.state;
    }
    expect(g.phase).toBe('over');
    let snapped = 0;
    for (let seed = 1; seed <= 12; seed++) {
    let h = createGame({ seed, scenario: 'flatline', ruleset: 'standard', mapSize: 'small', theme: 'docks', maxRounds: 8, points: 999, sides: [
      { ...base, name: 'A', team: 0, control: 'ai', roster: [load('breaker', { unstable: true }), load('breaker')] },
      { ...base, faction: 'meridian', name: 'B', team: 1, control: 'ai', roster: [load('breaker')] },
    ] });
    for (let i = 0; i < 3000 && h.phase !== 'over'; i++) {
      const res = applyAction(h, chooseAction(h, h.activeSide, 'normal', rnd), h.activeSide);
      expect(res.ok, res.error).toBe(true);
      snapped += res.events.filter((e) => e.t === 'snap').length;
      h = res.state;
    }
    expect(h.phase).toBe('over');
    }
    expect(snapped).toBeGreaterThan(0);
  });
});

describe('actions from other players are not trusted', () => {
  it('lets the other side command a crew member who has snapped', () => {
    const state = { cfg: { seed: 1 }, owners: { s0u0: 'p1' }, units: [{ id: 's0u0', snapped: { side: 0, team: 0 } }] };
    const session = new LocalSession(state as never, [1]);
    expect(session.mayControl('s0u0')).toBe(true);
  });

  it('lets a guest bring only their own people on a job, and the host anyone', () => {
    const s = act(newCamp({ mode: 'endless', arc: null, online: true }), { a: 'setPlayers', players: [{ name: 'H', peer: null, connected: true }, { name: 'F', peer: 'p', connected: true }] });
    const own = act(s, { a: 'setOwner', id: 1, slot: 1 }, 1);
    const gig = own.offers[0].id;
    expect(refused(own, { a: 'takeGig', gig, squad: [1, 2] }, 1)).toBe('notYours');
    expect(refused(own, { a: 'takeGig', gig, squad: [1] }, 1)).toBeUndefined();
    expect(refused(own, { a: 'takeGig', gig, squad: [1, 2] }, 0)).toBeUndefined();
  });

  it('charges for a weapon once, so switching back is free', () => {
    let s = act(newCamp({ mode: 'endless', arc: null }), { a: 'rest' });
    const id = s.crew.find((m) => m.role === 'breaker')!.id;
    const start = s.crew.find((m) => m.id === id)!.ranged!;
    const cash = s.cash;
    s = act(s, { a: 'weapon', id, kind: 'ranged', weapon: 'smg' });
    expect(s.cash).toBe(cash - 150);
    s = act(s, { a: 'weapon', id, kind: 'ranged', weapon: start });
    s = act(s, { a: 'weapon', id, kind: 'ranged', weapon: 'smg' });
    expect(s.cash).toBe(cash - 150);
  });

  const online = () => {
    let s = newCamp({ mode: 'endless', arc: null, online: true });
    s = act(s, { a: 'setPlayers', players: [...s.players, { name: 'F', peer: 'p', connected: true }] });
    return act(s, { a: 'setOwner', id: 1, slot: 1 }, 1);
  };

  it('refuses names inherited from Object, so cash can never become NaN', () => {
    const s = online();
    expect(refused(s, { a: 'grenade', id: 1, kind: 'constructor' as never }, 1)).toBe('badGrenade');
    expect(refused(s, { a: 'chrome', id: 1, chrome: 'constructor' as never }, 1)).toBe('badChrome');
    expect(refused(s, { a: 'setOwner', id: 2, slot: 'constructor' as never }, 1)).toBe('badPlayer');
    expect(s.cash).toBe(1000);
  });

  it('refuses malformed actions instead of throwing', () => {
    const s = online();
    expect(refused(s, null as never, 1)).toBe('badAction');
    expect(refused(s, { a: 'takeGig', gig: s.offers[0].id, squad: {} as never }, 1)).toBe('badSquad');
    expect(refused(s, { a: 'takeGig', gig: s.offers[0].id, squad: 5 as never }, 1)).toBe('badSquad');
  });

  it('only lets a player pay for healing their own people', () => {
    const s = online();
    const hurt = { ...s, crew: s.crew.map((m) => ({ ...m, status: 'wounded' as const, humanity: 10, injuries: ['brokenArm' as const] })) };
    for (const a of [{ a: 'clinic', id: 2 }, { a: 'therapy', id: 2 }, { a: 'treat', id: 2, injury: 'brokenArm' }] as CampaignAction[]) {
      expect(refused(hurt, a, 1)).toBe('notYours');
      expect(refused(hurt, { ...a, id: 1 } as CampaignAction, 1)).toBeUndefined();
      expect(refused(hurt, a, 0)).toBeUndefined();
    }
  });

  it('keeps the dead dead when the rest of the crew retreats on the Full Contract', () => {
    let s = newCamp({ mode: 'endless', arc: null, ruleset: 'full' });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1, 2] });
    const game = buildMission(s);
    game.units.find((u) => u.id === 's0u0')!.state = 'dead';
    const after = applyAction(game, { type: 'concede' }, 0).state;
    s = act(s, { a: 'finishMission', result: missionResult(after) });
    expect(s.crew.find((m) => m.id === 1)!.status).toBe('dead');
    expect(s.crew.find((m) => m.id === 2)!.status).toBe('wounded');
  });

  it('refuses malformed battle actions, and a conceding carrier drops the core', () => {
    let s = newCamp({ mode: 'endless', arc: null });
    s = act(s, { a: 'takeGig', gig: s.offers[0].id, squad: [1, 2] });
    const game = buildMission(s);
    const side = game.activeSide;
    const u = game.units.find((x) => x.side === side)!;
    expect(applyAction(game, null as never, side).error).toBe('badAction');
    expect(applyAction(game, { type: 'place', unitId: u.id, x: 1.25, y: 0.75 }, side).error).toBe('badAction');
    expect(applyAction(game, { type: 'place', unitId: u.id, x: '2' as never, y: 3 }, side).error).toBe('badAction');
    expect(applyAction(game, { type: 'grenade', kind: 'constructor' as never, x: 1, y: 1 }, side).error).toBe('badAction');
    expect(applyAction(game, { type: 'focus', kind: 'bogus' as never }, side).error).toBe('badAction');
    const heist = { ...game, core: { x: u.x, y: u.y, carrier: u.id } };
    const out = applyAction(heist, { type: 'concede' }, side).state;
    expect(out.core!.carrier).toBeNull();
  });
});
