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
 *   GET  /api/solo/share/:id                            → an HTML page (see below)
 *
 * A run's share page is what a link posted to Facebook, LinkedIn or Bluesky
 * points at: its Open Graph tags put the score in the link preview, and a
 * person opening it is sent on to the game.
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

/** The game's source code, linked from the game and its share pages. */
export const SOURCE_URL = 'https://github.com/mishan/crack-attack-web';

/** A run's share page, relative to the scoreboard's base URL (`…/api/solo`). */
export function soloSharePath(id: number): string {
  return `/share/${id}`;
}

/** Run ids: lowercase hex, fixed length (128 bits). */
export const RUN_ID_LENGTH = 32;

/** Longest name shown on the boards, in characters (grapheme clusters: an emoji, a flag, a letter and its accents). */
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
 * Stripped outright: control characters other than whitespace, format
 * characters other than the zero-width joiner and non-joiner, private-use,
 * unassigned and lone-surrogate code points, and marks that only ever render
 * invisibly (the combining grapheme joiner, the Khmer inherent vowels).
 */
const STRIPPED = /(?!\s)\p{Cc}|(?!\u200C|\u200D)\p{Cf}|[\p{Co}\p{Cn}\p{Cs}\u034F\u17B4\u17B5]/gu;
/**
 * A run of whitespace, or of characters that render blank without being
 * whitespace to Unicode: the Hangul fillers, the Mongolian vowel separator and
 * the braille blank.
 */
const BLANK_RUN = /[\s\u115F\u1160\u180E\u2800\u3164\uFFA0]+/gu;
/** A run of zero-width joiners and non-joiners. */
const JOINER_RUN = /(?:\u200C|\u200D)+/gu;

/**
 * Clean up a display name for the public boards, or null if nothing usable is
 * left (or it was absurdly long to begin with). Strips control, format
 * (zero-width, bidi overrides), private-use, unassigned and lone-surrogate
 * characters and invisible marks, but keeps a zero-width joiner or non-joiner
 * standing alone between two visible characters (emoji sequences, Persian and
 * Indic text). Then turns whitespace and blank-looking characters (Hangul
 * fillers, the braille blank) into single spaces, composes (NFC), caps
 * stacked combining marks at two, trims, and truncates to
 * {@link SCORE_NAME_MAX_LENGTH} characters (grapheme clusters).
 */
export function normalizeScoreName(raw: string): string | null {
  if (raw.length > SCORE_NAME_MAX_INPUT) return null;
  const cleaned = raw
    .replace(STRIPPED, '')
    .replace(BLANK_RUN, ' ')
    .replace(JOINER_RUN, keepJoiner)
    .replace(/ {2,}/g, ' ')
    .normalize('NFC')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .trim();
  const name = truncateCharacters(cleaned, SCORE_NAME_MAX_LENGTH).trim();
  return name === '' ? null : name;
}

/** A joiner run stays only if it's a single joiner between two non-space characters. */
function keepJoiner(run: string, at: number, text: string): string {
  const before = text[at - 1];
  const after = text[at + run.length];
  const joins = run.length === 1 && before !== undefined && after !== undefined;
  return joins && before !== ' ' && after !== ' ' ? run : '';
}

/** Grapheme segmentation, made on first use; null where the platform lacks it. */
let graphemes: Intl.Segmenter | null | undefined;

/**
 * The first `max` characters of `text`: grapheme clusters (an emoji, a flag,
 * a letter and its accents), or code points where `Intl.Segmenter` is
 * missing (Firefox before 125).
 */
function truncateCharacters(text: string, max: number): string {
  if (graphemes === undefined) {
    graphemes =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
  }
  const chars = graphemes
    ? Array.from(graphemes.segment(text), (s) => s.segment)
    : Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
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
