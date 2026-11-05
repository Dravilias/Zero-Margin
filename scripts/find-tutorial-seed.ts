// Finds a dice seed that makes the tutorial's guided section play out as its text describes.
// Run with: npx esbuild scripts/find-tutorial-seed.ts --bundle --platform=node --outfile=<temp file> && node <temp file>
import { applyAction } from '../src/engine/game';
import { ANCHOR, CLINKER, RIVET, SOOT, TUTORIAL_STEPS, createTutorialGame } from '../src/engine/tutorial';
import type { GameEvent } from '../src/engine/types';

function outcome(rng: number): boolean {
  let s = createTutorialGame(rng);
  const events: GameEvent[] = [];
  for (const step of TUTORIAL_STEPS) {
    const actions = step.kind === 'do' ? [step.action!] : step.kind === 'enemy' ? step.script! : [];
    for (const action of actions) {
      const res = applyAction(s, action, s.activeSide);
      if (!res.ok) return false;
      s = res.state;
      events.push(...res.events);
    }
  }
  const attacks = events.filter((e) => e.t === 'attack');
  const shot = (from: string, to: string) => attacks.find((e) => e.t === 'attack' && e.unit === from && e.target === to);
  const hit = (e: GameEvent | undefined) => !!e && e.t === 'attack' && e.hit;
  const rolledAsNeeded = (e: GameEvent | undefined, low: number, high: number) =>
    !!e && e.t === 'attack' && e.roll.nat >= low && e.roll.nat <= high;
  const round2 = events.find((e) => e.t === 'round');
  return (
    hit(shot(RIVET, SOOT)) && rolledAsNeeded(shot(RIVET, SOOT), 5, 10) &&
    // Soot must miss by 1 or 2, so the miss really is down to Rivet's cover.
    !hit(shot(SOOT, RIVET)) && rolledAsNeeded(shot(SOOT, RIVET), 6, 7) &&
    hit(shot(ANCHOR, SOOT)) && rolledAsNeeded(shot(ANCHOR, SOOT), 5, 9) &&
    hit(shot(CLINKER, ANCHOR)) && rolledAsNeeded(shot(CLINKER, ANCHOR), 9, 10) &&
    !!round2 && round2.t === 'round' && round2.order[0] === 0
  );
}

const found: number[] = [];
for (let rng = 1; rng < 200000 && found.length < 5; rng++) if (outcome(rng)) found.push(rng);
console.log(found.length ? `seeds that work: ${found.join(', ')}` : 'no seed found');
