/**
 * palette.ts — flavor → colour mapping for the renderer.
 *
 * The original uses textured glTF models per flavor (Phase 2 asset conversion is
 * a later tool); for the shell we render solid-coloured blocks. Colours are a
 * platform-layer choice — restyle freely; only the flavor *indices* are load-
 * bearing (they come from the deterministic core).
 */

import {
  BF_BLACK,
  BF_GRAY,
  BF_NORMAL_1,
  BF_NORMAL_2,
  BF_NORMAL_3,
  BF_NORMAL_4,
  BF_NORMAL_5,
  BF_WHITE,
  GF_BLACK,
  GF_GRAY,
} from '@crack-attack/core';
import { Color } from 'three';

/** The five normal block colours, plus fallbacks for special flavors. */
const BLOCK_COLORS: Record<number, number> = {
  [BF_NORMAL_1]: 0xe0483f, // red
  [BF_NORMAL_2]: 0x46b24a, // green
  [BF_NORMAL_3]: 0x3f7fe0, // blue
  [BF_NORMAL_4]: 0xe0c53f, // yellow
  [BF_NORMAL_5]: 0xa04fd0, // purple
  [BF_GRAY]: 0x8a909c,
  [BF_BLACK]: 0x2a2d35,
  [BF_WHITE]: 0xf2f4f8,
};

const DEFAULT_BLOCK = 0xff5bd0; // eye-catching magenta for any unmapped special

const GARBAGE_COLORS: Record<number, number> = {
  [GF_GRAY]: 0x6c7280,
  [GF_BLACK]: 0x23262d,
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
