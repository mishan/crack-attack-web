/**
 * verifier.ts — re-simulates games without stalling the relay: submitted solo
 * replays for the scoreboard, and disputed or desynced netplay matches for
 * the lobby. A long game takes a few hundred ms of CPU to replay, and the same
 * event loop carries live netplay input, so jobs run one at a time in short
 * slices (core `SoloReplayRunner` / `NetMatchRunner`), yielding to other work
 * between slices.
 *
 * Solo submissions come from the open internet, so the queue refuses them
 * past a bound, turning a flood into quick "busy" replies instead of an
 * ever-growing backlog. Match jobs are never refused: they come from the relay
 * itself, one per disputed game at most, and refusing one would let a flood of
 * solo submissions erase a loss.
 */

import {
  NetMatchRunner,
  SoloReplayRunner,
  type NetMatchReplayResult,
  type SoloReplay,
  type SoloResult,
} from '@crack-attack/core';

/** The queue is full; try again later. */
export class VerifierBusyError extends Error {
  constructor() {
    super('the verifier queue is full');
    this.name = 'VerifierBusyError';
  }
}

export interface VerifierOptions {
  /** Solo replays queued or running before new ones are refused. Default 32. */
  maxQueued?: number | undefined;
  /** Ticks per slice. Default 2000, a few ms of CPU. */
  sliceTicks?: number | undefined;
  /** Yields to other work between slices. Default: the next event-loop turn. */
  yieldFn?: (() => Promise<void>) | undefined;
}

/** A match to re-simulate: its seed and both seats' input ledgers, by seat. */
export interface MatchJob {
  seed: number;
  ledgers: readonly [readonly number[], readonly number[]];
  /** Stop here even if the ledgers go further (a desync's tick). Default: play it out. */
  endTick?: number | undefined;
}

/** A sliced re-simulation: a core runner. */
interface Runner<T> {
  advance(budget: number): boolean;
  result(): T;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class Verifier {
  private readonly maxQueued: number;
  private readonly sliceTicks: number;
  private readonly yieldFn: () => Promise<void>;
  private pending = 0;
  private pendingSolo = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: VerifierOptions = {}) {
    this.maxQueued = options.maxQueued ?? 32;
    this.sliceTicks = options.sliceTicks ?? 2000;
    this.yieldFn = options.yieldFn ?? nextTurn;
  }

  /** Jobs of either kind queued or running. */
  get queued(): number {
    return this.pending;
  }

  /**
   * Verify a well-formed solo replay (see core `parseSoloReplay`). Rejects with
   * a `SoloReplayError` if it doesn't describe a finished game, or with
   * {@link VerifierBusyError} if the queue is full.
   */
  verifySolo(replay: SoloReplay): Promise<SoloResult> {
    if (this.pendingSolo >= this.maxQueued) return Promise.reject(new VerifierBusyError());
    this.pendingSolo++;
    return this.enqueue(() => new SoloReplayRunner(replay)).finally(() => {
      this.pendingSolo--;
    });
  }

  /** Re-simulate a match from its ledgers (see core `NetMatchRunner`). */
  verifyMatch(job: MatchJob): Promise<NetMatchReplayResult> {
    return this.enqueue(() => new NetMatchRunner(job.seed, job.ledgers, job.endTick));
  }

  /** Resolves once every job queued so far has finished (for tests). */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.tail;
  }

  private enqueue<T>(start: () => Runner<T>): Promise<T> {
    this.pending++;
    const job = this.tail.then(() => this.run(start()));
    this.tail = job.catch(() => undefined);
    return job.finally(() => {
      this.pending--;
    });
  }

  private async run<T>(runner: Runner<T>): Promise<T> {
    while (!runner.advance(this.sliceTicks)) await this.yieldFn();
    return runner.result();
  }
}
