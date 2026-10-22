/**
 * glicko.ts — Glicko-2 (Mark Glickman, "Example of the Glicko-2 system",
 * http://www.glicko.net/glicko/glicko2.pdf; step numbers below are the
 * paper's). Every rated game is a rating period of its own, as on Lichess, and
 * a player's deviation grows with the days since their last rated game,
 * applied when they next play.
 *
 * Floats are fine here: ratings live on the server and never touch the sim.
 */

/** A player's rating on the Glicko scale (1500-centered). */
export interface Rating {
  rating: number;
  /** Rating deviation: how uncertain the rating is. */
  rd: number;
  /** How erratic the player's results are. */
  volatility: number;
}

/** System constant: how much volatility may change per period. */
export const TAU = 0.5;
/** The deviation of a player nothing is known about, and the most any deviation grows to. */
export const MAX_RD = 350;
/** Glicko ↔ Glicko-2 scale factor (400 / ln 10). */
const SCALE = 173.7178;
/** Convergence tolerance for the volatility iteration (step 5). */
const EPSILON = 0.000001;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** One game's result against an opponent: 1 a win, ½ a draw, 0 a loss. */
export interface GameResult {
  opponent: Rating;
  score: 0 | 0.5 | 1;
}

/**
 * `r` with its deviation grown for time idle: one period of volatility per
 * day since `ratedAt` (the paper's step 6 for periods without games), up to
 * {@link MAX_RD}. A player never rated keeps the deviation they have.
 */
export function withIdle(r: Rating, ratedAt: number | null, now: number): Rating {
  if (ratedAt === null) return r;
  const days = Math.max(0, now - ratedAt) / MS_PER_DAY;
  const phi = r.rd / SCALE;
  const grown = Math.sqrt(phi * phi + r.volatility * r.volatility * days) * SCALE;
  return { ...r, rd: Math.min(MAX_RD, grown) };
}

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** Rate `player` after one rating period's games (steps 2–8). */
export function rate(player: Rating, games: readonly GameResult[]): Rating {
  // Step 2: to the Glicko-2 scale.
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.volatility;
  if (games.length === 0) {
    return { ...player, rd: Math.min(MAX_RD, Math.sqrt(phi * phi + sigma * sigma) * SCALE) };
  }

  // Steps 3 and 4: the estimated variance, and the estimated improvement.
  let vInverse = 0;
  let sum = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - 1500) / SCALE;
    const phiJ = opponent.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInverse += g(phiJ) * g(phiJ) * e * (1 - e);
    sum += g(phiJ) * (score - e);
  }
  const v = 1 / vInverse;
  const delta = v * sum;

  // Step 5: the new volatility, by the Illinois algorithm.
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const d = phi * phi + v + ex;
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * d * d) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  while (Math.abs(B - A) > EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA /= 2;
    }
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  // Steps 6 and 7: the new deviation and rating.
  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * sum;

  // Step 8: back to the Glicko scale.
  return {
    rating: newMu * SCALE + 1500,
    rd: Math.min(MAX_RD, newPhi * SCALE),
    volatility: newSigma,
  };
}

/**
 * Both players' ratings after one game between them, each grown for its idle
 * time first. `score` is player a's: 1 a win, ½ a draw, 0 a loss.
 */
export function rateGame(
  a: Rating & { ratedAt: number | null },
  b: Rating & { ratedAt: number | null },
  score: 0 | 0.5 | 1,
  now: number,
): { a: Rating; b: Rating; aBefore: Rating; bBefore: Rating } {
  const aBefore = withIdle(pick(a), a.ratedAt, now);
  const bBefore = withIdle(pick(b), b.ratedAt, now);
  return {
    a: rate(aBefore, [{ opponent: bBefore, score }]),
    b: rate(bBefore, [{ opponent: aBefore, score: (1 - score) as 0 | 0.5 | 1 }]),
    aBefore,
    bBefore,
  };
}

const pick = ({ rating, rd, volatility }: Rating): Rating => ({ rating, rd, volatility });
