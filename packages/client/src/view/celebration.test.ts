import { describe, expect, it } from 'vitest';
import { Celebration, type CelebrationRng } from './celebration.js';

// Deterministic RNG: never fires a chance (no strobe re-arm, no firework boosts,
// and `number` returns 0 so the spawn threshold `number(600) < rate` always emits).
const noFlash: CelebrationRng = { chanceIn: () => false, number: () => 0 };
const always: CelebrationRng = { chanceIn: () => true, number: () => 0 };

describe('Celebration — board fade', () => {
  it('dims the board from 0 to 1 over the fade time and marks complete', () => {
    const c = new Celebration(noFlash);
    c.start('loss');
    expect(c.view.boardDim).toBe(0);
    for (let i = 0; i < 100; i++) c.tick();
    expect(c.view.boardDim).toBeGreaterThan(0.4);
    expect(c.view.boardDim).toBeLessThan(0.6);
    for (let i = 0; i < 130; i++) c.tick(); // past CELEBRATION_TIME (225)
    expect(c.view.boardDim).toBe(1);
    expect(c.view.complete).toBe(true);
  });
});

describe('Celebration — win', () => {
  it('scales in from huge to 1 and fades to full opacity over the fade time', () => {
    const c = new Celebration(noFlash);
    c.start('win');
    expect(c.view.scale).toBeCloseTo(12); // DC_STARTING_WIN_SCALE
    expect(c.view.opacity).toBeLessThan(0.05);
    for (let i = 0; i < 50; i++) c.tick(); // WIN_FADE_TIME
    expect(c.view.scale).toBeCloseTo(1);
    expect(c.view.opacity).toBe(1);
  });

  it('shrinks and brightens monotonically during the fade-in', () => {
    const c = new Celebration(noFlash);
    c.start('win');
    let prevScale = c.view.scale;
    let prevOpacity = c.view.opacity;
    for (let i = 0; i < 40; i++) {
      c.tick();
      expect(c.view.scale).toBeLessThanOrEqual(prevScale);
      expect(c.view.opacity).toBeGreaterThanOrEqual(prevOpacity);
      prevScale = c.view.scale;
      prevOpacity = c.view.opacity;
    }
  });

  it('flashes after the fade when the strobe re-arms', () => {
    const c = new Celebration(always); // always re-arm
    c.start('win');
    for (let i = 0; i < 55; i++) c.tick();
    expect(c.view.flash).toBeGreaterThan(0);
  });

  it('emits firework spark spawns only after the fade, across all sources', () => {
    const c = new Celebration(noFlash); // number()==0 → spawn threshold always met
    c.start('win');
    // Ticks process t=0..50; the fade fills t<50 and t===50 seeds the source
    // rates (no emission on the seed tick).
    for (let i = 0; i < 51; i++) c.tick();
    expect(c.drainSparkSpawns()).toEqual([]);
    // The next tick (t=51) is the first in the emission loop: every source fires.
    c.tick();
    const spawns = c.drainSparkSpawns();
    expect(spawns.map((s) => s.source).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    expect(c.drainSparkSpawns()).toEqual([]); // drained
  });

  it('a loss never emits fireworks', () => {
    const c = new Celebration(noFlash);
    c.start('loss');
    for (let i = 0; i < 200; i++) c.tick();
    expect(c.drainSparkSpawns()).toEqual([]);
  });
});

describe('Celebration — loss bounce', () => {
  it('starts at full drop height and settles to rest', () => {
    const c = new Celebration(noFlash);
    c.start('loss');
    expect(c.view.dropFraction).toBeCloseTo(1); // starts above the board
    expect(c.view.scale).toBe(1);
    expect(c.view.opacity).toBe(1);
    // run long enough for gravity + bounces to settle
    for (let i = 0; i < 4000; i++) c.tick();
    expect(c.view.dropFraction).toBeCloseTo(0);
  });

  it('drops (dropFraction decreases) before the first bounce', () => {
    const c = new Celebration(noFlash);
    c.start('loss');
    const start = c.view.dropFraction;
    for (let i = 0; i < 20; i++) c.tick();
    expect(c.view.dropFraction).toBeLessThan(start);
  });
});

describe('Celebration — lifecycle', () => {
  it('is inactive until start and after stop, and tick is a no-op when idle', () => {
    const c = new Celebration(noFlash);
    expect(c.active).toBe(false);
    c.tick(); // no-op
    c.start('win');
    expect(c.active).toBe(true);
    c.stop();
    expect(c.active).toBe(false);
  });
});
