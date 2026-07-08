/**
 * rng.ts
 *
 * Deterministic, seedable pseudo-random number generator for the simulation.
 *
 * The original C++ `Random` (crack-attack/src/Random.{h,cxx}) wraps libc
 * `srand()`/`rand()`. This port replaces that with a self-contained generator
 * so the sequence is identical across browsers and Node — libc `rand()` is
 * platform-defined and unusable for cross-runtime determinism.
 *
 * The public helper surface deliberately mirrors `Random`'s inline methods
 * (`chanceIn`, `chanceIn2`, `number`, `number2`, `numberFloat`) so gameplay
 * code ports one-to-one. Only the underlying bit source differs.
 *
 * Core generator: Mulberry32 — a well-documented 32-bit PRNG with a single
 * word of state, good statistical quality, and trivial serialization. Chosen
 * as the production RNG. NOTE: this does NOT reproduce glibc's `random()`
 * sequence; sequence-exact validation against the unmodified C++ build is
 * handled separately by an RNG-draw-log harness (see BROWSER_PORT_PLAN.md),
 * not by cloning the C++ generator here.
 *
 * Determinism contract:
 *   - Given the same seed and the same sequence of calls, output is identical.
 *   - State is a single uint32, exposed via `state` for serialize/restore.
 *   - No floating-point state: `numberFloat()` derives from integer draws and
 *     is intended for cosmetic/derived use, never stored in sim state.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

/**
 * Upper bound of {@link Rng.next} draws, matching glibc's `RAND_MAX`
 * (2^31 - 1). Kept identical so ported `rand() % n` / `rand() * (1/RAND_MAX)`
 * expressions behave as they did in C++.
 */
export const RAND_MAX = 0x7fffffff;

/** Mulberry32 additive constant. */
const MULBERRY_INCREMENT = 0x6d2b79f5;

export class Rng {
  /** Single-word generator state (uint32). */
  private s: number;

  /**
   * @param seed Unsigned 32-bit seed. Mirrors `Random::seed(unsigned int)`.
   *             Any 32-bit value (including 0) yields a valid stream.
   */
  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Current generator state (uint32). Use with the constructor / {@link setState} to serialize. */
  get state(): number {
    return this.s >>> 0;
  }

  /** Restore a previously captured state (uint32). */
  setState(state: number): void {
    this.s = state >>> 0;
  }

  /** An independent copy positioned at the same point in the stream. */
  clone(): Rng {
    const r = new Rng(0);
    r.s = this.s;
    return r;
  }

  /**
   * Core Mulberry32 step. Advances state and returns a full uint32.
   * @internal
   */
  private nextUint32(): number {
    this.s = (this.s + MULBERRY_INCREMENT) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /**
   * A draw in `[0, RAND_MAX]`, the analogue of libc `rand()`.
   * The high bit is dropped so results are non-negative 31-bit integers.
   */
  next(): number {
    return this.nextUint32() >>> 1;
  }

  /** `true` with probability 1/chance. Mirrors `Random::chanceIn`. */
  chanceIn(chance: number): boolean {
    return this.next() % chance === 0;
  }

  /** `chanceIn` specialized for power-of-two `chance`. Mirrors `Random::chanceIn2`. */
  chanceIn2(chance: number): boolean {
    return (this.next() & (chance - 1)) === 0;
  }

  /** Uniform integer in `[0, maximum)`. Mirrors `Random::number(int)`. */
  number(maximum: number): number {
    return this.next() % maximum;
  }

  /** `number` specialized for power-of-two `maximum`. Mirrors `Random::number2(int)`. */
  number2(maximum: number): number {
    return this.next() & (maximum - 1);
  }

  /** Float in `[0, 1]`. Mirrors `Random::number()`. Cosmetic/derived use only. */
  numberFloat(): number {
    return this.next() * (1 / RAND_MAX);
  }
}

/**
 * Generate a nondeterministic 32-bit seed for starting a fresh game.
 *
 * Replaces `Random::generateSeed()` (which returned `time(null)`). In the port
 * the authoritative seed comes from the lobby/relay server; this helper is a
 * local fallback (e.g. solo/offline games). Accepts an injectable source so it
 * stays platform-agnostic and testable — callers pass `Math.random` or a
 * crypto source.
 *
 * @param entropy A function returning a float in [0, 1); defaults to `Math.random`.
 */
export function generateSeed(entropy: () => number = Math.random): number {
  return (entropy() * 0x100000000) >>> 0;
}
