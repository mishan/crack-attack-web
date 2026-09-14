import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SoloReplayError, type SoloReplay } from '@crack-attack/core';
import { SoloVerifier, VerifierBusyError } from './soloVerifier.js';

/** A real solo game (hard AI, seed 2026): 2757 ticks, score 48, top multiplier 3. */
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../core/src/fixtures/solo-hard-2026.replay.json', import.meta.url)),
    'utf8',
  ),
) as SoloReplay;

describe('SoloVerifier', () => {
  it('verifies a replay in slices, yielding between them', async () => {
    let yields = 0;
    const verifier = new SoloVerifier({
      sliceTicks: 500,
      yieldFn: () => {
        yields++;
        return Promise.resolve();
      },
    });
    expect(await verifier.verify(FIXTURE)).toMatchObject({
      ticks: 2757,
      score: 48,
      topMultiplier: 3,
    });
    expect(yields).toBe(5); // six slices of up to 500 ticks
    expect(verifier.queued).toBe(0);
  });

  it('rejects a replay that does not end in a loss', async () => {
    const verifier = new SoloVerifier();
    await expect(verifier.verify({ ...FIXTURE, ticks: FIXTURE.ticks + 1 })).rejects.toBeInstanceOf(
      SoloReplayError,
    );
    expect(verifier.queued).toBe(0);
  });

  it('runs replays one at a time and refuses more than it can queue', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const verifier = new SoloVerifier({ maxQueued: 2, sliceTicks: 1000, yieldFn: () => gate });
    const finished: string[] = [];
    const first = verifier.verify(FIXTURE).then(() => finished.push('first'));
    const second = verifier.verify(FIXTURE).then(() => finished.push('second'));
    expect(verifier.queued).toBe(2);
    await expect(verifier.verify(FIXTURE)).rejects.toBeInstanceOf(VerifierBusyError);
    release();
    await Promise.all([first, second]);
    expect(finished).toEqual(['first', 'second']);
    expect(verifier.queued).toBe(0);
  });
});
