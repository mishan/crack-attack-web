import { describe, expect, it } from 'vitest';
import { AiController, aiDecisionSeed, aiTuningFor } from './aiController.js';
import { CC_ADVANCE, CC_SWAP } from './controller.js';
import { GameSim } from './gameSim.js';
import { GF_NORMAL } from './flavors.js';
import { BF_NORMAL_1, BF_NORMAL_2, BF_NORMAL_3, BF_NORMAL_4, BF_NORMAL_5 } from './constants.js';

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
  it('actually plays: it makes swaps that eliminate blocks', { timeout: 30_000 }, () => {
    // Across several seeds the bot should find and execute clearing swaps.
    let played = 0;
    for (const seed of [1, 2, 7, 42, 2026]) {
      if (runAi(seed, 'hard', 4000)) played++;
    }
    expect(played).toBeGreaterThan(0);
  });

  // Long-running: three tiers × 8 seeds × up to 40k ticks each, and both the
  // medium and hard tiers now run the strategic planner — needs headroom on
  // slower machines than vitest's 5 s default.
  it(
    'difficulty escalates under garbage: easy survives least, hard attacks most',
    { timeout: 60_000 },
    () => {
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
    },
  );

  it('is deterministic: same seed + difficulty ⇒ identical sim digest', () => {
    const run = (): number => {
      const sim = new GameSim(99);
      const ai = new AiController('medium');
      for (let t = 0; t < 1500; t++) sim.step(ai.decide(sim));
      return sim.digest();
    };
    expect(run()).toBe(run());
  });

  it('uses seat-derived judgment seeds to break symmetry reproducibly', () => {
    const run = (seat: number): number[] => {
      const sim = new GameSim(42);
      const ai = new AiController('hard', aiDecisionSeed(42, seat));
      const actions: number[] = [];
      for (let t = 0; t < 1200 && !sim.lost; t++) {
        const action = ai.decide(sim);
        actions.push(action.state);
        sim.step(action);
      }
      return actions;
    };
    expect(run(0)).toEqual(run(0));
    expect(run(0)).not.toEqual(run(1));
  });

  it('does not undo the same constructive swap forever when setup targets compete', () => {
    // Seed 4 used to toggle the same two opening blocks more than 100 times:
    // one x8 target selected the forward swap, then another x8 target selected
    // its exact inverse. The controller must leave that two-board cycle.
    const sim = new GameSim(4);
    const ai = new AiController('hard', aiDecisionSeed(4, 0));
    let last = '';
    let repeated = 0;
    let longestRepeat = 0;
    for (let t = 0; t < 2000 && !sim.lost; t++) {
      const action = ai.decide(sim);
      if (action.swapCommand()) {
        const cell = `${sim.swapper.x},${sim.swapper.y}`;
        repeated = cell === last ? repeated + 1 : 1;
        last = cell;
        longestRepeat = Math.max(longestRepeat, repeated);
      }
      sim.step(action);
    }
    expect(longestRepeat).toBeLessThan(4);
  });

  it('manually advances a row when no useful move exists, then releases the latch', () => {
    const sim = new GameSim(123);
    const ai = new AiController('easy', aiDecisionSeed(123, 0));
    let accepted = false;
    for (let t = 0; t < 5000 && !sim.lost; t++) {
      const action = ai.decide(sim);
      sim.step(action);
      if ((action.state & CC_ADVANCE) !== 0 && sim.creep.isAdvancing) {
        accepted = true;
        break;
      }
    }
    expect(accepted).toBe(true);

    let guard = 0;
    while (sim.creep.isAdvancing && !sim.lost) {
      const action = ai.decide(sim);
      expect(action.state).toBe(0);
      sim.step(action);
      expect(++guard).toBeLessThan(1000);
    }
    expect(sim.creep.isAdvancing).toBe(false);
  });

  it('slides a support aside so its cap drops onto a matching pair', () => {
    const sim = new GameSim(7);
    sim.blocks.gameStart();
    sim.garbageStore.gameStart();
    sim.combos.gameStart();
    sim.garbageGenerator.gameStart();
    sim.grid.gameStart();
    sim.swapper.gameStart();

    // Bottom support row, then the pictured shape at y2/y3:
    //   ...O..
    //   ...YOO
    // Moving Y left (swap x2/x3) lets O fall into OOO.
    const floor = [BF_NORMAL_2, BF_NORMAL_3, BF_NORMAL_4, BF_NORMAL_5, BF_NORMAL_1, BF_NORMAL_1];
    for (let x = 0; x < floor.length; x++) {
      sim.blocks.newBlock(x, 0, BF_NORMAL_5); // incoming-row support (not planned)
      sim.blocks.newBlock(x, 1, floor[x]!);
    }
    sim.blocks.newBlock(3, 2, BF_NORMAL_2); // Y support
    sim.blocks.newBlock(4, 2, BF_NORMAL_1); // O O to its right
    sim.blocks.newBlock(5, 2, BF_NORMAL_1);
    sim.blocks.newBlock(3, 3, BF_NORMAL_1); // O cap
    sim.grid.top_occupied_row = 3;
    sim.grid.top_effective_row = 3;

    const tuning = {
      ...aiTuningFor('hard'),
      shatterSetupMaxCost: 0,
      undermine: false,
      chainSetup: false,
      bigComboSetupMaxCost: 0,
      flatten: false,
    };
    const ai = new AiController(tuning, aiDecisionSeed(7, 0));
    let swapped = false;
    let eliminated = false;
    for (let t = 0; t < 100; t++) {
      const action = ai.decide(sim);
      if (action.swapCommand()) swapped = true;
      sim.step(action);
      if (sim.dying_count >= 3) eliminated = true;
      if (eliminated) break;
    }
    expect(swapped).toBe(true);
    expect(eliminated).toBe(true);
  });

  it('uses the hang window to arrange a match for a linked block landing', () => {
    const sim = new GameSim(19);
    sim.blocks.gameStart();
    sim.garbageStore.gameStart();
    sim.combos.gameStart();
    sim.garbageGenerator.gameStart();
    sim.grid.gameStart();
    sim.swapper.gameStart();

    // Current row 1 is 1 2 . 1. The linked 1 hanging above x2 will make
    // 1 2 1 1 if untouched (no match), but swapping x0/x1 now makes
    // 2 1 1 1 once it lands: the landing is therefore a chain.
    for (let x = 0; x < 6; x++) sim.blocks.newBlock(x, 0, (x + 2) % 5);
    sim.blocks.newBlock(0, 1, BF_NORMAL_1);
    sim.blocks.newBlock(1, 1, BF_NORMAL_2);
    sim.blocks.newBlock(3, 1, BF_NORMAL_1);
    sim.blocks.newBlock(2, 3, BF_NORMAL_1);
    sim.grid.top_occupied_row = 3;
    sim.grid.top_effective_row = 3;
    const combo = sim.combos.newComboTabulator();
    sim.grid.blockAt(2, 3).startFalling(sim, combo);
    sim.swapper.x = 0;
    sim.swapper.y = 1;

    const ai = new AiController('hard', aiDecisionSeed(19, 0));
    const action = ai.decide(sim);
    expect(action.state).toBe(CC_SWAP);
    sim.step(action);
    for (let t = 0; t < 30 && combo.multiplier === 1; t++) sim.step(ai.decide(sim));
    expect(combo.multiplier).toBeGreaterThan(1);
  });

  it('uses the preceding elimination animation to prepare the same falling chain', () => {
    const sim = new GameSim(21);
    sim.blocks.gameStart();
    sim.garbageStore.gameStart();
    sim.combos.gameStart();
    sim.garbageGenerator.gameStart();
    sim.grid.gameStart();
    sim.swapper.gameStart();

    // Same target as the hang-window case, one phase earlier: the block at
    // (2,1) is still popping, and its linked cap waits immediately above it.
    // The AI can use that long animation window to make the setup swap now.
    for (let x = 0; x < 6; x++) sim.blocks.newBlock(x, 0, (x + 3) % 5);
    sim.blocks.newBlock(0, 1, BF_NORMAL_1);
    sim.blocks.newBlock(1, 1, BF_NORMAL_2);
    sim.blocks.newBlock(2, 1, BF_NORMAL_3);
    sim.blocks.newBlock(3, 1, BF_NORMAL_1);
    sim.blocks.newBlock(2, 2, BF_NORMAL_1);
    sim.grid.top_occupied_row = 2;
    sim.grid.top_effective_row = 2;
    const combo = sim.combos.newComboTabulator();
    sim.grid.blockAt(2, 1).startDying(sim, combo, 3);
    sim.swapper.x = 0;
    sim.swapper.y = 1;

    const ai = new AiController('hard', aiDecisionSeed(21, 0));
    const action = ai.decide(sim);
    expect(action.state).toBe(CC_SWAP);
    sim.step(action);
    for (let t = 0; t < 120 && combo.multiplier === 1; t++) sim.step(ai.decide(sim));
    expect(combo.multiplier).toBeGreaterThan(1);
  });

  it('preserves status quo when a linked fall is already guaranteed to chain', () => {
    const sim = new GameSim(23);
    sim.blocks.gameStart();
    sim.garbageStore.gameStart();
    sim.combos.gameStart();
    sim.garbageGenerator.gameStart();
    sim.grid.gameStart();
    sim.swapper.gameStart();

    // The hanging 1 at x2 will complete 1 1 1 on row 2 without help. Row 1
    // simultaneously offers a tempting 2 2 3 2 one-swap clear at x4. Taking
    // that lesser move risks disturbing the guaranteed falling chain, so wait.
    const floor = [BF_NORMAL_4, BF_NORMAL_5, BF_NORMAL_2, BF_NORMAL_2, BF_NORMAL_3, BF_NORMAL_2];
    for (let x = 0; x < 6; x++) {
      sim.blocks.newBlock(x, 0, (x + 1) % 5);
      sim.blocks.newBlock(x, 1, floor[x]!);
    }
    sim.blocks.newBlock(0, 2, BF_NORMAL_1);
    sim.blocks.newBlock(1, 2, BF_NORMAL_1);
    sim.blocks.newBlock(2, 4, BF_NORMAL_1);
    sim.grid.top_occupied_row = 4;
    sim.grid.top_effective_row = 4;
    const combo = sim.combos.newComboTabulator();
    sim.grid.blockAt(2, 4).startFalling(sim, combo);
    sim.swapper.x = 4;
    sim.swapper.y = 1;

    const ai = new AiController('hard', aiDecisionSeed(23, 0));
    expect(ai.decide(sim).state).toBe(0);
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
