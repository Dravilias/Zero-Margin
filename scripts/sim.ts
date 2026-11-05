// Balance simulator: plays computer-vs-computer games and prints win rates and game length.
// Run with: npx esbuild scripts/sim.ts --bundle --platform=node --outfile=<some temp file> && node <that file>
import { chooseAction } from '../src/engine/ai';
import { FACTION_IDS, defaultRoster } from '../src/engine/data';
import { applyAction, createGame } from '../src/engine/game';
import { Rand } from '../src/engine/rng';
import type { Action, FactionId, GameConfig, GameState, MapSize, RulesetId, ScenarioId, ThemeId } from '../src/engine/types';

const GAMES = Number(process.argv[2] || 40);
const THEMES: ThemeId[] = ['docks', 'market', 'plaza'];

function cfg(seed: number, a: FactionId, b: FactionId, ruleset: RulesetId, scenario: ScenarioId, mapSize: MapSize = 'medium'): GameConfig {
  const points = 100;
  return {
    seed, scenario, ruleset, mapSize, theme: THEMES[seed % 3], maxRounds: scenario === 'heist' ? 10 : 8, points,
    sides: [a, b].map((faction, i) => ({ name: `S${i}`, faction, team: i, control: 'ai' as const, aiLevel: 'hard' as const, roster: defaultRoster(faction, points) })),
  };
}

function play(c: GameConfig, usage: Record<string, number>): GameState {
  let s = createGame(c);
  const rnd = new Rand(c.seed + 5);
  while (s.phase !== 'over') {
    const side = s.activeSide;
    const action: Action = chooseAction(s, side, 'hard', rnd);
    usage[action.type] = (usage[action.type] || 0) + 1;
    const res = applyAction(s, action, side);
    if (!res.ok) throw new Error(`${res.error}: ${JSON.stringify(action)}`);
    s = res.state;
  }
  return s;
}

const rulesets: RulesetId[] = ['quick', 'standard', 'full'];
const scenarios: ScenarioId[] = ['flatline', 'terminals', 'heist'];

for (const ruleset of rulesets) {
  console.log(`\n=== ${ruleset} ===`);
  for (const scenario of scenarios) {
    const usage: Record<string, number> = {};
    const wins: Record<string, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0]));
    const played: Record<string, number> = Object.fromEntries(FACTION_IDS.map((f) => [f, 0]));
    let rounds = 0;
    let total = 0;
    let draws = 0;
    const reasons: Record<string, number> = {};
    let seed = 1;
    for (const a of FACTION_IDS) for (const b of FACTION_IDS) {
      if (a === b) continue;
      for (let i = 0; i < GAMES / 4; i++) {
        const s = play(cfg(seed++, a, b, ruleset, scenario), usage);
        total++;
        rounds += s.round;
        reasons[s.reason!] = (reasons[s.reason!] || 0) + 1;
        played[a]++;
        played[b]++;
        if (s.winner === 0) wins[a]++;
        else if (s.winner === 1) wins[b]++;
        else draws++;
      }
    }
    const rate = FACTION_IDS.map((f) => `${f} ${Math.round((100 * wins[f]) / played[f])}%`).join('  ');
    const top = Object.entries(usage).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`${scenario.padEnd(10)} games ${total}, avg rounds ${(rounds / total).toFixed(1)}, draws ${draws}, ends ${JSON.stringify(reasons)}`);
    console.log(`  win rate: ${rate}`);
    console.log(`  actions: ${top}`);
  }
}
