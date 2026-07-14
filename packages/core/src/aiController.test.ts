import { describe, expect, it } from 'vitest';
import { AiController } from './aiController.js';
import { GameSim } from './gameSim.js';
import { GF_NORMAL } from './flavors.js';

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

/**
 * Run a difficulty against a steady stream of injected full-width garbage (a
 * stand-in for a human attacking with combos), summed over seeds. Reports both
 * survival ticks and garbage cells *sent back* (attack output).
 */
function underGarbage(
  difficulty: 'easy' | 'medium' | 'hard',
  seeds: number[],
): { survival: number; sent: number } {
  let survival = 0;
  let sent = 0;
  for (const seed of seeds) {
    const sim = new GameSim(seed);
    const ai = new AiController(difficulty);
    sim.garbageGenerator.outSink = {
      sendGarbage: (h, w) => {
        sent += h * w;
      },
      sendSpecialGarbage: () => {
        sent += 1;
      },
    };
    let t = 0;
    for (; t < 40000 && !sim.lost; t++) {
      if (t > 500 && t % 300 === 0) {
        sim.garbageGenerator.addToQueue(1, 6, GF_NORMAL, sim.clock.time_step);
      }
      sim.step(ai.decide(sim));
    }
    survival += t;
  }
  return { survival, sent };
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

  it('difficulty escalates under garbage: easy survives least, hard attacks most', () => {
    // The tiers are defined behaviourally: easy is the survival floor (fixing the
    // old inversion where medium/hard were no stronger), while hard is the
    // *aggressive* tier — it banks blocks and fires combos/chains, sending far
    // more garbage back than the others. Aggregated over seeds (per-game play is
    // chaotic).
    const seeds = [1, 2, 7, 42, 101, 2026, 55, 88];
    const easy = underGarbage('easy', seeds);
    const medium = underGarbage('medium', seeds);
    const hard = underGarbage('hard', seeds);
    // Survival: easy is clearly the weakest (the reported inversion is gone).
    expect(medium.survival).toBeGreaterThan(easy.survival);
    // Attack: strictly escalating — hard throws the most garbage, easy the least.
    expect(medium.sent).toBeGreaterThan(easy.sent);
    expect(hard.sent).toBeGreaterThan(medium.sent);
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

  it('pendingCellsWithin sees an inbound slab only inside its window, until it lands', () => {
    const sim = new GameSim(11);
    // Discard outbound garbage — in solo mode the bot's own combos would
    // otherwise be dealt back into its own queue and pollute the counts.
    sim.garbageGenerator.outSink = { sendGarbage: () => {}, sendSpecialGarbage: () => {} };
    const stamp = sim.clock.time_step;
    // A 2×6 slab queued now lands at stamp + ~300 (GC_AVERAGE_GARBAGE_DROP_DELAY
    // ± half the spread), so a short window misses it and a long one sees it.
    sim.garbageGenerator.addToQueue(2, 6, GF_NORMAL, stamp);
    expect(sim.garbageGenerator.pendingCellsWithin(stamp, 100)).toBe(0);
    expect(sim.garbageGenerator.pendingCellsWithin(stamp, 1000)).toBe(12);
    // Once it has dropped onto the board, the queue is empty again.
    const ai = new AiController('hard');
    for (let t = 0; t < 400 && !sim.lost; t++) sim.step(ai.decide(sim));
    expect(sim.garbageGenerator.pendingCellsWithin(sim.clock.time_step, 1000)).toBe(0);
  });

  it('never desyncs the sim (no exceptions) even on easy over a long game', () => {
    const sim = new GameSim(123);
    const ai = new AiController('easy');
    expect(() => {
      for (let t = 0; t < 6000 && !sim.lost; t++) sim.step(ai.decide(sim));
    }).not.toThrow();
  });
});
