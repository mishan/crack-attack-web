import { describe, expect, it } from 'vitest';
import { CC_ADVANCE, CC_DOWN, CC_LEFT, CC_RIGHT, CC_SWAP, CC_UP, Rng } from '@crack-attack/core';
import { LockstepSession } from './lockstep.js';
import { SpectatorSession } from './spectator.js';

/** Same deterministic input recipe as the lockstep tests. */
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

const SEED = 0x57ec7a70;

describe('SpectatorSession', () => {
  it("reproduces the players' sims exactly, from start or mid-match", () => {
    const a = new LockstepSession(SEED, 0, 3);
    const b = new LockstepSession(SEED, 1, 3);
    const inA = scripted(5);
    const inB = scripted(6);

    // A from-the-start spectator, fed the same batches the relay fans out.
    const early = new SpectatorSession(SEED, [[], []]);
    const ledgers: [number[], number[]] = [[], []];
    const pump = (): void => {
      for (const batch of a.takeOutgoing()) {
        b.addRemoteFrames(batch.startTick, batch.frames);
        early.addFrames(0, batch.startTick, batch.frames);
        ledgers[0].push(...batch.frames);
      }
      for (const batch of b.takeOutgoing()) {
        a.addRemoteFrames(batch.startTick, batch.frames);
        early.addFrames(1, batch.startTick, batch.frames);
        ledgers[1].push(...batch.frames);
      }
    };

    for (let i = 0; i < 150; i++) {
      pump();
      a.advance(2, inA);
      b.advance(2, inB);
      early.advance(1000);
    }
    pump();
    early.advance(100000);

    const frontier = Math.min(a.currentTick, b.currentTick);
    expect(early.currentTick).toBeGreaterThanOrEqual(frontier);

    // A mid-match spectator built from the ledgers lands on identical sims.
    const late = new SpectatorSession(SEED, [[...ledgers[0]], [...ledgers[1]]]);
    late.advance(100000);
    expect(late.currentTick).toBe(early.currentTick);
    expect([late.sims[0]!.digest(), late.sims[1]!.digest()]).toEqual([
      early.sims[0]!.digest(),
      early.sims[1]!.digest(),
    ]);
  });

  it('stalls without both streams and rejects gaps', () => {
    const s = new SpectatorSession(SEED, [[], []]);
    expect(s.waiting).toBe(true);
    s.addFrames(0, 0, [0, 0, 0]);
    expect(s.advance(10)).toBe(0); // player 1's stream still empty
    s.addFrames(1, 0, [0, 0]);
    expect(s.advance(10)).toBe(2); // min of both streams
    expect(s.currentTick).toBe(2);
    expect(() => s.addFrames(0, 5, [0])).toThrow(/lost lockstep/);
  });

  it('resolves the same outcome as the players', () => {
    const a = new LockstepSession(SEED, 0, 3);
    const b = new LockstepSession(SEED, 1, 3);
    const watcher = new SpectatorSession(SEED, [[], []]);
    const inA = (): number => CC_ADVANCE; // hold raise: fast loss
    const inB = (): number => 0;
    for (let i = 0; i < 5000 && !a.outcome; i++) {
      for (const batch of a.takeOutgoing()) {
        b.addRemoteFrames(batch.startTick, batch.frames);
        watcher.addFrames(0, batch.startTick, batch.frames);
      }
      for (const batch of b.takeOutgoing()) {
        a.addRemoteFrames(batch.startTick, batch.frames);
        watcher.addFrames(1, batch.startTick, batch.frames);
      }
      a.advance(50, inA);
      b.advance(50, inB);
    }
    watcher.advance(1000000);
    expect(a.outcome).not.toBeNull();
    expect(watcher.outcome).toEqual(a.outcome);
  });
});
