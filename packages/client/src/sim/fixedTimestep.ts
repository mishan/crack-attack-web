/**
 * fixedTimestep.ts
 *
 * A wall-clock → fixed-tick accumulator. The simulation is deterministic and
 * runs at exactly 50 Hz (`GC_STEPS_PER_SECOND`); the browser renders at whatever
 * rate `requestAnimationFrame` gives us. This bridges the two the same way
 * `Game::timeStep` does: accumulate elapsed real time, run as many whole sim
 * steps as have come due, and expose an interpolation `alpha` for the render
 * layer to tween between the last two ticks.
 *
 * Pure and DOM-free: the caller feeds it timestamps (`performance.now()` in the
 * browser, fabricated values in tests), so it is fully unit-testable.
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';

export interface FixedTimestepOptions {
  /** Simulation rate in Hz. Defaults to the core's fixed 50 Hz. */
  readonly stepHz?: number;
  /**
   * Cap on steps run in a single `sample()` so a long stall (tab backgrounded,
   * GC pause) doesn't trigger a "spiral of death" where catch-up never finishes.
   * Excess accumulated time is dropped. Defaults to 10 (~200 ms at 50 Hz).
   */
  readonly maxCatchUpSteps?: number;
}

/** The fixed-timestep accumulator. One instance drives one simulation. */
export class FixedTimestep {
  /** Milliseconds per simulation step (20 ms at 50 Hz). */
  readonly stepMs: number;
  private readonly maxCatchUpSteps: number;

  private accumulatorMs = 0;
  private lastMs: number | null = null;

  constructor(options: FixedTimestepOptions = {}) {
    const hz = options.stepHz ?? GC_STEPS_PER_SECOND;
    // Must be positive AND finite: Infinity/NaN slip past `hz > 0` (Infinity) and
    // would give stepMs = 0, turning `sample()`/`alpha` into Infinity/NaN.
    if (!Number.isFinite(hz) || hz <= 0) {
      throw new RangeError(`stepHz must be a positive finite number (got ${hz})`);
    }
    this.stepMs = 1000 / hz;

    const maxCatchUp = options.maxCatchUpSteps ?? 10;
    // Must be a positive integer: `sample()` clamps its step count to this, so a
    // zero or negative value would make it return <= 0 steps and stall (or, with
    // a negative, hand callers a negative step count).
    if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1) {
      throw new RangeError(`maxCatchUpSteps must be a positive integer (got ${maxCatchUp})`);
    }
    this.maxCatchUpSteps = maxCatchUp;
  }

  /**
   * Advance the accumulator to `nowMs` and return how many whole sim steps are
   * now due. The first call establishes the baseline and returns 0. Time that
   * would exceed `maxCatchUpSteps` is discarded so catch-up stays bounded.
   */
  sample(nowMs: number): number {
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      return 0;
    }

    // Guard against non-monotonic clocks: never accumulate negative time.
    const delta = Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    this.accumulatorMs += delta;

    let steps = Math.floor(this.accumulatorMs / this.stepMs);
    // `steps * stepMs` can exceed the accumulator by a rounding ulp (fractional
    // stepMs), leaving a tiny negative remainder; clamp so `alpha` stays >= 0.
    this.accumulatorMs = Math.max(0, this.accumulatorMs - steps * this.stepMs);

    if (steps > this.maxCatchUpSteps) {
      // Drop the backlog beyond the cap; keep the sub-step remainder for alpha.
      steps = this.maxCatchUpSteps;
      this.accumulatorMs = Math.min(this.accumulatorMs, this.stepMs);
    }
    return steps;
  }

  /**
   * Interpolation fraction in [0, 1): how far the render clock has progressed
   * into the step *after* the last one `sample()` ran. The renderer tweens
   * positions by this to stay smooth between 50 Hz ticks.
   */
  get alpha(): number {
    // Clamp to [0, 1): a fractional `stepMs` (custom stepHz) plus the catch-up
    // path's `Math.min(accumulator, stepMs)` can make the ratio reach or slightly
    // exceed 1 through floating-point rounding; render interpolation relies on the
    // strict upper bound.
    return Math.min(this.accumulatorMs / this.stepMs, 1 - Number.EPSILON);
  }

  /** Reset to the pre-first-sample state (e.g. after a pause or restart). */
  reset(): void {
    this.accumulatorMs = 0;
    this.lastMs = null;
  }
}
