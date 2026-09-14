import { describe, expect, it } from 'vitest';
import type { SoloSubmitResponse } from '@crack-attack/protocol';
import { rejectionLine, runTag, scoreNameWithoutPrompt, standingLine } from './ranked.js';

const submitted = (standing: SoloSubmitResponse['standing']): SoloSubmitResponse => ({
  id: 1,
  name: 'misha',
  score: 48,
  topMultiplier: 3,
  ticks: 2757,
  standing,
});

describe('runTag', () => {
  it('names each kind of run', () => {
    expect(runTag('ranked')).toBe('RANKED');
    expect(runTag('practice')).toBe('PRACTICE');
    expect(runTag('offline')).toBe('UNRANKED — offline');
    expect(runTag('stale')).toBe('UNRANKED — reload');
  });
});

describe('standingLine', () => {
  it('gives the monthly then all-time place, one per line', () => {
    const line = standingLine(
      submitted({ all: { rank: 85, total: 2000 }, month: { rank: 12, total: 340 } }),
    );
    expect(line).toBe('#12 of 340 this month\n#85 of 2000 all time');
  });

  it('leaves out a place the server withheld', () => {
    expect(standingLine(submitted({ all: { rank: 3, total: 9 }, month: null }))).toBe(
      '#3 of 9 all time',
    );
    expect(standingLine(submitted({ all: null, month: null }))).toBe('Ranked');
  });
});

describe('rejectionLine', () => {
  it('explains known rejections, and falls back for the rest', () => {
    expect(rejectionLine('too_fast')).toBe('Not ranked: submitted too soon');
    expect(rejectionLine('stale_version')).toBe('Not ranked: the game was updated — reload');
    expect(rejectionLine('bad_request')).toBe('Not ranked: the scoreboard refused it');
  });
});

describe('scoreNameWithoutPrompt', () => {
  it('asks until a name has been confirmed, even with a lobby name saved', () => {
    expect(scoreNameWithoutPrompt(null, false)).toBeNull();
    expect(scoreNameWithoutPrompt('misha', false)).toBeNull();
  });

  it('submits under the confirmed name, cleaned up', () => {
    expect(scoreNameWithoutPrompt('  misha   n ', true)).toBe('misha n');
  });

  it('asks again if the saved name is gone or unusable', () => {
    expect(scoreNameWithoutPrompt(null, true)).toBeNull();
    expect(scoreNameWithoutPrompt('x'.repeat(100), true)).toBeNull();
  });
});
