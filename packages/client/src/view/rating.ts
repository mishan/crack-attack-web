/**
 * rating.ts — pure wording for ratings: the lobby's labels, the result
 * banner's rating change, and the leaderboard's and player page's rows.
 */

import type {
  LeaderboardEntry,
  PlayerRating,
  PlayerRecord,
  RatedGameSummary,
  RatingChange,
} from '@crack-attack/protocol';

/** A rating as shown: `1580`, or `1580?` while provisional. */
export function ratingText(r: PlayerRating): string {
  return `${r.rating}${r.provisional ? '?' : ''}`;
}

/** A rated game's change: `+14 → 1594`, `-14 → 1406`, `±0 → 1500`. */
export function ratingChangeText(c: RatingChange): string {
  const delta = c.after.rating - c.before.rating;
  const sign = delta > 0 ? '+' : delta < 0 ? '-' : '±';
  return `${sign}${Math.abs(delta)} → ${ratingText(c.after)}`;
}

/** A player in the lobby: `Alice 1580? (3W/1L)`; a guest has no rating. */
export function lobbyPlayerText(
  name: string,
  record: PlayerRecord,
  rating: PlayerRating | null,
): string {
  const shown = rating ? ` ${ratingText(rating)}` : '';
  return `${name}${shown} (${record.wins}W/${record.losses}L)`;
}

/** W-L-D, as `12-4-1`. */
export function recordText(r: { wins: number; losses: number; draws: number }): string {
  return `${r.wins}-${r.losses}-${r.draws}`;
}

export const LADDER_COLUMNS = [
  { label: '#', align: 'right' },
  { label: 'Player', align: 'left', isolate: true },
  { label: 'Rating', align: 'right' },
  { label: 'W-L-D', align: 'right' },
] as const;

export function ladderCells(e: LeaderboardEntry): string[] {
  return [String(e.rank), e.handle, String(e.rating), recordText(e)];
}

export const GAME_COLUMNS = [
  { label: 'Date', align: 'left' },
  { label: 'Opponent', align: 'left', isolate: true },
  { label: 'Result', align: 'left' },
  { label: 'Rating', align: 'right' },
] as const;

const END_NOTE: Record<RatedGameSummary['end'], string> = {
  result: '',
  concession: ' (conceded)',
  disconnect: ' (left)',
  desync: ' (settled)',
};

/** A rated game from the player's side: date, opponent, result, rating change. */
export function gameCells(g: RatedGameSummary): string[] {
  const result = g.result === 'win' ? 'Won' : g.result === 'loss' ? 'Lost' : 'Draw';
  const delta = g.ratingAfter - g.ratingBefore;
  const change = `${delta > 0 ? '+' : delta < 0 ? '-' : '±'}${Math.abs(delta)} → ${g.ratingAfter}`;
  return [
    new Date(g.createdAt).toISOString().slice(0, 10),
    g.opponent ?? 'deleted player',
    result + END_NOTE[g.end],
    change,
  ];
}
