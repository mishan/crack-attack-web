import { describe, expect, it } from 'vitest';
import { foundLine, queueCountLine, queueLine } from './queue.js';

describe('queue wording', () => {
  it('shows the wait, the window and the queue', () => {
    expect(queueLine(23_400, 150, 2)).toBe(
      'Looking for a rated game · 0:23 · ±150 · 2 in the queue',
    );
    expect(queueLine(61_000, 100, 1)).toBe(
      'Looking for a rated game · 1:01 · ±100 · only you in the queue',
    );
  });

  it("counts the lobby's queue, silent when it's empty", () => {
    expect(queueCountLine(0)).toBe('');
    expect(queueCountLine(2)).toBe('2 looking for a rated game');
  });

  it('prompts with the opponent and the seconds left, rounded up', () => {
    expect(foundLine('Bob', { rating: 1620, provisional: true }, 8_200)).toBe(
      'Rated game found: Bob 1620? — accept within 9 s',
    );
    expect(foundLine('Bob', { rating: 1620, provisional: false }, -5)).toBe(
      'Rated game found: Bob 1620 — accept within 0 s',
    );
  });
});
