import { describe, expect, it } from 'vitest';
import { BF_GRAY, BF_NORMAL_1 } from './constants.js';
import { Block } from './block.js';
import { ComboTabulator } from './combo.js';

const kernel = (x: number, y: number, flavor: number): Block => {
  const b = new Block();
  b.x = x;
  b.y = y;
  b.flavor = flavor;
  return b;
};

describe('ComboTabulator.initialize', () => {
  it('resets accumulators and records the creation tick', () => {
    const c = new ComboTabulator();
    c.magnitude = 99;
    c.multiplier = 5;
    c.involvement_count = 3;

    c.initialize(42);
    expect(c.magnitude).toBe(0);
    expect(c.special_magnitude).toBe(0);
    expect(c.multiplier).toBe(1);
    expect(c.n_multipliers_this_step).toBe(0);
    expect(c.involvement_count).toBe(0);
    expect(c.creation_time_stamp).toBe(42);
  });

  it('clears stale pooled state so it cannot leak across games', () => {
    const c = new ComboTabulator();
    c.time_stamp = 5;
    c.x = 9;
    c.y = 9;
    c.latest_magnitude = 7;
    c.special[0] = 3;

    c.initialize(0);
    // -1 sentinel: never equals a real tick, so a fresh combo isn't mistaken
    // for one that eliminated this tick
    expect(c.time_stamp).toBe(-1);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    expect(c.latest_magnitude).toBe(0);
    expect(c.special.every((v) => v === 0)).toBe(true);
  });
});

describe('ComboTabulator.reportElimination', () => {
  it('adds a normal-flavor match to the normal magnitude', () => {
    const c = new ComboTabulator();
    c.initialize(10);
    c.reportElimination(3, kernel(1, 2, BF_NORMAL_1), 10);
    expect(c.magnitude).toBe(3);
    expect(c.special_magnitude).toBe(0);
    expect(c.x).toBe(1);
    expect(c.y).toBe(2);
    expect(c.time_stamp).toBe(10);
  });

  it('adds a colorless-flavor match to the special magnitude', () => {
    const c = new ComboTabulator();
    c.initialize(10);
    c.reportElimination(4, kernel(0, 0, BF_GRAY), 10);
    expect(c.special_magnitude).toBe(4);
    expect(c.magnitude).toBe(0);
  });

  it('does not raise the multiplier on the creation tick', () => {
    const c = new ComboTabulator();
    c.initialize(10);
    c.reportElimination(3, kernel(0, 0, BF_NORMAL_1), 10);
    expect(c.multiplier).toBe(1);
    expect(c.n_multipliers_this_step).toBe(0);
  });

  it('raises the multiplier on a later (chained) tick', () => {
    const c = new ComboTabulator();
    c.initialize(10);
    c.reportElimination(3, kernel(0, 0, BF_NORMAL_1), 13);
    expect(c.multiplier).toBe(2);
    expect(c.n_multipliers_this_step).toBe(1);
    c.reportElimination(3, kernel(0, 0, BF_NORMAL_1), 16);
    expect(c.multiplier).toBe(3);
    expect(c.n_multipliers_this_step).toBe(2);
  });
});

describe('ComboTabulator involvement', () => {
  it('counts blocks joining and leaving', () => {
    const c = new ComboTabulator();
    c.initialize(0);
    c.incrementInvolvement();
    c.incrementInvolvement();
    expect(c.involvement_count).toBe(2);
    c.decrementInvolvement();
    expect(c.involvement_count).toBe(1);
  });

  it('throws on involvement underflow rather than going negative', () => {
    const c = new ComboTabulator();
    c.initialize(0);
    expect(() => c.decrementInvolvement()).toThrow(/underflow/);
  });
});
