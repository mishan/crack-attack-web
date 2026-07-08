import { describe, expect, it } from 'vitest';
import { dangerTier, formatClock } from './hud.js';

describe('dangerTier', () => {
  it('is safe below half', () => {
    expect(dangerTier(0)).toBe('safe');
    expect(dangerTier(0.49)).toBe('safe');
  });

  it('is warning from half to 0.8', () => {
    expect(dangerTier(0.5)).toBe('warning');
    expect(dangerTier(0.79)).toBe('warning');
  });

  it('is danger at 0.8 and above', () => {
    expect(dangerTier(0.8)).toBe('danger');
    expect(dangerTier(1)).toBe('danger');
  });
});

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
