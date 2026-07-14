/**
 * config.ts — resolve a CLI side spec into an `AiTuning`.
 *
 * A spec is either a named difficulty preset (`easy` / `medium` / `hard`) or a
 * JSON object of tuning overrides merged over a base preset:
 *
 *   { "base": "hard", "shatterWeight": 6, "dangerMargin": 4 }
 *
 * `base` defaults to `hard`. Unknown keys and wrong types are rejected loudly —
 * a silently-ignored typo in a tuning experiment would corrupt the measurement.
 */

import { aiTuningFor, type AiDifficultyLevel, type AiTuning } from '@crack-attack/core';

const DIFFICULTIES: readonly AiDifficultyLevel[] = ['easy', 'medium', 'hard'];

const isDifficulty = (v: unknown): v is AiDifficultyLevel =>
  DIFFICULTIES.includes(v as AiDifficultyLevel);

/** Expected type of each overridable {@link AiTuning} field. */
const TUNING_FIELDS: Record<keyof AiTuning, 'number' | 'boolean'> = {
  cooldown: 'number',
  flatten: 'boolean',
  strategic: 'boolean',
  dangerMargin: 'number',
  shatterWeight: 'number',
  shatterSetupMaxCost: 'number',
  undermine: 'boolean',
  chainSetup: 'boolean',
  chainLookahead: 'boolean',
  holdFireTicks: 'number',
  holdFireMinCells: 'number',
  fireMinChain: 'number',
  fireMinRun: 'number',
  clusterVertical: 'number',
  clusterHorizontal: 'number',
};

/**
 * Build an `AiTuning` from parsed JSON: overrides over a `base` preset.
 * Throws with a precise message on any unknown key or type mismatch.
 */
export function tuningFromJson(value: unknown): AiTuning {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tuning JSON must be an object of AiTuning overrides');
  }
  const obj = value as Record<string, unknown>;
  const base = obj['base'] ?? 'hard';
  if (!isDifficulty(base)) {
    throw new Error(`"base" must be one of ${DIFFICULTIES.join('/')} (got ${String(base)})`);
  }
  const tuning: Record<string, unknown> = { ...aiTuningFor(base) };
  for (const [key, v] of Object.entries(obj)) {
    if (key === 'base') continue;
    const expected = (TUNING_FIELDS as Record<string, string | undefined>)[key];
    if (expected === undefined) {
      throw new Error(
        `unknown tuning key "${key}" (valid: ${Object.keys(TUNING_FIELDS).join(', ')})`,
      );
    }
    if (typeof v !== expected || (expected === 'number' && !Number.isFinite(v))) {
      throw new Error(`tuning key "${key}" must be a ${expected} (got ${JSON.stringify(v)})`);
    }
    tuning[key] = v;
  }
  return tuning as unknown as AiTuning;
}

/** Whether a CLI spec names a preset (vs a JSON file path). */
export function isPresetSpec(spec: string): spec is AiDifficultyLevel {
  return isDifficulty(spec);
}
