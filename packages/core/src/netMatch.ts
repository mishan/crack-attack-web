/**
 * netMatch.ts — a two-board match: one seed, two sims, garbage cross-wired.
 *
 * The one definition of how a head-to-head game plays out and who wins it.
 * Netplay (`LockstepSession`), spectators (`SpectatorSession`), the AI-vs-AI
 * demo and `tools/ai-arena` all step a {@link NetMatch}, and a relay can
 * re-simulate a match from its seed and both input ledgers the same way.
 *
 * - **Shared seed.** Both sims start from the match seed, as the original's
 *   seed exchange did, so both boards see the same block sequence.
 * - **Cross-wired garbage.** Each sim's outbound garbage is queued on the other,
 *   stamped with the sender's current tick: the lockstep equivalent of the C++
 *   `addToQueue(..., time_stamp)` ingress (GarbageGenerator.cxx:154). Garbage
 *   never crosses the wire; every copy of the match produces it locally.
 * - **Step order.** Both frames for a tick are fixed before it runs; seat 0
 *   steps, then seat 1. Seat 0's garbage is therefore already queued on seat 1
 *   when seat 1 steps, and that order is part of the result.
 * - **Outcome.** Losses are checked after both seats step. The first sim to
 *   lose loses; both losing on the same tick is a draw, retiring the C++'s
 *   hidden server-wins-ties quirk (Communicator.cxx:423).
 *
 * A match has no tick cap of its own; a driver that needs one (the arena)
 * stops stepping and calls the result a timeout.
 */

import { ActionState } from './controller.js';
import { GameSim } from './gameSim.js';

/** How a two-board match ended. */
export interface NetMatchOutcome {
  /** The winning seat, or null for a same-tick draw. */
  readonly winner: 0 | 1 | null;
  /** The tick the game ended on (ticks played). */
  readonly tick: number;
}

/**
 * Optional taps on the garbage each seat sends, called before it is queued on
 * the other seat. For measurement only (the arena counts cells); they must not
 * touch either sim.
 */
export interface NetMatchObserver {
  sendGarbage?(from: 0 | 1, height: number, width: number, flavor: number): void;
  sendSpecialGarbage?(from: 0 | 1, flavor: number): void;
}

export class NetMatch {
  /** Both seats' sims, indexed by seat. */
  readonly sims: readonly [GameSim, GameSim];

  private ticks = 0;
  private result: NetMatchOutcome | null = null;
  private readonly scratch = [new ActionState(0), new ActionState(0)] as const;

  constructor(seed: number, observer?: NetMatchObserver) {
    const sims = [new GameSim(seed), new GameSim(seed)] as const;
    for (const from of [0, 1] as const) {
      const src = sims[from];
      const dst = sims[1 - from]!;
      src.garbageGenerator.outSink = {
        sendGarbage: (height, width, flavor) => {
          observer?.sendGarbage?.(from, height, width, flavor);
          dst.garbageGenerator.addToQueue(height, width, flavor, src.clock.time_step);
        },
        sendSpecialGarbage: (flavor) => {
          observer?.sendSpecialGarbage?.(from, flavor);
          dst.garbageGenerator.addToQueue(1, 1, flavor, src.clock.time_step);
        },
      };
    }
    this.sims = sims;
  }

  /** Ticks played; both sims are at this tick. */
  get tick(): number {
    return this.ticks;
  }

  /** The result, or null while both boards are still in play. */
  get outcome(): NetMatchOutcome | null {
    return this.result;
  }

  /**
   * Play one tick with each seat's `CC_*` command. Returns the outcome once the
   * match is decided. Stepping a decided match is an error: the sims are past
   * the end of the game, and a caller doing it has lost track of the match.
   */
  step(command0: number, command1: number): NetMatchOutcome | null {
    if (this.result) throw new Error(`the match ended on tick ${this.result.tick}`);
    const [sim0, sim1] = this.sims;
    const [act0, act1] = this.scratch;
    act0.state = command0;
    act1.state = command1;
    sim0.step(act0);
    sim1.step(act1);
    this.ticks++;
    if (sim0.lost || sim1.lost) {
      this.result = {
        winner: sim0.lost && sim1.lost ? null : sim0.lost ? 1 : 0,
        tick: this.ticks,
      };
    }
    return this.result;
  }
}

/** What re-simulating a match from its ledgers found. */
export interface NetMatchReplayResult {
  /** How the match ended, or null if it was still in play at {@link tick}. */
  readonly outcome: NetMatchOutcome | null;
  /** Ticks played. */
  readonly tick: number;
  /** Both sims' digests after the last tick played. */
  readonly digests: readonly [number, number];
}

/**
 * Re-simulates a match from its seed and both seats' per-tick input ledgers, a
 * slice at a time, so a relay can decide a match without trusting either
 * client and without blocking its event loop. Plays until the match ends, a
 * ledger runs out, or `endTick`, whichever comes first.
 */
export class NetMatchRunner {
  private readonly match: NetMatch;
  private readonly endTick: number;

  constructor(
    seed: number,
    private readonly ledgers: readonly [readonly number[], readonly number[]],
    endTick = Infinity,
  ) {
    this.match = new NetMatch(seed);
    this.endTick = Math.min(endTick, ledgers[0].length, ledgers[1].length);
  }

  /** Whether the match has ended or there is nothing left to play. */
  get done(): boolean {
    return this.match.outcome !== null || this.match.tick >= this.endTick;
  }

  /**
   * Play up to `budget` more ticks; returns {@link done}. `budget` must be a
   * positive integer, as for `SoloReplayRunner.advance`.
   */
  advance(budget: number): boolean {
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new RangeError(`budget must be a positive integer, not ${budget}`);
    }
    const [frames0, frames1] = this.ledgers;
    for (let n = 0; n < budget && !this.done; n++) {
      const t = this.match.tick;
      this.match.step(frames0[t]!, frames1[t]!);
    }
    return this.done;
  }

  /** The result, once {@link advance} has returned true. */
  result(): NetMatchReplayResult {
    if (!this.done) throw new Error('the match has not been played out');
    const [sim0, sim1] = this.match.sims;
    return {
      outcome: this.match.outcome,
      tick: this.match.tick,
      digests: [sim0.digest(), sim1.digest()],
    };
  }
}
