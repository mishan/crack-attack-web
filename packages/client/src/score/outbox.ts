/**
 * outbox.ts — finished ranked runs waiting to be submitted, kept in
 * localStorage so a network blip or a closed tab doesn't lose one. Submitting
 * is idempotent on the server, so a run can be retried until it gets an
 * answer, for as long as its ticket is valid (or until the server has failed on
 * it {@link MAX_RUN_FAILURES} times, spaced out by {@link FAILURE_SPACING_MS}).
 */

import type { SoloSubmitRequest, SoloSubmitResponse } from '@crack-attack/protocol';
import { ScoreboardError, type ScoreboardFailure } from './scoreboardApi.js';

const OUTBOX_KEY = 'crack-attack.outbox';
/** Runs kept at most; past it, the oldest are dropped. */
const MAX_PENDING = 20;
/**
 * Counted failures (`internal`, `bad_response`) after which a run is dropped:
 * by then it's most likely that run, not a passing fault. Counted failures are
 * at least {@link FAILURE_SPACING_MS} apart, so dropping one takes 4+ hours of
 * failing on it (tickets last 24 h).
 */
export const MAX_RUN_FAILURES = 5;
/**
 * A run's failure counts only this long after its last counted one. An outage
 * (a proxy's error page reads as `internal` too) fails every run on every
 * flush, at page load and each new game; spacing the count keeps a few games
 * in a bad hour from dropping good runs.
 */
export const FAILURE_SPACING_MS = 60 * 60 * 1000;

/**
 * Failures that stop a flush: they'd fail every run the same way. Any other
 * retryable failure is the run's own (e.g. the server broke on its replay), so
 * the flush goes on to the next run.
 */
const STOPS_FLUSH: ReadonlySet<ScoreboardFailure> = new Set(['network', 'rate_limited']);
/** Per-run failures that count towards {@link MAX_RUN_FAILURES}; `busy` doesn't. */
const COUNTS_AS_FAILURE: ReadonlySet<ScoreboardFailure> = new Set(['internal', 'bad_response']);

export interface PendingRun {
  request: SoloSubmitRequest;
  /** When its ticket expires (epoch ms, this browser's clock); the server won't take it after. */
  expiresAt: number;
  /** Counted failures so far (missing in entries stored before they were counted). */
  failures?: number;
  /** When the last counted failure happened (epoch ms, this browser's clock). */
  lastFailureAt?: number;
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
   * Submit every waiting run, oldest first, reporting each one's outcome. A run
   * the server rejects is dropped; one that fails for a reason that may pass is
   * kept. Being offline or rate-limited stops the flush (every waiting run is
   * reported kept); a failure on one run (busy, or a server error) goes on to
   * the next. A flush called while one is running makes it go round again, so
   * runs queued meanwhile aren't missed.
   */
  async flush(submit: (request: SoloSubmitRequest) => Promise<SoloSubmitResponse>): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    // Runs already tried (and kept) by this flush: another pass skips them.
    const tried = new Set<string>();
    try {
      do {
        this.flushAgain = false;
        if (!(await this.flushOnce(submit, tried))) break;
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  /** One pass over the queue; false if it stopped at a failure every run would hit. */
  private async flushOnce(
    submit: (request: SoloSubmitRequest) => Promise<SoloSubmitResponse>,
    tried: Set<string>,
  ): Promise<boolean> {
    const runs = this.pending().filter((run) => !tried.has(run.request.runId));
    for (const [i, run] of runs.entries()) {
      const { runId } = run.request;
      try {
        const response = await submit(run.request);
        this.remove(runId);
        this.emit(runId, { ok: true, response });
      } catch (err) {
        const error =
          err instanceof ScoreboardError ? err : new ScoreboardError('network', String(err));
        if (!error.retryable) {
          this.remove(runId);
          this.emit(runId, { ok: false, error, kept: false });
        } else if (STOPS_FLUSH.has(error.code)) {
          // Nothing else will get through either: they all wait for the next flush.
          for (const rest of runs.slice(i)) {
            this.emit(rest.request.runId, { ok: false, error, kept: true });
          }
          return false;
        } else if (this.countFailure(run, error.code) >= MAX_RUN_FAILURES) {
          this.remove(runId);
          this.emit(runId, { ok: false, error, kept: false });
        } else {
          tried.add(runId);
          this.emit(runId, { ok: false, error, kept: true });
        }
      }
    }
    return true;
  }

  /**
   * Count a failed attempt against a kept run, if its kind counts and the last
   * counted one was at least {@link FAILURE_SPACING_MS} ago; returns the total.
   */
  private countFailure(run: PendingRun, code: ScoreboardFailure): number {
    const failures = run.failures ?? 0;
    const now = this.now();
    const spaced = run.lastFailureAt === undefined || now - run.lastFailureAt >= FAILURE_SPACING_MS;
    if (!COUNTS_AS_FAILURE.has(code) || !spaced) return failures;
    const counted = { failures: failures + 1, lastFailureAt: now };
    this.save(
      this.load().map((r) => (r.request.runId === run.request.runId ? { ...r, ...counted } : r)),
    );
    return counted.failures;
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
  const { request, expiresAt, failures, lastFailureAt } = v as Record<string, unknown>;
  if (typeof request !== 'object' || request === null || typeof expiresAt !== 'number') {
    return false;
  }
  if (failures !== undefined && !Number.isSafeInteger(failures)) return false;
  if (lastFailureAt !== undefined && typeof lastFailureAt !== 'number') return false;
  const { runId, name, replay } = request as Record<string, unknown>;
  return typeof runId === 'string' && typeof name === 'string' && replay !== undefined;
}
