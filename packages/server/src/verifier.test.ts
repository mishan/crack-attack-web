import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SoloReplayError, type SoloReplay } from '@crack-attack/core';
import { Verifier, VerifierBusyError } from './verifier.js';

/** A real solo game (hard AI, seed 2026): 2757 ticks, score 48, top multiplier 3. */
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../core/src/fixtures/solo-hard-2026.replay.json', import.meta.url)),
    'utf8',
  ),
) as SoloReplay;

/** A real match (hard vs medium, seed 42): seat 0 wins on tick 2409. */
const MATCH = (() => {
  const fixture = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../core/src/fixtures/net-hard-medium-42.match.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { seed: number; ticks: number; inputs: [number, number][][] };
  // Expand the [tickDelta, command] changes to one frame per tick.
  const ledgers = fixture.inputs.map((changes) => {
    const frames: number[] = [];
    let held = 0;
    for (const [delta, command] of changes) {
      for (let i = 1; i < delta; i++) frames.push(held);
      frames.push((held = command));
    }
    while (frames.length < fixture.ticks) frames.push(held);
    return frames;
  }) as [number[], number[]];
  return { seed: fixture.seed, ledgers };
})();

describe('Verifier', () => {
  it('verifies a replay in slices, yielding between them', async () => {
    let yields = 0;
    const verifier = new Verifier({
      sliceTicks: 500,
      yieldFn: () => {
        yields++;
        return Promise.resolve();
      },
    });
    expect(await verifier.verifySolo(FIXTURE)).toMatchObject({
      ticks: 2757,
      score: 48,
      topMultiplier: 3,
    });
    expect(yields).toBe(5); // six slices of up to 500 ticks
    expect(verifier.queued).toBe(0);
  });

  it('rejects a replay that does not end in a loss', async () => {
    const verifier = new Verifier();
    await expect(
      verifier.verifySolo({ ...FIXTURE, ticks: FIXTURE.ticks + 1 }),
    ).rejects.toBeInstanceOf(SoloReplayError);
    expect(verifier.queued).toBe(0);
  });

  it('runs replays one at a time and refuses more than it can queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new Verifier({ maxQueued: 2, sliceTicks: 1000, yieldFn: () => gate });
    const finished: string[] = [];
    const first = verifier.verifySolo(FIXTURE).then(() => finished.push('first'));
    const second = verifier.verifySolo(FIXTURE).then(() => finished.push('second'));
    expect(verifier.queued).toBe(2);
    await expect(verifier.verifySolo(FIXTURE)).rejects.toBeInstanceOf(VerifierBusyError);
    release();
    await Promise.all([first, second]);
    expect(finished).toEqual(['first', 'second']);
    expect(verifier.queued).toBe(0);
  });

  it('plays a match out from its ledgers', async () => {
    const verifier = new Verifier({ sliceTicks: 500 });
    const result = await verifier.verifyMatch(MATCH);
    expect(result).toMatchObject({ outcome: { winner: 0, tick: 2409 }, tick: 2409 });
    const early = await verifier.verifyMatch({ ...MATCH, endTick: 64 });
    expect(early).toMatchObject({ outcome: null, tick: 64 });
  });

  it('never refuses a match, even with the solo queue full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new Verifier({ maxQueued: 1, sliceTicks: 1000, yieldFn: () => gate });
    const solo = verifier.verifySolo(FIXTURE);
    await expect(verifier.verifySolo(FIXTURE)).rejects.toBeInstanceOf(VerifierBusyError);
    const match = verifier.verifyMatch(MATCH);
    expect(verifier.queued).toBe(2);
    const idle = verifier.idle();
    release();
    await idle;
    expect(verifier.queued).toBe(0);
    await expect(solo).resolves.toMatchObject({ score: 48 });
    await expect(match).resolves.toMatchObject({ outcome: { winner: 0 } });
  });
});
