import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/engine/ai';
import { applyAction, losBetween, previewAttack, reachable, stoppable, unitById } from '../src/engine/game';
import { Rand } from '../src/engine/rng';
import { ANCHOR, CLINKER, RIVET, SOOT, TUTORIAL_STEPS, createTutorialGame, sameAction } from '../src/engine/tutorial';
import type { GameEvent, GameState } from '../src/engine/types';
import { DICTIONARIES } from '../src/ui/i18n';

function playTo(stopAt: string): { s: GameState; events: GameEvent[] } {
  let s = createTutorialGame();
  const events: GameEvent[] = [];
  for (const step of TUTORIAL_STEPS) {
    if (step.id === stopAt) break;
    const actions = step.kind === 'do' ? [step.action!] : step.kind === 'enemy' ? step.script! : [];
    for (const action of actions) {
      const res = applyAction(s, action, s.activeSide);
      expect(res.ok, `${step.id}: ${JSON.stringify(action)} ${res.error}`).toBe(true);
      s = res.state;
      events.push(...res.events);
    }
  }
  return { s, events };
}

describe('tutorial script', () => {
  it('finishes every guided step, in order, with legal actions', () => {
    let s = createTutorialGame();
    for (const step of TUTORIAL_STEPS) {
      const actions = step.kind === 'do' ? [step.action!] : step.kind === 'enemy' ? step.script! : [];
      for (const action of actions) {
        const res = applyAction(s, action, s.activeSide);
        expect(res.ok, `${step.id}: ${res.error}`).toBe(true);
        s = res.state;
      }
      if (step.done) expect(step.done(s), `${step.id} should be done`).toBe(true);
    }
    expect(s.phase).toBe('battle');
    expect(s.activeSide).toBe(0);
    expect(TUTORIAL_STEPS[TUTORIAL_STEPS.length - 1].kind).toBe('free');
  });

  it('plays out exactly as the lesson text says', () => {
    const { s, events } = playTo('free');
    const attacks = events.filter((e) => e.t === 'attack');
    const shot = (a: string, b: string) => attacks.find((e) => e.t === 'attack' && e.unit === a && e.target === b);
    expect(shot(RIVET, SOOT)).toMatchObject({ hit: true });
    expect(shot(SOOT, RIVET)).toMatchObject({ hit: false });
    // "Without the cover, that roll would have hit": it misses, but by no more than cover's +2.
    const sootShot = shot(SOOT, RIVET) as Extract<GameEvent, { t: 'attack' }>;
    expect(sootShot.cover).toBe(1);
    expect(sootShot.roll.total).toBeLessThan(sootShot.roll.tn);
    expect(sootShot.roll.total).toBeGreaterThanOrEqual(sootShot.roll.tn - 2);
    expect(shot(ANCHOR, SOOT)).toMatchObject({ hit: true });
    expect(shot(CLINKER, ANCHOR)).toMatchObject({ hit: true });
    const damage = events.filter((e) => e.t === 'damage');
    expect(damage[0]).toMatchObject({ target: SOOT, dealt: 11 }); // "Soot loses 11 health"
    expect(damage[2]).toMatchObject({ target: ANCHOR, raw: 9, armor: 4, dealt: 5 }); // "absorbed 4 of the 9"
    expect(unitById(s, SOOT)!.state).toBe('dead');
    expect(s.vp[0]).toBeGreaterThan(0);
    expect(events.find((e) => e.t === 'round')).toMatchObject({ round: 2, order: [0, 1] });
  });

  it('shows the odds the lesson quotes', () => {
    const rivet = playTo('odds').s;
    expect(previewAttack(rivet, unitById(rivet, RIVET)!, unitById(rivet, SOOT)!, 'ranged').chance).toBeCloseTo(0.7);
    const before = playTo('aim').s;
    const beforeOdds = previewAttack(before, unitById(before, ANCHOR)!, unitById(before, SOOT)!, 'ranged');
    expect(beforeOdds.chance).toBeCloseTo(0.4);
    expect(beforeOdds.cover).toBe(1); // "something low stands in the way"
    const after = playTo('shoot2').s;
    expect(unitById(after, ANCHOR)!.aiming).toBe(2); // "+2"
    expect(previewAttack(after, unitById(after, ANCHOR)!, unitById(after, SOOT)!, 'ranged').chance).toBeCloseTo(0.6);
  });

  it('puts Rivet behind cover against Soot', () => {
    const { s } = playTo('cover');
    const pv = previewAttack(s, unitById(s, SOOT)!, unitById(s, RIVET)!, 'ranged', { hypothetical: true });
    expect(pv.ok).toBe(true);
    expect(pv.cover).toBe(1);
  });

  it('keeps Clinker out of sight until the lesson says otherwise', () => {
    const { s } = playTo('end');
    const c = unitById(s, CLINKER)!;
    for (const id of [RIVET, ANCHOR]) {
      const u = unitById(s, id)!;
      expect(losBetween(s, u.x, u.y, c.x, c.y).visible, `${id} should not see Clinker`).toBe(false);
    }
  });

  it('offers every square the lesson points at as a legal move', () => {
    for (const id of ['move', 'closein']) {
      const step = TUTORIAL_STEPS.find((x) => x.id === id)!;
      const { s } = playTo(id);
      const u = unitById(s, s.activeUnit!)!;
      expect(step.action!.type).toBe('move');
      const a = step.action as { x: number; y: number };
      expect(stoppable(s, u, reachable(s, u))).toContain(a.x + a.y * s.map.w);
    }
  });

  it('is winnable in free play, nearly always, by even a basic player', () => {
    let wins = 0;
    const games = 60;
    for (let g = 0; g < games; g++) {
      let { s } = playTo('free');
      const rnd = new Rand(1000 + g);
      for (let i = 0; i < 2000 && s.phase !== 'over'; i++) {
        const level = s.activeSide === 0 ? 'normal' : 'easy';
        const res = applyAction(s, chooseAction(s, s.activeSide, level, rnd), s.activeSide);
        expect(res.ok).toBe(true);
        s = res.state;
      }
      expect(s.phase).toBe('over');
      if (s.winner === 0) wins += 1;
    }
    expect(wins).toBeGreaterThanOrEqual(games * 0.9);
  });

  it('matches actions the way the interface sends them', () => {
    expect(sameAction({ type: 'shoot', targetId: SOOT }, { type: 'shoot', targetId: SOOT, mode: undefined, aimedAt: undefined })).toBe(true);
    expect(sameAction({ type: 'shoot', targetId: SOOT }, { type: 'shoot', targetId: CLINKER })).toBe(false);
    expect(sameAction({ type: 'move', x: 4, y: 5 }, { type: 'move', x: 3, y: 5 })).toBe(false);
  });

  it('has text for every step in both languages', () => {
    for (const step of TUTORIAL_STEPS) {
      for (const lang of ['en', 'pl'] as const) {
        expect(DICTIONARIES[lang][`tutorial.step.${step.id}.title`], `${lang} ${step.id} title`).toBeTruthy();
        expect(DICTIONARIES[lang][`tutorial.step.${step.id}.text`], `${lang} ${step.id} text`).toBeTruthy();
      }
    }
  });
});

describe('tutorial session', () => {
  it('never overwrites the player\'s saved game', async () => {
    const writes: string[] = [];
    (globalThis as any).localStorage = { getItem: () => null, setItem: (k: string) => writes.push(k), removeItem: (k: string) => writes.push(k) };
    const { TutorialSession } = await import('../src/ui/tutorial');
    const session = new TutorialSession(createTutorialGame(), [0]);
    session.submit({ type: 'select', unitId: RIVET }, 0);
    expect(session.state.activeUnit).toBe(RIVET);
    expect(writes).toEqual([]);
    session.dispose();
  });
});
