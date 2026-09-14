import { describe, expect, it } from 'vitest';
import { Histogram } from './histogram.js';

describe('Histogram', () => {
  it('is empty before any sample', () => {
    const h = new Histogram();
    expect(h.count).toBe(0);
    expect(Number.isNaN(h.percentile(50))).toBe(true);
    expect(Number.isNaN(h.mean)).toBe(true);
  });

  it('recovers percentiles of a uniform 0..999 ms spread within a few percent', () => {
    const h = new Histogram();
    for (let ms = 0; ms < 1000; ms++) h.record(ms);
    expect(h.count).toBe(1000);
    expect(h.percentile(50)).toBeGreaterThan(490);
    expect(h.percentile(50)).toBeLessThan(520);
    expect(h.percentile(99)).toBeGreaterThan(980);
    expect(h.percentile(99)).toBeLessThanOrEqual(999);
    expect(h.max).toBe(999);
    expect(h.mean).toBeCloseTo(499.5, 0);
  });

  it('keeps sub-millisecond values distinct', () => {
    const h = new Histogram();
    for (let i = 0; i < 100; i++) h.record(0.04); // 40 µs
    expect(h.percentile(50)).toBeGreaterThan(0.03);
    expect(h.percentile(50)).toBeLessThan(0.06);
  });

  it('clamps negatives and NaN to zero', () => {
    const h = new Histogram();
    h.record(-5);
    h.record(NaN);
    expect(h.count).toBe(2);
    expect(h.max).toBe(0);
    expect(h.percentile(99)).toBe(0);
  });

  it('merges by adding bucket counts: exact regardless of order', () => {
    const a = new Histogram();
    const b = new Histogram();
    const whole = new Histogram();
    for (let ms = 0; ms < 500; ms++) {
      a.record(ms);
      whole.record(ms);
    }
    for (let ms = 500; ms < 1000; ms++) {
      b.record(ms);
      whole.record(ms);
    }
    a.merge(b);
    expect(a.count).toBe(whole.count);
    expect(a.sum).toBeCloseTo(whole.sum, 6);
    expect(a.max).toBe(whole.max);
    expect(a.percentile(99)).toBe(whole.percentile(99));
  });

  it('round-trips through plain data (a fork boundary)', () => {
    const h = new Histogram();
    for (let ms = 0; ms < 200; ms++) h.record(ms * 0.5);
    const restored = Histogram.from(h.toData());
    expect(restored.count).toBe(h.count);
    expect(restored.percentile(90)).toBe(h.percentile(90));
    expect(restored.max).toBe(h.max);
  });
});
