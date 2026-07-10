/**
 * sparkles.ts — death sparks and combo reward motes (pure, render-layer).
 *
 * Faithful port of `SparkleManager.{h,cxx}`: dying blocks burst into
 * flavor-colored sparks (count = the combo magnitude the block stashed in
 * `pop_alarm`) that arc under gravity, and combo payouts launch "motes" —
 * stars that hold at the payout cell, then dive outward and float up off the
 * top of the board under an upward force, a centering spring, and a twist
 * spring. All positions/velocities are in the reference's world units
 * (DC_GRID_ELEMENT_LENGTH = 2.0 per cell, origin at the board center); the
 * view divides by 2 into cell units, as the shake spring does.
 *
 * In the C++ these 20-odd RNG draws share the *gameplay* stream — the single
 * biggest reason the port gave cosmetics their own unsynced stream. Here the
 * RNG is injected (a throwaway `Rng`), so nothing can perturb determinism.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_DYING_DELAY, GC_PLAY_WIDTH, type Rng } from '@crack-attack/core';

// --- constants (Displayer.h:174-258) ----------------------------------------

export const DC_MAX_SPARK_NUMBER = 400;
export const DC_MAX_MOTE_NUMBER = 40;
const DC_GRID_ELEMENT_LENGTH = 2.0;
export const DC_SPARKLE_LENGTH = 0.4 / 2.0;

const DC_SPARK_GRAVITY = 0.001;
const DC_SPARK_DRAG = 0.001;
const DC_MIN_SPARK_VELOCITY = 0.02;
const DC_MAX_SPARK_VELOCITY = 0.15;
const DC_MIN_SPARK_ANGULAR_VELOCITY = 1.0;
const DC_MAX_SPARK_ANGULAR_VELOCITY = 15.0;
const DC_MIN_SPARK_SIZE = 0.4;
const DC_MEDIUM_SPARK_LIFE_TIME = 120;
const DC_SPREAD_SPARK_LIFE_TIME = 50;
const DC_CHANCE_LONG_SPARK_LIFE_TIME = 40;
export const DC_SPARK_FADE_TIME = 15;
export const DC_SPARK_PULSE_TIME = 6;

const DC_MULTI_MOTE_FIRE_DELAY = 25;
export const DC_MOTE_COLOR_FADE_TIME = 50;
const DC_MEDIUM_MOTE_VELOCITY = 0.2;
const DC_SPREAD_MOTE_VELOCITY = 0.02;
const DC_MEDIUM_MOTE_ANGULAR_VELOCITY = 3.0;
const DC_SPREAD_MOTE_ANGULAR_VELOCITY = 1.0;
const DC_MOTE_UPWARD_FORCE = 0.004;
const DC_MOTE_CENTER_SPRING = 0.005;
const DC_MOTE_TWIST_SPRING = 0.0008;
const DC_MOTE_DRAG = 0.005;
export const DC_NUMBER_MOTE_LEVELS = 22;
export const DC_FIRST_SPECIAL_MOTE_COLOR = 4;

// Mote star shapes (Displayer.h:241-247); the view maps these to geometry.
export const MT_FOUR_POINTED_STAR = 0;
export const MT_FIVE_POINTED_STAR = 1;
export const MT_SIX_POINTED_STAR = 2;
export const MT_SPECIAL_STAR = 3;
export const MT_MULTIPLIER_ONE_STAR = 4;
export const MT_MULTIPLIER_TWO_STAR = 5;
export const MT_MULTIPLIER_THREE_STAR = 6;

// Per-level tables (SparkleManager.cxx:41-68).
const MOTE_COLORS_BY_LEVEL = [0, 0, 0, 4, 5, 6, 7, 8, 9, 10, 11, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 3];
const MOTE_TYPES_BY_LEVEL = [
  MT_FOUR_POINTED_STAR,
  MT_FIVE_POINTED_STAR,
  MT_SIX_POINTED_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_SPECIAL_STAR,
  MT_MULTIPLIER_ONE_STAR,
  MT_MULTIPLIER_TWO_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
  MT_MULTIPLIER_THREE_STAR,
];
const MOTE_SIZES_BY_LEVEL = [
  2.0, 2.8, 2.8, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 3.4, 4.0, 2.6, 3.5, 3.7, 3.9, 4.1, 4.3, 4.5,
  4.7, 4.9, 5.1,
];
const MOTE_INVERSE_MASSES_BY_LEVEL = [
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1 / 1.4,
  1 / 1.8,
  1 / 2.2,
  1 / 2.6,
  1 / 3.0,
  1 / 3.4,
  1 / 3.8,
  1 / 4.2,
];

/** Mote RGB triplets (DrawCandy.cxx:37-48). Index 0 is the fade-in "normal". */
export const MOTE_COLORS: readonly [number, number, number][] = [
  [1.0, 0.0, 0.0], // normal
  [0.9, 0.4, 0.0], // yellow flare
  [0.8, 0.8, 0.0], // orange flare
  [0.3, 0.3, 1.0], // blue flare
  [0.4, 0.4, 0.4], // gray
  [0.0, 0.0, 0.0], // black
  [0.9, 0.9, 0.9], // white
  [0.73, 0.0, 0.73], // purple
  [0.2, 0.2, 0.8], // blue
  [0.0, 0.6, 0.05], // green
  [0.85, 0.85, 0.0], // yellow
  [1.0, 0.4, 0.0], // orange
];

export interface Spark {
  active: boolean;
  x: number;
  y: number;
  v_x: number;
  v_y: number;
  /** Rotation + angular velocity in degrees, as the reference keeps them. */
  a: number;
  v_a: number;
  size: number;
  /** Block flavor (the view colors from the block palette). */
  color: number;
  life_time: number;
}

export interface Mote {
  active: boolean;
  x: number;
  y: number;
  v_x: number;
  v_y: number;
  a: number;
  initial_a: number;
  v_a: number;
  /** Index into {@link MOTE_COLORS}. */
  color: number;
  /** MT_* star shape. */
  type: number;
  size: number;
  inverse_mass: number;
  life_time: number;
  sibling_delay: number;
}

/** Spark tint factors at `life` ticks remaining (DrawCandy.cxx:120-140). */
export function sparkTint(life: number): { alpha: number; whiteMix: number } {
  if (life < DC_SPARK_FADE_TIME) {
    return { alpha: life / DC_SPARK_FADE_TIME, whiteMix: 0 };
  }
  if (life < DC_SPARK_FADE_TIME + DC_SPARK_PULSE_TIME) {
    let pulse = (life - DC_SPARK_FADE_TIME) * (2 / DC_SPARK_PULSE_TIME);
    if (pulse > 1) pulse = 2 - pulse;
    return { alpha: 1, whiteMix: pulse };
  }
  return { alpha: 1, whiteMix: 0 };
}

/** Mote RGBA at its current life (DrawCandy.cxx:163-196). */
export function moteTint(mote: Mote): [number, number, number, number] {
  const base = MOTE_COLORS[mote.color]!;
  if (mote.color > 0 && mote.color < DC_FIRST_SPECIAL_MOTE_COLOR) {
    if (mote.life_time >= 0 && mote.life_time < GC_DYING_DELAY) {
      const c0 = MOTE_COLORS[0]!;
      return [c0[0], c0[1], c0[2], mote.life_time / GC_DYING_DELAY];
    }
    if (mote.life_time > -DC_MOTE_COLOR_FADE_TIME) {
      const fade = -mote.life_time / DC_MOTE_COLOR_FADE_TIME;
      const c0 = MOTE_COLORS[0]!;
      return [
        (1 - fade) * c0[0] + fade * base[0],
        (1 - fade) * c0[1] + fade * base[1],
        (1 - fade) * c0[2] + fade * base[2],
        1,
      ];
    }
    return [base[0], base[1], base[2], 1];
  }
  if (mote.life_time >= 0 && mote.life_time < GC_DYING_DELAY) {
    return [base[0], base[1], base[2], mote.life_time / GC_DYING_DELAY];
  }
  return [base[0], base[1], base[2], 1];
}

export class Sparkles {
  readonly sparks: Spark[] = [];
  readonly motes: Mote[] = [];
  spark_count = 0;
  mote_count = 0;

  /**
   * @param rng   Throwaway cosmetic RNG (injected for tests).
   * @param halfW Board half-width in cells ((width - 1) / 2), for centering.
   * @param halfH Board half-height in cells.
   * @param killY World y above which motes despawn (the visible top edge).
   */
  constructor(
    private readonly rng: Rng,
    private readonly halfW: number,
    private readonly halfH: number,
    private readonly killY: number,
  ) {
    for (let n = 0; n < DC_MAX_SPARK_NUMBER; n++) {
      this.sparks.push({
        active: false,
        x: 0,
        y: 0,
        v_x: 0,
        v_y: 0,
        a: 0,
        v_a: 0,
        size: 1,
        color: 0,
        life_time: 0,
      });
    }
    for (let n = 0; n < DC_MAX_MOTE_NUMBER; n++) {
      this.motes.push({
        active: false,
        x: 0,
        y: 0,
        v_x: 0,
        v_y: 0,
        a: 0,
        initial_a: 0,
        v_a: 0,
        color: 0,
        type: 0,
        size: 1,
        inverse_mass: 1,
        life_time: 0,
        sibling_delay: 0,
      });
    }
  }

  /** Deactivate everything (new game). Mirrors `SparkleManager::initialize`. */
  gameStart(): void {
    for (const s of this.sparks) s.active = false;
    for (const m of this.motes) m.active = false;
    this.spark_count = 0;
    this.mote_count = 0;
  }

  /**
   * Burst of `n` sparks at grid cell (x, y), colored by block flavor.
   * Mirrors `SparkleManager::createBlockDeathSpark` (SparkleManager.cxx:81).
   */
  createBlockDeathSpark(cellX: number, cellY: number, flavor: number, n: number): void {
    const rng = this.rng;
    while (n--) {
      if (this.spark_count === DC_MAX_SPARK_NUMBER) return;
      let i = 0;
      while (this.sparks[i]!.active) i++;
      const spark = this.sparks[i]!;

      this.spark_count++;
      spark.active = true;
      spark.x = (cellX - this.halfW) * DC_GRID_ELEMENT_LENGTH;
      spark.y = (cellY - this.halfH) * DC_GRID_ELEMENT_LENGTH;

      const v =
        DC_MIN_SPARK_VELOCITY +
        (rng.numberFloat() + rng.numberFloat()) *
          (0.5 * (DC_MAX_SPARK_VELOCITY - DC_MIN_SPARK_VELOCITY));
      // Random::deathSparkAngle: uniform in [π/4, 3π/4] — an upward fan.
      const angle = Math.PI / 4 + (Math.PI / 2) * rng.numberFloat();
      spark.v_x = Math.cos(angle) * v;
      spark.v_y = Math.sin(angle) * v;

      spark.a = rng.number(360);
      spark.v_a =
        DC_MIN_SPARK_ANGULAR_VELOCITY +
        (rng.numberFloat() + rng.numberFloat()) *
          (0.5 * (DC_MAX_SPARK_ANGULAR_VELOCITY - DC_MIN_SPARK_ANGULAR_VELOCITY));
      if (rng.chanceIn2(2)) spark.v_a = -spark.v_a;

      switch (rng.number2(4)) {
        case 0:
          spark.size = DC_MIN_SPARK_SIZE;
          break;
        case 1:
          spark.size = DC_MIN_SPARK_SIZE + rng.numberFloat() * (1 - DC_MIN_SPARK_SIZE);
          break;
        default:
          spark.size = 1;
          break;
      }

      spark.color = flavor;

      if (rng.chanceIn(DC_CHANCE_LONG_SPARK_LIFE_TIME)) {
        spark.life_time =
          rng.number(10 * DC_SPREAD_SPARK_LIFE_TIME) +
          rng.number(10 * DC_SPREAD_SPARK_LIFE_TIME) +
          10 * (DC_MEDIUM_SPARK_LIFE_TIME - DC_SPREAD_SPARK_LIFE_TIME);
      } else {
        spark.life_time =
          rng.number(DC_SPREAD_SPARK_LIFE_TIME) +
          rng.number(DC_SPREAD_SPARK_LIFE_TIME) +
          (DC_MEDIUM_SPARK_LIFE_TIME - DC_SPREAD_SPARK_LIFE_TIME);
      }
    }
  }

  /**
   * Launch a reward mote from grid cell (x, y) at `level` (clamped), staggered
   * by `sibling`. Mirrors `SparkleManager::createRewardMote`
   * (SparkleManager.cxx:224).
   */
  createRewardMote(cellX: number, cellY: number, level: number, sibling: number): void {
    if (this.mote_count === DC_MAX_MOTE_NUMBER) return;
    let i = 0;
    while (this.motes[i]!.active) i++;
    const mote = this.motes[i]!;
    const rng = this.rng;

    this.mote_count++;
    mote.active = true;

    if (level >= DC_NUMBER_MOTE_LEVELS) level = DC_NUMBER_MOTE_LEVELS - 1;
    if (level < 0) level = 0;
    mote.color = MOTE_COLORS_BY_LEVEL[level]!;
    mote.type = MOTE_TYPES_BY_LEVEL[level]!;
    mote.size = MOTE_SIZES_BY_LEVEL[level]!;
    mote.inverse_mass = MOTE_INVERSE_MASSES_BY_LEVEL[level] ?? 1;

    mote.x =
      (cellX - this.halfW) * DC_GRID_ELEMENT_LENGTH -
      DC_GRID_ELEMENT_LENGTH / 2 +
      rng.number(20) * (DC_GRID_ELEMENT_LENGTH / 20);
    mote.y =
      (cellY - this.halfH) * DC_GRID_ELEMENT_LENGTH -
      DC_GRID_ELEMENT_LENGTH / 2 +
      rng.number(20) * (DC_GRID_ELEMENT_LENGTH / 20);

    // slow down big ones
    const v =
      (DC_MEDIUM_MOTE_VELOCITY -
        DC_SPREAD_MOTE_VELOCITY +
        rng.numberFloat() * (2 * DC_SPREAD_MOTE_VELOCITY)) *
      mote.inverse_mass;
    mote.v_x = cellX < GC_PLAY_WIDTH / 2 ? -0.707107 * v : 0.707107 * v;
    mote.v_y = -0.707107 * v;

    mote.a = mote.initial_a = rng.number(360);
    mote.v_a =
      (DC_MEDIUM_MOTE_ANGULAR_VELOCITY -
        DC_SPREAD_MOTE_ANGULAR_VELOCITY +
        rng.numberFloat() * (2 * DC_SPREAD_MOTE_ANGULAR_VELOCITY)) *
      mote.inverse_mass;
    if (rng.chanceIn2(2)) mote.v_a = -mote.v_a;

    mote.life_time = 0;
    mote.sibling_delay = sibling * DC_MULTI_MOTE_FIRE_DELAY;
  }

  /** Advance one 50 Hz tick. Mirrors `SparkleManager::timeStep` (SparkleManager.cxx:276). */
  timeStep(): void {
    let c = this.spark_count;
    for (let n = 0; c; n++) {
      const spark = this.sparks[n]!;
      if (!spark.active) continue;
      c--;
      if (--spark.life_time === 0) {
        spark.active = false;
        this.spark_count--;
      } else {
        spark.x += spark.v_x;
        spark.y += spark.v_y;
        spark.a += spark.v_a;
        spark.v_y -= DC_SPARK_GRAVITY + DC_SPARK_DRAG * spark.v_y;
        spark.v_x -= DC_SPARK_DRAG * spark.v_x;
      }
    }

    c = this.mote_count;
    for (let n = 0; c; n++) {
      const mote = this.motes[n]!;
      if (!mote.active) continue;
      c--;

      // Hold at the payout cell (fading in) until the sibling stagger passes.
      if (mote.life_time >= 0) {
        if (++mote.life_time - mote.sibling_delay < GC_DYING_DELAY) {
          mote.a += mote.v_a;
          continue;
        }
        mote.life_time = -1;
      } else if (mote.color > 0 && mote.color < DC_FIRST_SPECIAL_MOTE_COLOR) {
        mote.life_time--; // times the color fade
      }

      mote.y += mote.v_y;
      if (mote.y > this.killY + mote.size * (DC_SPARKLE_LENGTH / 2)) {
        mote.active = false;
        this.mote_count--;
        continue;
      }
      mote.x += mote.v_x;
      mote.a += mote.v_a;

      mote.v_y += mote.inverse_mass * DC_MOTE_UPWARD_FORCE - DC_MOTE_DRAG * mote.v_y;
      mote.v_x -= mote.inverse_mass * DC_MOTE_CENTER_SPRING * mote.x + DC_MOTE_DRAG * mote.v_x;
      mote.v_a -= mote.inverse_mass * DC_MOTE_TWIST_SPRING * (mote.a - mote.initial_a);
    }
  }
}
