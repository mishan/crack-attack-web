import { describe, expect, it } from 'vitest';
import { verifySoloReplay } from '@crack-attack/core';
import { maxReplayInputs } from '@crack-attack/server';
import { makeReplay } from './replays.js';

describe('makeReplay', () => {
  it('advance: a short finished game the verifier accepts', async () => {
    const replay = await makeReplay('advance', 12345);
    const result = verifySoloReplay(replay);
    expect(result.ticks).toBe(replay.ticks);
    expect(result.ticks).toBeGreaterThan(100);
    expect(result.ticks).toBeLessThan(1500);
    // Holding advance stores essentially no input changes.
    expect(replay.inputs.length).toBeLessThan(5);
  });

  it('idle: a longer finished game', async () => {
    const replay = await makeReplay('idle', 777);
    expect(replay.ticks).toBeGreaterThan(2000);
    expect(() => verifySoloReplay(replay)).not.toThrow();
  });

  it('padded: dense input changes, but within the server cap', async () => {
    const replay = await makeReplay('padded', 4242);
    expect(() => verifySoloReplay(replay)).not.toThrow();
    // A change roughly every padEvery ticks — many, but the server still admits it.
    expect(replay.inputs.length).toBeGreaterThan(replay.ticks / 4);
    expect(replay.inputs.length).toBeLessThanOrEqual(maxReplayInputs(replay.ticks));
  });

  it('ai: real play then a forced end, accepted by the verifier', async () => {
    const replay = await makeReplay('ai', 2026, { aiTicks: 400 });
    const result = verifySoloReplay(replay);
    expect(result.ticks).toBe(replay.ticks);
    expect(result.score).toBeGreaterThan(0);
  });

  it('is deterministic in the seed', async () => {
    const a = await makeReplay('advance', 9);
    const b = await makeReplay('advance', 9);
    expect(b).toEqual(a);
  });
});
