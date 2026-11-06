import { describe, expect, it } from 'vitest';
import { CARDS, CARD_IDS, applyDuel, createDuel, duelAi, type DuelSide, type DuelState } from '../src/engine/duel';
import { Rand } from '../src/engine/rng';
import { DICTIONARIES } from '../src/ui/i18n';

function play(seed: number, ruleset: 'quick' | 'standard' | 'full'): DuelState {
  let s = createDuel(seed, ruleset);
  const rnd = new Rand(seed + 1);
  for (let i = 0; i < 2000 && !s.winner; i++) {
    const side: DuelSide = s.active;
    const res = applyDuel(s, duelAi(s, side, rnd), side);
    expect(res.ok, res.error).toBe(true);
    s = res.state;
  }
  return s;
}

describe('card duel', () => {
  it('always finishes, and neither side runs away with it', () => {
    for (const ruleset of ['quick', 'standard', 'full'] as const) {
      let hacker = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const s = play(seed, ruleset);
        expect(s.winner).not.toBeNull();
        if (s.winner === 'hacker') hacker++;
      }
      console.log(ruleset, 'hacker wins', hacker / 3, '%');
      expect(hacker).toBeGreaterThan(75);
      expect(hacker).toBeLessThan(225);
    }
  });

  it('enforces turns, costs and lanes', () => {
    const s = createDuel(3, 'standard');
    expect(applyDuel(s, { a: 'end' }, 'corp').error).toBe('notYourTurn');
    expect(applyDuel(s, { a: 'play', hand: 99, lane: 0 }, 'hacker').error).toBe('noCard');
    const dear = { ...s, hacker: { ...s.hacker, hand: ['zeroday' as const], bandwidth: 1 } };
    expect(applyDuel(dear, { a: 'play', hand: 0, lane: 0 }, 'hacker').error).toBe('noBandwidth');
  });

  it('programs go through walls and into nodes; ghosts hide from sentries', () => {
    let s = createDuel(3, 'standard');
    s.lanes[0].hacker = [{ uid: 90, card: 'crowbar', hp: 2, locked: false }, { uid: 91, card: 'ghost', hp: 3, locked: false }];
    s.lanes[0].corp = [{ uid: 92, card: 'firewall', hp: 2, locked: false }];
    s = applyDuel(s, { a: 'end' }, 'hacker').state;
    expect(s.lanes[0].corp).toHaveLength(0);
    expect(s.lanes[0].node).toBe(s.nodeMax - 4);
    s.lanes[0].corp = [{ uid: 93, card: 'watchdog', hp: 2, locked: false }];
    s = applyDuel(s, { a: 'end' }, 'corp').state;
    expect(s.lanes[0].hacker.map((x) => x.card)).toEqual(['ghost']);
  });

  it('never counts past the last round, and a draw card leaves room for what it draws', () => {
    let s = createDuel(3, 'quick');
    s.round = s.maxRounds;
    s.active = 'corp';
    s = applyDuel(s, { a: 'end' }, 'corp').state;
    expect(s.winner).toBe('corp');
    expect(s.round).toBe(s.maxRounds);
    let d = createDuel(3, 'standard');
    d.hacker.hand = ['dredge', 'spike', 'spike', 'spike', 'spike', 'spike'];
    d.hacker.bandwidth = 5;
    d = applyDuel(d, { a: 'play', hand: 0, lane: 0 }, 'hacker').state;
    expect(d.hacker.hand).toHaveLength(7);
    expect(d.log[d.log.length - 1].k).toBe('duel.log.playGlobal');
  });

  it('refuses malformed actions from the other player', () => {
    const s = createDuel(3, 'standard');
    expect(applyDuel(s, null as never, 'hacker').error).toBe('badAction');
    expect(applyDuel(s, { a: 'play', hand: 'constructor' as never, lane: 0 }, 'hacker').error).toBe('badAction');
    expect(applyDuel(s, { a: 'play', hand: 0, lane: 0, target: 'constructor' as never }, 'hacker').error).toBe('badAction');
    expect(applyDuel(s, { a: 'nope' } as never, 'hacker').error).toBe('badAction');
  });

  it('has names and descriptions for every card in both languages', () => {
    for (const id of CARD_IDS) for (const d of [DICTIONARIES.en, DICTIONARIES.pl]) {
      expect(d[`card.${id}`]).toBeTruthy();
      expect(d[`card.${id}.d`]).toBeTruthy();
    }
    expect(CARDS.spike.side).toBe('hacker');
  });
});
