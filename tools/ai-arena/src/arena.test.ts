import { describe, expect, it } from 'vitest';
import { aiTuningFor } from '@crack-attack/core';
import { runMatch, runSeries } from './arena.js';
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
