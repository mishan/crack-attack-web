import { describe, expect, it } from 'vitest';
import {
  GARBAGE_DECAL_COUNT,
  GARBAGE_DECAL_MIN_LENGTH,
  decalAnchor,
  decalClaims,
  decalEligible,
  pickDecalTexture,
} from './garbageDecal.js';

/** A rand stub that returns each supplied value in turn (then repeats the last). */
const seq = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
};

describe('decalEligible', () => {
  it('requires both dimensions at least the minimum length', () => {
    expect(decalEligible(GARBAGE_DECAL_MIN_LENGTH, GARBAGE_DECAL_MIN_LENGTH)).toBe(true);
    expect(decalEligible(3, 6)).toBe(false);
    expect(decalEligible(6, 3)).toBe(false);
    expect(decalEligible(5, 4)).toBe(true);
  });
});

describe('decalClaims', () => {
  it('skips on a roll of 0 (the 1-in-8 no-decal case)', () => {
    expect(decalClaims(seq(0))).toBe(false); // floor(0 * 8) === 0
  });

  it('claims on any non-zero roll', () => {
    expect(decalClaims(seq(0.5))).toBe(true); // floor(0.5 * 8) === 4
    expect(decalClaims(seq(0.99))).toBe(true);
  });
});

describe('pickDecalTexture', () => {
  it('returns an index within the available images', () => {
    expect(pickDecalTexture(seq(0))).toBe(0);
    expect(pickDecalTexture(seq(0.999))).toBe(GARBAGE_DECAL_COUNT - 1);
    for (let i = 0; i < GARBAGE_DECAL_COUNT; i++) {
      const idx = pickDecalTexture(seq((i + 0.5) / GARBAGE_DECAL_COUNT));
      expect(idx).toBe(i);
    }
  });
});

describe('decalAnchor', () => {
  it('anchors inside the slab, defaulting to the bottom interior row', () => {
    // dx roll 0 -> 1; y-branch roll 0.5 -> number2(4)=2 (nonzero) -> dy = 1
    const a = decalAnchor(6, 6, seq(0, 0.5));
    expect(a).toEqual({ dx: 1, dy: 1 });
  });

  it('picks a random interior row one time in four', () => {
    // dx roll 0.99 -> 1 + floor(0.99*3) = 3; y-branch roll 0 -> number2(4)=0 ->
    // dy = 1 + floor(rowRoll * (height-3)); rowRoll 0.99 -> 1 + 2 = 3
    const a = decalAnchor(6, 6, seq(0.99, 0, 0.99));
    expect(a).toEqual({ dx: 3, dy: 3 });
  });

  it('keeps a 2×2 decal within an eligible slab', () => {
    for (const [w, h] of [
      [4, 4],
      [5, 7],
      [6, 6],
    ] as const) {
      // Max out every roll so dx/dy are as large as possible.
      const a = decalAnchor(w, h, seq(0.999, 0, 0.999));
      expect(a.dx + 2).toBeLessThanOrEqual(w - 1);
      expect(a.dy + 2).toBeLessThanOrEqual(h - 1);
    }
  });
});
