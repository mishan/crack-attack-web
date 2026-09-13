import { describe, expect, it } from 'vitest';
import { HIGH_SCORE_COLUMNS, entryCells, periodQuery } from './highScores.js';

describe('periodQuery', () => {
  const sep13 = Date.UTC(2026, 8, 13, 12);

  it('asks for all time, this month or last month (UTC)', () => {
    expect(periodQuery('all', sep13)).toEqual({ period: 'all' });
    expect(periodQuery('month', sep13)).toEqual({ period: 'month', month: '2026-09' });
    expect(periodQuery('lastMonth', sep13)).toEqual({ period: 'month', month: '2026-08' });
  });

  it('steps back across a year end', () => {
    expect(periodQuery('lastMonth', Date.UTC(2027, 0, 1))).toEqual({
      period: 'month',
      month: '2026-12',
    });
  });
});

describe('entryCells', () => {
  const entry = {
    rank: 3,
    id: 9,
    name: 'misha',
    score: 1234,
    topMultiplier: 4,
    ticks: 3 * 60 * 50 + 7 * 50,
    createdAt: Date.UTC(2026, 8, 13, 23, 59),
  };

  it('fills one cell per column', () => {
    expect(entryCells(entry)).toEqual(['3', 'misha', '1234', '×4', '3:07', '2026-09-13']);
    expect(entryCells(entry)).toHaveLength(HIGH_SCORE_COLUMNS.length);
  });

  it('isolates the name column only (right-to-left names)', () => {
    expect(HIGH_SCORE_COLUMNS.filter((c) => c.isolate).map((c) => c.label)).toEqual(['Name']);
  });

  it('shows a dash for a run without a chain', () => {
    expect(entryCells({ ...entry, topMultiplier: 0 })[3]).toBe('—');
    expect(entryCells({ ...entry, topMultiplier: 1 })[3]).toBe('—');
  });
});
