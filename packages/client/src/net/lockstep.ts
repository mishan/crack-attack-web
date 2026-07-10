/**
 * lockstep.ts — the input-relay lockstep driver (DOM-free, unit-tested).
 *
 * Runs *both* players' sims locally from the shared match seed, advancing a
 * tick only when both players' input frames for that tick are known. Local
 * input is scheduled `inputDelay` ticks ahead to hide latency (the first
 * `inputDelay` ticks are pre-filled neutral); when the opponent's frames
 * haven't arrived the session stalls (`waitingForRemote`) and the caller shows
 * a waiting indicator, exactly the "no blocking" replacement for the C++'s
 * alternating send/recv (Communicator.cxx:453).
 *
 * The two sims' garbage-out ports are cross-wired locally, so garbage insertion
 * happens at the same tick on both machines and never crosses the wire. Both
 * sims share the match seed, as the original's seed exchange did — both boards
 * see the same block sequence, which is the fairness the C++ intended.
 *
 * Every DIGEST_PERIOD ticks the session snapshots both sims' digests for the
 * relay to compare (desync detection). Game over is decided deterministically:
 * the first sim to lose loses; both losing on the same tick is a draw
 * (retiring the C++'s hidden server-wins-ties quirk, Communicator.cxx:423).
 */

import { ActionState, GameSim } from '@crack-attack/core';
import { ACTION_MASK, DIGEST_PERIOD, MAX_INPUT_FRAMES_PER_MESSAGE } from '@crack-attack/protocol';

/** An outgoing contiguous input batch (the payload of an `inputs` message). */
export interface OutgoingInputs {
  startTick: number;
  frames: number[];
}

/** A digest snapshot to submit (the payload of a `digest` message). */
export interface DigestSnapshot {
  tick: number;
  digests: [number, number];
}

/** The deterministic match outcome, once a sim has lost. */
export interface Outcome {
  /** Winning player index, or null for a same-tick draw. */
  winner: number | null;
  /** The tick the game ended on. */
  tick: number;
}

export class LockstepSession {
  /** Both players' sims, indexed by player index. */
  readonly sims: [GameSim, GameSim];
  readonly localIndex: number;
  readonly inputDelay: number;

  /** Per-player input frames by tick. */
  private readonly frames: [number[], number[]] = [[], []];
  /** Ticks stepped so far (both sims are always at this tick). */
  private ticks = 0;
  /** Local frames scheduled but not yet handed to the transport. */
  private readonly outbox: number[] = [];
  private outboxStart = 0;
  /** Digest snapshots awaiting submission. */
  private readonly digestQueue: DigestSnapshot[] = [];

  private readonly scratchActions = new ActionState(0);

  /** Set once a sim has lost; the session refuses to step further. */
  outcome: Outcome | null = null;

  constructor(seed: number, localIndex: number, inputDelay: number) {
    this.localIndex = localIndex;
    this.inputDelay = inputDelay;
    this.sims = [new GameSim(seed), new GameSim(seed)];

    // Cross-wire the garbage ports: sim i's outbound garbage is queued on the
    // other sim, stamped with the current (shared) tick — the lockstep
    // equivalent of the C++ addToQueue(..., time_stamp) ingress
    // (GarbageGenerator.cxx:154). Runs at the same point on both machines.
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

    // Pre-fill the local stream's first `inputDelay` ticks with neutral input
    // (both clients do this, so the streams agree without a wire exchange) and
    // queue them for sending so the relay's contiguity ledger starts at 0.
    for (let t = 0; t < inputDelay; t++) {
      this.frames[localIndex]!.push(0);
      this.outbox.push(0);
    }
  }

  /** The tick both sims are at. */
  get currentTick(): number {
    return this.ticks;
  }

  /** True when the next tick is blocked on the opponent's input frames. */
  get waitingForRemote(): boolean {
    return this.outcome === null && this.frames[1 - this.localIndex]!.length <= this.ticks;
  }

  /**
   * Ingest a relayed batch of the opponent's input frames. Batches must be
   * contiguous (the relay enforces this too); a gap here means transport
   * corruption, which lockstep cannot survive.
   */
  addRemoteFrames(startTick: number, frames: number[]): void {
    const buffer = this.frames[1 - this.localIndex]!;
    if (startTick !== buffer.length) {
      throw new Error(
        `peer_inputs batch starts at ${startTick}, expected ${buffer.length} — lost lockstep`,
      );
    }
    for (const f of frames) buffer.push(f & ACTION_MASK);
  }

  /**
   * Try to advance up to `maxSteps` ticks. `sampleLocal` is called once per
   * tick actually stepped, returning the local `CC_*` bitmask to schedule
   * `inputDelay` ticks ahead — input is only sampled for ticks that run, so a
   * stall doesn't eat presses into the future. `onTick`, when given, fires
   * after each stepped tick (the render layer captures view models there).
   * Returns the ticks stepped.
   */
  advance(maxSteps: number, sampleLocal: () => number, onTick?: (tick: number) => void): number {
    let stepped = 0;
    const local = this.frames[this.localIndex]!;
    const remote = this.frames[1 - this.localIndex]!;

    while (stepped < maxSteps && this.outcome === null) {
      const t = this.ticks;
      if (remote.length <= t) break; // waiting for the opponent

      // Schedule local input for t + inputDelay. The stream invariant is
      // local.length === t + inputDelay, so with inputDelay = 0 the frame
      // pushed here is the one consumed below.
      const bits = sampleLocal() & ACTION_MASK;
      local.push(bits);
      this.outbox.push(bits);

      for (let i = 0; i < 2; i++) {
        this.scratchActions.state = this.frames[i]![t]!;
        this.sims[i]!.step(this.scratchActions);
      }
      this.ticks++;
      stepped++;

      if (this.ticks % DIGEST_PERIOD === 0) {
        this.digestQueue.push({
          tick: this.ticks,
          digests: [this.sims[0]!.digest(), this.sims[1]!.digest()],
        });
      }

      const lost0 = this.sims[0]!.lost;
      const lost1 = this.sims[1]!.lost;
      if (lost0 || lost1) {
        this.outcome = { winner: lost0 && lost1 ? null : lost0 ? 1 : 0, tick: this.ticks };
      }
      onTick?.(this.ticks);
    }
    return stepped;
  }

  /**
   * Drain locally scheduled frames into wire batches (chunked to the protocol
   * maximum). Call every render frame; returns [] when nothing is pending.
   */
  takeOutgoing(): OutgoingInputs[] {
    const batches: OutgoingInputs[] = [];
    while (this.outbox.length > 0) {
      const frames = this.outbox.splice(0, MAX_INPUT_FRAMES_PER_MESSAGE);
      batches.push({ startTick: this.outboxStart, frames });
      this.outboxStart += frames.length;
    }
    return batches;
  }

  /** Drain digest snapshots due for submission to the relay. */
  takeDigests(): DigestSnapshot[] {
    return this.digestQueue.splice(0, this.digestQueue.length);
  }
}
