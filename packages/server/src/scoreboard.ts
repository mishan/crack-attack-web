/**
 * scoreboard.ts — the solo scoreboard service, transport-free. The HTTP routes
 * (`httpApi.ts`) are a thin wrapper, as `wsServer.ts` is for the relay.
 *
 * Trust model (docs/SCOREBOARD_PLAN.md): the client never reports a score. It
 * plays a run on a server-issued ticket (a fresh seed), then submits the
 * replay; the server re-simulates it and ranks the score _it_ computed.
 * Tickets are single-use and expire, and a run can't be submitted sooner than
 * it could have been played.
 */

import {
  GC_STEPS_PER_SECOND,
  SIM_VERSION,
  SoloReplayError,
  parseSoloReplay,
  type SoloReplay,
  type SoloResult,
} from '@crack-attack/core';
import {
  ProtocolError,
  SCORE_BOARDS,
  SCORE_LIST_DEFAULT_LIMIT,
  SCORE_LIST_MAX_LIMIT,
  SCORE_PERIODS,
  SOLO_TICKET_TTL_MS,
  decodeSoloSubmitRequest,
  monthKey,
  monthRange,
  normalizeScoreName,
  type ScoreBoard,
  type ScorePeriod,
  type ScoreboardErrorBody,
  type ScoreboardErrorCode,
  type SoloReplayResponse,
  type SoloScoreEntry,
  type SoloScoresResponse,
  type SoloSubmitRequest,
  type SoloSubmitResponse,
  type SoloTicketResponse,
} from '@crack-attack/protocol';
import { randomBytes } from 'node:crypto';
import { RateLimiter, siteKey, type RateLimit } from './rateLimit.js';
import { ALL_TIME, type ScoreStore, type StoredSoloScore, type TimeRange } from './scoreStore.js';
import { SoloVerifier, VerifierBusyError } from './soloVerifier.js';

/** A request the scoreboard refuses, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ScoreboardErrorCode,
    message: string,
    /** Extra response headers, e.g. `Retry-After` or `Allow`. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body(): ScoreboardErrorBody {
    return { error: this.code, message: this.message };
  }
}

/** Tickets per client: a burst of 30 (quick restarts), then one per 10 s. */
export const DEFAULT_TICKET_LIMIT: RateLimit = { capacity: 30, refillMs: 10_000 };
/**
 * Tickets per IPv6 /48, on top of the per-/64 limit: a site usually holds a
 * whole /48 (65,536 /64s), so a client could otherwise rotate through fresh
 * buckets. Room for a few busy players, then one every 2.5 s.
 */
export const DEFAULT_TICKET_SITE_LIMIT: RateLimit = { capacity: 120, refillMs: 2_500 };
/**
 * Tickets across all clients: the backstop against address rotation, since
 * every ticket is a row kept for a day. A burst of 600, then five a second.
 */
export const DEFAULT_TICKET_GLOBAL_LIMIT: RateLimit = { capacity: 600, refillMs: 200 };
/** Submissions per client: a burst of 20, then one per 20 s. */
export const DEFAULT_SUBMIT_LIMIT: RateLimit = { capacity: 20, refillMs: 20_000 };
/** Board requests per client: a burst of 60 (flipping through tabs), then one a second. */
export const DEFAULT_SCORES_LIMIT: RateLimit = { capacity: 60, refillMs: 1_000 };
/**
 * How long a board response is reused. Recording a run here clears the cache;
 * the admin CLI hides runs from another process, so this bounds how long a
 * hidden run lingers.
 */
export const DEFAULT_SCORES_CACHE_MS = 5_000;

/** Board responses cached at most (each board, period, month and limit is one). */
const SCORES_CACHE_MAX_ENTRIES = 256;
/** The global ticket bucket's key. */
const EVERYONE = '*';
/** Expired tickets are swept at most this often (when the next ticket is issued). */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
/** `Retry-After` for a full verifier queue: a replay takes well under a second. */
const BUSY_RETRY_SECONDS = 5;
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;

export interface SoloScoreboardOptions {
  store: ScoreStore;
  verifier?: SoloVerifier | undefined;
  /** Wall clock in epoch ms (timestamps, ticket expiry, pacing). Inject for tests. */
  now?: (() => number) | undefined;
  /** Seed source; defaults to a CSPRNG. Inject for tests. */
  newSeed?: (() => number) | undefined;
  /** Run-id source; defaults to a CSPRNG. Inject for tests. */
  newRunId?: (() => string) | undefined;
  /** Tickets per client (an IPv4 address or IPv6 /64). */
  ticketLimit?: RateLimit | undefined;
  /** Tickets per IPv6 /48. */
  ticketSiteLimit?: RateLimit | undefined;
  /** Tickets across all clients. */
  ticketGlobalLimit?: RateLimit | undefined;
  submitLimit?: RateLimit | undefined;
  /** Board requests per client. */
  scoresLimit?: RateLimit | undefined;
  /** How long a board response is reused, in ms; 0 turns the cache off. */
  scoresCacheMs?: number | undefined;
}

interface CachedScores {
  at: number;
  response: Promise<SoloScoresResponse>;
}

export class SoloScoreboard {
  private readonly store: ScoreStore;
  private readonly verifier: SoloVerifier;
  private readonly now: () => number;
  private readonly newSeed: () => number;
  private readonly newRunId: () => string;
  private readonly ticketLimiter: RateLimiter;
  private readonly ticketSiteLimiter: RateLimiter;
  private readonly ticketGlobalLimiter: RateLimiter;
  private readonly submitLimiter: RateLimiter;
  private readonly scoresLimiter: RateLimiter;
  private readonly scoresCacheMs: number;
  /** Board responses by their normalized query, oldest first. */
  private readonly scoresCache = new Map<string, CachedScores>();
  /** Submissions being checked, by run id. */
  private readonly inFlight = new Map<string, Promise<SoloSubmitResponse>>();
  private lastPrune = -Infinity;

  constructor(options: SoloScoreboardOptions) {
    this.store = options.store;
    this.verifier = options.verifier ?? new SoloVerifier();
    this.now = options.now ?? Date.now;
    this.newSeed = options.newSeed ?? (() => randomBytes(4).readUInt32BE(0));
    this.newRunId = options.newRunId ?? (() => randomBytes(16).toString('hex'));
    const limiter = (limit: RateLimit, maxTracked?: number) =>
      new RateLimiter(limit, this.now, maxTracked);
    this.ticketLimiter = limiter(options.ticketLimit ?? DEFAULT_TICKET_LIMIT);
    this.ticketSiteLimiter = limiter(options.ticketSiteLimit ?? DEFAULT_TICKET_SITE_LIMIT);
    this.ticketGlobalLimiter = limiter(options.ticketGlobalLimit ?? DEFAULT_TICKET_GLOBAL_LIMIT, 1);
    this.submitLimiter = limiter(options.submitLimit ?? DEFAULT_SUBMIT_LIMIT);
    this.scoresLimiter = limiter(options.scoresLimit ?? DEFAULT_SCORES_LIMIT);
    this.scoresCacheMs = options.scoresCacheMs ?? DEFAULT_SCORES_CACHE_MS;
  }

  /** Issue a run ticket to `client` (a rate-limit key, see `clientKey`). */
  async issueTicket(client: string): Promise<SoloTicketResponse> {
    // Narrowest first, so a client already over its own limit spends nothing
    // from the shared buckets.
    take(this.ticketLimiter, client);
    const site = siteKey(client);
    if (site !== null) take(this.ticketSiteLimiter, site);
    take(this.ticketGlobalLimiter, EVERYONE);
    const now = this.now();
    if (now - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = now;
      await this.store.pruneTickets(now - SOLO_TICKET_TTL_MS);
    }
    const ticket = {
      runId: this.newRunId(),
      seed: this.newSeed() >>> 0,
      simVersion: SIM_VERSION,
      issuedAt: now,
    };
    await this.store.addTicket(ticket);
    return {
      runId: ticket.runId,
      seed: ticket.seed,
      simVersion: ticket.simVersion,
      expiresAt: now + SOLO_TICKET_TTL_MS,
    };
  }

  /**
   * Verify and record a finished run. Submitting a run that's already recorded
   * returns its current standing, so a client can safely retry.
   */
  async submit(client: string, body: unknown): Promise<SoloSubmitResponse> {
    take(this.submitLimiter, client);
    let request: SoloSubmitRequest;
    try {
      request = decodeSoloSubmitRequest(body);
    } catch (err) {
      if (err instanceof ProtocolError) throw new ApiError(400, 'bad_request', err.message);
      throw err;
    }
    const { runId } = request;
    const name = normalizeScoreName(request.name);
    if (name === null) throw new ApiError(400, 'bad_name', 'the name is empty or too long');
    let replay: SoloReplay;
    try {
      replay = parseSoloReplay(request.replay);
    } catch (err) {
      if (err instanceof SoloReplayError) throw new ApiError(422, 'invalid_replay', err.message);
      throw err;
    }

    // One check per run at a time. A copy arriving while the first is being
    // checked (a client retry, or a racing duplicate) shares its outcome:
    // it neither queues a second verification nor drops the ticket under it.
    const pending = this.inFlight.get(runId);
    if (pending) return pending;
    const attempt = this.check(runId, name, replay);
    this.inFlight.set(runId, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(runId);
    }
  }

  /** A board: `board`, `period`, `month` and `limit` query parameters. */
  async scores(client: string, params: URLSearchParams): Promise<SoloScoresResponse> {
    take(this.scoresLimiter, client);
    const board = oneOf(params.get('board') ?? 'score', SCORE_BOARDS, 'board');
    const monthParam = params.get('month');
    const period = oneOf(
      params.get('period') ?? (monthParam ? 'month' : 'all'),
      SCORE_PERIODS,
      'period',
    );
    let month: string | null = null;
    let range: TimeRange = ALL_TIME;
    if (period === 'month') {
      month = monthParam ?? monthKey(this.now());
      const r = monthRange(month);
      if (!r) throw new ApiError(400, 'bad_request', 'month must be YYYY-MM');
      range = r;
    } else if (monthParam !== null) {
      throw new ApiError(400, 'bad_request', 'month needs period=month');
    }
    const limitParam = params.get('limit');
    const limit = limitParam === null ? SCORE_LIST_DEFAULT_LIMIT[board] : Number(limitParam);
    if (
      limitParam !== null &&
      (!/^\d+$/.test(limitParam) || limit < 1 || limit > SCORE_LIST_MAX_LIMIT)
    ) {
      throw new ApiError(400, 'bad_request', `limit must be 1..${SCORE_LIST_MAX_LIMIT}`);
    }

    // Keyed by the normalized query: `?period=month` and `?month=<this month>` share an entry.
    const key = `${board} ${period} ${month ?? '-'} ${limit}`;
    const now = this.now();
    const cached = this.scoresCache.get(key);
    // (A clock stepped backwards expires an entry too.)
    if (cached && now >= cached.at && now - cached.at < this.scoresCacheMs) return cached.response;
    const response = this.loadScores(board, period, month, range, limit);
    if (this.scoresCacheMs > 0) this.cacheScores(key, { at: now, response });
    return response;
  }

  /** A visible run's replay, by id (the path segment, unparsed). */
  async replay(idText: string): Promise<SoloReplayResponse> {
    const id = /^[1-9]\d{0,14}$/.test(idText) ? Number(idText) : null;
    const found = id === null ? null : await this.store.getReplay(id);
    if (!found) throw new ApiError(404, 'not_found', 'no such run');
    return { entry: entryOf(found.score), replay: JSON.parse(found.replay) as unknown };
  }

  /** Check a submission against its ticket, verify it, and record it. */
  private async check(
    runId: string,
    name: string,
    replay: SoloReplay,
  ): Promise<SoloSubmitResponse> {
    const ticket = await this.store.getTicket(runId);
    if (!ticket) return this.resubmission(runId);
    // A ticket that fails a check is used up: an honest client never sends one.
    const reject = async (status: number, code: ScoreboardErrorCode, message: string) => {
      await this.store.dropTicket(runId);
      return new ApiError(status, code, message);
    };
    const now = this.now();
    // `>=`: the advertised `expiresAt` (issuedAt + TTL) is itself too late.
    if (now - ticket.issuedAt >= SOLO_TICKET_TTL_MS) {
      throw await reject(409, 'expired_run', "this run's ticket has expired");
    }
    if (ticket.simVersion !== SIM_VERSION) {
      throw await reject(409, 'stale_version', 'the game has been updated since this run began');
    }
    if (replay.seed !== ticket.seed) {
      throw await reject(422, 'invalid_replay', "the replay's seed doesn't match its run");
    }
    if (now - ticket.issuedAt < replay.ticks * MS_PER_TICK) {
      throw await reject(422, 'too_fast', 'the run was submitted sooner than it could be played');
    }

    let result: SoloResult;
    try {
      result = await this.verifier.verify(replay);
    } catch (err) {
      // Busy leaves the ticket intact, so the client can retry.
      if (err instanceof VerifierBusyError) {
        throw new ApiError(503, 'busy', 'the server is busy; try again shortly', {
          'Retry-After': String(BUSY_RETRY_SECONDS),
        });
      }
      if (err instanceof SoloReplayError) throw await reject(422, 'invalid_replay', err.message);
      throw err;
    }

    const run = {
      runId,
      name,
      score: result.score,
      topMultiplier: result.topMultiplier,
      ticks: result.ticks,
      simVersion: ticket.simVersion,
      createdAt: this.now(),
    };
    const id = await this.store.recordRun({ ...run, replay: JSON.stringify(replay) });
    if (id === null) return this.resubmission(runId);
    this.scoresCache.clear(); // every board may have changed
    return this.submitted({ ...run, id, hidden: false });
  }

  private async loadScores(
    board: ScoreBoard,
    period: ScorePeriod,
    month: string | null,
    range: TimeRange,
    limit: number,
  ): Promise<SoloScoresResponse> {
    const rows = await this.store.topScores(board, range, limit);
    const total = await this.store.countScores(range);
    return {
      board,
      period,
      month,
      total,
      entries: rows.map((row, i) => ({ rank: i + 1, ...entryOf(row) })),
    };
  }

  private cacheScores(key: string, entry: CachedScores): void {
    this.scoresCache.delete(key); // re-inserted as the newest
    if (this.scoresCache.size >= SCORES_CACHE_MAX_ENTRIES) {
      for (const [k, e] of this.scoresCache) {
        if (entry.at - e.at >= this.scoresCacheMs) this.scoresCache.delete(k);
      }
      const oldest = this.scoresCache.keys().next();
      if (this.scoresCache.size >= SCORES_CACHE_MAX_ENTRIES && !oldest.done) {
        this.scoresCache.delete(oldest.value);
      }
    }
    this.scoresCache.set(key, entry);
    // A failed lookup isn't worth keeping.
    entry.response.catch(() => {
      if (this.scoresCache.get(key) === entry) this.scoresCache.delete(key);
    });
  }

  /** A run id with no ticket: already recorded (a retry), or never issued. */
  private async resubmission(runId: string): Promise<SoloSubmitResponse> {
    const prior = await this.store.scoreByRun(runId);
    if (!prior) throw new ApiError(409, 'unknown_run', 'no such run, or it was already used');
    return this.submitted(prior);
  }

  private async submitted(run: StoredSoloScore): Promise<SoloSubmitResponse> {
    const all = await this.store.standing(run.id, ALL_TIME);
    const month = await this.store.standing(run.id, monthRange(monthKey(run.createdAt))!);
    return {
      id: run.id,
      name: run.name,
      score: run.score,
      topMultiplier: run.topMultiplier,
      ticks: run.ticks,
      standing: { all, month },
    };
  }
}

/** Spend a request from `key`'s bucket, or refuse with a 429 saying when to try again. */
function take(limiter: RateLimiter, key: string): void {
  if (limiter.take(key)) return;
  const seconds = Math.max(1, Math.ceil(limiter.waitMs(key) / 1000));
  throw new ApiError(429, 'rate_limited', 'too many requests; slow down', {
    'Retry-After': String(seconds),
  });
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ApiError(400, 'bad_request', `${field} must be one of ${allowed.join('|')}`);
  }
  return value as T;
}

function entryOf(run: StoredSoloScore): SoloScoreEntry {
  return {
    id: run.id,
    name: run.name,
    score: run.score,
    topMultiplier: run.topMultiplier,
    ticks: run.ticks,
    createdAt: run.createdAt,
  };
}
