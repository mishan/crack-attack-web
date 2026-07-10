import { describe, expect, it } from 'vitest';
import { GC_SAFE_HEIGHT } from '@crack-attack/core';
import { LEVEL_LIGHT_COUNT, LevelLightsState, isLevelLightRed } from './levelLights.js';

/** Run `n` ticks at a fixed stack height. */
function run(state: LevelLightsState, ticks: number, row: number, live = true): void {
  for (let t = 0; t < ticks; t++) state.tick(row, live);
}

/** [r, g, b] convenience with rounding for stable comparisons. */
function rgb(state: LevelLightsState, n: number): [number, number, number] {
  const [r, g, b] = state.color(n);
  return [Math.round(r * 1000) / 1000, Math.round(g * 1000) / 1000, Math.round(b * 1000) / 1000];
}

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

describe('LevelLightsState', () => {
  it('converges to the steady-state red/blue rule after the fade (150 ticks)', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, 5); // past DC_LEVEL_LIGHT_FADE_TIME
    for (let n = 0; n < LEVEL_LIGHT_COUNT; n++) {
      const [r, , b] = rgb(state, n);
      if (isLevelLightRed(n, 5)) {
        expect(r).toBeCloseTo(0.7, 3);
        expect(b).toBe(0);
      } else {
        expect(r).toBe(0);
        expect(b).toBeCloseTo(0.7, 3);
      }
    }
  });

  it('fades rather than snaps: mid-fade a raising light shows both channels', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, 3); // settle at top = 3
    run(state, 40, 6); // raise; lights 3..5 are mid-fade to red
    const [r, , b] = rgb(state, 4);
    expect(r).toBeGreaterThan(0.1);
    expect(b).toBeGreaterThan(0.1);
    run(state, 200, 6); // fade completes
    const [r2, , b2] = rgb(state, 4);
    expect(r2).toBeCloseTo(0.7, 3);
    expect(b2).toBe(0);
  });

  it('reversing a fade mid-way keeps the visual position (alarm mirror)', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, 3);
    run(state, 30, 6); // partway toward red
    const towardRed = rgb(state, 4)[0];
    run(state, 1, 3); // drop back: reverses to fade-to-blue
    const reversing = rgb(state, 4)[0];
    // No snap: the red channel continues from (near) where it was.
    expect(Math.abs(reversing - towardRed)).toBeLessThan(0.1);
  });

  it('impact-flashes the covered rows toward white, then decays', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, 2);
    // A slab landing on rows 5..6 flashes lights 4..5, not light 3 or 6.
    state.notifyImpact(5, 2);
    run(state, 3, 2); // into the pulse
    expect(rgb(state, 4)[1]).toBeGreaterThan(0); // green only exists while flashing
    expect(rgb(state, 5)[1]).toBeGreaterThan(0);
    expect(rgb(state, 3)[1]).toBe(0);
    expect(rgb(state, 6)[1]).toBe(0);
    run(state, 25, 2); // DC_LEVEL_LIGHT_IMPACT_FLASH_TIME = 20: over
    expect(rgb(state, 4)[1]).toBe(0);
  });

  it('clamps impacts that extend above the light column', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    expect(() => state.notifyImpact(LEVEL_LIGHT_COUNT, 4)).not.toThrow();
    expect(() => state.notifyImpact(LEVEL_LIGHT_COUNT + 2, 1)).not.toThrow();
  });

  it('death-flashes the whole column while the stack violates the safe height', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, 5);
    expect(state.deathFlashing).toBe(false);

    const violating = GC_SAFE_HEIGHT - 1;
    run(state, 1, violating);
    expect(state.deathFlashing).toBe(true);
    // Mid-strobe, even a blue light picks up red+green (whitening).
    run(state, 6, violating);
    const [r, g] = rgb(state, LEVEL_LIGHT_COUNT - 1);
    expect(r).toBeGreaterThan(0);
    expect(g).toBeGreaterThan(0);

    // While violating, the strobe re-arms indefinitely...
    run(state, 100, violating);
    expect(state.deathFlashing).toBe(true);
    // ...and stops (within one strobe period) once the danger clears.
    run(state, 20, 5);
    expect(state.deathFlashing).toBe(false);
  });

  it('does not re-arm the death flash once the game is over', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    const violating = GC_SAFE_HEIGHT - 1;
    run(state, 5, violating);
    expect(state.deathFlashing).toBe(true);
    run(state, 20, violating, false); // game over: gameLive = false
    expect(state.deathFlashing).toBe(false);
  });

  it('gameStart resets to the starting stack height', () => {
    const state = new LevelLightsState();
    state.gameStart(0);
    run(state, 200, GC_SAFE_HEIGHT - 1);
    state.gameStart(2);
    expect(state.deathFlashing).toBe(false);
    run(state, 200, 2);
    expect(rgb(state, 0)[0]).toBeCloseTo(0.7, 3);
    expect(rgb(state, 5)[2]).toBeCloseTo(0.7, 3);
  });
});
