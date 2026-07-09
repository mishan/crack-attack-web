/**
 * levelLights.ts — pure logic for the side "level light" danger indicators.
 *
 * The original shows a vertical column of arrow lights down each side of the
 * board (`LevelLights`): one per playable row (`LL_NUMBER_LEVEL_LIGHTS =
 * GC_SAFE_HEIGHT - 1`). A light is **red** while its row is below the top of the
 * stack (filled → danger) and **blue** at or above it, so the red/blue boundary
 * tracks the stack height. In solo both sides mirror this same local set.
 *
 * This is the DOM-free decision logic; `render/levelLightsView.ts` draws it.
 */

import { GC_SAFE_HEIGHT } from '@crack-attack/core';

/** Number of level lights per side (`LL_NUMBER_LEVEL_LIGHTS`). */
export const LEVEL_LIGHT_COUNT = GC_SAFE_HEIGHT - 1;

/**
 * Whether the light at `index` (0 = bottom) is red rather than blue.
 *
 * Light `index` sits at playable grid row `index + 1` (grid row 0 is the creep
 * floor). It is red once that row is at or below the stack's top — i.e. when
 * `index + 1 <= topEffectiveRow`, equivalently `index < topEffectiveRow`. So the
 * lowest blue light is the one at row `topEffectiveRow + 1` (the first empty row
 * above the stack). Mirrors `LevelLights::levelRaise`.
 */
export function isLevelLightRed(index: number, topEffectiveRow: number): boolean {
  return index < topEffectiveRow;
}
