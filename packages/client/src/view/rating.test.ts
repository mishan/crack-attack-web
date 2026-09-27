import { describe, expect, it } from 'vitest';
import {
  gameCells,
  ladderCells,
  lobbyPlayerText,
  ratingChangeText,
  ratingText,
  recordText,
} from './rating.js';

const r = (rating: number, provisional = false) => ({ rating, provisional });

describe('rating wording', () => {
  it('marks a provisional rating', () => {
    expect(ratingText(r(1580, true))).toBe('1580?');
    expect(ratingText(r(1580))).toBe('1580');
  });

  it('shows a change with its sign', () => {
    expect(ratingChangeText({ before: r(1580, true), after: r(1594) })).toBe('+14 → 1594');
    expect(ratingChangeText({ before: r(1420), after: r(1406) })).toBe('-14 → 1406');
    expect(ratingChangeText({ before: r(1500, true), after: r(1500, true) })).toBe('±0 → 1500?');
  });

  it('labels lobby players, guests without a rating', () => {
    expect(lobbyPlayerText('Alice', { wins: 3, losses: 1 }, r(1580, true))).toBe(
      'Alice 1580? (3W/1L)',
    );
    expect(lobbyPlayerText('carol', { wins: 0, losses: 0 }, null)).toBe('carol (0W/0L)');
  });

  it('fills leaderboard and game rows', () => {
    expect(recordText({ wins: 12, losses: 4, draws: 1 })).toBe('12-4-1');
    expect(
      ladderCells({ rank: 1, handle: 'Misha', rating: 1712, wins: 12, losses: 4, draws: 1 }),
    ).toEqual(['1', 'Misha', '1712', '12-4-1']);
    const game = {
      id: 1,
      opponent: null,
      result: 'loss' as const,
      end: 'concession' as const,
      ratingBefore: 1500,
      ratingAfter: 1338,
      createdAt: Date.UTC(2026, 8, 27, 12),
    };
    expect(gameCells(game)).toEqual([
      '2026-09-27',
      'deleted player',
      'Lost (conceded)',
      '-162 → 1338',
    ]);
    expect(gameCells({ ...game, opponent: 'Bob', result: 'win', end: 'result' })[1]).toBe('Bob');
  });
});
