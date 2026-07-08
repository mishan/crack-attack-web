import { describe, expect, it } from 'vitest';
import { RAND_MAX, Rng, generateSeed } from './rng.js';

describe('Rng determinism', () => {
  it('same seed yields the same sequence', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    const seqA = Array.from({ length: 100 }, () => a.next());
    const seqB = Array.from({ length: 100 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('different seeds diverge', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).not.toEqual(seqB);
  });

  it('seed 0 is valid and produces a non-degenerate stream', () => {
    const r = new Rng(0);
    const draws = new Set(Array.from({ length: 20 }, () => r.next()));
    expect(draws.size).toBeGreaterThan(1);
  });
});

describe('Rng ranges', () => {
  it('next() stays within [0, RAND_MAX]', () => {
    const r = new Rng(999);
    for (let i = 0; i < 10000; i++) {
      const v = r.next();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(RAND_MAX);
    }
  });

  it('number(max) stays within [0, max)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 10000; i++) {
      const v = r.number(6);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(6);
    }
  });

  it('number2 matches number for power-of-two maxima', () => {
    // Both consume one draw, so run them on independent clones of one stream.
    const base = new Rng(42);
    const a = base.clone();
    const b = base.clone();
    for (let i = 0; i < 1000; i++) {
      expect(a.number2(8)).toBe(b.number(8));
    }
  });

  it('numberFloat() stays within [0, 1]', () => {
    const r = new Rng(3);
    for (let i = 0; i < 10000; i++) {
      const v = r.numberFloat();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('Rng distribution sanity', () => {
  it('number(6) is roughly uniform across columns', () => {
    const r = new Rng(2024);
    const counts = new Array(6).fill(0);
    const n = 60000;
    for (let i = 0; i < n; i++) counts[r.number(6)]++;
    const expected = n / 6;
    for (const c of counts) {
      expect(Math.abs(c - expected) / expected).toBeLessThan(0.05);
    }
  });

  it('chanceIn(3) fires close to 1/3 of the time', () => {
    const r = new Rng(555);
    let hits = 0;
    const n = 60000;
    for (let i = 0; i < n; i++) if (r.chanceIn(3)) hits++;
    expect(Math.abs(hits / n - 1 / 3)).toBeLessThan(0.02);
  });
});

describe('Rng serialization', () => {
  it('state capture and restore reproduce the stream', () => {
    const r = new Rng(88);
    for (let i = 0; i < 37; i++) r.next(); // advance to an arbitrary point
    const snapshot = r.state;

    const expected = Array.from({ length: 20 }, () => r.next());

    const restored = new Rng(0);
    restored.setState(snapshot);
    const actual = Array.from({ length: 20 }, () => restored.next());

    expect(actual).toEqual(expected);
  });

  it('clone advances independently of the original', () => {
    const r = new Rng(101);
    r.next();
    const c = r.clone();
    const fromClone = Array.from({ length: 10 }, () => c.next());
    const fromOriginal = Array.from({ length: 10 }, () => r.next());
    expect(fromClone).toEqual(fromOriginal);
    // further draws from the original no longer match the (now stale) clone
    expect(r.next()).not.toBe(fromClone[0]);
  });
});

describe('generateSeed', () => {
  it('produces a uint32 from an injected entropy source', () => {
    expect(generateSeed(() => 0)).toBe(0);
    expect(generateSeed(() => 0.9999999)).toBeLessThanOrEqual(0xffffffff);
    const s = generateSeed(() => 0.5);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});
