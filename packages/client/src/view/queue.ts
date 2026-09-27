/**
 * queue.ts — pure wording for the rated queue: the queued player's status
 * line, the lobby's count, and the match-found prompt.
 */

import type { PlayerRating } from '@crack-attack/protocol';
import { ratingText } from './rating.js';

/** `m:ss`. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** While queued: `Looking for a rated game · 0:23 · ±150 · 2 in the queue`. */
export function queueLine(waitedMs: number, window: number, queued: number): string {
  const others = queued === 1 ? 'only you in the queue' : `${queued} in the queue`;
  return `Looking for a rated game · ${clock(waitedMs)} · ±${window} · ${others}`;
}

/** The lobby's count, or '' when the queue is empty: `2 looking for a rated game`. */
export function queueCountLine(queued: number): string {
  return queued === 0 ? '' : `${queued} looking for a rated game`;
}

/** The prompt: `Rated game found: Bob 1620? — accept within 9 s`. */
export function foundLine(opponent: string, rating: PlayerRating, msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `Rated game found: ${opponent} ${ratingText(rating)} — accept within ${s} s`;
}
