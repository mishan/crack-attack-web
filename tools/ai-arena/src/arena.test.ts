import { describe, expect, it } from 'vitest';
import {
  GF_BLACK,
  GF_COLOR_1,
  GF_COLOR_2,
  GF_COLOR_3,
  GF_COLOR_4,
  GF_COLOR_5,
  GF_GRAY,
  GF_WHITE,
  GameSim,
  aiTuningFor,
} from '@crack-attack/core';
import { runMatch, runSeries, specialCells } from './arena.js';
import { tuningFromJson } from './config.js';

describe('arena', () => {
  it('a mirror match (same tuning, same seed) is a perfect draw', () => {
    // Both sims start identical and the controllers are deterministic functions
    // of sim state, so the boards must evolve in lockstep and top out together.
    const hard = aiTuningFor('hard');
    const result = runMatch(hard, hard, 42, 30_000);
    expect(result.outcome === 'draw' || result.outcome === 'timeout').toBe(true);
    expect(result.sentA).toBe(result.sentB);
  });

  it('is deterministic: same pairing + seed ⇒ identical result', () => {
    const a = aiTuningFor('hard');
    const b = aiTuningFor('easy');
    expect(runMatch(a, b, 7)).toEqual(runMatch(a, b, 7));
  });

  it('hard beats easy over a seed batch', () => {
    const series = runSeries(aiTuningFor('hard'), aiTuningFor('easy'), [1, 2, 7, 42, 101]);
    expect(series.winsA).toBeGreaterThan(series.winsB);
    expect(series.matches).toHaveLength(5);
    expect(series.winsA + series.winsB + series.draws + series.timeouts).toBe(5);
  });

  it('specialCells matches what the receiving generator actually queues', () => {
    // Deterministic expansions: the table must agree cell-for-cell with
    // dealSpecialLocalGarbage.
    for (const flavor of [
      GF_GRAY,
      GF_WHITE,
      GF_COLOR_2,
      GF_BLACK,
      GF_COLOR_3,
      GF_COLOR_4,
      GF_COLOR_5,
    ]) {
      const sim = new GameSim(3);
      sim.garbageGenerator.addToQueue(1, 1, flavor, sim.clock.time_step);
      expect(sim.garbageGenerator.pendingCellsWithin(sim.clock.time_step, 10_000)).toBe(
        specialCells(flavor),
      );
    }
    // COLOR_1 splinters by the receiver's RNG into 5–7 cells; the table's 6 is
    // a documented approximation — assert the real expansion stays in range.
    const sim = new GameSim(3);
    sim.garbageGenerator.addToQueue(1, 1, GF_COLOR_1, sim.clock.time_step);
    const cells = sim.garbageGenerator.pendingCellsWithin(sim.clock.time_step, 10_000);
    expect(cells).toBeGreaterThanOrEqual(5);
    expect(cells).toBeLessThanOrEqual(7);
  });

  it('tuningFromJson merges overrides over a base preset and rejects junk', () => {
    const t = tuningFromJson({ base: 'hard', shatterWeight: 6, flatten: true });
    expect(t).toEqual({ ...aiTuningFor('hard'), shatterWeight: 6, flatten: true });
    // Defaults to hard as the base.
    expect(tuningFromJson({})).toEqual(aiTuningFor('hard'));
    expect(() => tuningFromJson({ shatterWieght: 6 })).toThrow(/unknown tuning key/);
    expect(() => tuningFromJson({ cooldown: 'fast' })).toThrow(/must be a number/);
    expect(() => tuningFromJson({ base: 'brutal' })).toThrow(/"base" must be/);
    expect(() => tuningFromJson([1])).toThrow(/must be an object/);
  });
});
