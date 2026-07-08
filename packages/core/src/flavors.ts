/**
 * flavors.ts
 *
 * Pure block- and garbage-flavor classification and mapping. Ported from the
 * inline helpers in `BlockManager.h` and `GarbageManager.h`. These are integer
 * functions with no state — the safest, most testable part of the rules layer.
 *
 * Block flavor constants (BF_*) live in `constants.ts`. Garbage flavor
 * constants (GF_*) are defined here since they are only meaningful alongside
 * these helpers.
 *
 * NOTE on X-mode (wild) matching: `BlockManager::flavorMatch` has a branch for
 * `X::wildActive()` in which BF_WILD blocks resolve to a rolled flavor. X-mode
 * is a deferred subsystem (Phase 6); {@link flavorMatch} here implements only
 * the non-X path (`X::wildActive()` is always false with X-mode off), which is
 * faithful for standard play. The wild branch will be layered in with X-mode.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  BF_FINAL_GRAY_SPECIAL,
  BF_GRAY,
  BF_NUMBER_NORMAL,
  BF_SPECIAL_COLOR_1,
} from './constants.js';

// --- Garbage flavors (Garbage.h:35-50) -------------------------------------

export const GF_NORMAL = 0;
export const GF_GRAY = 1; // hard to destroy
export const GF_BLACK = 2; // very hard to destroy
export const GF_WHITE = 3; // crazy lights
export const GF_COLOR_1 = 4; // sprinkling of 1x1's
export const GF_COLOR_2 = 5; // shatters to normal garbage
export const GF_COLOR_3 = 6; // invisible swapper
export const GF_COLOR_4 = 7; // reverse controls
export const GF_COLOR_5 = 8; // tall garbage
export const GF_NUMBER = 9;

// flavor effects (Garbage.h:47-50)
export const GF_SHATTER_TO_NORMAL_GARBAGE = GF_COLOR_2;
export const GF_REVERSE_CONTROLS = GF_COLOR_4;
export const GF_INVISIBLE_SWAPPER = GF_COLOR_3;
export const GF_CRAZY_LIGHTS = GF_WHITE;

// --- Block flavor classification (BlockManager.h:145-196) ------------------

/** `flavor <= BF_NUMBER_NORMAL`. Note: BF_WILD counts as "normal". `BlockManager.h:145` */
export function isNormalFlavor(flavor: number): boolean {
  return flavor <= BF_NUMBER_NORMAL;
}

/** `flavor <= BF_GRAY`. `BlockManager.h:150` */
export function isBaseFlavor(flavor: number): boolean {
  return flavor <= BF_GRAY;
}

/** Gray/black/white band: `BF_GRAY <= flavor <= BF_FINAL_GRAY_SPECIAL`. `BlockManager.h:155` */
export function isColorlessFlavor(flavor: number): boolean {
  return flavor >= BF_GRAY && flavor <= BF_FINAL_GRAY_SPECIAL;
}

/** `flavor > BF_GRAY`. `BlockManager.h:160` */
export function isSpecialFlavor(flavor: number): boolean {
  return flavor > BF_GRAY;
}

/** `flavor >= BF_SPECIAL_COLOR_1`. `BlockManager.h:165` */
export function isSpecialColorFlavor(flavor: number): boolean {
  return flavor >= BF_SPECIAL_COLOR_1;
}

/**
 * Collapse a flavor to its base (matchable) color. Special colors map onto the
 * corresponding normal color; everything non-base but non-special-color maps to
 * gray. `BlockManager.h:170`
 */
export function mapFlavorToBaseFlavor(flavor: number): number {
  if (isBaseFlavor(flavor)) return flavor;
  if (isSpecialColorFlavor(flavor)) return mapSpecialColorFlavorToColor(flavor);
  return BF_GRAY;
}

/**
 * Whether two blocks match for elimination (non-X path).
 * Mirrors `BlockManager::flavorMatch` with `X::wildActive()` false.
 * `BlockManager.h:124`
 */
export function flavorMatch(flavorA: number, flavorB: number): boolean {
  return mapFlavorToBaseFlavor(flavorA) === mapFlavorToBaseFlavor(flavorB);
}

// --- Special-flavor "code" arithmetic (BlockManager.h:183-196) -------------
// Each special flavor has a distinct code used to index special-flavor arrays.

/** `code <= mapSpecialFlavorToCode(BF_FINAL_GRAY_SPECIAL)`. `BlockManager.h:183` */
export function isColorlessCode(code: number): boolean {
  return code <= mapSpecialFlavorToCode(BF_FINAL_GRAY_SPECIAL);
}

/** `flavor - (BF_GRAY + 1)`. `BlockManager.h:188` */
export function mapSpecialFlavorToCode(flavor: number): number {
  return flavor - (BF_GRAY + 1);
}

/** `flavor - BF_SPECIAL_COLOR_1`. `BlockManager.h:193` */
export function mapSpecialColorFlavorToColor(flavor: number): number {
  return flavor - BF_SPECIAL_COLOR_1;
}

// --- Garbage-flavor helpers (GarbageManager.h:85-93) -----------------------

/** `GarbageManager::isSpecialFlavor` — any non-normal garbage. `GarbageManager.h:85` */
export function garbageIsSpecialFlavor(flavor: number): boolean {
  return flavor !== GF_NORMAL;
}

/** `code + (GF_GRAY + 1)`. Maps a block special-code to a garbage flavor. `GarbageManager.h:90` */
export function mapBlockCodeToGarbageFlavor(code: number): number {
  return code + (GF_GRAY + 1);
}
