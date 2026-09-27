/**
 * rating.ts — the ladder's read-only HTTP API: the leaderboard and a player's
 * page (see docs/RATING_PLAN.md). Served by the relay beside the scoreboard:
 *
 *   GET /api/rating/leaderboard?limit=   → LeaderboardResponse
 *   GET /api/rating/player/:handle       → RatingPlayerResponse
 *
 * Failures come back as an `ApiErrorBody`.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 */

/** Path prefix of every rating route. */
export const RATING_API_PREFIX = '/api/rating';

/** The leaderboard lists accounts with a rated game in this many ms. */
export const LEADERBOARD_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;

export const LEADERBOARD_DEFAULT_LIMIT = 50;
export const LEADERBOARD_MAX_LIMIT = 100;

/** Rated games a player's page lists, newest first. */
export const PLAYER_RECENT_GAMES = 20;

export interface LeaderboardEntry {
  rank: number;
  handle: string;
  /** Rounded to a whole number. */
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Accounts with a settled rating (not provisional) and a rated game in the
 * last {@link LEADERBOARD_ACTIVE_MS}, best first.
 */
export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
}

/** How a rated game ended, from one player's side. */
export type RatedGameResult = 'win' | 'loss' | 'draw';

/** Why a rated game ended (a `MatchEndReason` short of a void). */
export type RatedGameEnd = 'result' | 'concession' | 'disconnect' | 'desync';

export interface RatedGameSummary {
  id: number;
  /** The opponent's handle now; null if their account was deleted. */
  opponent: string | null;
  result: RatedGameResult;
  end: RatedGameEnd;
  /** Whole numbers. */
  ratingBefore: number;
  ratingAfter: number;
  /** Epoch ms. */
  createdAt: number;
}

export interface RatingPlayerResponse {
  handle: string;
  rating: number;
  provisional: boolean;
  wins: number;
  losses: number;
  draws: number;
  /** Up to {@link PLAYER_RECENT_GAMES}, newest first. */
  games: RatedGameSummary[];
}
