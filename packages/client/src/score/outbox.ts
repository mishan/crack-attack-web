/**
 * outbox.ts — finished ranked runs waiting to be submitted, kept in
 * localStorage so a network blip or a closed tab doesn't lose one. Submitting
 * is idempotent on the server, so a run can be retried until it gets an
 * answer, for as long as its ticket is valid.
 */

import type { SoloSubmitRequest, SoloSubmitResponse } from '@crack-attack/protocol';
import { ScoreboardError } from './scoreboardApi.js';

const OUTBOX_KEY = 'crack-attack.outbox';
/** Runs kept at most; past it, the oldest are dropped. */
const MAX_PENDING = 20;

export interface PendingRun {
  request: SoloSubmitRequest;
  /** The ticket's expiry (epoch ms); the server won't take the run after it. */
  expiresAt: number;
}

export type SubmitOutcome =
  | { ok: true; response: SoloSubmitResponse }
  /** `kept`: the failure may pass, so the run stays queued. */
  | { ok: false; error: ScoreboardError; kept: boolean };

export type OutcomeListener = (runId: string, outcome: SubmitOutcome) => void;

/** The slice of the Web Storage API the outbox uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class Outbox {
  private readonly listeners = new Set<OutcomeListener>();
  /** The queue, mirrored here in case storage is unavailable or full. */
  private memory: PendingRun[] = [];
  private flushing = false;
  private flushAgain = false;

  constructor(
    private storage: StorageLike | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs waiting, oldest first (expired ones dropped). */
  pending(): PendingRun[] {
    return this.load().filter((run) => run.expiresAt > this.now());
  }

  /** Queue a finished run (replacing any earlier copy of it). */
  add(run: PendingRun): void {
    const runs = this.pending().filter((r) => r.request.runId !== run.request.runId);
    runs.push(run);
    this.save(runs.slice(-MAX_PENDING));
  }

  /** Hear each run's outcome; returns a function that stops listening. */
  listen(listener: OutcomeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Submit every waiting run, oldest first. A run the server rejects is
   * dropped; one that fails for a reason that may pass (unreachable, busy) is
   * kept, and the rest wait for the next flush. A flush called while one is
   * running makes it go round again, so runs queued meanwhile aren't missed.
   */
  async flush(submit: (request: SoloSubmitRequest) => Promise<SoloSubmitResponse>): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        if (!(await this.flushOnce(submit))) break;
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  /** One pass over the queue; false if it stopped at a failure that may pass. */
  private async flushOnce(
    submit: (request: SoloSubmitRequest) => Promise<SoloSubmitResponse>,
  ): Promise<boolean> {
    for (const run of this.pending()) {
      const { runId } = run.request;
      try {
        const response = await submit(run.request);
        this.remove(runId);
        this.emit(runId, { ok: true, response });
      } catch (err) {
        const error =
          err instanceof ScoreboardError ? err : new ScoreboardError('network', String(err));
        if (error.retryable) {
          this.emit(runId, { ok: false, error, kept: true });
          return false;
        }
        this.remove(runId);
        this.emit(runId, { ok: false, error, kept: false });
      }
    }
    return true;
  }

  private emit(runId: string, outcome: SubmitOutcome): void {
    for (const listener of this.listeners) listener(runId, outcome);
  }

  private remove(runId: string): void {
    this.save(this.load().filter((r) => r.request.runId !== runId));
  }

  private load(): PendingRun[] {
    if (!this.storage) return this.memory.slice();
    try {
      const data: unknown = JSON.parse(this.storage.getItem(OUTBOX_KEY) ?? '[]');
      return Array.isArray(data) ? data.filter(isPendingRun) : [];
    } catch {
      return [];
    }
  }

  private save(runs: PendingRun[]): void {
    this.memory = runs;
    try {
      this.storage?.setItem(OUTBOX_KEY, JSON.stringify(runs));
    } catch {
      // Full or unavailable: carry on in memory for the rest of the visit.
      this.storage = null;
    }
  }
}

function isPendingRun(v: unknown): v is PendingRun {
  if (typeof v !== 'object' || v === null) return false;
  const { request, expiresAt } = v as Record<string, unknown>;
  if (typeof request !== 'object' || request === null || typeof expiresAt !== 'number') {
    return false;
  }
  const { runId, name, replay } = request as Record<string, unknown>;
  return typeof runId === 'string' && typeof name === 'string' && replay !== undefined;
}
