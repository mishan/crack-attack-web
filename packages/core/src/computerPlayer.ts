/**
 * computerPlayer.ts — the AI opponent (Phase 3), ported from
 * `ComputerPlayer.{h,cxx}` + `ComputerPlayerAI.{h,cxx}` + `GarbageQueue.{h,cxx}`.
 *
 * The AI does **not** simulate a grid. It is a timed garbage state machine: it
 * attacks the human on a difficulty-based cadence, holds the human's incoming
 * garbage in a queue, and loses when that queue overflows its capacity. It plugs
 * into the same garbage in/out seam the network path uses — the human's
 * `GarbageOutSink` feeds {@link addGarbage}, and {@link step}'s returned sends
 * are dropped on the human's board via `GarbageGenerator.addToQueue`.
 *
 * Deterministic given (difficulty, seed, garbage-arrival order): the only
 * randomness is the shatter's `chanceIn(GC_GARBAGE_TO_GARBAGE_SHATTER)`, drawn
 * from an injected {@link Rng}. A vs-AI match is local, so this need not be the
 * gameplay stream.
 *
 * Original work Copyright (C) 2000 Daniel Nelson, (C) 2004 Andrew Sayman.
 * GPL-2.0-or-later.
 */

import {
  GC_CREEP_ADVANCE_VELOCITY,
  GC_DYING_DELAY,
  GC_FINAL_POP_DELAY,
  GC_GARBAGE_TO_GARBAGE_SHATTER,
  GC_INITIAL_POP_DELAY,
  GC_INTERNAL_POP_DELAY,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
  GC_STEPS_PER_SECOND,
} from './constants.js';
import { GF_GRAY, GF_NORMAL } from './flavors.js';
import type { Rng } from './rng.js';

export type AiDifficulty = 'easy' | 'medium' | 'hard';

/** One garbage block to drop on the human's board (as `sendGarbage`). */
export interface GarbageSend {
  readonly height: number;
  readonly width: number;
  readonly flavor: number;
}

interface QueueElement {
  height: number;
  width: number;
  flavor: number;
}

/** Per-difficulty tuning: attack cadence multiplier and queue capacity. */
const DIFFICULTY: Record<AiDifficulty, { baseMultiplier: number; lossHeight: number }> = {
  // baseSteps() = GC_STEPS_PER_SECOND * multiplier (ComputerPlayerAI.cxx).
  easy: { baseMultiplier: 15, lossHeight: 4 },
  medium: { baseMultiplier: 10, lossHeight: 10 },
  hard: { baseMultiplier: 5, lossHeight: 20 },
};

/**
 * The incoming-garbage queue the AI holds (its "board"). Faithful port of
 * `GarbageQueue.{h,cxx}` — a list of garbage blocks with a total row height and
 * a leading-run removal for shattering.
 */
export class GarbageQueue {
  private readonly elements: QueueElement[] = [];

  add(height: number, width: number, flavor: number): void {
    this.elements.push({ height, width, flavor });
  }

  /** Total rows queued. */
  height(): number {
    let h = 0;
    for (const e of this.elements) h += e.height;
    return h;
  }

  /** Rows of special (non-normal, i.e. gray) garbage queued. */
  specialHeight(): number {
    let h = 0;
    for (const e of this.elements) if (e.flavor !== GF_NORMAL) h += e.height;
    return h;
  }

  reset(): void {
    this.elements.length = 0;
  }

  /**
   * Shatter: remove the leading run of one flavour up to the first block of the
   * other (`removeWithSpecials` → `removeToFirst`). Returns the number of blocks
   * removed (the reference's `last_shatter_height`).
   */
  removeWithSpecials(): number {
    if (this.elements.length === 0) return 0;
    const stopAt = this.elements[0]!.flavor === GF_GRAY ? GF_NORMAL : GF_GRAY;
    let removed = 0;
    while (removed < this.elements.length && this.elements[removed]!.flavor !== stopAt) removed++;
    if (removed === 0) return 0;
    this.elements.splice(0, removed);
    return removed;
  }
}

/**
 * The computer opponent. Create per game with a difficulty and RNG; feed it the
 * human's outgoing garbage via {@link addGarbage}, {@link step} it each tick to
 * get its attacks, and read {@link lost}/{@link queueHeight} for the outcome and
 * the danger display.
 */
export class ComputerPlayer {
  private readonly queue = new GarbageQueue();
  private readonly baseSteps: number;
  private readonly lossHeightValue: number;

  /** AI_WAITING vs AI_SHATTERING — feeds the alarm's `stateSteps`. */
  private shattering = false;
  private lastShatterHeight = 0;
  /** Tick the alarm was last reset (ComputerPlayerAI `last_time`). */
  private lastTime: number;
  /** Set when garbage arrives; the display flashes and clears it. */
  private impactFlag = false;

  constructor(
    readonly difficulty: AiDifficulty,
    private readonly rng: Rng,
    startTick = 0,
  ) {
    const tuning = DIFFICULTY[difficulty];
    this.baseSteps = GC_STEPS_PER_SECOND * tuning.baseMultiplier;
    this.lossHeightValue = tuning.lossHeight;
    this.lastTime = startTick;
  }

  /** The human's outgoing garbage lands in the AI's queue (ComputerPlayer::addGarbage). */
  addGarbage(height: number, width: number, flavor: number): void {
    this.queue.add(height, width, flavor);
    this.impactFlag = true;
  }

  /** Read-and-clear the "garbage just arrived" flag (for the incoming flash). */
  takeImpact(): boolean {
    const v = this.impactFlag;
    this.impactFlag = false;
    return v;
  }

  /** Extra alarm delay for the current state (ComputerPlayerAI::stateSteps). */
  private stateSteps(): number {
    if (this.shattering) {
      // garbageShatterDelay()
      return (
        GC_INITIAL_POP_DELAY +
        this.lastShatterHeight * GC_PLAY_WIDTH * GC_INTERNAL_POP_DELAY +
        GC_FINAL_POP_DELAY
      );
    }
    // AI_WAITING: raise five lines + five combos.
    return GC_CREEP_ADVANCE_VELOCITY * 5 + GC_DYING_DELAY * 5;
  }

  /** The tick the AI next attacks (ComputerPlayerAI::alarm). */
  nextAttackTick(): number {
    return this.lastTime + this.baseSteps + this.stateSteps();
  }

  /**
   * Advance to `now`. If the attack alarm has fired, compute the garbage to send
   * the human (ComputerPlayerAI::garbageAmount), shatter the AI's own queue, and
   * reset the alarm. Returns the blocks to drop on the human (empty otherwise).
   */
  step(now: number): GarbageSend[] {
    if (now < this.nextAttackTick()) return [];
    const attack = this.garbageAmount();
    this.shatter();
    this.lastTime = now; // resetAlarm
    return attack;
  }

  /** Whether the AI has lost (its queue overflowed). ComputerPlayerAI::determineLoss. */
  get lost(): boolean {
    return this.queue.height() > this.lossHeightValue;
  }

  /** Current queued rows (for the danger display). */
  queueHeight(): number {
    return this.queue.height();
  }

  /** The queue capacity before the AI loses. */
  lossHeight(): number {
    return this.lossHeightValue;
  }

  /** The attack to send the human this alarm (ComputerPlayerAI::garbageAmount). */
  private garbageAmount(): GarbageSend[] {
    const q: GarbageSend[] = [];
    const height = this.queue.height();
    const workingHeight = GC_SAFE_HEIGHT - 1 - height;
    const numGrays = workingHeight > 0 ? workingHeight % 3 : 0;
    const numNormals = height + workingHeight;

    for (let i = 0; i < numGrays; i++) q.push({ height: 1, width: GC_PLAY_WIDTH, flavor: GF_GRAY });

    const normDiv = Math.floor(numNormals / 3);
    const normMod = numNormals % 3;
    if (normDiv > 0) q.push({ height: normDiv, width: GC_PLAY_WIDTH, flavor: GF_NORMAL });
    for (let i = 0; i < normMod; i++)
      q.push({ height: 1, width: GC_PLAY_WIDTH, flavor: GF_NORMAL });

    return q;
  }

  /** Clear the AI's own queue (ComputerPlayerAI::shatter), with residual re-adds. */
  private shatter(): void {
    if (this.queue.height() > 0) {
      this.shattering = true;
      this.lastShatterHeight = this.queue.removeWithSpecials();
      for (let i = 0; i < this.lastShatterHeight; i++) {
        if (this.rng.chanceIn(GC_GARBAGE_TO_GARBAGE_SHATTER)) {
          this.queue.add(1, GC_PLAY_WIDTH, GF_NORMAL);
        }
      }
    } else {
      this.shattering = false;
      this.lastShatterHeight = 0;
    }
  }
}
