/**
 * scoreboard.ts — the solo scoreboard's HTTP API: request/response shapes,
 * limits, and the validation both ends share (see docs/SCOREBOARD_PLAN.md).
 *
 * Plain JSON over HTTP, served by the relay beside its WebSocket:
 *
 *   POST /api/solo/ticket                               → SoloTicketResponse
 *   POST /api/solo/submit   (SoloSubmitRequest)         → SoloSubmitResponse
 *   GET  /api/solo/scores?board=&period=&month=&limit=  → SoloScoresResponse
 *   GET  /api/solo/replay/:id                           → SoloReplayResponse
 *
 * Failures come back as a {@link ScoreboardErrorBody} with a 4xx/5xx status.
 * A submission's replay is validated by core's `parseSoloReplay`, not here:
 * this module checks the envelope only.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 */

import { GC_SCORE_MULT_LENGTH, GC_SCORE_REC_LENGTH } from '@crack-attack/core';
import { ProtocolError } from './codec.js';

/** Path prefix of every scoreboard route. */
export const SOLO_API_PREFIX = '/api/solo';

/** Run ids: lowercase hex, fixed length (128 bits). */
export const RUN_ID_LENGTH = 32;

/** Longest name shown on the boards, in characters (code points). */
export const SCORE_NAME_MAX_LENGTH = 16;

/** Longest name a submission may carry before cleanup, in UTF-16 units. */
export const SCORE_NAME_MAX_INPUT = 64;

/** Largest submission body the server reads. An hour-long game is under 100 KB. */
export const SOLO_SUBMIT_MAX_BYTES = 256 * 1024;

/** How long a run ticket stays valid: longer than any game, pauses included. */
export const SOLO_TICKET_TTL_MS = 24 * 60 * 60 * 1000;

export const SCORE_BOARDS = ['score', 'mult'] as const;
/** `score`: ranked by score. `mult`: ranked by top chain multiplier, then score. */
export type ScoreBoard = (typeof SCORE_BOARDS)[number];

export const SCORE_PERIODS = ['all', 'month'] as const;
/** `all`: every run. `month`: runs in one UTC calendar month. */
export type ScorePeriod = (typeof SCORE_PERIODS)[number];

/** Default list lengths: the original's two tables (Game.h:233-236). */
export const SCORE_LIST_DEFAULT_LIMIT: Readonly<Record<ScoreBoard, number>> = {
  score: GC_SCORE_REC_LENGTH,
  mult: GC_SCORE_MULT_LENGTH,
};

/** Longest list a scores request may ask for. */
export const SCORE_LIST_MAX_LIMIT = 100;

/** A run ticket: play on `seed`, then submit with `runId` before `expiresAt`. */
export interface SoloTicketResponse {
  runId: string;
  seed: number;
  /** Core `SIM_VERSION` the run must be played under. */
  simVersion: number;
  /** Epoch ms. */
  expiresAt: number;
}

export interface SoloSubmitRequest {
  runId: string;
  /** Display name, cleaned up server-side by {@link normalizeScoreName}. */
  name: string;
  /** A core `SoloReplay`. */
  replay: unknown;
}

/** A run's 1-based place on the score board, among `total` runs. */
export interface SoloStanding {
  rank: number;
  total: number;
}

export interface SoloSubmitResponse {
  id: number;
  name: string;
  score: number;
  topMultiplier: number;
  ticks: number;
  /** Null for a run that has since been hidden. */
  standing: { all: SoloStanding | null; month: SoloStanding | null };
}

/** One run on a board. */
export interface SoloScoreEntry {
  id: number;
  name: string;
  score: number;
  topMultiplier: number;
  ticks: number;
  /** Epoch ms. */
  createdAt: number;
}

export interface SoloRankedEntry extends SoloScoreEntry {
  rank: number;
}

export interface SoloScoresResponse {
  board: ScoreBoard;
  period: ScorePeriod;
  /** `YYYY-MM` for a monthly board, else null. */
  month: string | null;
  /** Runs in the period. */
  total: number;
  entries: SoloRankedEntry[];
}

export interface SoloReplayResponse {
  entry: SoloScoreEntry;
  /** A core `SoloReplay`. */
  replay: unknown;
}

export const SCOREBOARD_ERROR_CODES = [
  'bad_request',
  'method_not_allowed',
  'bad_name',
  'invalid_replay',
  'unknown_run',
  'expired_run',
  'stale_version',
  'too_fast',
  'not_found',
  'too_large',
  'rate_limited',
  'busy',
  'internal',
] as const;
export type ScoreboardErrorCode = (typeof SCOREBOARD_ERROR_CODES)[number];

export interface ScoreboardErrorBody {
  error: ScoreboardErrorCode;
  message: string;
}

/** Whether `id` is a well-formed run id (shape check only). */
export function isRunId(id: string): boolean {
  if (id.length !== RUN_ID_LENGTH) return false;
  for (const ch of id) if (!'0123456789abcdef'.includes(ch)) return false;
  return true;
}

/**
 * Clean up a display name for the public boards, or null if nothing usable is
 * left (or it was absurdly long to begin with). Collapses whitespace; strips
 * control, format (zero-width, bidi overrides), private-use, unassigned and
 * lone-surrogate characters; caps stacked combining marks at two; trims; and
 * truncates to {@link SCORE_NAME_MAX_LENGTH} code points.
 */
export function normalizeScoreName(raw: string): string | null {
  if (raw.length > SCORE_NAME_MAX_INPUT) return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .trim();
  const name = Array.from(cleaned).slice(0, SCORE_NAME_MAX_LENGTH).join('').trim();
  return name === '' ? null : name;
}

/** Validate a submission's envelope; throws {@link ProtocolError}. */
export function decodeSoloSubmitRequest(value: unknown): SoloSubmitRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('submission must be a JSON object');
  }
  const { runId, name, replay } = value as Record<string, unknown>;
  if (typeof runId !== 'string' || !isRunId(runId)) {
    throw new ProtocolError('runId is not a valid run id');
  }
  if (typeof name !== 'string') throw new ProtocolError('name must be a string');
  if (replay === undefined) throw new ProtocolError('replay is missing');
  return { runId, name, replay };
}

/** The UTC calendar month of an epoch-ms time, as `YYYY-MM`. */
export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The half-open epoch-ms range `[from, to)` of a `YYYY-MM` month, or null if malformed. */
export function monthRange(key: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2000 || month < 1 || month > 12) return null;
  return { from: Date.UTC(year, month - 1, 1), to: Date.UTC(year, month, 1) };
}
