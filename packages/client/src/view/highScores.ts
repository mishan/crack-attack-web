/**
 * highScores.ts — pure helpers for the high-score screen (the DOM lives in the
 * client root's `highScores.ts`): which query a period tab makes, and how a
 * board row reads.
 */

import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { monthKey, type SoloRankedEntry } from '@crack-attack/protocol';
import { formatClock } from './hud.js';

/** The period tabs. */
export type HighScorePeriod = 'month' | 'lastMonth' | 'all';

/** The scores query for a period tab, as of `now` (epoch ms; months are UTC). */
export function periodQuery(
  period: HighScorePeriod,
  now: number,
): { period: 'all' } | { period: 'month'; month: string } {
  if (period === 'all') return { period: 'all' };
  const d = new Date(now);
  const back = period === 'lastMonth' ? 1 : 0;
  return {
    period: 'month',
    month: monthKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1)),
  };
}

export const HIGH_SCORE_COLUMNS = [
  { label: '#', align: 'right' },
  { label: 'Name', align: 'left' },
  { label: 'Score', align: 'right' },
  { label: 'Chain', align: 'right' },
  { label: 'Time', align: 'right' },
  { label: 'Date', align: 'right' },
] as const;

/** A board row's cells, in {@link HIGH_SCORE_COLUMNS} order. */
export function entryCells(entry: SoloRankedEntry): string[] {
  return [
    String(entry.rank),
    entry.name,
    String(entry.score),
    entry.topMultiplier > 1 ? `×${entry.topMultiplier}` : '—',
    formatClock(entry.ticks / GC_STEPS_PER_SECOND),
    new Date(entry.createdAt).toISOString().slice(0, 10),
  ];
}
