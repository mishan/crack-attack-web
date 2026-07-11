import { describe, expect, it } from 'vitest';
import { GC_DYING_DELAY, Rng } from '@crack-attack/core';
import {
  DC_MAX_MOTE_NUMBER,
  DC_MAX_SPARK_NUMBER,
  DC_MOTE_COLOR_FADE_TIME,
  MOTE_COLORS,
  MT_FIVE_POINTED_STAR,
  MT_MULTIPLIER_ONE_STAR,
  MT_SPECIAL_STAR,
  Sparkles,
  moteTint,
  sparkTint,
} from './sparkles.js';

const HALF_W = 2.5;
const HALF_H = 6;
const KILL_Y = 14;

function make(seed = 0xdecaf): Sparkles {
  return new Sparkles(new Rng(seed), HALF_W, HALF_H, KILL_Y);
}

describe('death sparks', () => {
  it('spawns exactly n sparks, colored by flavor, launched upward', () => {
    const s = make();
    s.createBlockDeathSpark(2, 3, 4, 7);
    expect(s.spark_count).toBe(7);
    for (const spark of s.sparks.filter((p) => p.active)) {
      expect(spark.color).toBe(4);
      expect(spark.v_y).toBeGreaterThan(0); // deathSparkAngle: [π/4, 3π/4]
      expect(Math.abs(spark.v_x)).toBeLessThanOrEqual(spark.v_y + 1e-9);
      expect(spark.life_time).toBeGreaterThan(0);
    }
  });

  it('caps at the pool size', () => {
    const s = make();
    s.createBlockDeathSpark(0, 0, 1, DC_MAX_SPARK_NUMBER + 50);
    expect(s.spark_count).toBe(DC_MAX_SPARK_NUMBER);
  });

  it('gravity arcs sparks down and life expiry frees the pool', () => {
    const s = make(7);
    s.createBlockDeathSpark(2, 3, 0, 20);
    const before = s.sparks.find((p) => p.active)!;
    const vy0 = before.v_y;
    for (let t = 0; t < 100; t++) s.timeStep();
    if (before.active) expect(before.v_y).toBeLessThan(vy0);
    // Sparks live at most ~1700 ticks; run past it and the pool must be empty.
    for (let t = 0; t < 1800; t++) s.timeStep();
    expect(s.spark_count).toBe(0);
    expect(s.sparks.every((p) => !p.active)).toBe(true);
  });

  it('tint: plain, then a white pulse, then a fade-out at end of life', () => {
    expect(sparkTint(100)).toEqual({ alpha: 1, whiteMix: 0 });
    expect(sparkTint(18).whiteMix).toBeGreaterThan(0); // pulse window [15, 21)
    expect(sparkTint(14).alpha).toBeCloseTo(14 / 15, 5);
    expect(sparkTint(1).alpha).toBeCloseTo(1 / 15, 5);
  });
});

describe('celebration (firework) sparks', () => {
  it('launches from source positions with the requested colour, arcing upward', () => {
    const s = make();
    const W = HALF_W * 2;
    // sources 0-3 fan up-and-out; source 4 shoots nearly straight up
    s.createCelebrationSpark(0, 3);
    s.createCelebrationSpark(2, 3);
    s.createCelebrationSpark(4, 1);
    const active = s.sparks.filter((p) => p.active);
    expect(active).toHaveLength(3);
    for (const spark of active) {
      expect(spark.v_y).toBeGreaterThan(0); // both angle fans launch upward
      expect(spark.life_time).toBeGreaterThan(0);
    }
    // source 0 launches from the left edge, source 2 from the right (mirrored in).
    expect(s.sparks.find((p) => p.active && p.x === -W)).toBeTruthy();
    expect(s.sparks.find((p) => p.active && p.x === W)).toBeTruthy();
    expect(active.find((p) => p.color === 1)).toBeTruthy(); // source 4's colour
  });

  it('caps at the pool size', () => {
    const s = make();
    for (let i = 0; i < DC_MAX_SPARK_NUMBER + 20; i++) s.createCelebrationSpark(i % 5, i % 5);
    expect(s.spark_count).toBe(DC_MAX_SPARK_NUMBER);
  });
});

describe('reward motes', () => {
  it('maps levels through the C++ tables (type, size, color)', () => {
    const s = make();
    s.createRewardMote(1, 5, 1, 0); // level 1: five-pointed star, color 0
    s.createRewardMote(1, 5, 3, 0); // level 3: special star, color 4 (gray)
    s.createRewardMote(1, 5, 11, 0); // level 11: multiplier-one star, color 0
    s.createRewardMote(1, 5, 999, 0); // clamps to the last level
    const active = s.motes.filter((m) => m.active);
    expect(active[0]!.type).toBe(MT_FIVE_POINTED_STAR);
    expect(active[1]!.type).toBe(MT_SPECIAL_STAR);
    expect(active[1]!.color).toBe(4);
    expect(active[2]!.type).toBe(MT_MULTIPLIER_ONE_STAR);
    expect(active[2]!.inverse_mass).toBe(1); // ×2 chains are still light
    expect(active[3]!.size).toBe(5.1);
    expect(active[3]!.inverse_mass).toBeCloseTo(1 / 4.2, 10); // heaviest, level 21
    expect(s.mote_count).toBe(4);
  });

  it('the heavy multiplier band starts at level 14 (table alignment)', () => {
    // Regression: a dropped 1.0 entry once shifted the whole inverse-mass
    // band by one level (and left level 21 falling off the table).
    const s = make();
    s.createRewardMote(1, 1, 13, 0); // ×4 chain: last of the unit-mass band
    s.createRewardMote(1, 1, 14, 0); // ×5 chain: first heavy mote
    const [l13, l14] = s.motes.filter((m) => m.active);
    expect(l13!.inverse_mass).toBe(1);
    expect(l14!.inverse_mass).toBeCloseTo(1 / 1.4, 10);
  });

  it('holds at the payout (rotating only), staggered by sibling, then launches', () => {
    const s = make();
    s.createRewardMote(4, 5, 0, 0); // sibling 0: launches after GC_DYING_DELAY
    s.createRewardMote(4, 5, 0, 2); // sibling 2: +50 ticks later
    const [first, second] = s.motes.filter((m) => m.active);
    const x0 = first!.x;
    for (let t = 0; t < GC_DYING_DELAY - 1; t++) s.timeStep();
    expect(first!.x).toBe(x0); // still holding
    for (let t = 0; t < 10; t++) s.timeStep();
    expect(first!.x).not.toBe(x0); // launched
    expect(second!.life_time).toBeGreaterThanOrEqual(0); // still holding
    for (let t = 0; t < 60; t++) s.timeStep();
    expect(second!.life_time).toBeLessThan(0); // launched too
  });

  it('floats up and despawns off the top', () => {
    const s = make(3);
    s.createRewardMote(4, 10, 5, 0);
    for (let t = 0; t < 3000 && s.mote_count > 0; t++) s.timeStep();
    expect(s.mote_count).toBe(0);
  });

  it('right-half payouts launch right, left-half launch left', () => {
    const s = make();
    s.createRewardMote(0, 5, 0, 0); // left half
    s.createRewardMote(5, 5, 0, 0); // right half (GC_PLAY_WIDTH = 6)
    const [left, right] = s.motes.filter((m) => m.active);
    expect(left!.v_x).toBeLessThan(0);
    expect(right!.v_x).toBeGreaterThan(0);
  });

  it('caps at the pool size', () => {
    const s = make();
    for (let n = 0; n < DC_MAX_MOTE_NUMBER + 5; n++) s.createRewardMote(1, 1, 0, 0);
    expect(s.mote_count).toBe(DC_MAX_MOTE_NUMBER);
  });

  it('multiplier motes fade in white-ish then cross-fade to their color', () => {
    const s = make();
    s.createRewardMote(1, 1, 14, 0); // level 14 → color 1 (yellow flare)
    const mote = s.motes.find((m) => m.active)!;
    // Fading in: shows color 0 with rising alpha.
    mote.life_time = 30;
    expect(moteTint(mote)).toEqual([...MOTE_COLORS[0]!, 30 / GC_DYING_DELAY]);
    // Post-launch: cross-fades toward its own color.
    mote.life_time = -Math.trunc(DC_MOTE_COLOR_FADE_TIME / 2);
    const mid = moteTint(mote);
    expect(mid[3]).toBe(1);
    expect(mid[0]).toBeGreaterThan(MOTE_COLORS[1]![0]); // still part color-0 red
    // Fully faded.
    mote.life_time = -DC_MOTE_COLOR_FADE_TIME - 1;
    expect(moteTint(mote)).toEqual([...MOTE_COLORS[1]!, 1]);
  });
});
