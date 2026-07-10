import { describe, expect, it } from 'vitest';
import { CC_DOWN, CC_LEFT, CC_RIGHT, CC_SWAP, CC_UP, Rng } from '@crack-attack/core';
import { DIGEST_PERIOD, MAX_INPUT_FRAMES_PER_MESSAGE } from '@crack-attack/protocol';
import { LockstepSession } from './lockstep.js';

/** Deterministic per-player input script (same recipe as the core digest tests). */
function scripted(seed: number): () => number {
  const r = new Rng(seed);
  return () => {
    let bits = 0;
    const roll = r.number(8);
    if (roll === 0) bits |= CC_LEFT;
    else if (roll === 1) bits |= CC_RIGHT;
    else if (roll === 2) bits |= CC_UP;
    else if (roll === 3) bits |= CC_DOWN;
    if (r.chanceIn(3)) bits |= CC_SWAP;
    return bits;
  };
}

/** Route each session's outgoing batches into the other, as the relay would. */
function exchange(a: LockstepSession, b: LockstepSession): void {
  for (const batch of a.takeOutgoing()) b.addRemoteFrames(batch.startTick, batch.frames);
  for (const batch of b.takeOutgoing()) a.addRemoteFrames(batch.startTick, batch.frames);
}

const SEED = 0xabcdef;
const DELAY = 3;

describe('LockstepSession', () => {
  it('stalls without remote frames and never diverges with them', () => {
    const a = new LockstepSession(SEED, 0, DELAY);
    const b = new LockstepSession(SEED, 1, DELAY);
    const inA = scripted(1);
    const inB = scripted(2);

    // Without any exchange, neither side can step at all.
    expect(a.advance(10, inA)).toBe(0);
    expect(a.waitingForRemote).toBe(true);
    expect(a.currentTick).toBe(0);

    // Pump ~40 s of game in small irregular slices, exchanging as a relay would.
    let tick = 0;
    for (let round = 0; round < 500 && !a.outcome && !b.outcome; round++) {
      exchange(a, b);
      a.advance(1 + (round % 4), inA);
      b.advance(1 + ((round + 2) % 4), inB);
      // The two sessions can be at different ticks mid-round, but the shared
      // prefix must agree: compare digests once both have passed a checkpoint.
      const common = Math.min(a.currentTick, b.currentTick);
      expect(common).toBeGreaterThanOrEqual(tick);
      tick = common;
    }
    exchange(a, b);
    // Let both sessions drain to the same tick.
    for (let i = 0; i < 10; i++) {
      a.advance(1000, inA);
      b.advance(1000, inB);
      exchange(a, b);
    }
    expect(a.currentTick).toBeGreaterThan(500);

    // Every digest checkpoint the two sessions share must match exactly —
    // this exercises input relay, garbage cross-wiring, and both sims.
    const digestsA = new Map(a.takeDigests().map((d) => [d.tick, d.digests]));
    const digestsB = new Map(b.takeDigests().map((d) => [d.tick, d.digests]));
    let compared = 0;
    for (const [t, dA] of digestsA) {
      const dB = digestsB.get(t);
      if (!dB) continue;
      expect(dA).toEqual(dB);
      compared++;
    }
    expect(compared).toBeGreaterThan(10);
  });

  it('schedules local input inputDelay ticks ahead', () => {
    const a = new LockstepSession(SEED, 0, DELAY);
    const b = new LockstepSession(SEED, 1, DELAY);
    // Collect everything A sends, across drains (the prefill goes out first).
    const sent: number[] = [];
    const pump = (): void => {
      for (const batch of a.takeOutgoing()) {
        expect(batch.startTick).toBe(sent.length); // contiguous
        sent.push(...batch.frames);
        b.addRemoteFrames(batch.startTick, batch.frames);
      }
      for (const batch of b.takeOutgoing()) a.addRemoteFrames(batch.startTick, batch.frames);
    };
    pump();
    // A presses swap on its first stepped tick.
    expect(a.advance(1, () => CC_SWAP)).toBe(1);
    pump();
    // Prefill (ticks 0..DELAY-1) is neutral; the sampled press lands at DELAY.
    expect(sent.slice(0, DELAY)).toEqual([0, 0, 0]);
    expect(sent[DELAY]).toBe(CC_SWAP);
  });

  it('chunks outgoing batches to the protocol maximum', () => {
    const a = new LockstepSession(SEED, 0, 0);
    const b = new LockstepSession(SEED, 1, 0);
    // Feed b's stream far ahead so a can step a lot in one call.
    const remote = Array<number>(MAX_INPUT_FRAMES_PER_MESSAGE + 50).fill(0);
    a.addRemoteFrames(0, remote);
    a.advance(MAX_INPUT_FRAMES_PER_MESSAGE + 50, () => 0);
    const batches = a.takeOutgoing();
    expect(batches).toHaveLength(2);
    expect(batches[0]!.startTick).toBe(0);
    expect(batches[0]!.frames).toHaveLength(MAX_INPUT_FRAMES_PER_MESSAGE);
    expect(batches[1]!.startTick).toBe(MAX_INPUT_FRAMES_PER_MESSAGE);
    expect(b.localIndex).toBe(1); // silence unused warning meaningfully
  });

  it('rejects a non-contiguous remote batch', () => {
    const a = new LockstepSession(SEED, 0, DELAY);
    a.addRemoteFrames(0, [0, 0]);
    expect(() => a.addRemoteFrames(5, [0])).toThrow(/lost lockstep/);
  });

  it('emits digests on the DIGEST_PERIOD cadence', () => {
    const a = new LockstepSession(SEED, 0, 0);
    a.addRemoteFrames(0, Array<number>(DIGEST_PERIOD * 3).fill(0));
    a.advance(DIGEST_PERIOD * 3, () => 0);
    const digests = a.takeDigests();
    expect(digests.map((d) => d.tick)).toEqual([
      DIGEST_PERIOD,
      DIGEST_PERIOD * 2,
      DIGEST_PERIOD * 3,
    ]);
    expect(a.takeDigests()).toEqual([]); // drained
  });

  it('resolves the outcome deterministically on both machines', () => {
    // Drive both sessions with manual-advance held down so a loss arrives fast.
    const a = new LockstepSession(SEED, 0, DELAY);
    const b = new LockstepSession(SEED, 1, DELAY);
    // Player 0 raises constantly; player 1 idles. Identical boards -> player 0
    // tops out first on both machines.
    const inA = (): number => 32; // CC_ADVANCE
    const inB = (): number => 0;
    for (let i = 0; i < 5000 && !a.outcome; i++) {
      exchange(a, b);
      a.advance(50, inA);
      b.advance(50, inB);
    }
    exchange(a, b);
    b.advance(100000, inB);
    expect(a.outcome).not.toBeNull();
    expect(b.outcome).toEqual(a.outcome);
    expect(a.outcome!.winner).toBe(1);
    // Frozen after the outcome: no further stepping.
    const t = a.currentTick;
    a.advance(100, inA);
    expect(a.currentTick).toBe(t);
  });
});
