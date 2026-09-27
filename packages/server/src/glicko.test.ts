import { describe, expect, it } from 'vitest';
import { MAX_RD, rate, rateGame, withIdle } from './glicko.js';

const DAY = 24 * 60 * 60 * 1000;

describe('Glicko-2', () => {
  it("matches the worked example in Glickman's paper", () => {
    const after = rate({ rating: 1500, rd: 200, volatility: 0.06 }, [
      { opponent: { rating: 1400, rd: 30, volatility: 0.06 }, score: 1 },
      { opponent: { rating: 1550, rd: 100, volatility: 0.06 }, score: 0 },
      { opponent: { rating: 1700, rd: 300, volatility: 0.06 }, score: 0 },
    ]);
    expect(after.rating).toBeCloseTo(1464.06, 1);
    expect(after.rd).toBeCloseTo(151.52, 1);
    expect(after.volatility).toBeCloseTo(0.05999, 4);
  });

  it('grows the deviation of a player who sits out a period', () => {
    const after = rate({ rating: 1600, rd: 50, volatility: 0.06 }, []);
    expect(after.rating).toBe(1600);
    expect(after.rd).toBeGreaterThan(50);
  });

  it('grows the deviation with days idle, up to the cap', () => {
    const r = { rating: 1600, rd: 50, volatility: 0.06 };
    expect(withIdle(r, null, 1e12)).toEqual(r);
    expect(withIdle(r, 0, 0).rd).toBe(50);
    const month = withIdle(r, 0, 30 * DAY).rd;
    const year = withIdle(r, 0, 365 * DAY).rd;
    expect(month).toBeGreaterThan(50);
    expect(year).toBeGreaterThan(month);
    expect(withIdle(r, 0, 10_000 * DAY).rd).toBe(MAX_RD);
  });

  it('moves a new player fast and a settled one slowly', () => {
    const fresh = { rating: 1500, rd: 350, volatility: 0.06, ratedAt: null };
    const settled = { rating: 1500, rd: 60, volatility: 0.06, ratedAt: 0 };
    const beatFresh = rateGame(fresh, { ...fresh }, 1, 0);
    const beatSettled = rateGame(settled, { ...settled }, 1, 0);
    expect(beatFresh.a.rating - 1500).toBeGreaterThan(100);
    expect(beatSettled.a.rating - 1500).toBeLessThan(20);
    expect(beatFresh.a.rating - 1500).toBeCloseTo(1500 - beatFresh.b.rating, 6);
  });

  it('rates a draw between equals as no change, and blunts a win over an unknown', () => {
    const r = { rating: 1700, rd: 80, volatility: 0.06, ratedAt: 0 };
    const draw = rateGame(r, { ...r }, 0.5, 0);
    expect(draw.a.rating).toBeCloseTo(1700, 6);
    expect(draw.a.rd).toBeLessThan(80);
    // Beating a fresh account (an alt, say) is worth less than beating an
    // established one of the same rating.
    const alt = { rating: 1700, rd: 350, volatility: 0.06, ratedAt: null };
    expect(rateGame(r, alt, 1, 0).a.rating).toBeLessThan(rateGame(r, { ...r }, 1, 0).a.rating);
  });

  it("uses each player's idle-grown deviation, and reports it as the before", () => {
    const idle = { rating: 1600, rd: 50, volatility: 0.06, ratedAt: 0 };
    const game = rateGame(idle, { ...idle, ratedAt: 100 * DAY }, 1, 100 * DAY);
    expect(game.aBefore.rd).toBeGreaterThan(game.bBefore.rd);
    expect(game.a.rating - 1600).toBeGreaterThan(1600 - game.b.rating);
  });
});
