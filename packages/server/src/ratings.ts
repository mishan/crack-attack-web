/**
 * ratings.ts — the ladder's read-only service, transport-free (protocol
 * `rating.ts`): the leaderboard and a player's page. The HTTP routes
 * (`httpApi.ts`) are a thin wrapper, as for the scoreboard. Rated games are
 * written by the relay (`relay.ts`), not here.
 */

import {
  LEADERBOARD_ACTIVE_MS,
  LEADERBOARD_DEFAULT_LIMIT,
  LEADERBOARD_MAX_LIMIT,
  PLAYER_RECENT_GAMES,
  PROVISIONAL_RD,
  foldHandle,
  normalizeHandle,
  type LeaderboardResponse,
  type RatedGameSummary,
  type RatingPlayerResponse,
} from '@crack-attack/protocol';
import type { AccountStore, StoredRatedGame } from './accountStore.js';
import { shownRating } from './accounts.js';
import { ApiError, take } from './apiError.js';
import { RateLimiter, type RateLimit } from './rateLimit.js';

/** Requests per client: a burst of 60, then one a second. */
export const DEFAULT_RATING_LIMIT: RateLimit = { capacity: 60, refillMs: 1_000 };

export interface RatingServiceOptions {
  store: AccountStore;
  /** Wall clock in epoch ms. Inject for tests. */
  now?: (() => number) | undefined;
  limit?: RateLimit | undefined;
}

export class RatingService {
  private readonly store: AccountStore;
  private readonly now: () => number;
  private readonly limiter: RateLimiter;

  constructor(options: RatingServiceOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.limiter = new RateLimiter(options.limit ?? DEFAULT_RATING_LIMIT, this.now);
  }

  /** The leaderboard for `client` (a rate-limit key); `params` may set `limit`. */
  async leaderboard(client: string, params: URLSearchParams): Promise<LeaderboardResponse> {
    take(this.limiter, client);
    const raw = params.get('limit');
    const limit = raw === null ? LEADERBOARD_DEFAULT_LIMIT : Number(raw);
    if (!/^\d+$/.test(raw ?? '0') || limit < 1 || limit > LEADERBOARD_MAX_LIMIT) {
      throw new ApiError(400, 'bad_request', `limit must be 1..${LEADERBOARD_MAX_LIMIT}`);
    }
    const accounts = await this.store.leaderboard(
      this.now() - LEADERBOARD_ACTIVE_MS,
      PROVISIONAL_RD,
      limit,
    );
    return {
      entries: accounts.map((a, i) => ({
        rank: i + 1,
        handle: a.handle,
        rating: Math.round(a.rating),
        wins: a.wins,
        losses: a.losses,
        draws: a.draws,
      })),
    };
  }

  /** A player's page, by handle as typed (a URL path segment, still encoded). */
  async player(client: string, encodedHandle: string): Promise<RatingPlayerResponse> {
    take(this.limiter, client);
    let raw: string;
    try {
      raw = decodeURIComponent(encodedHandle);
    } catch {
      throw new ApiError(400, 'bad_request', 'malformed handle');
    }
    const handle = normalizeHandle(raw);
    const account = handle === null ? null : await this.store.accountByHandle(foldHandle(handle));
    if (!account) throw new ApiError(404, 'not_found', 'no such player');
    const games = await this.store.ratedGames(account.id, PLAYER_RECENT_GAMES);
    return {
      handle: account.handle,
      ...shownRating(account),
      wins: account.wins,
      losses: account.losses,
      draws: account.draws,
      games: games.map((g) => fromSide(g, account.id)),
    };
  }
}

/** A logged game as `accountId` played it. */
function fromSide(game: StoredRatedGame, accountId: number): RatedGameSummary {
  const seatA = game.accountA === accountId;
  const mine = seatA ? 'a' : 'b';
  return {
    id: game.id,
    opponent: seatA ? game.handleB : game.handleA,
    result: game.result === 'draw' ? 'draw' : game.result === mine ? 'win' : 'loss',
    end: game.end,
    ratingBefore: Math.round((seatA ? game.aBefore : game.bBefore).rating),
    ratingAfter: Math.round((seatA ? game.aAfter : game.bAfter).rating),
    createdAt: game.createdAt,
  };
}
