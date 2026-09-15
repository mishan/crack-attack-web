import { describe, expect, it } from 'vitest';
import { DEFAULT_ARRIVALS, NO_POPULATIONS } from './directives.js';
import { arrivalMs, shares, splitPopulations } from './split.js';

describe('shares', () => {
  it('divides evenly, remainder to the first workers', () => {
    expect(shares(10, 3)).toEqual([4, 3, 3]);
    expect(shares(9, 3)).toEqual([3, 3, 3]);
    expect(shares(2, 4)).toEqual([1, 1, 0, 0]);
    expect(shares(0, 2)).toEqual([0, 0]);
  });

  it('sums back to the total', () => {
    for (const total of [1, 7, 100, 2001]) {
      for (const workers of [1, 2, 3, 8]) {
        expect(shares(total, workers).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });
});

describe('splitPopulations', () => {
  it('spreads games and lobby counts, repeats per-game, and pins single-game to worker 0', () => {
    const parts = splitPopulations(
      { wireGames: 50, simGames: 3, idlers: 5000, spectatorsPerGame: 4, spectatorsOnFirst: 100 },
      4,
    );
    expect(parts).toHaveLength(4);
    expect(parts.reduce((n, p) => n + (p.wireGames ?? 0), 0)).toBe(50);
    expect(parts.reduce((n, p) => n + (p.simGames ?? 0), 0)).toBe(3);
    expect(parts.reduce((n, p) => n + (p.idlers ?? 0), 0)).toBe(5000);
    // Per-game value repeats.
    expect(parts.every((p) => p.spectatorsPerGame === 4)).toBe(true);
    // Single-game pile-on only on worker 0.
    expect(parts[0]!.spectatorsOnFirst).toBe(100);
    expect(parts.slice(1).every((p) => p.spectatorsOnFirst === 0)).toBe(true);
  });

  it('leaves out what the step leaves out, so the workers keep those targets', () => {
    // L2's last step adds a room to the idlers already connected.
    const parts = splitPopulations({ rooms: 1 }, 2);
    expect(parts).toEqual([{ rooms: 1 }, { rooms: 0 }]);
  });
});

describe('arrivalMs', () => {
  it('times the slowest-growing population at its rate', () => {
    // 500 more idlers at 50 a second.
    expect(
      arrivalMs(
        { ...NO_POPULATIONS, idlers: 500 },
        { ...NO_POPULATIONS, idlers: 1000 },
        DEFAULT_ARRIVALS,
      ),
    ).toBe(10_000);
    // 50 games at 5 a second outlast their 100 spectators at 20 a second.
    expect(
      arrivalMs(
        NO_POPULATIONS,
        { ...NO_POPULATIONS, wireGames: 50, spectatorsPerGame: 2 },
        DEFAULT_ARRIVALS,
      ),
    ).toBe(10_000);
    // L4a: spectators piled onto the one game.
    expect(
      arrivalMs(
        { ...NO_POPULATIONS, wireGames: 1, spectatorsOnFirst: 10 },
        { ...NO_POPULATIONS, wireGames: 1, spectatorsOnFirst: 50 },
        DEFAULT_ARRIVALS,
      ),
    ).toBe(2_000);
  });

  it('takes no time for a population that shrinks', () => {
    expect(arrivalMs({ ...NO_POPULATIONS, wireGames: 100 }, NO_POPULATIONS, DEFAULT_ARRIVALS)).toBe(
      0,
    );
  });
});
