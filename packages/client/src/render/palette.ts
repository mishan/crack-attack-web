/**
 * palette.ts — flavor → colour mapping for the renderer.
 *
 * The original draws blocks and garbage as lit, solid-coloured cubes (no per-
 * flavor texture — see `DrawBlocks.cxx`/`DrawGarbage.cxx`), tinted by fixed RGB
 * tables. We reproduce those tables here so the port reads like the reference:
 * `block_colors[BF_NUMBER]` and `garbage_colors[GF_NUMBER]`. Colours are a
 * platform-layer choice, but matching the original keeps flavors recognisable.
 * Only the flavor *indices* are load-bearing (they come from the deterministic
 * core); the RGB values are cosmetic.
 */

import {
  BF_BLACK,
  BF_GRAY,
  BF_NORMAL_1,
  BF_NORMAL_2,
  BF_NORMAL_3,
  BF_NORMAL_4,
  BF_NORMAL_5,
  BF_SPECIAL_COLOR_1,
  BF_SPECIAL_COLOR_2,
  BF_SPECIAL_COLOR_3,
  BF_SPECIAL_COLOR_4,
  BF_SPECIAL_COLOR_5,
  BF_WHITE,
  BF_WILD,
  GF_BLACK,
  GF_COLOR_1,
  GF_COLOR_2,
  GF_COLOR_3,
  GF_COLOR_4,
  GF_COLOR_5,
  GF_GRAY,
  GF_NORMAL,
  GF_WHITE,
} from '@crack-attack/core';
import { Color } from 'three';

/** Pack a float RGB triple (as written in the C++ tables) into a hex int. */
function rgb(r: number, g: number, b: number): number {
  const to8 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return (to8(r) << 16) | (to8(g) << 8) | to8(b);
}

/**
 * `Displayer::block_colors[BF_NUMBER]` (DrawBlocks.cxx). The five specials are
 * 2× the normal channels in the original (clamped to [0, 1] on upload).
 */
const BLOCK_COLORS: Record<number, number> = {
  [BF_NORMAL_1]: rgb(0.73, 0.0, 0.73), // purple
  [BF_NORMAL_2]: rgb(0.2, 0.2, 0.8), // blue
  [BF_NORMAL_3]: rgb(0.0, 0.6, 0.05), // green
  [BF_NORMAL_4]: rgb(0.85, 0.85, 0.0), // yellow
  [BF_NORMAL_5]: rgb(1.0, 0.4, 0.0), // orange
  [BF_WILD]: rgb(1.0, 0.0, 0.0), // wild (red)
  [BF_GRAY]: rgb(0.4, 0.4, 0.4),
  [BF_BLACK]: rgb(0.05, 0.05, 0.05),
  [BF_WHITE]: rgb(0.95, 0.95, 0.95),
  [BF_SPECIAL_COLOR_1]: rgb(2.0 * 0.73, 0.0, 2.0 * 0.73),
  [BF_SPECIAL_COLOR_2]: rgb(2.0 * 0.2, 2.0 * 0.2, 2.0 * 0.8),
  [BF_SPECIAL_COLOR_3]: rgb(0.0, 2.0 * 0.6, 2.0 * 0.05),
  [BF_SPECIAL_COLOR_4]: rgb(2.0 * 0.85, 2.0 * 0.85, 0.0),
  [BF_SPECIAL_COLOR_5]: rgb(2.0 * 1.0, 2.0 * 0.4, 0.0),
};

const DEFAULT_BLOCK = 0xff5bd0; // eye-catching magenta for any unmapped flavor

/** `Displayer::garbage_colors[GF_NUMBER]` (DrawGarbage.cxx). */
const GARBAGE_COLORS: Record<number, number> = {
  [GF_NORMAL]: rgb(1.0, 0.0, 0.0), // red
  [GF_GRAY]: rgb(0.4, 0.4, 0.4),
  [GF_BLACK]: rgb(0.05, 0.05, 0.05),
  [GF_WHITE]: rgb(0.95, 0.95, 0.95),
  [GF_COLOR_1]: rgb(0.73, 0.0, 0.73), // purple
  [GF_COLOR_2]: rgb(0.2, 0.2, 0.8), // blue
  [GF_COLOR_3]: rgb(0.0, 0.6, 0.05), // green
  [GF_COLOR_4]: rgb(0.85, 0.85, 0.0), // yellow
  [GF_COLOR_5]: rgb(1.0, 0.4, 0.0), // orange
};
const DEFAULT_GARBAGE = 0x9aa3b2;

// Colours are immutable and there are only a handful of flavors, so cache one
// `Color` per flavor. `blockColor`/`garbageColor` run per sprite per frame; the
// renderer's "no per-frame allocation" rule means we must not mint a Color each
// call. Callers treat the returned Color as read-only (BoardView copies it into
// a scratch Color before tinting).
const blockCache = new Map<number, Color>();
const garbageCache = new Map<number, Color>();

function cached(cache: Map<number, Color>, flavor: number, hex: number): Color {
  let c = cache.get(flavor);
  if (!c) {
    c = new Color(hex);
    cache.set(flavor, c);
  }
  return c;
}

/** Shared immutable colour for a block flavor. Do not mutate the result. */
export function blockColor(flavor: number): Color {
  return cached(blockCache, flavor, BLOCK_COLORS[flavor] ?? DEFAULT_BLOCK);
}

/** Shared immutable colour for a garbage slab flavor. Do not mutate the result. */
export function garbageColor(flavor: number): Color {
  return cached(garbageCache, flavor, GARBAGE_COLORS[flavor] ?? DEFAULT_GARBAGE);
}
