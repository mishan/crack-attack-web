import { describe, expect, it } from 'vitest';
import type { Rgb } from './loseBar.js';
import { LOSEBAR_TEX_S, LOSEBAR_TEX_T, loseBarColorAt, loseBarTexture } from './loseBarTexture.js';

const at = (a: Float32Array, s: number, t: number): number => a[t * LOSEBAR_TEX_S + s]!;

describe('loseBarTexture', () => {
  const tex = loseBarTexture();

  it('keeps every texel in [0, 1]', () => {
    for (const v of [...tex.lumin, ...tex.alpha]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the edge columns and the corners outside the round ends transparent', () => {
    for (let t = 0; t < LOSEBAR_TEX_T; t++) {
      expect(at(tex.alpha, 0, t)).toBe(0);
      expect(at(tex.alpha, LOSEBAR_TEX_S - 1, t)).toBe(0);
    }
    expect(at(tex.alpha, 1, 0)).toBe(0);
    expect(at(tex.alpha, LOSEBAR_TEX_S - 2, LOSEBAR_TEX_T - 1)).toBe(0);
  });

  it('is solid down the middle of the tube', () => {
    const mid = LOSEBAR_TEX_S / 2;
    expect(at(tex.alpha, mid, LOSEBAR_TEX_T / 2)).toBeGreaterThan(0.5);
  });

  it('is lit from above: brighter near the top than the bottom', () => {
    const mid = LOSEBAR_TEX_S / 2;
    expect(at(tex.lumin, mid, 3)).toBeGreaterThan(at(tex.lumin, mid, LOSEBAR_TEX_T - 3));
  });
});

describe('loseBarColorAt', () => {
  const blue: Rgb = [0, 0, 1];
  const red: Rgb = [1, 0, 0];

  it('is all the empty colour at zero fill', () => {
    for (const u of [0, 0.5, 1]) expect(loseBarColorAt(u, 0, red, blue)).toEqual(blue);
  });

  it('is all the fill colour when full', () => {
    for (const u of [0, 0.5, 1]) expect(loseBarColorAt(u, 1, red, blue)).toEqual(red);
  });

  it('fills from the left, fading into the empty colour at the boundary', () => {
    expect(loseBarColorAt(0, 0.5, red, blue)).toEqual(red);
    expect(loseBarColorAt(1, 0.5, red, blue)).toEqual(blue);
    const [r, , b] = loseBarColorAt(0.5, 0.5, red, blue);
    expect(r).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(0.5, 6);
  });
});
