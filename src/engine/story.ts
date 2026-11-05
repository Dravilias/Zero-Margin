import { END, type Arc, type ArcChoice, type ArcNode, type GigSpec } from './campaign';
import { Rand } from './rng';
import type { FactionId, ScenarioId, ThemeId } from './types';

/* All wording lives in src/ui/storyText.ts under these keys, in both languages. */

function gig(id: string, scenario: ScenarioId, enemy: FactionId, theme: ThemeId, threat: number, pay: number): GigSpec {
  return {
    title: `note.${id}.title`, brief: `note.${id}.brief`, won: `note.${id}.won`, lost: `note.${id}.lost`,
    scenario, enemy, theme, threat, pay,
  };
}

function choice(node: string, id: string, extra: Partial<ArcChoice> = {}): ArcChoice {
  return { id, label: `note.${node}.${id}`, ...extra };
}

function scene(id: string, chapter: number, speaker: string, choices: ArcChoice[]): ArcNode {
  return { id, kind: 'scene', chapter, speaker: `note.speaker.${speaker}`, text: `note.${id}.text`, choices };
}

/** The hand-written story: a dock crew's debt gets bought, and the paperwork turns out to be a plan to drown a neighborhood. */
export const THE_NOTE: Arc = {
  id: 'the-note',
  source: 'authored',
  title: 'note.title',
  premise: 'note.premise',
  chapters: 5,
  start: 'c1',
  nodes: [
    scene('c1', 1, 'wren', [
      choice('c1', 'take'),
      choice('c1', 'advance', { cash: 300, flag: 'owes_wren', threat: 1, result: 'note.c1.advance.result' }),
    ]),
    { id: 'c1g', kind: 'gig', chapter: 1, gig: gig('c1g', 'heist', 'kilnrats', 'docks', 1, 900) },

    scene('c2', 2, 'matchstick', [
      choice('c2', 'ally', { flag: 'rats_ally', next: 'c2a', threat: -1, result: 'note.c2.ally.result' }),
      choice('c2', 'sell', { flag: 'rats_burned', next: 'c2b', cash: 500, rep: -1, result: 'note.c2.sell.result' }),
    ]),
    { id: 'c2a', kind: 'gig', chapter: 2, gig: gig('c2a', 'terminals', 'meridian', 'market', 2, 1100), next: 'c3' },
    { id: 'c2b', kind: 'gig', chapter: 2, gig: gig('c2b', 'terminals', 'kilnrats', 'market', 2, 1100), next: 'c3' },

    scene('c3', 3, 'cantor', [
      choice('c3', 'pay', { needCash: 800, cash: -800, flag: 'choir_paid', next: 'c4', result: 'note.c3.pay.result' }),
      choice('c3', 'back', { needFlag: 'rats_ally', threat: -1, flag: 'choir_robbed', result: 'note.c3.back.result' }),
      choice('c3', 'take', { flag: 'choir_robbed', threat: 1 }),
    ]),
    { id: 'c3g', kind: 'gig', chapter: 3, gig: gig('c3g', 'flatline', 'choir', 'plaza', 3, 1300) },

    scene('c4', 4, 'cantor', [
      choice('c4', 'broadcast', { flag: 'broadcast', result: 'note.c4.broadcast.result' }),
      choice('c4', 'leverage', { flag: 'leverage', result: 'note.c4.leverage.result' }),
      choice('c4', 'sell', { flag: 'sold', cash: 2500, rep: -2, next: 'c4s', result: 'note.c4.sell.result' }),
    ]),
    { id: 'c4g', kind: 'gig', chapter: 4, gig: gig('c4g', 'heist', 'meridian', 'plaza', 4, 1600), next: 'c5' },
    { id: 'c4s', kind: 'gig', chapter: 4, gig: gig('c4s', 'flatline', 'kilnrats', 'market', 4, 1600), next: 'c5' },

    scene('c5', 5, 'wren', [
      choice('c5', 'hold'),
      choice('c5', 'gear', { needCash: 500, cash: -500, threat: -1, result: 'note.c5.gear.result' }),
    ]),
    { id: 'c5g', kind: 'gig', chapter: 5, gig: gig('c5g', 'terminals', 'meridian', 'plaza', 5, 2500), next: END },
  ],
  endings: [
    { id: 'sold', title: 'note.end.sold.title', text: 'note.end.sold.text', needFlag: 'sold' },
    { id: 'leverage', title: 'note.end.leverage.title', text: 'note.end.leverage.text', needFlag: 'leverage' },
    { id: 'broadcast', title: 'note.end.broadcast.title', text: 'note.end.broadcast.text' },
  ],
};

/* ---------- A new story every time: assembled from written pieces ---------- */

export const GEN_PATRONS = ['ledger', 'steward', 'doc', 'councillor', 'defector', 'pilot'] as const;
export const GEN_STAKES = ['pumps', 'list', 'chrome', 'ledger', 'servers', 'water', 'children', 'ferry'] as const;
export const GEN_TWISTS = ['double', 'sabotage', 'witness', 'rival', 'flood'] as const;
export const GEN_REVEALS = ['patron', 'buyer', 'old'] as const;
export const GEN_FINALES = ['storm', 'auction', 'siege'] as const;
export const GEN_HOOKS = ['rain', 'funeral', 'debt'] as const;
const ENEMIES: FactionId[] = ['meridian', 'choir', 'kilnrats'];
const THEMES: ThemeId[] = ['docks', 'market', 'plaza'];
const SCENARIOS: ScenarioId[] = ['flatline', 'terminals', 'heist'];

function shuffled<T>(r: Rand, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface GenMemory { patrons?: string[]; stakes?: string[] }

/** Builds a four-chapter story. Passing what was already used keeps a long-running crew from repeating itself. */
export function generateArc(seed: number, memory: GenMemory = {}): Arc {
  const r = new Rand(seed);
  const fresh = <T extends string>(all: readonly T[], used: string[] = []): T => {
    const left = all.filter((x) => !used.includes(x));
    return r.pick(left.length ? left : all);
  };
  const patron = fresh(GEN_PATRONS, memory.patrons);
  const stake = fresh(GEN_STAKES, memory.stakes);
  const hook = r.pick(GEN_HOOKS);
  const twist = r.pick(GEN_TWISTS);
  const reveal = r.pick(GEN_REVEALS);
  const finale = r.pick(GEN_FINALES);
  const [rival, heavy] = shuffled(r, ENEMIES);
  const v = { patron: `gen.patron.${patron}`, patronWho: `gen.patron.${patron}.who`, stake: `gen.stake.${stake}`, rival: `faction.${rival}`, heavy: `faction.${heavy}` };
  const say = (k: string) => ({ k, v });
  const job = (chapter: number, scenario: ScenarioId, enemy: FactionId, theme: ThemeId): GigSpec => {
    const n = r.int(0, 2);
    return {
      title: `gigt.${scenario}.${n}`, brief: say(`gen.brief.${chapter}`), won: say(`gen.won.${chapter}`), lost: say(`gen.lost.${chapter}`),
      scenario, enemy, theme, threat: chapter, pay: 700 + chapter * 300 + r.int(0, 4) * 25,
    };
  };
  const scenarios = shuffled(r, SCENARIOS);
  const themes = shuffled(r, THEMES);
  const speaker = `gen.patron.${patron}`;
  const nodes: ArcNode[] = [
    {
      id: 'c1', kind: 'scene', chapter: 1, speaker, text: say(`gen.hook.${hook}`),
      choices: [
        { id: 'accept', label: 'gen.c1.accept', result: say('gen.c1.accept.result') },
        { id: 'haggle', label: 'gen.c1.haggle', cash: 300, threat: 1, flag: 'haggled', result: say('gen.c1.haggle.result') },
      ],
    },
    { id: 'c1g', kind: 'gig', chapter: 1, gig: job(1, scenarios[0], rival, themes[0]) },
    {
      id: 'c2', kind: 'scene', chapter: 2, speaker, text: say(`gen.twist.${twist}`),
      choices: [
        { id: 'careful', label: `gen.twist.${twist}.careful`, threat: -1, result: say('gen.c2.careful.result') },
        { id: 'fast', label: `gen.twist.${twist}.fast`, cash: 400, threat: 1, flag: 'reckless', result: say('gen.c2.fast.result') },
      ],
    },
    { id: 'c2g', kind: 'gig', chapter: 2, gig: job(2, scenarios[1], rival, themes[1]) },
    {
      id: 'c3', kind: 'scene', chapter: 3, speaker, text: say(`gen.reveal.${reveal}`),
      choices: [
        { id: 'stay', label: 'gen.c3.stay', cash: 600, flag: 'loyal', rep: -1, result: say('gen.c3.stay.result') },
        { id: 'turn', label: say('gen.c3.turn'), flag: 'turned', rep: 1, threat: 1, result: say('gen.c3.turn.result') },
        { id: 'both', label: 'gen.c3.both', flag: 'both', needCash: 400, cash: -400, result: say('gen.c3.both.result') },
      ],
    },
    { id: 'c3g', kind: 'gig', chapter: 3, gig: job(3, scenarios[2], heavy, themes[2]) },
    {
      id: 'c4', kind: 'scene', chapter: 4, speaker, text: say(`gen.finale.${finale}`),
      choices: [
        { id: 'in', label: 'gen.c4.in' },
        { id: 'prep', label: 'gen.c4.prep', needCash: 500, cash: -500, threat: -1, result: say('gen.c4.prep.result') },
      ],
    },
    { id: 'c4g', kind: 'gig', chapter: 4, gig: { ...job(4, r.pick(SCENARIOS), heavy, r.pick(THEMES)), pay: 2400 }, next: END },
  ];
  return {
    id: `gen-${seed}`, source: 'generated', title: { k: 'gen.title', v: { stake: `gen.stake.${stake}.short` } }, premise: say('gen.premise'), chapters: 4,
    start: 'c1', nodes,
    endings: [
      { id: 'loyal', title: 'gen.end.loyal.title', text: say('gen.end.loyal.text'), needFlag: 'loyal' },
      { id: 'turned', title: 'gen.end.turned.title', text: say('gen.end.turned.text'), needFlag: 'turned' },
      { id: 'both', title: 'gen.end.both.title', text: say('gen.end.both.text') },
    ],
    bible: JSON.stringify({ patron, stake, rival, heavy }),
  };
}
