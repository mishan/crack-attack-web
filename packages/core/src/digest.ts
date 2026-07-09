/**
 * digest.ts
 *
 * Deterministic uint32 digest of a `GameSim`'s gameplay state. This is the
 * port-plan "per-tick state digest": the desync detector for netplay (each
 * client submits digests of both sims every DIGEST_PERIOD; the relay compares)
 * and the comparison key for the `tools/replay-check` golden-master harness.
 * The C++ had no equivalent — boards could silently diverge — so there is no
 * source reference; the *coverage* is every field the C++ treats as gameplay
 * state.
 *
 * Two rules keep the digest trustworthy:
 *
 * 1. **Pure.** Computing a digest reads state only — it must never draw RNG or
 *    mutate anything, so digesting at any cadence cannot perturb the sim.
 * 2. **Gameplay state only.** Cosmetic fields (block death axes `axis_x`/
 *    `axis_y`, `pop_direction`, `pop_color`, the cosmetic RNG stream) are
 *    deliberately excluded: they are allowed to diverge across clients without
 *    that being a desync.
 *
 * The hash is word-wise FNV-1a (32-bit): well distributed for this use, tiny,
 * and dependency-free. Each stateful class feeds its own words through a
 * `hashState(h)` method so private fields stay private.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Sentinel word for an absent reference (no combo attached, empty cell, no
 * swap partner). Real ids are small store indices, so this can't collide.
 */
export const HASH_NONE = 0xffffffff;

/** Accumulates uint32 words into a running FNV-1a hash. */
export class StateHasher {
  private h = FNV_OFFSET_BASIS;

  /** Fold one 32-bit word into the hash. Accepts any int32/uint32. */
  add(word: number): void {
    this.h = Math.imul(this.h ^ (word >>> 0), FNV_PRIME) >>> 0;
  }

  /** Fold a boolean as 0/1. */
  addBool(b: boolean): void {
    this.add(b ? 1 : 0);
  }

  /** The digest so far (uint32). */
  get value(): number {
    return this.h >>> 0;
  }
}
