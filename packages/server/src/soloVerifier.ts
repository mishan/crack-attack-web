/**
 * soloVerifier.ts — re-simulates submitted solo replays without stalling the
 * relay. A long game takes a few hundred ms of CPU to replay, and the same
 * event loop carries live netplay input, so replays run one at a time in short
 * slices (core `SoloReplayRunner.advance`), yielding to other work between
 * slices. A bounded queue turns a flood into quick "busy" replies instead of
 * an ever-growing backlog.
 */

import { SoloReplayRunner, type SoloReplay, type SoloResult } from '@crack-attack/core';

/** The queue is full; try again later. */
export class VerifierBusyError extends Error {
  constructor() {
    super('the verifier queue is full');
    this.name = 'VerifierBusyError';
  }
}

export interface SoloVerifierOptions {
  /** Replays queued or running before new ones are refused. Default 32. */
  maxQueued?: number | undefined;
  /** Ticks per slice. Default 2000, a few ms of CPU. */
  sliceTicks?: number | undefined;
  /** Yields to other work between slices. Default: the next event-loop turn. */
  yieldFn?: (() => Promise<void>) | undefined;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class SoloVerifier {
  private readonly maxQueued: number;
  private readonly sliceTicks: number;
  private readonly yieldFn: () => Promise<void>;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: SoloVerifierOptions = {}) {
    this.maxQueued = options.maxQueued ?? 32;
    this.sliceTicks = options.sliceTicks ?? 2000;
    this.yieldFn = options.yieldFn ?? nextTurn;
  }

  /** Replays queued or running. */
  get queued(): number {
    return this.pending;
  }

  /**
   * Verify a well-formed replay (see core `parseSoloReplay`). Rejects with a
   * `SoloReplayError` if it doesn't describe a finished game, or with
   * {@link VerifierBusyError} if the queue is full.
   */
  verify(replay: SoloReplay): Promise<SoloResult> {
    if (this.pending >= this.maxQueued) return Promise.reject(new VerifierBusyError());
    this.pending++;
    const job = this.tail.then(() => this.run(replay));
    this.tail = job.catch(() => undefined);
    return job.finally(() => {
      this.pending--;
    });
  }

  private async run(replay: SoloReplay): Promise<SoloResult> {
    const runner = new SoloReplayRunner(replay);
    while (!runner.advance(this.sliceTicks)) await this.yieldFn();
    return runner.result();
  }
}
