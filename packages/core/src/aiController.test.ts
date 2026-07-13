import { describe, expect, it } from 'vitest';
import { AiController } from './aiController.js';
import { GameSim } from './gameSim.js';

/** Run the AI on its own sim for `ticks`, returning whether it ever eliminated. */
function runAi(seed: number, difficulty: 'easy' | 'medium' | 'hard', ticks: number): boolean {
  const sim = new GameSim(seed);
  const ai = new AiController(difficulty);
  let eliminated = false;
  for (let t = 0; t < ticks && !sim.lost; t++) {
    sim.step(ai.decide(sim));
    if (sim.dying_count > 0) eliminated = true;
  }
  return eliminated;
}

describe('AiController', () => {
  it('actually plays: it makes swaps that eliminate blocks', () => {
    // Across several seeds the bot should find and execute clearing swaps.
    let played = 0;
    for (const seed of [1, 2, 7, 42, 2026]) {
      if (runAi(seed, 'hard', 4000)) played++;
    }
    expect(played).toBeGreaterThan(0);
  });

  it('is deterministic: same seed + difficulty ⇒ identical sim digest', () => {
    const run = (): number => {
      const sim = new GameSim(99);
      const ai = new AiController('medium');
      for (let t = 0; t < 1500; t++) sim.step(ai.decide(sim));
      return sim.digest();
    };
    expect(run()).toBe(run());
  });

  it('reset clears the plan/timer so a reused controller replays identically', () => {
    const sim1 = new GameSim(5);
    const ai = new AiController('hard');
    for (let t = 0; t < 800; t++) sim1.step(ai.decide(sim1));

    // Reuse the same controller on a fresh sim after reset.
    const sim2 = new GameSim(5);
    ai.reset();
    for (let t = 0; t < 800; t++) sim2.step(ai.decide(sim2));

    const fresh = new GameSim(5);
    const ai2 = new AiController('hard');
    for (let t = 0; t < 800; t++) fresh.step(ai2.decide(fresh));

    expect(sim2.digest()).toBe(fresh.digest());
  });

  it('never desyncs the sim (no exceptions) even on easy over a long game', () => {
    const sim = new GameSim(123);
    const ai = new AiController('easy');
    expect(() => {
      for (let t = 0; t < 6000 && !sim.lost; t++) sim.step(ai.decide(sim));
    }).not.toThrow();
  });
});
