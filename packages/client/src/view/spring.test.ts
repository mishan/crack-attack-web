import { describe, expect, it } from 'vitest';
import { Spring, SPRING_UNITS_PER_CELL } from './spring.js';

describe('Spring', () => {
  it('rests at zero until an impact', () => {
    const s = new Spring();
    for (let t = 0; t < 50; t++) s.timeStep();
    expect(s.y).toBe(0);
    expect(s.offsetCells).toBe(0);
  });

  it('an impact kicks the board downward, then it springs back up', () => {
    const s = new Spring();
    s.notifyImpact(1, 6); // full-width single-row slab
    s.timeStep();
    expect(s.y).toBeLessThan(0); // first motion is a dip

    // Track the extremes over a few seconds: it must come back up past zero
    // (overshoot) and oscillate with decreasing amplitude.
    let min = 0;
    let max = 0;
    for (let t = 0; t < 150; t++) {
      s.timeStep();
      min = Math.min(min, s.y);
      max = Math.max(max, s.y);
    }
    expect(min).toBeLessThan(-0.05);
    expect(max).toBeGreaterThan(0.01);
  });

  it('damps back to rest', () => {
    const s = new Spring();
    s.notifyImpact(4, 6); // a big slab
    for (let t = 0; t < 500; t++) s.timeStep();
    expect(Math.abs(s.y)).toBeLessThan(1e-3);
  });

  it('bigger slabs kick harder', () => {
    const small = new Spring();
    const big = new Spring();
    small.notifyImpact(1, 3);
    big.notifyImpact(3, 6);
    small.timeStep();
    big.timeStep();
    expect(big.y).toBeLessThan(small.y); // more negative = deeper dip
  });

  it('a small impact while already plunging fast is a no-op (dv > 0 guard)', () => {
    // After a big slab, v is far below -SP_IMPACT_VELOCITY, so a 1×1 impact's
    // dv = (0.1 + v)·0.2 is negative and the guard drops it (Spring.h:42-44).
    const control = new Spring();
    const probed = new Spring();
    control.notifyImpact(4, 6);
    probed.notifyImpact(4, 6);
    probed.notifyImpact(1, 1); // guard: no added energy while plunging
    for (let t = 0; t < 10; t++) {
      control.timeStep();
      probed.timeStep();
    }
    expect(probed.y).toBe(control.y);
  });

  it('gameStart resets to rest', () => {
    const s = new Spring();
    s.notifyImpact(2, 6);
    s.timeStep();
    s.gameStart();
    expect(s.y).toBe(0);
    s.timeStep();
    expect(s.y).toBe(0);
  });

  it('converts reference units to cells', () => {
    const s = new Spring();
    s.notifyImpact(1, 6);
    s.timeStep();
    expect(s.offsetCells).toBeCloseTo(s.y / SPRING_UNITS_PER_CELL, 12);
  });
});
