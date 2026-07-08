import { describe, expect, it } from 'vitest';
import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { FixedTimestep } from './fixedTimestep.js';

describe('FixedTimestep', () => {
  it('defaults to the core 50 Hz step (20 ms)', () => {
    expect(new FixedTimestep().stepMs).toBeCloseTo(1000 / GC_STEPS_PER_SECOND);
  });

  it('runs no steps on the first sample (establishes the baseline)', () => {
    const ts = new FixedTimestep();
    expect(ts.sample(1000)).toBe(0);
  });

  it('runs one step per elapsed step interval', () => {
    const ts = new FixedTimestep();
    ts.sample(0);
    expect(ts.sample(20)).toBe(1);
    expect(ts.sample(40)).toBe(1);
  });

  it('runs multiple steps when several intervals elapse at once', () => {
    const ts = new FixedTimestep();
    ts.sample(0);
    expect(ts.sample(105)).toBe(5); // 105 ms / 20 ms = 5 whole steps
  });

  it('carries the sub-step remainder into alpha', () => {
    const ts = new FixedTimestep();
    ts.sample(0);
    ts.sample(30); // one step (20 ms), 10 ms left over
    expect(ts.sample(30)).toBe(0);
    expect(ts.alpha).toBeCloseTo(0.5); // 10 ms / 20 ms
  });

  it('accumulates fractional time across samples until a step is due', () => {
    const ts = new FixedTimestep();
    ts.sample(0);
    expect(ts.sample(12)).toBe(0);
    expect(ts.sample(24)).toBe(1); // 24 ms total crosses one 20 ms boundary
  });

  it('caps catch-up so a long stall does not spiral', () => {
    const ts = new FixedTimestep({ maxCatchUpSteps: 10 });
    ts.sample(0);
    expect(ts.sample(10_000)).toBe(10); // 500 steps due, clamped to 10
  });

  it('ignores backward clock jumps rather than accumulating negative time', () => {
    const ts = new FixedTimestep();
    ts.sample(1000);
    expect(ts.sample(500)).toBe(0);
    expect(ts.alpha).toBe(0);
  });

  it('reset() returns to the pre-baseline state', () => {
    const ts = new FixedTimestep();
    ts.sample(0);
    ts.sample(50);
    ts.reset();
    expect(ts.sample(9999)).toBe(0); // first sample after reset is a baseline
    expect(ts.alpha).toBe(0);
  });

  it('keeps alpha strictly below 1 even with a fractional step and full catch-up', () => {
    const ts = new FixedTimestep({ stepHz: 60, maxCatchUpSteps: 3 }); // 16.666… ms/step
    ts.sample(0);
    ts.sample(10_000); // huge stall: catch-up clamps, accumulator pinned to stepMs
    expect(ts.alpha).toBeLessThan(1);
    expect(ts.alpha).toBeGreaterThanOrEqual(0);
  });

  it('rejects a non-positive, infinite, or NaN step rate', () => {
    expect(() => new FixedTimestep({ stepHz: 0 })).toThrow();
    expect(() => new FixedTimestep({ stepHz: -30 })).toThrow();
    expect(() => new FixedTimestep({ stepHz: Infinity })).toThrow();
    expect(() => new FixedTimestep({ stepHz: NaN })).toThrow();
  });

  it('never yields a negative alpha (fractional-step rounding stays clamped)', () => {
    const ts = new FixedTimestep({ stepHz: 60 }); // 16.666… ms/step
    ts.sample(0);
    ts.sample(1000 / 60 + 1000 / 60 + 1000 / 60); // ~3 steps; subtraction may round < 0
    expect(ts.alpha).toBeGreaterThanOrEqual(0);
  });

  it('rejects a non-positive or fractional maxCatchUpSteps', () => {
    expect(() => new FixedTimestep({ maxCatchUpSteps: 0 })).toThrow();
    expect(() => new FixedTimestep({ maxCatchUpSteps: -3 })).toThrow();
    expect(() => new FixedTimestep({ maxCatchUpSteps: 2.5 })).toThrow();
  });
});
