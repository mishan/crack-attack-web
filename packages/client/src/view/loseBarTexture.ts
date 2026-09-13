/**
 * loseBarTexture.ts — the reference lose bar's shaded-tube texture, and the
 * colour sweep drawn across it.
 *
 * The original doesn't draw the bar from an image: `generateExternalCandy`
 * (obj_external_candy.cxx) computes a 128×16 luminance-alpha texture of a
 * capsule lit from the upper left — per-texel surface normals over a cylinder
 * with round caps, 4×4 supersampled — and `drawExternalCandy`
 * (DrawExternalCandy.cxx) blends it over per-vertex colours with a white
 * texture-environment colour (Displayer.cxx:146), so the specular luminance
 * lifts the colour toward white while the alpha carries the ambient + diffuse
 * shading and the rounded ends. This ports both halves as pure math for
 * `render/loseBarCanvas.ts`.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import type { Rgb } from './loseBar.js';

// Displayer.h:506-525.
export const LOSEBAR_TEX_S = 128;
export const LOSEBAR_TEX_T = 16;
const TEX_EFFECTIVE_S = LOSEBAR_TEX_S - 2;
const ANTIALIAS = 4;
const END_RATIO = (0.5 * LOSEBAR_TEX_T) / TEX_EFFECTIVE_S;
const LIGHT_X = -1 / Math.sqrt(3);
const LIGHT_Y = 1 / Math.sqrt(3);
const LIGHT_Z = 1 / Math.sqrt(3);
const SPECULAR_POWER = 0.45;
const AMBIENT_RATIO = 0.5;
/** DC_LOSEBAR_FADE_LENGTH / DC_LOSEBAR_LENGTH: the colour fade's width in texture u. */
const FADE_TEX_LENGTH = 2 / 7;

/** The bar's height : length as drawn (DC_LOSEBAR_HEIGHT / DC_LOSEBAR_LENGTH). */
export const LOSEBAR_ASPECT = LOSEBAR_TEX_T / TEX_EFFECTIVE_S;

export interface LoseBarTexture {
  /** Per texel, row-major from the top row, each in [0, 1]. */
  readonly lumin: Float32Array;
  readonly alpha: Float32Array;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Compute the tube texture (obj_external_candy.cxx:111-208). */
export function loseBarTexture(): LoseBarTexture {
  const lumin = new Float32Array(LOSEBAR_TEX_S * LOSEBAR_TEX_T);
  const alpha = new Float32Array(LOSEBAR_TEX_S * LOSEBAR_TEX_T);
  const k = (0.5 * Math.PI) / END_RATIO;
  const samples = ANTIALIAS * ANTIALIAS;

  for (let s = 0; s < LOSEBAR_TEX_S; s++) {
    // The clamped left and right edge columns stay transparent.
    if (s === 0 || s === LOSEBAR_TEX_S - 1) continue;
    const left = s / TEX_EFFECTIVE_S;
    for (let t = 0; t < LOSEBAR_TEX_T; t++) {
      const top = t / TEX_EFFECTIVE_S;
      let l = 0;
      let a = 0;
      for (let i = 0; i < ANTIALIAS; i++) {
        // Runs from 0 to 1 along the bar.
        const x = left + (i + 0.5) / (TEX_EFFECTIVE_S * ANTIALIAS);
        for (let j = 0; j < ANTIALIAS; j++) {
          // Runs from 0 to 2 · END_RATIO down the bar.
          const y = top + (j + 0.5) / (TEX_EFFECTIVE_S * ANTIALIAS);
          let nx = 0;
          let ny = Math.cos(y * k);
          let nz = Math.sin(y * k);
          if (x < END_RATIO || x > 1 - END_RATIO) {
            // A round end: skip samples outside it (they add no light or alpha,
            // which antialiases the silhouette).
            const dx = (x < END_RATIO ? END_RATIO : 1 - END_RATIO) - x;
            if ((y - END_RATIO) ** 2 + dx * dx >= END_RATIO * END_RATIO) continue;
            nx = Math.sin(dx * k);
            ny *= Math.cos(dx * k);
            nz *= Math.cos(dx * k);
          }
          const light = nx * LIGHT_X + ny * LIGHT_Y + nz * LIGHT_Z;
          l += 1 - Math.pow(1 - light, SPECULAR_POWER);
          a += AMBIENT_RATIO + (1 - AMBIENT_RATIO) * light;
        }
      }
      // GL clamps the float texels to [0, 1] on upload.
      lumin[t * LOSEBAR_TEX_S + s] = clamp01(l / samples);
      alpha[t * LOSEBAR_TEX_S + s] = clamp01(a / samples);
    }
  }
  return { lumin, alpha };
}

/**
 * The bar's colour at texture `u` (0 = left end, 1 = right end): `color1` filled
 * in from the left up to the fill boundary, `color2` beyond it, fading linearly
 * over FADE_TEX_LENGTH between — the left/centre/right quads of
 * DrawExternalCandy.cxx:60-125, placed by `bar` as at lines 150-153.
 */
export function loseBarColorAt(u: number, bar: number, color1: Rgb, color2: Rgb): Rgb {
  const t = bar * (1 + FADE_TEX_LENGTH) - 0.5 * FADE_TEX_LENGTH;
  const f = (u - (t - FADE_TEX_LENGTH / 2)) / FADE_TEX_LENGTH;
  if (f <= 0) return color1;
  if (f >= 1) return color2;
  return [
    color1[0] + f * (color2[0] - color1[0]),
    color1[1] + f * (color2[1] - color1[1]),
    color1[2] + f * (color2[2] - color1[2]),
  ];
}
