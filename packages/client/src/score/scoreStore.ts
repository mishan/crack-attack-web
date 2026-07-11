/**
 * scoreStore.ts — localStorage persistence for the solo hall of fame.
 *
 * The impure edge around the pure `view/scoreRecords.ts` tables: load/save the
 * top-score and top-multiplier records (replacing the C++'s `~/.crack-attack/`
 * files) and read the saved player name. All access is defensive — a missing or
 * corrupt entry falls back to the defaults so a first run (or private-mode
 * browser) still works.
 */

import { GC_SCORE_MULT_LENGTH, GC_SCORE_REC_LENGTH } from '@crack-attack/core';
import {
  type MultRecord,
  type ScoreRecord,
  defaultMultRecords,
  defaultScoreRecords,
} from '../view/scoreRecords.js';

const SCORES_KEY = 'crack-attack.scores';
const MULTS_KEY = 'crack-attack.mults';
/** Shared with netplay's identity (netplay.ts STORAGE_NAME). */
const NAME_KEY = 'crack-attack.name';

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — records just don't persist */
  }
}

/**
 * Shape-validate a loaded score table, else fall back to defaults. The exact
 * length is required (not just non-empty): a truncated/corrupt table would break
 * the top-30 invariants and make rank/best readings inconsistent.
 */
export function loadScoreRecords(): ScoreRecord[] {
  const data = loadJson<ScoreRecord[]>(SCORES_KEY);
  if (
    Array.isArray(data) &&
    data.length === GC_SCORE_REC_LENGTH &&
    data.every((r) => typeof r?.name === 'string' && Number.isFinite(r?.score))
  ) {
    return data;
  }
  return defaultScoreRecords();
}

export function loadMultRecords(): MultRecord[] {
  const data = loadJson<MultRecord[]>(MULTS_KEY);
  if (
    Array.isArray(data) &&
    data.length === GC_SCORE_MULT_LENGTH &&
    data.every((r) => typeof r?.name === 'string' && Number.isFinite(r?.multiplier))
  ) {
    return data;
  }
  return defaultMultRecords();
}

export function saveScoreRecords(records: ScoreRecord[]): void {
  saveJson(SCORES_KEY, records);
}

export function saveMultRecords(records: MultRecord[]): void {
  saveJson(MULTS_KEY, records);
}

/** The saved player name (shared with netplay), defaulting to 'player'. */
export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || 'player';
  } catch {
    return 'player';
  }
}
