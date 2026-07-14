/**
 * arena.ts — headless AI-vs-AI match runner.
 *
 * Two `GameSim`s share a seed (identical starting boards), their garbage ports
 * are cross-wired exactly as in netplay / the client's `aiMatch`, and each side
 * is driven by its own `AiController` with its own tuning. Everything is
 * deterministic: a `(tuningA, tuningB, seed)` triple always produces the same
 * result, so a series over a seed batch is reproducible and any planner/tuning
 * change is *measurable* against a baseline rather than eyeballed. Because both
 * boards start identical, sides are symmetric — swapping A and B just mirrors
 * the result, so there is no need to replay swapped sides.
 *
 * A same-tick double loss is a draw (the netplay convention); hitting the tick
 * cap is reported separately as a timeout so stalemates don't masquerade as
 * draws.
 */

import { AiController, GameSim, type AiTuning } from '@crack-attack/core';

/** Who won a single match. */
export type MatchOutcome = 'a' | 'b' | 'draw' | 'timeout';

export interface MatchResult {
  outcome: MatchOutcome;
  seed: number;
  /** Ticks played (50/s). */
  ticks: number;
  /** Garbage cells each side sent at the other. */
  sentA: number;
  sentB: number;
}

export interface SeriesResult {
  winsA: number;
  winsB: number;
  draws: number;
  timeouts: number;
  /** Sum of ticks across all matches. */
  totalTicks: number;
  /** Sum of garbage cells sent across all matches, per side. */
  sentA: number;
  sentB: number;
  matches: MatchResult[];
}

/** Default tick cap: 10 minutes of game time (50 ticks/s). */
export const DEFAULT_MAX_TICKS = 30_000;

/** Route `from`'s outgoing garbage into `to`'s queue, counting cells sent. */
function link(from: GameSim, to: GameSim, count: (cells: number) => void): void {
  from.garbageGenerator.outSink = {
    sendGarbage: (h, w, f) => {
      count(h * w);
      to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step);
    },
    sendSpecialGarbage: (f) => {
      count(1);
      to.garbageGenerator.addToQueue(1, 1, f, from.clock.time_step);
    },
  };
}

/** Play one deterministic match between two tunings on a shared seed. */
export function runMatch(
  tuningA: AiTuning,
  tuningB: AiTuning,
  seed: number,
  maxTicks = DEFAULT_MAX_TICKS,
): MatchResult {
  const simA = new GameSim(seed);
  const simB = new GameSim(seed);
  const aiA = new AiController(tuningA);
  const aiB = new AiController(tuningB);
  let sentA = 0;
  let sentB = 0;
  link(simA, simB, (cells) => (sentA += cells));
  link(simB, simA, (cells) => (sentB += cells));

  let ticks = 0;
  while (ticks < maxTicks && !simA.lost && !simB.lost) {
    // Both sims step every tick (as in netplay); losses are checked after the
    // full tick so a same-tick double loss is seen as such.
    simA.step(aiA.decide(simA));
    simB.step(aiB.decide(simB));
    ticks++;
  }

  const outcome: MatchOutcome =
    simA.lost && simB.lost ? 'draw' : simA.lost ? 'b' : simB.lost ? 'a' : 'timeout';
  return { outcome, seed, ticks, sentA, sentB };
}

/** Play a series over a seed batch, aggregating results. */
export function runSeries(
  tuningA: AiTuning,
  tuningB: AiTuning,
  seeds: readonly number[],
  maxTicks = DEFAULT_MAX_TICKS,
  onMatch?: (result: MatchResult) => void,
): SeriesResult {
  const series: SeriesResult = {
    winsA: 0,
    winsB: 0,
    draws: 0,
    timeouts: 0,
    totalTicks: 0,
    sentA: 0,
    sentB: 0,
    matches: [],
  };
  for (const seed of seeds) {
    const result = runMatch(tuningA, tuningB, seed, maxTicks);
    if (result.outcome === 'a') series.winsA++;
    else if (result.outcome === 'b') series.winsB++;
    else if (result.outcome === 'draw') series.draws++;
    else series.timeouts++;
    series.totalTicks += result.ticks;
    series.sentA += result.sentA;
    series.sentB += result.sentB;
    series.matches.push(result);
    onMatch?.(result);
  }
  return series;
}
