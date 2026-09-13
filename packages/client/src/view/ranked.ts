/**
 * ranked.ts — pure wording for ranked solo runs (docs/SCOREBOARD_PLAN.md): the
 * HUD tag while a run plays, and the line that replaces it once a ranked run
 * has been submitted.
 */

import type { SoloSubmitResponse } from '@crack-attack/protocol';
import type { ScoreboardFailure } from '../score/scoreboardApi.js';

/**
 * What kind of run is being played: `ranked` (on a server ticket), `practice`
 * (the player turned ranked play off), or unranked for want of a ticket —
 * `offline` (the scoreboard is unreachable) or `stale` (the server runs newer
 * rules; reloading fixes it).
 */
export type RunKind = 'ranked' | 'practice' | 'offline' | 'stale';

export function runTag(kind: RunKind): string {
  switch (kind) {
    case 'ranked':
      return 'RANKED';
    case 'practice':
      return 'PRACTICE';
    case 'offline':
      return 'UNRANKED — offline';
    case 'stale':
      return 'UNRANKED — reload';
  }
}

export const VERIFYING_LINE = 'Verifying…';
export const RETRY_LINE = 'Saved — will submit when the scoreboard is back';
export const NOT_SUBMITTED_LINE = 'Not submitted';

/** A verified run's places, one per line: "#12 of 340 this month", "#85 of 2000 all time". */
export function standingLine(res: SoloSubmitResponse): string {
  const { month, all } = res.standing;
  const lines: string[] = [];
  if (month) lines.push(`#${month.rank} of ${month.total} this month`);
  if (all) lines.push(`#${all.rank} of ${all.total} all time`);
  return lines.length > 0 ? lines.join('\n') : 'Ranked';
}

const REJECTIONS: Partial<Record<ScoreboardFailure, string>> = {
  invalid_replay: "the replay didn't check out",
  too_fast: 'submitted too soon',
  expired_run: 'its ticket expired',
  stale_version: 'the game was updated — reload',
  unknown_run: 'its ticket was already used',
  bad_name: "that name can't be used",
};

/** Why a submitted run wasn't ranked. */
export function rejectionLine(code: ScoreboardFailure): string {
  return `Not ranked: ${REJECTIONS[code] ?? 'the scoreboard refused it'}`;
}
