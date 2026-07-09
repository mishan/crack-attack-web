/**
 * garbageDecal.ts — pure logic for the decorative garbage "flavor image".
 *
 * The original stamps a picture (`garbage_flavor_00N.png`) onto a *large* garbage
 * slab: `GarbageFlavorImage::requestGarbageFlavorImage`. Only one slab wears the
 * decal at a time (`associated_garbage_id`); a slab qualifies only when it is at
 * least `DC_MIN_FLAVOR_GARBAGE_LENGTH` cells in each dimension, and even then it
 * appears only ~7 times in 8 (`DC_CHANCE_NO_GARBAGE_FLAVOR`). The image and its
 * interior anchor cell are chosen at random.
 *
 * All of that is cosmetic, so it lives in the client and draws on `Math.random`
 * (injectable here for tests), never the deterministic gameplay RNG. This module
 * is the DOM-free decision logic; `render/garbageDecalView.ts` draws the result.
 */

/** A slab must be at least this many cells wide and tall to wear a decal. */
export const GARBAGE_DECAL_MIN_LENGTH = 4;
/** 1-in-this chance a qualifying slab shows *no* decal (`DC_CHANCE_NO_GARBAGE_FLAVOR`). */
export const GARBAGE_DECAL_NO_CHANCE = 8;
/** Number of decal images shipped (`garbage_flavor_000..003`). */
export const GARBAGE_DECAL_COUNT = 4;

/** Interior cell (relative to the slab origin) a decal is anchored at. */
export interface DecalAnchor {
  readonly dx: number;
  readonly dy: number;
}

/** Whether a slab is large enough to wear a decal (both dims ≥ the minimum). */
export function decalEligible(width: number, height: number): boolean {
  return width >= GARBAGE_DECAL_MIN_LENGTH && height >= GARBAGE_DECAL_MIN_LENGTH;
}

/**
 * Whether a qualifying slab actually claims the decal this time. Mirrors
 * `if (!Random::number(DC_CHANCE_NO_GARBAGE_FLAVOR)) return;` — it *skips* on a
 * roll of 0 (1 in 8), so it claims on the other 7.
 */
export function decalClaims(rand: () => number): boolean {
  return Math.floor(rand() * GARBAGE_DECAL_NO_CHANCE) !== 0;
}

/** Pick which decal image to show (`Random::number2(4)` → 0‥3). */
export function pickDecalTexture(rand: () => number): number {
  return Math.floor(rand() * GARBAGE_DECAL_COUNT);
}

/**
 * Choose the interior anchor cell, faithful to `requestGarbageFlavorImage`:
 * `x = 1 + number(width - 3)`, and `y = 1` three times in four (else a random
 * interior row). Assumes the slab is {@link decalEligible} (both dims ≥ 4), so
 * the `- 3` ranges are ≥ 1.
 */
export function decalAnchor(width: number, height: number, rand: () => number): DecalAnchor {
  const dx = 1 + Math.floor(rand() * (width - 3));
  const yAtBottom = Math.floor(rand() * 4) !== 0; // number2(4) nonzero → y = 1
  const dy = yAtBottom ? 1 : 1 + Math.floor(rand() * (height - 3));
  return { dx, dy };
}
