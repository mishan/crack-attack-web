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
 * The match itself — shared seed, cross-wired garbage, step order, who won —
 * is core's {@link NetMatch}, so every client, spectator and the relay agree on
 * it. Every DIGEST_PERIOD ticks the session snapshots both sims' digests for
 * the relay to compare (desync detection).
 */

import { NetMatch } from '@crack-attack/core';
import type { AiController, GameSim } from '@crack-attack/core';
import { ACTION_MASK, DIGEST_PERIOD, MAX_INPUT_FRAMES_PER_MESSAGE } from '@crack-attack/protocol';

/**
 * A bot seat: the deterministic controller that plays it and which player index
 * it occupies. When present the opponent is an AI whose inputs are generated
 * just-in-time from its own sim rather than received over the wire — so the
 * session never waits on it, and (since the controller is a pure function of
 * the identical AI sim) every client and spectator reproduces the same moves.
 */
export interface AiSeat {
  controller: AiController;
  index: number;
}

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
  /** The match both sims play in. */
  readonly match: NetMatch;
  readonly localIndex: number;
  readonly inputDelay: number;

  /** Per-player input frames by tick. */
  private readonly frames: [number[], number[]] = [[], []];
  /** Local frames scheduled but not yet handed to the transport. */
  private readonly outbox: number[] = [];
  private outboxStart = 0;
  /** Digest snapshots awaiting submission. */
  private readonly digestQueue: DigestSnapshot[] = [];
  /**
   * Digests at or below this tick are not queued. Set on resume: the replay
   * re-crosses checkpoints whose digests the server already compared and
   * discarded, and resubmitting them would leak into its pending map.
   */
  private digestFloor = -1;

  /**
   * When the opponent is a bot: its controller + seat index. The bot's frames
   * are generated locally each tick (never received), so the session never
   * stalls on it and no digests are queued (there is no peer to compare with).
   */
  private readonly aiOpponent: AiSeat | null;

  /** Set once a sim has lost; the session refuses to step further. */
  outcome: Outcome | null = null;

  /**
   * Rebuild a session from the server's `match_resume` ledgers: both players'
   * full input histories from tick 0. The caller then drives {@link advance}
   * hard (catch-up) — the sims replay deterministically to the frontier and
   * the session continues live from there. The server's ledger is
   * authoritative for the local stream too: anything scheduled before the
   * drop but never sent is gone.
   */
  static resume(
    seed: number,
    localIndex: number,
    inputDelay: number,
    histories: [number[], number[]],
  ): LockstepSession {
    const s = new LockstepSession(seed, localIndex, inputDelay, histories);
    return s;
  }

  constructor(
    seed: number,
    localIndex: number,
    inputDelay: number,
    resumeHistories?: [number[], number[]],
    aiOpponent?: AiSeat,
  ) {
    this.localIndex = localIndex;
    this.inputDelay = inputDelay;
    this.aiOpponent = aiOpponent ?? null;
    this.match = new NetMatch(seed);

    if (resumeHistories) {
      // Resume: adopt the server ledgers wholesale. Everything in them was
      // already sent, so the outbox starts empty at the ledger frontier, and
      // digests are suppressed up to the steppable frontier.
      this.frames[0] = [...resumeHistories[0]];
      this.frames[1] = [...resumeHistories[1]];
      this.outboxStart = this.frames[localIndex]!.length;
      this.digestFloor = Math.min(this.frames[0].length, this.frames[1].length);
      return;
    }

    // Pre-fill the local stream's first `inputDelay` ticks with neutral input
    // (both clients do this, so the streams agree without a wire exchange) and
    // queue them for sending so the relay's contiguity ledger starts at 0.
    for (let t = 0; t < inputDelay; t++) {
      this.frames[localIndex]!.push(0);
      this.outbox.push(0);
    }
  }

  /** Both players' sims, indexed by player index. */
  get sims(): readonly [GameSim, GameSim] {
    return this.match.sims;
  }

  /** How many remote ticks are buffered beyond the current tick (catch-up depth). */
  get bufferedRemoteTicks(): number {
    return Math.max(0, this.frames[1 - this.localIndex]!.length - this.match.tick);
  }

  /** The tick both sims are at. */
  get currentTick(): number {
    return this.match.tick;
  }

  /** True when the next tick is blocked on the opponent's input frames. */
  get waitingForRemote(): boolean {
    // A bot opponent's frames are produced on demand, so we never wait on it.
    if (this.aiOpponent) return false;
    return this.outcome === null && this.frames[1 - this.localIndex]!.length <= this.match.tick;
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
   * Try to advance up to `maxSteps` ticks. `sampleLocal` returns the local
   * `CC_*` bitmask and is called as ticks are stepped (once per tick in steady
   * state; not at all while replaying resumed history, since those inputs are
   * already fixed) — input is only sampled for ticks that run, so a stall
   * doesn't eat presses into the future. `onTick`, when given, fires after
   * each stepped tick (the render layer captures view models there). Returns
   * the ticks stepped.
   */
  advance(maxSteps: number, sampleLocal: () => number, onTick?: (tick: number) => void): number {
    let stepped = 0;
    const local = this.frames[this.localIndex]!;
    const remote = this.frames[1 - this.localIndex]!;

    while (stepped < maxSteps && this.outcome === null) {
      const t = this.match.tick;

      // Bot opponent: synthesize its frame for this tick from its own sim
      // (read *before* stepping, exactly like a sampled human input), so the
      // stream is never behind. Deterministic in the AI sim's state, which is
      // identical on every client — the bot's play needs no wire traffic.
      if (this.aiOpponent && remote.length <= t) {
        remote.push(this.aiOpponent.controller.decide(this.sims[this.aiOpponent.index]!).state);
      }
      if (remote.length <= t) break; // waiting for the opponent

      // Schedule local input so local[t] exists. Steady state pushes exactly
      // one frame at t + inputDelay; during a resume replay the slots already
      // exist (zero pushes); after a truncated ledger (frames scheduled but
      // never sent before the drop) it fills the shortfall with live input.
      while (local.length < t + this.inputDelay + 1) {
        const bits = sampleLocal() & ACTION_MASK;
        local.push(bits);
        this.outbox.push(bits);
      }

      const ended = this.match.step(this.frames[0]![t]!, this.frames[1]![t]!);
      const tick = this.match.tick;
      stepped++;

      // Skip digests against a bot: its inputs never reach the relay, so there
      // is no peer submission to compare them with (desync detection is moot).
      if (!this.aiOpponent && tick % DIGEST_PERIOD === 0 && tick > this.digestFloor) {
        const [sim0, sim1] = this.match.sims;
        this.digestQueue.push({ tick, digests: [sim0.digest(), sim1.digest()] });
      }

      if (ended) this.outcome = { ...ended };
      onTick?.(tick);
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
