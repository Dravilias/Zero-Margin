import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/engine/ai';
import { CARDS, applyDuel, createDuel, duelAi, duelTip, type DuelState } from '../src/engine/duel';
import { applyAction } from '../src/engine/game';
import { Rand } from '../src/engine/rng';
import { PRACTICE_SKILLS, createPracticeGame, practiceSkill, practiceTip, type PracticeTip } from '../src/engine/tutorial';
import type { Action, GameState } from '../src/engine/types';
import { DICTIONARIES } from '../src/ui/i18n';

/** Plays the practice fight with the computer on both sides, collecting every hint shown on the way. */
function playPractice(seed: number): { s: GameState; tips: Set<PracticeTip>; tried: Set<string> } {
  let s = createPracticeGame(seed);
  const rnd = new Rand(seed);
  const tips = new Set<PracticeTip>();
  const tried = new Set<string>();
  for (let i = 0; i < 4000 && s.phase !== 'over'; i++) {
    tips.add(practiceTip(s, tried));
    const side = s.phase === 'deploy' ? (s.ready[0] ? 1 : 0) : s.activeSide;
    const action: Action = chooseAction(s, side, side === 0 ? 'normal' : 'easy', rnd);
    const res = applyAction(s, action, side);
    expect(res.ok, `${JSON.stringify(action)} ${res.error}`).toBe(true);
    if (side === 0) {
      const skill = practiceSkill(action);
      if (skill) tried.add(skill);
    }
    s = res.state;
  }
  tips.add(practiceTip(s, tried));
  return { s, tips, tried };
}

describe('field practice lesson', () => {
  it('starts in deployment with a crew that can do everything the lesson teaches', () => {
    const s = createPracticeGame(7);
    expect(s.phase).toBe('deploy');
    expect(s.cfg.ruleset).toBe('standard');
    const mine = s.units.filter((u) => u.side === 0);
    expect(mine.map((u) => u.role).sort()).toEqual(['breaker', 'patcher', 'razor', 'sapper', 'wire']);
    expect(mine.find((u) => u.role === 'sapper')!.grenades.frag).toBeGreaterThan(0);
    expect(mine.find((u) => u.role === 'patcher')!.kits).toBeGreaterThan(0);
    expect(practiceTip(s, new Set())).toBe('deploy');
  });

  it('plays to the end on any seed, and the crew usually wins', () => {
    let wins = 0;
    const seen = new Set<PracticeTip>();
    for (let seed = 1; seed <= 12; seed++) {
      const { s, tips } = playPractice(seed);
      expect(s.phase).toBe('over');
      expect(tips.has('over')).toBe(true);
      if (s.winner === 0) wins += 1;
      for (const tip of tips) seen.add(tip);
    }
    expect(wins).toBeGreaterThanOrEqual(8);
    for (const tip of ['deploy', 'wait', 'pick', 'act'] as const) expect(seen.has(tip), tip).toBe(true);
    // Every skill has to come up in real games, or the lesson would promise something it never shows.
    for (const skill of PRACTICE_SKILLS) expect(seen.has(skill), skill).toBe(true);
  });

  it('stops suggesting a skill once it has been tried', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let s = createPracticeGame(seed);
      const rnd = new Rand(seed);
      for (let i = 0; i < 4000 && s.phase !== 'over'; i++) {
        const tip = practiceTip(s, new Set());
        if ((PRACTICE_SKILLS as readonly string[]).includes(tip)) {
          expect(practiceTip(s, new Set([tip]))).not.toBe(tip);
          return;
        }
        const side = s.phase === 'deploy' ? (s.ready[0] ? 1 : 0) : s.activeSide;
        s = applyAction(s, chooseAction(s, side, 'normal', rnd), side).state;
      }
    }
    throw new Error('no skill hint came up');
  });

  it('counts the right actions as skills', () => {
    expect(practiceSkill({ type: 'shoot', targetId: 'x', mode: 'burst' } as Action)).toBe('burst');
    expect(practiceSkill({ type: 'shoot', targetId: 'x' } as Action)).toBeNull();
    expect(practiceSkill({ type: 'overwatch' } as Action)).toBe('overwatch');
    expect(practiceSkill({ type: 'end' } as Action)).toBeNull();
  });
});

describe('card duel lesson', () => {
  const start = (): DuelState => createDuel(5, 'quick');

  it('opens with the goal and reacts to the chosen card', () => {
    const s = start();
    expect(s.active).toBe('hacker');
    expect(duelTip(s, null)).toBe('goal');
    expect(duelTip(s, 'spike')).toBe('program');
    expect(duelTip(s, 'overload')).toBe('target');
    expect(duelTip(s, 'scrub')).toBe('global');
  });

  it('says to end the turn when nothing is affordable, and warns about the trace', () => {
    const s = start();
    s.round = 2;
    s.hacker.bandwidth = 0;
    expect(duelTip(s, null)).toBe('end');
    s.hacker.bandwidth = 7;
    s.hacker.hand = ['spike'];
    s.trace = s.traceMax - 2;
    expect(duelTip(s, null)).toBe('trace');
    s.trace = 0;
    expect(duelTip(s, null)).toBe('pick');
    s.lanes[0].corp.push({ uid: 901, card: 'firewall', hp: CARDS.firewall.hp ?? 1, locked: false });
    expect(duelTip(s, null)).toBe('barrier');
    s.lanes[1].corp.push({ uid: 902, card: 'tracer', hp: CARDS.tracer.hp ?? 1, locked: false });
    expect(duelTip(s, null)).toBe('tracer');
  });

  it('follows a whole game to its end', () => {
    for (let seed = 1; seed <= 6; seed++) {
      let s = createDuel(seed, 'quick');
      const rnd = new Rand(seed);
      const seen = new Set<string>();
      for (let i = 0; i < 600 && !s.winner; i++) {
        seen.add(duelTip(s, null));
        const res = applyDuel(s, duelAi(s, s.active, rnd), s.active);
        expect(res.ok).toBe(true);
        s = res.state;
      }
      expect(s.winner).toBeTruthy();
      expect(duelTip(s, null)).toBe(s.winner === 'hacker' ? 'won' : 'lost');
      expect(seen.has('wait')).toBe(true);
    }
  });
});

describe('lesson texts', () => {
  const tips: Record<string, string[]> = {
    practice: [...PRACTICE_SKILLS, 'deploy', 'wait', 'pick', 'reload', 'melee', 'act', 'over'],
    duel: ['goal', 'pick', 'program', 'target', 'global', 'trick', 'end', 'trace', 'tracer', 'sentry', 'barrier', 'wait', 'won', 'lost'],
  };
  it('exist for every hint in both languages', () => {
    for (const lang of ['en', 'pl'] as const) {
      for (const [group, ids] of Object.entries(tips)) {
        for (const id of ids) {
          expect(DICTIONARIES[lang][`${group}.tip.${id}.title`], `${lang} ${group} ${id}`).toBeTruthy();
          expect(DICTIONARIES[lang][`${group}.tip.${id}.text`], `${lang} ${group} ${id}`).toBeTruthy();
        }
      }
    }
  });
});
