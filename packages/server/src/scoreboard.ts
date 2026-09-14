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
  type SoloScoreEntry,
  type SoloScoresResponse,
  type SoloSubmitRequest,
  type SoloSubmitResponse,
  type SoloTicketResponse,
} from '@crack-attack/protocol';
import { randomBytes } from 'node:crypto';
import { RateLimiter, siteKey, type RateLimit } from './rateLimit.js';
import {
  ALL_TIME,
  compareScores,
  type ScoreStore,
  type StoredSoloScore,
  type TimeRange,
} from './scoreStore.js';
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

  /** This refusal with more response headers. */
  withHeaders(extra: Readonly<Record<string, string>>): ApiError {
    return new ApiError(this.status, this.code, this.message, { ...this.headers, ...extra });
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
/** Submissions per IPv6 /48, as for tickets: a burst of 80, then one per 5 s. */
export const DEFAULT_SUBMIT_SITE_LIMIT: RateLimit = { capacity: 80, refillMs: 5_000 };
/**
 * Submissions across all clients: every run is stored, so this caps how fast
 * the database can grow however many addresses submit. A burst of 300, then
 * one a second (a finished game a second is far past the game's audience).
 */
export const DEFAULT_SUBMIT_GLOBAL_LIMIT: RateLimit = { capacity: 300, refillMs: 1_000 };
/** Board requests per client: a burst of 60 (flipping through tabs), then one a second. */
export const DEFAULT_SCORES_LIMIT: RateLimit = { capacity: 60, refillMs: 1_000 };
/** Replay requests per client: a burst of 30, then one per 2 s. */
export const DEFAULT_REPLAY_LIMIT: RateLimit = { capacity: 30, refillMs: 2_000 };
/**
 * How long a board response is reused. Recording a run here clears the cache;
 * the admin CLI hides runs from another process, so this bounds how long a
 * hidden run lingers.
 */
export const DEFAULT_SCORES_CACHE_MS = 5_000;
/**
 * How long every run keeps its replay. After that it keeps it only if it's
 * among the best {@link SCORE_LIST_MAX_LIMIT} of its month or of all time, on
 * either board: what the boards can show. Spam runs, however many get in,
 * then cost a row each rather than a replay each.
 */
export const DEFAULT_REPLAY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Most input changes a replay of `ticks` may hold: one per 3 ticks on
 * average, plus 100. The hard AI averages one per 6 ticks (one per 3 in its
 * busiest 10 s); a person keeping up more over a whole game isn't plausible.
 * It stops a bot padding its replays with input that does nothing (a cursor
 * wiggle stores a change every tick).
 */
export function maxReplayInputs(ticks: number): number {
  return Math.floor(ticks / 3) + 100;
}

/** Board responses cached at most (each board, period and month is one). */
const SCORES_CACHE_MAX_ENTRIES = 256;
/** The key of a bucket shared by all clients. */
const EVERYONE = '*';
/** Expired tickets are swept at most this often (when the next ticket is issued). */
const PRUNE_EVERY_MS = 10 * 60 * 1000;
/** Replays are swept at most this often (after a run is recorded). */
const REPLAY_SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Runs one replay sweep looks at, so it never holds the event loop for long. */
const REPLAY_SWEEP_BATCH = 500;
/** A shared limit turning requests away is logged at most this often. */
const SHARED_LIMIT_LOG_EVERY_MS = 10 * 60 * 1000;
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
  /** Operator warnings (a shared limit refusing requests); defaults to `console.warn`. */
  log?: ((line: string) => void) | undefined;
  /** Tickets per client (an IPv4 address or IPv6 /64). */
  ticketLimit?: RateLimit | undefined;
  /** Tickets per IPv6 /48. */
  ticketSiteLimit?: RateLimit | undefined;
  /** Tickets across all clients. */
  ticketGlobalLimit?: RateLimit | undefined;
  /** Submissions per client. */
  submitLimit?: RateLimit | undefined;
  /** Submissions per IPv6 /48. */
  submitSiteLimit?: RateLimit | undefined;
  /** Submissions across all clients. */
  submitGlobalLimit?: RateLimit | undefined;
  /** Board requests per client. */
  scoresLimit?: RateLimit | undefined;
  /** Replay requests per client. */
  replayLimit?: RateLimit | undefined;
  /** How long a board response is reused, in ms; 0 turns the cache off. */
  scoresCacheMs?: number | undefined;
}

interface CachedScores {
  at: number;
  /** The board's first {@link SCORE_LIST_MAX_LIMIT} entries; a request takes as many as it asked for. */
  response: Promise<SoloScoresResponse>;
}

/**
 * A request's rate limits, narrowest first: per client, per IPv6 /48 (none
 * for IPv4), and across all clients.
 */
class TieredLimit {
  private readonly own: RateLimiter;
  private readonly site: RateLimiter;
  private readonly everyone: RateLimiter;

  constructor(
    limits: [own: RateLimit, site: RateLimit, everyone: RateLimit],
    now: () => number,
    /** Called when the bucket shared by all clients turns a request away. */
    private readonly onSharedRefusal: () => void,
  ) {
    this.own = new RateLimiter(limits[0], now);
    this.site = new RateLimiter(limits[1], now);
    this.everyone = new RateLimiter(limits[2], now, 1);
  }

  /**
   * Spend one request for `client`, or refuse with a 429. Narrowest first, so
   * a client already over its own limit spends nothing from the shared buckets.
   */
  take(client: string): void {
    for (const [limiter, key] of this.buckets(client)) {
      if (!limiter.take(key)) throw this.refusal(limiter, key);
    }
  }

  /** Refuse as {@link take} would, but spend nothing. */
  check(client: string): void {
    for (const [limiter, key] of this.buckets(client)) {
      if (limiter.waitMs(key) > 0) throw this.refusal(limiter, key);
    }
  }

  private buckets(client: string): [RateLimiter, string][] {
    const site = siteKey(client);
    return [
      [this.own, client],
      ...(site === null ? [] : [[this.site, site] as [RateLimiter, string]]),
      [this.everyone, EVERYONE],
    ];
  }

  private refusal(limiter: RateLimiter, key: string): ApiError {
    if (key === EVERYONE) this.onSharedRefusal();
    return rateLimited(limiter, key);
  }
}

export class SoloScoreboard {
  private readonly store: ScoreStore;
  private readonly verifier: SoloVerifier;
  private readonly now: () => number;
  private readonly newSeed: () => number;
  private readonly newRunId: () => string;
  private readonly log: (line: string) => void;
  private readonly ticketLimit: TieredLimit;
  private readonly submitLimit: TieredLimit;
  private readonly scoresLimiter: RateLimiter;
  private readonly replayLimiter: RateLimiter;
  private readonly scoresCacheMs: number;
  /** Board responses by their normalized query, oldest first. */
  private readonly scoresCache = new Map<string, CachedScores>();
  /** Submissions being checked, by run id. */
  private readonly inFlight = new Map<string, Promise<SoloSubmitResponse>>();
  /** Requests each shared limit has refused since it was last logged. */
  private readonly sharedRefusals = new Map<string, { count: number; loggedAt: number }>();
  private lastPrune = -Infinity;
  private lastReplaySweep = -Infinity;

  constructor(options: SoloScoreboardOptions) {
    this.store = options.store;
    this.verifier = options.verifier ?? new SoloVerifier();
    this.now = options.now ?? Date.now;
    this.newSeed = options.newSeed ?? (() => randomBytes(4).readUInt32BE(0));
    this.newRunId = options.newRunId ?? (() => randomBytes(16).toString('hex'));
    this.log = options.log ?? ((line) => console.warn(line));
    this.ticketLimit = new TieredLimit(
      [
        options.ticketLimit ?? DEFAULT_TICKET_LIMIT,
        options.ticketSiteLimit ?? DEFAULT_TICKET_SITE_LIMIT,
        options.ticketGlobalLimit ?? DEFAULT_TICKET_GLOBAL_LIMIT,
      ],
      this.now,
      () => this.sharedRefusal('ticket'),
    );
    this.submitLimit = new TieredLimit(
      [
        options.submitLimit ?? DEFAULT_SUBMIT_LIMIT,
        options.submitSiteLimit ?? DEFAULT_SUBMIT_SITE_LIMIT,
        options.submitGlobalLimit ?? DEFAULT_SUBMIT_GLOBAL_LIMIT,
      ],
      this.now,
      () => this.sharedRefusal('submission'),
    );
    this.scoresLimiter = new RateLimiter(options.scoresLimit ?? DEFAULT_SCORES_LIMIT, this.now);
    this.replayLimiter = new RateLimiter(options.replayLimit ?? DEFAULT_REPLAY_LIMIT, this.now);
    this.scoresCacheMs = options.scoresCacheMs ?? DEFAULT_SCORES_CACHE_MS;
  }

  /** Issue a run ticket to `client` (a rate-limit key, see `clientKey`). */
  async issueTicket(client: string): Promise<SoloTicketResponse> {
    this.ticketLimit.take(client);
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
   * Refuse `client` as {@link submit} would for its rate limits, but spend
   * nothing: lets the HTTP layer turn a client away before reading its body.
   */
  checkSubmitLimit(client: string): void {
    this.submitLimit.check(client);
  }

  /**
   * Verify and record a finished run. Submitting a run that's already recorded
   * returns its current standing, so a client can safely retry.
   */
  async submit(client: string, body: unknown): Promise<SoloSubmitResponse> {
    this.submitLimit.take(client);
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
    if (replay.inputs.length > maxReplayInputs(replay.ticks)) {
      throw new ApiError(422, 'invalid_replay', 'the replay changes input faster than anyone can');
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

    // Keyed by the normalized query, less the limit: `?period=month` and
    // `?month=<this month>` share an entry, and every limit shares one load
    // (and one count of the period's runs).
    const key = `${board} ${period} ${month ?? '-'}`;
    const now = this.now();
    let cached = this.scoresCache.get(key);
    // (A clock stepped backwards expires an entry too.)
    if (!cached || now < cached.at || now - cached.at >= this.scoresCacheMs) {
      cached = { at: now, response: this.loadScores(board, period, month, range) };
      if (this.scoresCacheMs > 0) this.cacheScores(key, cached);
    }
    const full = await cached.response;
    return { ...full, entries: full.entries.slice(0, limit) };
  }

  /**
   * A visible run's replay, by id (the path segment, unparsed), as the JSON
   * text of a `SoloReplayResponse`.
   */
  async replay(client: string, idText: string): Promise<string> {
    take(this.replayLimiter, client);
    const id = /^[1-9]\d{0,14}$/.test(idText) ? Number(idText) : null;
    const found = id === null ? null : await this.store.getReplay(id);
    if (!found) throw new ApiError(404, 'not_found', 'no such replay');
    // The replay is JSON this server wrote: spliced in as it is, not parsed
    // and written out again.
    return `{"entry":${JSON.stringify(entryOf(found.score))},"replay":${found.replay}}`;
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
    await this.sweepReplays(run.createdAt);
    return this.submitted({ ...run, id, hidden: false });
  }

  /**
   * Drop the replays of runs past {@link DEFAULT_REPLAY_GRACE_MS} that no
   * board shows. A run is judged once, as it comes of age: later runs can only
   * push it down a board, never up (unless a moderator hides runs above it).
   * A failure is logged, not passed on: the run that set it off is recorded.
   */
  private async sweepReplays(now: number): Promise<void> {
    if (now - this.lastReplaySweep < REPLAY_SWEEP_EVERY_MS) return;
    this.lastReplaySweep = now;
    try {
      const runs = await this.store.replayCandidates(
        now - DEFAULT_REPLAY_GRACE_MS,
        REPLAY_SWEEP_BATCH,
      );
      // A full batch may have left some behind: sweep again after the next run.
      if (runs.length === REPLAY_SWEEP_BATCH) this.lastReplaySweep = -Infinity;
      // Each board's last listed run, by board and range (null: room to spare).
      const lastListed = new Map<string, Promise<StoredSoloScore | null>>();
      const onBoard = async (run: StoredSoloScore, board: ScoreBoard, month: string | null) => {
        const key = `${board} ${month ?? '-'}`;
        let last = lastListed.get(key);
        if (!last) {
          const range = month === null ? ALL_TIME : monthRange(month)!;
          last = this.store
            .topScores(board, range, SCORE_LIST_MAX_LIMIT)
            .then((rows) => (rows.length < SCORE_LIST_MAX_LIMIT ? null : rows[rows.length - 1]!));
          lastListed.set(key, last);
        }
        const bar = await last;
        return bar === null || compareScores(board)(run, bar) <= 0;
      };
      const drop: number[] = [];
      for (const run of runs) {
        let keep = false;
        for (const board of SCORE_BOARDS) {
          for (const month of [null, monthKey(run.createdAt)]) {
            keep ||= await onBoard(run, board, month);
          }
        }
        if (!keep) drop.push(run.id);
      }
      if (drop.length > 0) await this.store.dropReplays(drop);
    } catch (err) {
      this.log(`scoreboard: replay sweep failed: ${String(err)}`);
    }
  }

  /** Log that a shared limit turned a request away, at most every few minutes. */
  private sharedRefusal(what: string): void {
    const now = this.now();
    const seen = this.sharedRefusals.get(what) ?? { count: 0, loggedAt: -Infinity };
    seen.count++;
    this.sharedRefusals.set(what, seen);
    if (now >= seen.loggedAt && now - seen.loggedAt < SHARED_LIMIT_LOG_EVERY_MS) return;
    this.log(
      `scoreboard: the ${what} limit shared by all clients refused ${seen.count} ` +
        `request${seen.count === 1 ? '' : 's'} (reported at most every ` +
        `${SHARED_LIMIT_LOG_EVERY_MS / 60_000} min)`,
    );
    seen.count = 0;
    seen.loggedAt = now;
  }

  private async loadScores(
    board: ScoreBoard,
    period: ScorePeriod,
    month: string | null,
    range: TimeRange,
  ): Promise<SoloScoresResponse> {
    const rows = await this.store.topScores(board, range, SCORE_LIST_MAX_LIMIT);
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

/** The 429 for a request `key`'s bucket can't afford, saying when to try again. */
function rateLimited(limiter: RateLimiter, key: string): ApiError {
  const seconds = Math.max(1, Math.ceil(limiter.waitMs(key) / 1000));
  return new ApiError(429, 'rate_limited', 'too many requests; slow down', {
    'Retry-After': String(seconds),
  });
}

/** Spend a request from `key`'s bucket, or refuse with a 429. */
function take(limiter: RateLimiter, key: string): void {
  if (!limiter.take(key)) throw rateLimited(limiter, key);
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
