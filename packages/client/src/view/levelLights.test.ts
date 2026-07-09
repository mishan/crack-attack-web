import { describe, expect, it } from 'vitest';
import { GC_SAFE_HEIGHT } from '@crack-attack/core';
import { LEVEL_LIGHT_COUNT, isLevelLightRed } from './levelLights.js';

describe('level lights', () => {
  it('has one light per playable row (GC_SAFE_HEIGHT - 1)', () => {
    expect(LEVEL_LIGHT_COUNT).toBe(GC_SAFE_HEIGHT - 1);
  });

  it('reds every light whose row is within the stack top (index < top)', () => {
    const top = 5;
    // Light index i is at row i+1. Red while i < top (rows 1..5 ≤ top 5);
    // index 5 (row 6, the first empty row above the stack) and up are blue.
    expect(isLevelLightRed(0, top)).toBe(true); // row 1
    expect(isLevelLightRed(4, top)).toBe(true); // row 5 (= top)
    expect(isLevelLightRed(5, top)).toBe(false); // row 6 (just above the stack)
    expect(isLevelLightRed(LEVEL_LIGHT_COUNT - 1, top)).toBe(false);
  });

  it('is all blue at an empty stack and all red at a full stack', () => {
    for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
      expect(isLevelLightRed(n, 0)).toBe(false);
      expect(isLevelLightRed(n, LEVEL_LIGHT_COUNT)).toBe(true);
    }
  });
});
