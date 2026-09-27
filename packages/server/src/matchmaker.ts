/**
 * matchmaker.ts — the rated queue's pairing rules (docs/RATING_PLAN.md,
 * "Matchmaking"), pure so they're unit-tested; the relay keeps the queue and
 * its timers.
 *
 * Each queued player accepts opponents within a rating window that starts at
 * ±{@link QUEUE_WINDOW_START} and widens by {@link QUEUE_WINDOW_STEP} for every
 * {@link QUEUE_WINDOW_EVERY_MS} waited, so a quiet queue still finds someone.
 * The pair paired is the one whose ratings are closest, as long as the gap is
 * inside both players' windows.
 */

import {
  QUEUE_WINDOW_EVERY_MS,
  QUEUE_WINDOW_START,
  QUEUE_WINDOW_STEP,
} from '@crack-attack/protocol';

/** A player waiting in the queue. */
export interface QueueEntry {
  /** The player's record key (see relay's `Identity`). */
  key: string;
  rating: number;
  /** When the player joined, on the relay's clock; kept across a failed match. */
  joinedAt: number;
  /** Whom the queue last paired this player with, if anyone. */
  lastOpponent: string | null;
}

/** The rating gap `entry` accepts at `now` (±). */
export function queueWindow(entry: QueueEntry, now: number): number {
  const steps = Math.floor(Math.max(0, now - entry.joinedAt) / QUEUE_WINDOW_EVERY_MS);
  return QUEUE_WINDOW_START + QUEUE_WINDOW_STEP * steps;
}

/**
 * The pair to match now, or null. Of every pair whose gap is inside both
 * windows, the closest wins; a tie goes to the pair that has waited longest.
 * Skipped: pairs `blocked` says no to (today's cap), and the same two players
 * as last time while anyone else is waiting.
 */
export function bestPair(
  entries: readonly QueueEntry[],
  now: number,
  blocked: (a: QueueEntry, b: QueueEntry) => boolean = () => false,
): [QueueEntry, QueueEntry] | null {
  let best: [QueueEntry, QueueEntry] | null = null;
  let bestGap = Infinity;
  let bestSince = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const a = entries[i]!;
    for (let j = i + 1; j < entries.length; j++) {
      const b = entries[j]!;
      const gap = Math.abs(a.rating - b.rating);
      if (gap > Math.min(queueWindow(a, now), queueWindow(b, now))) continue;
      const rematch = a.lastOpponent === b.key || b.lastOpponent === a.key;
      if (rematch && entries.length > 2) continue;
      if (a.key === b.key || blocked(a, b)) continue;
      const since = a.joinedAt + b.joinedAt;
      if (gap < bestGap || (gap === bestGap && since < bestSince)) {
        best = [a, b];
        bestGap = gap;
        bestSince = since;
      }
    }
  }
  return best;
}
