import { describe, expect, it } from 'vitest';
import { bestPair, queueWindow, type QueueEntry } from './matchmaker.js';

const entry = (key: string, rating: number, joinedAt = 0, lastOpponent: string | null = null) =>
  ({ key, rating, joinedAt, lastOpponent }) satisfies QueueEntry;
const keys = (pair: [QueueEntry, QueueEntry] | null) => pair?.map((e) => e.key) ?? null;

describe('queueWindow', () => {
  it('starts at ±100 and widens by 50 per 10 s waited', () => {
    const e = entry('a', 1500, 1000);
    expect(queueWindow(e, 1000)).toBe(100);
    expect(queueWindow(e, 10_999)).toBe(100);
    expect(queueWindow(e, 11_000)).toBe(150);
    expect(queueWindow(e, 61_000)).toBe(400);
    expect(queueWindow(e, 0)).toBe(100); // a clock before joining counts as no wait
  });
});

describe('bestPair', () => {
  it('pairs the closest ratings inside both windows', () => {
    const q = [entry('a', 1500), entry('b', 1590), entry('c', 1560), entry('d', 1900)];
    expect(keys(bestPair(q, 0))).toEqual(['b', 'c']);
    expect(bestPair([entry('a', 1500), entry('b', 1601)], 0)).toBeNull();
  });

  it('needs the gap inside the narrower window', () => {
    // a has waited 20 s (±200), b has just joined (±100): 150 apart is too far for b.
    const q = [entry('a', 1500, 0), entry('b', 1650, 20_000)];
    expect(bestPair(q, 20_000)).toBeNull();
    expect(keys(bestPair(q, 30_000))).toEqual(['a', 'b']);
  });

  it('breaks a tie in favor of the longest wait', () => {
    const q = [entry('a', 1500, 5000), entry('b', 1550, 5000), entry('c', 1450, 0)];
    expect(keys(bestPair(q, 5000))).toEqual(['a', 'c']);
  });

  it("doesn't rematch the last pairing while anyone else is waiting", () => {
    const a = entry('a', 1500, 0, 'b');
    const b = entry('b', 1500, 0, 'a');
    expect(keys(bestPair([a, b], 0))).toEqual(['a', 'b']);
    expect(keys(bestPair([a, b, entry('c', 1580)], 0))).toEqual(['a', 'c']);
  });

  it('skips blocked pairs and a player against itself', () => {
    const q = [entry('a', 1500), entry('b', 1500), entry('c', 1550)];
    const capped = (x: QueueEntry, y: QueueEntry) => [x.key, y.key].sort().join() === 'a,b';
    expect(keys(bestPair(q, 0, capped))).toEqual(['a', 'c']);
    expect(bestPair([entry('a', 1500), entry('a', 1500)], 0)).toBeNull();
  });
});
