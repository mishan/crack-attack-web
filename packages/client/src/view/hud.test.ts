import { describe, expect, it } from 'vitest';
import { formatClock } from './hud.js';

describe('formatClock', () => {
  it('formats sub-minute times with zero-padded seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(59)).toBe('0:59');
  });

  it('rolls over into minutes and truncates fractions', () => {
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(605)).toBe('10:05');
  });

  it('clamps negatives to zero', () => {
    expect(formatClock(-3)).toBe('0:00');
  });
});
