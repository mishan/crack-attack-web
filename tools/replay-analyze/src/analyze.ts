/**
 * analyze.ts — deterministic post-game analysis of a human-vs-AI replay.
 *
 * A replay is `(seed, difficulty, ticks, sparse human actions)` — saved by the
 * client's vs-AI screen. Because the whole game is deterministic, this module
 * reconstructs *both* boards exactly as they were played (same wiring and step
 * order as the client's `aiMatch`: human first, then the AI, garbage ports
 * crossed), and while replaying it measures each seat with the same evaluator
 * the AI itself plans with:
 *
 *  - **fires**: every reward sign (chain multipliers, 4+ combo magnitudes) with
 *    its tick — the objective attack record of both seats;
 *  - **opportunity**: how often a worth-firing swap (chain ≥ 2 / run ≥ 4 /
 *    shatter, per `evaluateSwap`) existed on each board (sampled), and how much
 *    of that each seat converted — the "planner's eye view" of the human;
 *  - **pressure**: ticks spent in the danger zone, garbage cells sent/held.
 *
 * Everything here is a pure function of the replay file. No RNG, no wall
 * clock — the same replay always produces the same report.
 */

import {
  ActionState,
  AiController,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
  GC_SAFE_HEIGHT,
  GameSim,
  SS_SWAPPING,
  evaluateSwap,
  readPlanBoard,
  type AiDifficultyLevel,
  type SignEvent,
} from '@crack-attack/core';

/** Every valid command bit OR'd together (as in replay-check's validation). */
const ALL_COMMAND_BITS = CC_LEFT | CC_RIGHT | CC_UP | CC_DOWN | CC_SWAP | CC_ADVANCE;

/** The saved replay format (client `aiMatch` `saveReplay`). */
export interface VsAiReplay {
  readonly kind: string;
  readonly version: number;
  readonly seed: number;
  readonly difficulty: AiDifficultyLevel;
  readonly ticks: number;
  readonly actions: readonly { readonly tick: number; readonly command: number }[];
}

/** One attack event on the timeline. */
export interface FireEvent {
  readonly tick: number;
  readonly seat: 'human' | 'ai';
  /** 'chain ×N' or 'combo of N'. */
  readonly what: string;
}

export interface SeatReport {
  /** Swap executions (cursor swaps that actually ran). */
  swaps: number;
  /** Garbage cells sent at the opponent. */
  garbageSent: number;
  /** Chain fires (multiplier signs) and their best multiplier. */
  chains: number;
  bestChain: number;
  /** 4+ combo fires (magnitude signs) and the best combo size. */
  combos: number;
  bestCombo: number;
  /** Ticks spent at/above the danger line (top row ≥ safe − 3). */
  dangerTicks: number;
  /** Of the sampled ticks, how many had a worth-firing swap available. */
  opportunityTicks: number;
  /** Sampled ticks (opportunity is measured every {@link SAMPLE_EVERY}). */
  sampledTicks: number;
}

export interface Analysis {
  readonly seed: number;
  readonly difficulty: AiDifficultyLevel;
  /** Ticks actually replayed (may stop early on a loss). */
  readonly ticks: number;
  readonly outcome: 'human' | 'ai' | 'draw' | 'ongoing';
  readonly human: SeatReport;
  readonly ai: SeatReport;
  readonly timeline: readonly FireEvent[];
}

const SAMPLE_EVERY = 10;
const DANGER_MARGIN = 3;

function newSeatReport(): SeatReport {
  return {
    swaps: 0,
    garbageSent: 0,
    chains: 0,
    bestChain: 0,
    combos: 0,
    bestCombo: 0,
    dangerTicks: 0,
    opportunityTicks: 0,
    sampledTicks: 0,
  };
}

/**
 * Full shape validation for a JSON-loaded replay; throws with a specific
 * reason. This is the safety boundary for external input — every action entry
 * is checked (integer tick in range, no duplicates, command a valid CC_* mask)
 * so malformed files fail here with a clear message instead of surfacing as
 * confusing behavior mid-analysis.
 */
export function validateReplay(value: unknown): VsAiReplay {
  const r = value as Partial<VsAiReplay> | null;
  if (!r || typeof r !== 'object') throw new Error('replay must be a JSON object');
  if (r.kind !== 'crack-attack-vs-ai-replay')
    throw new Error(`unexpected kind "${String(r.kind)}"`);
  if (r.version !== 1) throw new Error(`unsupported version ${String(r.version)}`);
  if (typeof r.seed !== 'number' || !Number.isInteger(r.seed)) {
    throw new Error(`seed must be an integer (got ${String(r.seed)})`);
  }
  if (r.difficulty !== 'easy' && r.difficulty !== 'medium' && r.difficulty !== 'hard') {
    throw new Error(`bad difficulty "${String(r.difficulty)}"`);
  }
  if (!Number.isInteger(r.ticks) || (r.ticks as number) < 0) throw new Error('bad ticks');
  if (!Array.isArray(r.actions)) throw new Error('missing actions');
  const seen = new Set<number>();
  for (const a of r.actions as unknown[]) {
    const e = a as { tick?: unknown; command?: unknown } | null;
    if (!e || typeof e !== 'object') throw new Error('action entries must be objects');
    if (!Number.isInteger(e.tick) || (e.tick as number) < 1 || (e.tick as number) > r.ticks!) {
      throw new Error(`action tick ${String(e.tick)} outside 1..${r.ticks}`);
    }
    if (
      !Number.isInteger(e.command) ||
      (e.command as number) <= 0 ||
      ((e.command as number) & ~ALL_COMMAND_BITS) !== 0
    ) {
      throw new Error(
        `action command ${String(e.command)} at tick ${String(e.tick)} is not a valid CC_* mask`,
      );
    }
    if (seen.has(e.tick as number)) throw new Error(`duplicate action for tick ${String(e.tick)}`);
    seen.add(e.tick as number);
  }
  return r as VsAiReplay;
}

/** Count sign events into a seat report and emit timeline entries. */
function recordSigns(
  events: SignEvent[],
  seat: 'human' | 'ai',
  tick: number,
  report: SeatReport,
  timeline: FireEvent[],
): void {
  for (const ev of events) {
    if (ev.kind === 'multiplier') {
      report.chains++;
      const mult = ev.level + 2; // sign level → ×(level+2)
      report.bestChain = Math.max(report.bestChain, mult);
      timeline.push({ tick, seat, what: `chain ×${mult}` });
    } else if (ev.kind === 'magnitude') {
      report.combos++;
      const size = ev.level + 4; // sign level → combo of (level+4)
      report.bestCombo = Math.max(report.bestCombo, size);
      timeline.push({ tick, seat, what: `combo of ${size}` });
    }
  }
}

/** Whether any single swap on this board would be worth firing (planner's bar). */
function opportunityExists(sim: GameSim): boolean {
  const board = readPlanBoard(sim.grid);
  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width - 1; x++) {
      const c = evaluateSwap(board, x, y);
      if (c.chainDepth >= 2 || c.maxRound >= 4 || c.garbageShattered > 0) return true;
    }
  }
  return false;
}

/**
 * Re-run the replay and measure both seats. Deterministic; the reconstruction
 * matches the client's `aiMatch` wiring exactly (human steps first each tick,
 * garbage ports crossed, stamps from the sender's clock).
 */
export function analyzeReplay(replay: VsAiReplay): Analysis {
  const byTick = new Map<number, number>();
  for (const a of replay.actions) byTick.set(a.tick, a.command);

  const humanSim = new GameSim(replay.seed);
  const aiSim = new GameSim(replay.seed);
  const ai = new AiController(replay.difficulty);

  const human = newSeatReport();
  const aiReport = newSeatReport();
  const timeline: FireEvent[] = [];

  // Garbage is counted as the exact queued-cell delta on the *receiver* — this
  // accounts for special-flavor expansion (a gray special is a full-width row,
  // color-1 splinters by the receiver's RNG) and for queue-full drops, unlike
  // counting the sender's nominal dimensions.
  const link = (from: GameSim, to: GameSim, report: SeatReport): void => {
    const delivered = (deal: () => void): number => {
      const before = to.garbageGenerator.pendingCells;
      deal();
      return to.garbageGenerator.pendingCells - before;
    };
    from.garbageGenerator.outSink = {
      sendGarbage: (h, w, f) => {
        report.garbageSent += delivered(() =>
          to.garbageGenerator.addToQueue(h, w, f, from.clock.time_step),
        );
      },
      sendSpecialGarbage: (f) => {
        report.garbageSent += delivered(() =>
          to.garbageGenerator.addToQueue(1, 1, f, from.clock.time_step),
        );
      },
    };
  };
  link(humanSim, aiSim, human);
  link(aiSim, humanSim, aiReport);

  const seats: { sim: GameSim; report: SeatReport; name: 'human' | 'ai' }[] = [
    { sim: humanSim, report: human, name: 'human' },
    { sim: aiSim, report: aiReport, name: 'ai' },
  ];

  let prevHumanSwapping = false;
  let prevAiSwapping = false;
  let t = 0;
  for (; t < replay.ticks && !humanSim.lost && !aiSim.lost;) {
    t++;
    const command = byTick.get(t) ?? 0;
    humanSim.step(new ActionState(command));
    aiSim.step(ai.decide(aiSim));

    // Swap executions (rising edge of the swapper's swapping state).
    const humanSwapping = (humanSim.swapper.state & SS_SWAPPING) !== 0;
    const aiSwapping = (aiSim.swapper.state & SS_SWAPPING) !== 0;
    if (humanSwapping && !prevHumanSwapping) human.swaps++;
    if (aiSwapping && !prevAiSwapping) aiReport.swaps++;
    prevHumanSwapping = humanSwapping;
    prevAiSwapping = aiSwapping;

    for (const seat of seats) {
      recordSigns(seat.sim.drainSignEvents(), seat.name, t, seat.report, timeline);
      if (seat.sim.grid.top_effective_row >= GC_SAFE_HEIGHT - DANGER_MARGIN) {
        seat.report.dangerTicks++;
      }
      if (t % SAMPLE_EVERY === 0) {
        seat.report.sampledTicks++;
        if (opportunityExists(seat.sim)) seat.report.opportunityTicks++;
      }
      // Drain the cosmetic buffers we don't analyze so they can't grow.
      seat.sim.drainSoundEvents();
      seat.sim.drainImpactEvents();
      seat.sim.drainSparkEvents();
      seat.sim.drainMoteEvents();
    }
  }

  const outcome =
    humanSim.lost && aiSim.lost ? 'draw' : humanSim.lost ? 'ai' : aiSim.lost ? 'human' : 'ongoing';
  return {
    seed: replay.seed,
    difficulty: replay.difficulty,
    ticks: t,
    outcome,
    human,
    ai: aiReport,
    timeline,
  };
}
