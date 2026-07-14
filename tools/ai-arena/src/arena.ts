/**
 * arena.ts — headless AI-vs-AI match runner.
 *
 * Two `GameSim`s share a seed (identical starting boards), their garbage ports
 * are cross-wired exactly as in netplay / the client's `aiMatch`, and each side
 * is driven by its own `AiController` with its own tuning. Everything is
 * deterministic: a `(tuningA, tuningB, seed)` triple always produces the same
 * result, so a series over a seed batch is reproducible and any planner/tuning
 * change is *measurable* against a baseline rather than eyeballed.
 *
 * Seats are *near*- but not guaranteed symmetric: boards start identical, but
 * A steps before B within a tick, and a garbage enqueue draws the
 * **receiver's** gameplay RNG (`determineDropTime`) — so relative to the
 * receiver's own stream, a send lands one step earlier in seat B than the
 * mirror image. That reorders draws only when an enqueue coincides with the
 * receiver's own in-step draws (creep-row generation), so mirrors are
 * usually — but not provably — identical (measured: 20/20 hard-vs-medium
 * seeds mirrored exactly). For careful comparisons run both orientations
 * (the CLI's `--both`) and aggregate.
 *
 * A same-tick double loss is a draw (the netplay convention); hitting the tick
 * cap is reported separately as a timeout so stalemates don't masquerade as
 * draws.
 */

import {
  AiController,
  GC_PLAY_WIDTH,
  GF_BLACK,
  GF_COLOR_1,
  GF_COLOR_3,
  GF_COLOR_4,
  GF_COLOR_5,
  GameSim,
  type AiTuning,
} from '@crack-attack/core';

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

/**
 * Cells a special garbage flavor expands to when dealt (see the receiver's
 * `dealSpecialLocalGarbage`): gray/white/color-2 are a full-width row, black a
 * 1×2, color-3 a 1×4, color-4 a 1×3, color-5 a 3×2. Color-1 splinters by the
 * receiver's RNG into 5–7 cells — counted as 6 (the average), so throughput
 * for that one flavor is approximate. Exported so the test suite can verify
 * the table against what `dealSpecialLocalGarbage` actually queues.
 */
export function specialCells(flavor: number): number {
  switch (flavor) {
    case GF_BLACK:
      return 2;
    case GF_COLOR_1:
      return 6;
    case GF_COLOR_3:
      return 4;
    case GF_COLOR_4:
      return 3;
    case GF_COLOR_5:
      return 6;
    default:
      return GC_PLAY_WIDTH; // gray / white / color-2: one full-width row
  }
}

/** Route `from`'s outgoing garbage into `to`'s queue, counting cells sent. */
function link(from: GameSim, to: GameSim, count: (cells: number) => void): void {
  from.garbageGenerator.outSink = {
    sendGarbage: (h, w, f) => {
      count(h * w);
      to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step);
    },
    sendSpecialGarbage: (f) => {
      count(specialCells(f));
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
