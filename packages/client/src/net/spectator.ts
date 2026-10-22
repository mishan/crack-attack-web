/**
 * spectator.ts — a watcher's sim driver (DOM-free, unit-tested).
 *
 * A spectator is a third sim pair fed both players' input streams: the same
 * deterministic machinery as {@link LockstepSession}, minus the local player.
 * Construction takes the `spectate_start` ledgers (empty at match start, both
 * histories for a mid-match join — the late-join primitive shared with
 * `match_resume`); `peer_inputs` batches for both player indices append from
 * there, and a tick steps only when both streams have it. Nothing is sent:
 * a spectator has no inputs, no digests, no results.
 */

import { NetMatch } from '@crack-attack/core';
import type { GameSim } from '@crack-attack/core';
import { ACTION_MASK } from '@crack-attack/protocol';
import type { AiSeat, Outcome } from './lockstep.js';

export class SpectatorSession {
  /** The match both sims play in, the same {@link NetMatch} the players run. */
  readonly match: NetMatch;

  /** Per-player input frames by tick. */
  private readonly frames: [number[], number[]];

  /**
   * If a seat is a bot: its controller + index. Its frames aren't relayed; the
   * spectator generates them locally from the same (deterministic) AI sim, so
   * it sees the identical AI moves the players do.
   */
  private readonly aiOpponent: AiSeat | null;

  /** Set once a sim has lost; the session refuses to step further. */
  outcome: Outcome | null = null;

  constructor(seed: number, histories: [number[], number[]], aiOpponent?: AiSeat) {
    this.match = new NetMatch(seed);
    this.frames = [[...histories[0]], [...histories[1]]];
    this.aiOpponent = aiOpponent ?? null;
  }

  /** Both players' sims, indexed by player index. */
  get sims(): readonly [GameSim, GameSim] {
    return this.match.sims;
  }

  /** The tick both sims are at. */
  get currentTick(): number {
    return this.match.tick;
  }

  /**
   * How many ticks are fully buffered beyond the current tick. A bot stream is
   * produced on demand, so it never gates: only the human stream is counted.
   */
  get bufferedTicks(): number {
    const buffered = this.aiOpponent
      ? this.frames[1 - this.aiOpponent.index]!.length
      : Math.min(this.frames[0]!.length, this.frames[1]!.length);
    return Math.max(0, buffered - this.match.tick);
  }

  /** True when the next tick is blocked on either player's frames. */
  get waiting(): boolean {
    return this.outcome === null && this.bufferedTicks === 0;
  }

  /**
   * Ingest a relayed input batch for either player. Contiguity per stream, as
   * everywhere in lockstep.
   */
  addFrames(playerIndex: number, startTick: number, frames: number[]): void {
    const buffer = this.frames[playerIndex];
    if (!buffer) throw new Error(`bad player index ${playerIndex}`);
    if (startTick !== buffer.length) {
      throw new Error(
        `peer_inputs batch for player ${playerIndex} starts at ${startTick}, ` +
          `expected ${buffer.length} — lost lockstep`,
      );
    }
    for (const f of frames) buffer.push(f & ACTION_MASK);
  }

  /**
   * Step up to `maxSteps` fully-buffered ticks. `onTick` fires after each
   * (the render layer captures view models there). Returns the ticks stepped.
   */
  advance(maxSteps: number, onTick?: (tick: number) => void): number {
    let stepped = 0;
    while (stepped < maxSteps && this.outcome === null && this.bufferedTicks > 0) {
      const t = this.match.tick;
      // Synthesize the bot's frame for this tick from its own sim, before
      // stepping — the same computation the players run, over an identical AI
      // sim, so the spectator's boards match theirs tick for tick.
      if (this.aiOpponent && this.frames[this.aiOpponent.index]!.length <= t) {
        this.frames[this.aiOpponent.index]!.push(
          this.aiOpponent.controller.decide(this.sims[this.aiOpponent.index]!).state,
        );
      }
      const ended = this.match.step(this.frames[0]![t]!, this.frames[1]![t]!);
      stepped++;
      if (ended) this.outcome = { ...ended };
      onTick?.(this.match.tick);
    }
    return stepped;
  }
}
