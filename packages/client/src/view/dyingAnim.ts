/**
 * dyingAnim.ts — the two-phase block death animation (pure, render-layer).
 *
 * Faithful to the BS_DYING branch of `DrawBlocks.cxx:318-360`: for the first
 * DC_DYING_FLASH_TIME (12) ticks the block sits full-size strobing toward
 * white — the folded triangle wave produces two full 0→1→0 pulses — then it
 * shrinks (linearly to DC_DYING_SHRINK_MIN_SIZE) while spinning with a
 * quadratically accelerating angle around the block's cosmetic death axis.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_DYING_DELAY } from '@crack-attack/core';

// Death-animation constants (Displayer.h:122-135).
const DC_DYING_FLASH_TIME = 12;
const DC_DYING_SHRINK_MIN_SIZE = 0.1;
const DC_DYING_SHRINK_SPEED =
  (1.0 - DC_DYING_SHRINK_MIN_SIZE) / (GC_DYING_DELAY - DC_DYING_FLASH_TIME);
const DC_DYING_ROTATE_SPEED = 0.2; // degrees per tick²

/** The render pose of a dying block at some point through its countdown. */
export interface DyingPose {
  /** White-flash blend 0..1 (two strobe pulses during the flash phase, else 0). */
  flash: number;
  /** Spin angle in radians around the block's death axis (0 during the flash). */
  angle: number;
  /** Uniform scale (1 during the flash, then shrinking toward the minimum). */
  scale: number;
}

/**
 * Pose for a dying block, from the view model's `deathProgress` (0 at the
 * first visible dying tick, 1 at the last — i.e. `alarm` running
 * GC_DYING_DELAY → 1, exactly the range the reference draws).
 */
export function dyingPose(deathProgress: number): DyingPose {
  // Invert the view model's normalization back to the reference's counters.
  const elapsed = deathProgress * (GC_DYING_DELAY - 1); // GC_DYING_DELAY - alarm
  const alarm = GC_DYING_DELAY - elapsed;

  if (elapsed < DC_DYING_FLASH_TIME) {
    // "when dying, first we flash" (DrawBlocks.cxx:321-327): fold a 0..4 ramp
    // into two triangle pulses.
    let flash = elapsed * (4.0 / DC_DYING_FLASH_TIME);
    if (flash > 2.0) flash = 4.0 - flash;
    if (flash > 1.0) flash = 2.0 - flash;
    return { flash, angle: 0, scale: 1 };
  }

  // "then we shrink and spin" (DrawBlocks.cxx:347-360).
  const spin = elapsed - DC_DYING_FLASH_TIME;
  const angleDeg = spin * spin * DC_DYING_ROTATE_SPEED;
  const scale = alarm * DC_DYING_SHRINK_SPEED + DC_DYING_SHRINK_MIN_SIZE;
  return { flash: 0, angle: (angleDeg * Math.PI) / 180, scale };
}
