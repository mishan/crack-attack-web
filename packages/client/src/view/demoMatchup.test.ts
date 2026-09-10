import { describe, expect, it } from 'vitest';
import { parseDemoMatchup } from './demoMatchup.js';

describe('parseDemoMatchup', () => {
  it('reads a left,right pairing', () => {
    expect(parseDemoMatchup('easy,hard')).toEqual({ left: 'easy', right: 'hard' });
    expect(parseDemoMatchup('medium,easy')).toEqual({ left: 'medium', right: 'easy' });
  });

  it('defaults a bare or empty value to hard vs hard', () => {
    expect(parseDemoMatchup(null)).toEqual({ left: 'hard', right: 'hard' });
    expect(parseDemoMatchup('')).toEqual({ left: 'hard', right: 'hard' });
  });

  it('mirrors the left tier when the right is missing, empty, or unknown', () => {
    expect(parseDemoMatchup('easy')).toEqual({ left: 'easy', right: 'easy' });
    expect(parseDemoMatchup('easy,')).toEqual({ left: 'easy', right: 'easy' });
    expect(parseDemoMatchup('easy,bogus')).toEqual({ left: 'easy', right: 'easy' });
  });

  it('falls back to hard for an unknown or empty left tier', () => {
    expect(parseDemoMatchup('bogus,easy')).toEqual({ left: 'hard', right: 'easy' });
    expect(parseDemoMatchup(',easy')).toEqual({ left: 'hard', right: 'easy' });
  });

  it('ignores case and surrounding spaces', () => {
    expect(parseDemoMatchup('Easy,HARD')).toEqual({ left: 'easy', right: 'hard' });
    expect(parseDemoMatchup(' medium , easy ')).toEqual({ left: 'medium', right: 'easy' });
  });
});
