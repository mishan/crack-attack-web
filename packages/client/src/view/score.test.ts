import { describe, expect, it } from 'vitest';
import type { ScoreEvent } from '@crack-attack/core';
import { ScoreState, scorePoints, SPECIAL_BLOCK_SCORES } from './score.js';

const ev = (over: Partial<ScoreEvent> = {}): ScoreEvent => ({
  id: 0,
  creationTimeStamp: 0,
  magnitude: 0,
  specialMagnitude: 0,
  multiplier: 1,
  nMultipliers: 0,
  special: [0, 0, 0, 0, 0, 0, 0],
  ...over,
});

describe('scorePoints', () => {
  it('scores a minimum colored run as GC_MIN_PATTERN_SCORE (2)', () => {
    expect(scorePoints(ev({ magnitude: 3 }))).toBe(2);
  });

  it('scores a larger colored run as its magnitude', () => {
    expect(scorePoints(ev({ magnitude: 5 }))).toBe(5);
  });

  it('scores gray eliminations at GC_GRAY_SCORE with the min-pattern rule', () => {
    expect(scorePoints(ev({ specialMagnitude: 3 }))).toBe(6); // 3 * MIN_PATTERN_SCORE(2)
    expect(scorePoints(ev({ specialMagnitude: 4 }))).toBe(12); // 3 * 4
  });

  it('adds special-block bonuses (black=30, orange=10)', () => {
    // one black (code 0) + one orange (code 6) on a 3-run colored elimination
    const special = [1, 0, 0, 0, 0, 0, 1];
    expect(scorePoints(ev({ magnitude: 3, special }))).toBe(
      2 + SPECIAL_BLOCK_SCORES[0]! + SPECIAL_BLOCK_SCORES[6]!,
    );
  });
});

describe('ScoreState.report — backlog + multiplier bonus', () => {
  it('a single elimination adds its points to the backlog', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 3 }));
    expect(s.backlog).toBe(2);
    expect(s.topMultiplier).toBe(0); // no chain
  });

  it('a chain applies the reportMultiplier bonus from accumulated base score', () => {
    const s = new ScoreState();
    // Each report carries only that tick's magnitude (the core zeroes it after).
    // step 1: 3-run, no chain → 2 pts
    s.report(ev({ id: 0, creationTimeStamp: 0, magnitude: 3, multiplier: 1, nMultipliers: 0 }));
    // step 2 (chain): a 4-run this tick, multiplier 2, one new multiplier
    s.report(ev({ id: 0, creationTimeStamp: 0, magnitude: 4, multiplier: 2, nMultipliers: 1 }));
    // base_accumulated is the cross-tick sum: 2 + 4 = 6; base_step this tick = 4.
    // backlog: 2 (step1) + 4 (step2 points) + [4*(2-1-1) + 6*1] = 2 + 4 + 6 = 12
    expect(s.backlog).toBe(12);
    expect(s.topMultiplier).toBe(2);
  });

  it('treats a reused pool slot (new creationTimeStamp) as a fresh combo', () => {
    const s = new ScoreState();
    s.report(ev({ id: 0, creationTimeStamp: 0, magnitude: 5 }));
    const afterFirst = s.backlog;
    // same id, new creation stamp → scratch resets, no stale accumulated bonus
    s.report(ev({ id: 0, creationTimeStamp: 99, magnitude: 3, multiplier: 2, nMultipliers: 1 }));
    // step points 2; bonus uses fresh accumulated(2): 2*(2-1-1) + 2*1 = 2
    expect(s.backlog).toBe(afterFirst + 2 + 2);
  });
});

describe('ScoreState.timeStep — backlog drip', () => {
  it('drips the whole backlog into the score given enough ticks', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 10 })); // 10 points
    s.timeStep(1000);
    expect(s.score).toBe(10);
    expect(s.backlog).toBe(0);
  });

  it('does not overrun the backlog', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 5 }));
    s.timeStep(3); // only a few ticks — a large delay means < 5 dripped
    expect(s.score).toBeLessThanOrEqual(5);
    expect(s.score + s.backlog).toBe(5);
  });
});

describe('ScoreState display + reset', () => {
  it('zero-pads to at least the minimum digit width', () => {
    const s = new ScoreState();
    expect(s.formatted()).toBe('0000'); // GC_MIN_NUMBER_DIGITS_DISPLAYED = 4
  });

  it('grows the digit width as the score gains digits', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 12345 }));
    s.timeStep(100000); // ample: the drip caps at ~2 ticks/point
    expect(s.score).toBe(12345);
    expect(s.formatted()).toBe('12345'); // widened to 5
  });

  it('flush drips the remaining backlog into the score at once', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 100 }));
    s.flush();
    expect(s.score).toBe(100);
    expect(s.backlog).toBe(0);
  });

  it('reset clears score, backlog, multiplier, and per-combo scratch', () => {
    const s = new ScoreState();
    s.report(ev({ magnitude: 7, multiplier: 3, nMultipliers: 1 }));
    s.timeStep(50);
    s.reset();
    expect(s.score).toBe(0);
    expect(s.backlog).toBe(0);
    expect(s.topMultiplier).toBe(0);
    expect(s.formatted()).toBe('0000');
  });
});
