/**
 * signs.ts — pure presentation logic for the combo reward signs.
 *
 * The deterministic core emits {@link SignEvent}s (grid cell + kind + level); this
 * module turns each into the art it should show and animates its short life,
 * faithfully to the original's `SignManager`/`DrawCandy` (hold, then fade + grow
 * + float upward). No DOM/WebGL here so the mapping and physics are unit-tested;
 * `render/signsView.ts` is the thin Three.js layer that draws what this describes.
 *
 * Timing is in sim ticks (50 Hz). Distances are in grid cells (one cell = one
 * world unit in the renderer), converted from the C++'s 2-unit cells.
 */

import type { SignKind } from '@crack-attack/core';

// Sign lifetime, faithful to Displayer.h. Hold at full opacity, then fade out
// over `FADE` while inflating — the classic reward-pop flourish.
export const SIGN_HOLD_TIME = 100;
export const SIGN_FADE_TIME = 200;
export const SIGN_LIFE_TIME = SIGN_HOLD_TIME + SIGN_FADE_TIME; // 300 ticks (6 s)
/** Peak scale reached at the end of the fade (`DC_FINAL_INFLATE_SIZE`). */
export const SIGN_FINAL_INFLATE_SIZE = 5.0;
/** Terminal float speed, in cells/tick (`DC_GRID_ELEMENT_LENGTH / 500`, /2 for unit cells). */
export const SIGN_TERMINAL_VELOCITY = 1 / 500;
/** Float ramps linearly from 0 to terminal over the hold, then stays constant. */
export const SIGN_ACCELERATION = SIGN_TERMINAL_VELOCITY / SIGN_HOLD_TIME;

/** The largest `level` each sign kind has art for (`maximum_levels`, SignManager.cxx:37). */
const MAX_LEVEL: Record<SignKind, number> = { magnitude: 8, multiplier: 10, special: 8 };

/**
 * The texture key (PNG basename under `textures/signs/`) for a sign. Mirrors the
 * C++ `level → sign` mapping: magnitude `level` shows the combo size `level + 4`
 * (`sign_4`…`sign_12`), multiplier `level` shows `×(level + 2)` (`sign_x2`…
 * `sign_x12`), and every special shows the single bonus badge. `level` is clamped
 * to the available art exactly as `SignManager::createSign` clamps it.
 */
export function signTextureKey(kind: SignKind, level: number): string {
  const clamped = Math.max(0, Math.min(MAX_LEVEL[kind], Math.floor(level)));
  if (kind === 'magnitude') return `sign_${clamped + 4}`;
  if (kind === 'multiplier') return `sign_x${clamped + 2}`;
  return 'sign_bonus';
}

/**
 * The C++ special-sign tints (`sign_colors`, DrawCandy.cxx:51-60), indexed by
 * the special sign's level (`SignManager::createSign` sets `sign.color =
 * level` for ST_SPECIAL only): 0 = the generic gray-branch bonus, 1..7 = the
 * special flavor that was matched (black, white, purple, blue, green, yellow,
 * orange).
 */
const SPECIAL_SIGN_COLORS = [
  0xffffff, // normal
  0x333333, // black
  0xffffff, // white
  0xeebfee, // purple
  0xccccf2, // blue
  0xbfe5bf, // green
  0xf5f5bf, // yellow
  0xffd9bf, // orange
] as const;

/**
 * Tint applied to a sign's white glyph. Specials are tinted per matched
 * flavor, faithful to the C++ (`sign.color = level` for ST_SPECIAL); the
 * magnitude/multiplier tints are a deliberate cosmetic divergence (the C++
 * leaves those white) for legibility on our background.
 */
export function signColor(kind: SignKind, level = 0): number {
  if (kind === 'multiplier') return 0xffe24a; // gold chains (divergence)
  if (kind === 'special') {
    const clamped = Math.max(0, Math.min(SPECIAL_SIGN_COLORS.length - 1, Math.floor(level)));
    return SPECIAL_SIGN_COLORS[clamped]!;
  }
  return 0xffffff; // white combo size
}

/** Opacity over a sign's life: full during the hold, then an eased fade to 0. */
export function signAlpha(life: number): number {
  if (life < SIGN_HOLD_TIME) return 1;
  if (life >= SIGN_LIFE_TIME) return 0; // fully faded (guard over-age life)
  const fade = (SIGN_LIFE_TIME - life) / SIGN_FADE_TIME; // 1 → 0 across the fade
  return fade * fade;
}

/** Scale multiplier over life: 1 during the hold, inflating toward the peak as it fades. */
export function signScale(life: number): number {
  if (life < SIGN_HOLD_TIME) return 1;
  if (life >= SIGN_LIFE_TIME) return SIGN_FINAL_INFLATE_SIZE; // fully inflated (guard over-age life)
  const fade = (SIGN_LIFE_TIME - life) / SIGN_FADE_TIME;
  const grow = 1 - fade;
  return 1 + (SIGN_FINAL_INFLATE_SIZE - 1) * grow * grow;
}

/** Upward distance (cells) a sign rises on the tick it reaches age `life`. */
export function signRiseDelta(life: number): number {
  return life < SIGN_HOLD_TIME ? SIGN_ACCELERATION * life : SIGN_TERMINAL_VELOCITY;
}

/** Whether a sign has lived out its life and should be removed. */
export function signExpired(life: number): boolean {
  return life >= SIGN_LIFE_TIME;
}
