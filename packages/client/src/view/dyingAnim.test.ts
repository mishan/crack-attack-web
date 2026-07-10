import { describe, expect, it } from 'vitest';
import { GC_DYING_DELAY } from '@crack-attack/core';
import { dyingPose } from './dyingAnim.js';

/** deathProgress for a given number of elapsed dying ticks. */
function progressAt(elapsed: number): number {
  return elapsed / (GC_DYING_DELAY - 1);
}

describe('dyingPose', () => {
  it('flash phase: full size, no spin, strobing', () => {
    for (const elapsed of [0, 3, 6, 9, 11]) {
      const pose = dyingPose(progressAt(elapsed));
      expect(pose.scale).toBe(1);
      expect(pose.angle).toBe(0);
      expect(pose.flash).toBeGreaterThanOrEqual(0);
      expect(pose.flash).toBeLessThanOrEqual(1);
    }
  });

  it('the strobe pulses twice: up, down, up, down', () => {
    // elapsed 0 → 0, 3 → 1 (peak), 6 → 0, 9 → 1 (peak), 12 → phase over.
    expect(dyingPose(progressAt(0)).flash).toBeCloseTo(0, 5);
    expect(dyingPose(progressAt(3)).flash).toBeCloseTo(1, 5);
    expect(dyingPose(progressAt(6)).flash).toBeCloseTo(0, 5);
    expect(dyingPose(progressAt(9)).flash).toBeCloseTo(1, 5);
  });

  it('the phase boundary (elapsed = 12) is full size, unspun, unflashed', () => {
    const pose = dyingPose(progressAt(12));
    expect(pose.scale).toBeCloseTo(1, 5);
    expect(pose.angle).toBe(0);
    expect(pose.flash).toBe(0);
  });

  it('shrink phase: no flash, monotonically shrinking, accelerating spin', () => {
    let prevScale = dyingPose(progressAt(12)).scale;
    let prevAngle = 0;
    let prevAngleStep = 0;
    for (let elapsed = 18; elapsed < GC_DYING_DELAY - 1; elapsed += 6) {
      const pose = dyingPose(progressAt(elapsed));
      expect(pose.flash).toBe(0);
      expect(pose.scale).toBeLessThan(prevScale);
      const angleStep = pose.angle - prevAngle;
      expect(angleStep).toBeGreaterThanOrEqual(prevAngleStep); // quadratic accel
      prevScale = pose.scale;
      prevAngle = pose.angle;
      prevAngleStep = angleStep;
    }
  });

  it('ends near the minimum size', () => {
    const end = dyingPose(1);
    // alarm = 1 at the last visible tick: scale = 1·speed + min ≈ min.
    expect(end.scale).toBeGreaterThan(0.1);
    expect(end.scale).toBeLessThan(0.15);
  });
});
