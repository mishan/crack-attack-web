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

import { ActionState, GameSim } from '@crack-attack/core';
import { ACTION_MASK } from '@crack-attack/protocol';
import type { AiSeat, Outcome } from './lockstep.js';

export class SpectatorSession {
  /** Both players' sims, indexed by player index. */
  readonly sims: [GameSim, GameSim];

  /** Per-player input frames by tick. */
  private readonly frames: [number[], number[]];
  /** Ticks stepped so far (both sims are always at this tick). */
  private ticks = 0;

  private readonly scratchActions = new ActionState(0);

  /**
   * If a seat is a bot: its controller + index. Its frames aren't relayed; the
   * spectator generates them locally from the same (deterministic) AI sim, so
   * it sees the identical AI moves the players do.
   */
  private readonly aiOpponent: AiSeat | null;

  /** Set once a sim has lost; the session refuses to step further. */
  outcome: Outcome | null = null;

  constructor(seed: number, histories: [number[], number[]], aiOpponent?: AiSeat) {
    this.sims = [new GameSim(seed), new GameSim(seed)];
    this.frames = [[...histories[0]], [...histories[1]]];
    this.aiOpponent = aiOpponent ?? null;

    // Cross-wire the garbage ports exactly as the players do, so this sim
    // pair reproduces theirs tick for tick.
    for (let i = 0; i < 2; i++) {
      const from = this.sims[i]!;
      const to = this.sims[1 - i]!;
      from.garbageGenerator.outSink = {
        sendGarbage: (height, width, flavor) =>
          to.garbageGenerator.addToQueue(height, width, flavor, from.clock.time_step),
        sendSpecialGarbage: (flavor) =>
          to.garbageGenerator.addToQueue(1, 1, flavor, from.clock.time_step),
      };
    }
  }

  /** The tick both sims are at. */
  get currentTick(): number {
    return this.ticks;
  }

  /**
   * How many ticks are fully buffered beyond the current tick. A bot stream is
   * produced on demand, so it never gates: only the human stream is counted.
   */
  get bufferedTicks(): number {
    const buffered = this.aiOpponent
      ? this.frames[1 - this.aiOpponent.index]!.length
      : Math.min(this.frames[0]!.length, this.frames[1]!.length);
    return Math.max(0, buffered - this.ticks);
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
      const t = this.ticks;
      // Synthesize the bot's frame for this tick from its own sim, before
      // stepping — the same computation the players run, over an identical AI
      // sim, so the spectator's boards match theirs tick for tick.
      if (this.aiOpponent && this.frames[this.aiOpponent.index]!.length <= t) {
        this.frames[this.aiOpponent.index]!.push(
          this.aiOpponent.controller.decide(this.sims[this.aiOpponent.index]!).state,
        );
      }
      for (let i = 0; i < 2; i++) {
        this.scratchActions.state = this.frames[i]![t]!;
        this.sims[i]!.step(this.scratchActions);
      }
      this.ticks++;
      stepped++;

      const lost0 = this.sims[0]!.lost;
      const lost1 = this.sims[1]!.lost;
      if (lost0 || lost1) {
        this.outcome = { winner: lost0 && lost1 ? null : lost0 ? 1 : 0, tick: this.ticks };
      }
      onTick?.(this.ticks);
    }
    return stepped;
  }
}
