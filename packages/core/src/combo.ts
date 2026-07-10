/**
 * combo.ts
 *
 * ComboTabulator: tracks a set (or potential set) of elimination combos — the
 * accumulated magnitude of normal and special matches, the chain multiplier,
 * and how many blocks are still involved. Ported from `ComboTabulator.{h,cxx}`.
 *
 * A combo is created when blocks that might chain are set in motion (a swap, a
 * creep row, a fall), passed to the blocks it links, and reported to as those
 * blocks eliminate. When its involvement count returns to zero it is complete
 * and {@link ComboManager} converts its magnitude into garbage.
 *
 * Cosmetic side-effects in the C++ `reportElimination` (SignManager multiplier
 * signs, SparkleManager reward motes) are display-layer and omitted from core.
 * Score reporting is likewise deferred (display-only; see ComboManager).
 *
 * The current tick is passed in explicitly rather than read from a global,
 * keeping combos as plain pooled data objects.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { BF_NUMBER_SPECIAL } from './constants.js';
import { isColorlessFlavor } from './flavors.js';
import type { Block } from './block.js';
import type { SignSink } from './signs.js';
import type { StateHasher } from './digest.js';

export class ComboTabulator {
  /** Free-store id. `ComboTabulator.h:46` */
  id = 0;
  /** Latest elimination time stamp. `ComboTabulator.h:49` */
  time_stamp = 0;
  /** Creation time stamp. `ComboTabulator.h:52` */
  creation_time_stamp = 0;
  /** Number of blocks still involved in the combo. `ComboTabulator.h:55` */
  involvement_count = 0;
  /** Accumulated normal-elimination magnitude. `ComboTabulator.h:58` */
  magnitude = 0;
  /** Accumulated special-elimination magnitude. `ComboTabulator.h:61` */
  special_magnitude = 0;
  /** Chain multiplier. `ComboTabulator.h:64` */
  multiplier = 1;
  /** Multipliers gained this time step. `ComboTabulator.h:67` */
  n_multipliers_this_step = 0;
  /** Base score accumulated on this multiplier (Score display; deferred). `ComboTabulator.h:70` */
  base_accumulated_score = 0;
  /** Base score accumulated this step (Score display; deferred). `ComboTabulator.h:73` */
  base_score_this_step = 0;
  /** Magnitude used the step after elimination for death-spark count. `ComboTabulator.h:76` */
  latest_magnitude = 0;
  /** Location of the latest elimination. `ComboTabulator.h:79` */
  x = 0;
  y = 0;
  /** Tally of eliminated special blocks, indexed by special-flavor code. `ComboTabulator.h:82` */
  readonly special: number[] = new Array<number>(BF_NUMBER_SPECIAL).fill(0);

  /** Feed every gameplay field into the sim digest (digest.ts). Pure. */
  hashState(h: StateHasher): void {
    h.add(this.id);
    h.add(this.time_stamp);
    h.add(this.creation_time_stamp);
    h.add(this.involvement_count);
    h.add(this.magnitude);
    h.add(this.special_magnitude);
    h.add(this.multiplier);
    h.add(this.n_multipliers_this_step);
    h.add(this.base_accumulated_score);
    h.add(this.base_score_this_step);
    h.add(this.latest_magnitude);
    h.add(this.x);
    h.add(this.y);
    for (const s of this.special) h.add(s);
  }

  /**
   * Reset for reuse from the pool. Mirrors `ComboTabulator::initialize`
   * (ComboTabulator.cxx:39), plus a fuller reset than the C++ for robustness:
   * the original leaves `time_stamp`, `x`, `y`, `latest_magnitude`, and
   * `special[]` stale (it relies on invariants and pool-reuse patterns). We
   * clear them so a pooled combo can't leak state from a previous game — in
   * particular a stale `time_stamp` equal to the current tick would make
   * `ComboManager.timeStep` treat a fresh combo as having just eliminated.
   * `time_stamp` starts at -1 (never a valid tick) so it only matches after a
   * real `reportElimination`.
   */
  initialize(timeStep: number): void {
    this.magnitude = 0;
    this.special_magnitude = 0;
    this.multiplier = 1;
    this.n_multipliers_this_step = 0;
    this.base_accumulated_score = 0;
    this.base_score_this_step = 0;
    this.creation_time_stamp = timeStep;
    this.involvement_count = 0;

    this.time_stamp = -1;
    this.x = 0;
    this.y = 0;
    this.latest_magnitude = 0;
    this.special.fill(0);
  }

  /**
   * Record an elimination of `magnitudeDelta` blocks whose kernel is `kernel`.
   * Mirrors `ComboTabulator::reportElimination` (ComboTabulator.cxx:53). A
   * match that lands on a later tick than creation raises the multiplier (a
   * chain). Colorless (gray/black/white) kernels feed the special magnitude;
   * everything else feeds the normal magnitude. `signSink`, when supplied, is
   * notified of the multiplier reward sign; it's cosmetic and optional (the
   * emission draws no gameplay RNG, so it can't affect determinism).
   */
  reportElimination(
    magnitudeDelta: number,
    kernel: Block,
    timeStep: number,
    signSink?: SignSink,
  ): void {
    this.x = kernel.x;
    this.y = kernel.y;

    this.time_stamp = timeStep;

    // only a *late* elimination (a chain) bumps the multiplier
    if (timeStep !== this.creation_time_stamp) {
      this.multiplier++;
      this.n_multipliers_this_step++;
      // Cosmetic multiplier sign + reward mote (ComboTabulator.cxx:67-68).
      // `multiplier - 2` so the first chain (×2) is level 0; the mote uses the
      // C++'s `multiplier + 9` (the multiplier band of the mote-level tables).
      signSink?.createSign(this.x, this.y, 'multiplier', this.multiplier - 2);
      signSink?.createMote?.(this.x, this.y, this.multiplier + 9, 0);
    }

    if (isColorlessFlavor(kernel.flavor)) {
      this.special_magnitude += magnitudeDelta;
    } else {
      this.magnitude += magnitudeDelta;
    }
  }

  /** A block joins this combo. Mirrors `ComboTabulator::incrementInvolvement`. */
  incrementInvolvement(): void {
    ++this.involvement_count;
  }

  /** A block leaves this combo. Mirrors `ComboTabulator::decrementInvolvement`. */
  decrementInvolvement(): void {
    // Fail fast on underflow: a mismatched begin/end would drive the count
    // negative, so it could never return to 0 and the combo would never
    // complete — a subtle bug that this guard surfaces immediately.
    if (this.involvement_count <= 0) {
      throw new Error('ComboTabulator: involvement_count underflow');
    }
    --this.involvement_count;
  }
}
