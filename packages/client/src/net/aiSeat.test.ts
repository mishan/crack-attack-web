/**
 * aiSeat.test.ts — the determinism guarantee behind netplay-vs-AI.
 *
 * The bot's inputs never cross the wire: the player, and every spectator,
 * generate them locally by running an `AiController` over the (lockstep-
 * identical) AI sim. These tests pin the property the whole feature rests on —
 * a spectator fed *only the human's* input stream reproduces the players'
 * boards, and their AI opponent's moves, bit for bit.
 */

import { describe, expect, it } from 'vitest';
import { AiController } from '@crack-attack/core';
import { LockstepSession } from './lockstep.js';
import { SpectatorSession } from './spectator.js';

const SEED = 0xc0ffee;
const INPUT_DELAY = 3;
const AI_INDEX = 1;

/** A deterministic pseudo-human: a fixed, non-trivial input pattern by call order. */
function humanInputs(): () => number {
  let n = 0;
  const pattern = [0, 1, 0, 2, 0, 16, 0, 4, 0, 8, 0, 0, 16, 0];
  return () => pattern[n++ % pattern.length]!;
}

describe('netplay AI seat', () => {
  it('never stalls on the bot and reaches a decisive outcome', () => {
    const p = new LockstepSession(SEED, 0, INPUT_DELAY, undefined, {
      controller: new AiController('hard'),
      index: AI_INDEX,
    });
    const sample = humanInputs();
    // Advance in small budgets; the bot never gates, so it always progresses.
    for (let i = 0; i < 4000 && p.outcome === null; i++) {
      expect(p.waitingForRemote).toBe(false);
      p.advance(50, sample);
    }
    expect(p.outcome).not.toBeNull();
    expect(p.takeDigests()).toHaveLength(0); // no digests are queued vs a bot
  });

  it('a spectator fed only the human stream reproduces both boards and the AI', () => {
    // Drive the player to the end, capturing the human frames it emits.
    const p = new LockstepSession(SEED, 0, INPUT_DELAY, undefined, {
      controller: new AiController('medium'),
      index: AI_INDEX,
    });
    const sample = humanInputs();
    const humanStream: number[] = [];
    for (let i = 0; i < 6000 && p.outcome === null; i++) {
      p.advance(50, sample);
      for (const b of p.takeOutgoing()) humanStream.push(...b.frames);
    }
    expect(p.outcome).not.toBeNull();

    // A spectator gets the human's frames only (index 0); it computes the bot
    // (index 1) itself with the same controller/difficulty.
    const s = new SpectatorSession(SEED, [[], []], {
      controller: new AiController('medium'),
      index: AI_INDEX,
    });
    s.addFrames(0, 0, humanStream);
    while (s.outcome === null && s.bufferedTicks > 0) s.advance(200);

    expect(s.outcome).toEqual(p.outcome);
    expect(s.sims[0].digest()).toBe(p.sims[0].digest());
    expect(s.sims[1].digest()).toBe(p.sims[1].digest());
    expect(s.currentTick).toBe(p.currentTick);
  });

  it('is reproducible: two independent players with the same seed match tick for tick', () => {
    const run = (): number[] => {
      const p = new LockstepSession(SEED, 0, INPUT_DELAY, undefined, {
        controller: new AiController('hard'),
        index: AI_INDEX,
      });
      const sample = humanInputs();
      while (p.outcome === null) p.advance(100, sample);
      return [p.currentTick, p.sims[0].digest(), p.sims[1].digest(), p.outcome!.winner ?? -1];
    };
    expect(run()).toEqual(run());
  });
});
