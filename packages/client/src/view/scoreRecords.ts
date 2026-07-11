/**
 * scoreRecords.ts — pure high-score / top-multiplier tables (hall of fame).
 *
 * Ported from `Score::gameFinish` + the default-record setup (Score.cxx). Both
 * tables are kept **ascending** (index 0 = lowest, LENGTH-1 = best), exactly as
 * the C++ stores them, so insertion drops the weakest entry and shifts the rest
 * down. `render`/`main` handle localStorage persistence and drawing.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  GC_SCORE_DEFAULT_TOP_SCORE,
  GC_SCORE_MULT_LENGTH,
  GC_SCORE_REC_LENGTH,
} from '@crack-attack/core';

export interface ScoreRecord {
  name: string;
  score: number;
}

export interface MultRecord {
  name: string;
  multiplier: number;
}

/** Placeholder name for an unclaimed default slot (Score.h `GC_SCORE_REC_DEFAULT_NAME`). */
export const RECORD_DEFAULT_NAME = '-----';

/** Result of a record insertion: the new table and the placed index (-1 if not placed). */
export interface InsertResult<T> {
  records: T[];
  /** Index in the ascending table (LENGTH-1 = best), or -1 if the value didn't place. */
  rank: number;
}

/**
 * Default score table: ascending scores `((n+1) * TOP) / LENGTH` with unclaimed
 * names — the C++ fallback when no `default_record` data file is present
 * (Score.cxx `setupDefaultScoreRecord`).
 */
export function defaultScoreRecords(): ScoreRecord[] {
  const out: ScoreRecord[] = [];
  for (let n = 0; n < GC_SCORE_REC_LENGTH; n++) {
    out.push({
      name: RECORD_DEFAULT_NAME,
      score: Math.floor(((n + 1) * GC_SCORE_DEFAULT_TOP_SCORE) / GC_SCORE_REC_LENGTH),
    });
  }
  return out;
}

/** Default top-multiplier table: a gentle ascending ladder (2..) with unclaimed names. */
export function defaultMultRecords(): MultRecord[] {
  const out: MultRecord[] = [];
  for (let n = 0; n < GC_SCORE_MULT_LENGTH; n++) {
    out.push({ name: RECORD_DEFAULT_NAME, multiplier: n + 2 });
  }
  return out;
}

/** Insert a score into the ascending table (Score::gameFinish). Non-mutating. */
export function insertScore(
  records: ScoreRecord[],
  name: string,
  score: number,
): InsertResult<ScoreRecord> {
  const out = records.map((r) => ({ ...r }));
  for (let n = out.length - 1; n >= 0; n--) {
    if (score > out[n]!.score) {
      for (let i = 0; i < n; i++) out[i] = out[i + 1]!;
      out[n] = { name, score };
      return { records: out, rank: n };
    }
  }
  return { records: out, rank: -1 };
}

/** Insert a multiplier into the ascending table (Score::gameFinish). Non-mutating. */
export function insertMult(
  records: MultRecord[],
  name: string,
  multiplier: number,
): InsertResult<MultRecord> {
  const out = records.map((r) => ({ ...r }));
  for (let n = out.length - 1; n >= 0; n--) {
    if (multiplier > out[n]!.multiplier) {
      for (let i = 0; i < n; i++) out[i] = out[i + 1]!;
      out[n] = { name, multiplier };
      return { records: out, rank: n };
    }
  }
  return { records: out, rank: -1 };
}

/** Human-facing rank (1 = best) from an ascending-table index, or 0 if not placed. */
export function humanRank(rank: number, length: number): number {
  return rank < 0 ? 0 : length - rank;
}
