import { describe, expect, it } from 'vitest';
import { AiVsAiMatch } from './aiVsAi.js';

/** Play a match to completion; returns it for inspection. */
function playOut(match: AiVsAiMatch): AiVsAiMatch {
  while (match.step() === null);
  return match;
}

describe('AiVsAiMatch', () => {
  it('starts both seats on the same board', () => {
    const match = new AiVsAiMatch(1234, 'hard', 'easy');
    expect(match.sims[0].digest()).toBe(match.sims[1].digest());
    expect(match.outcome).toBeNull();
    expect(match.ticks).toBe(0);
  });

  it('is deterministic: the same seed and tiers replay the same game', () => {
    const a = playOut(new AiVsAiMatch(42, 'hard', 'medium'));
    const b = playOut(new AiVsAiMatch(42, 'hard', 'medium'));
    expect(a.outcome).toBe(b.outcome);
    expect(a.ticks).toBe(b.ticks);
    expect(a.sims[0].digest()).toBe(b.sims[0].digest());
    expect(a.sims[1].digest()).toBe(b.sims[1].digest());
  });

  it('plays to a decisive result, and the loser is the board that topped out', () => {
    const match = playOut(new AiVsAiMatch(7, 'hard', 'easy'));
    expect(match.outcome === 0 || match.outcome === 1).toBe(true);
    const loser = match.outcome === 0 ? 1 : 0;
    expect(match.sims[loser].lost).toBe(true);
    expect(match.sims[1 - loser]!.lost).toBe(false);
  });

  it('times out at the tick cap, then stops advancing', () => {
    const match = new AiVsAiMatch(99, 'hard', 'hard', 100);
    playOut(match);
    expect(match.outcome).toBe('timeout');
    expect(match.ticks).toBe(100);
    const digest = match.sims[0].digest();
    expect(match.step()).toBe('timeout');
    expect(match.ticks).toBe(100);
    expect(match.sims[0].digest()).toBe(digest);
  });
});
