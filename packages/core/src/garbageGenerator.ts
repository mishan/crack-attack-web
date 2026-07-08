/**
 * garbageGenerator.ts
 *
 * Turns finished combos into garbage: the magnitude/multiplier arithmetic that
 * decides garbage dimensions and flavors, a small queue of pending drops each
 * with a randomized drop delay, and the per-tick attempt to drop ready garbage
 * onto the board. Ported from `GarbageGenerator.{h,cxx}`.
 *
 * The outbound seam: in the C++, `sendGarbage`/`sendSpecialGarbage` branch on
 * game mode — solo deals the garbage to your own board, network sends it to the
 * opponent, AI hands it to the computer player. The port models that as an
 * optional {@link GarbageOutSink}: when set (multiplayer/AI), outgoing garbage
 * goes to the sink; when absent (solo), it is dealt locally. This is the port
 * that netcode and AI plug into (see BROWSER_PORT_PLAN.md).
 *
 * Cosmetic side-effects (SparkleManager reward motes, SignManager signs) are
 * display-layer and omitted. The `determineDropTime` jitter and the COLOR_1
 * splintering draw from the shared gameplay RNG — draw order is load-bearing.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  BF_NUMBER_SPECIAL,
  GC_AVERAGE_GARBAGE_DROP_DELAY,
  GC_GARBAGE_QUEUE_SIZE,
  GC_MIN_PATTERN_LENGTH,
  GC_PLAY_WIDTH,
  GC_SPREAD_GARBAGE_DROP_DELAY,
} from './constants.js';
import type { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import type { GarbageManager } from './garbage.js';
import {
  GF_BLACK,
  GF_COLOR_1,
  GF_COLOR_2,
  GF_COLOR_3,
  GF_COLOR_4,
  GF_COLOR_5,
  GF_GRAY,
  GF_NORMAL,
  GF_WHITE,
  garbageIsSpecialFlavor,
  isColorlessCode,
  mapBlockCodeToGarbageFlavor,
} from './flavors.js';
import type { Rng } from './rng.js';

/** One pending garbage drop. Mirrors `GarbageQueueElement` (GarbageQueueElement.h). */
export class GarbageQueueElement {
  active = false;
  alarm = 0;
  height = 0;
  width = 0;
  flavor = 0;
}

/**
 * Destination for outbound garbage (opponent or AI). When no sink is set the
 * generator deals garbage to its own board (solo). Mirrors the non-solo
 * branches of `GarbageGenerator::sendGarbage`/`sendSpecialGarbage`.
 */
export interface GarbageOutSink {
  sendGarbage(height: number, width: number, flavor: number): void;
  sendSpecialGarbage(flavor: number): void;
}

export class GarbageGenerator {
  private readonly garbage_queue: GarbageQueueElement[];
  private waiting_count = 0;

  /** Optional outbound destination; null ⇒ solo (deal to own board). */
  outSink: GarbageOutSink | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly rng: Rng,
    private readonly garbage: GarbageManager,
  ) {
    this.garbage_queue = new Array<GarbageQueueElement>(GC_GARBAGE_QUEUE_SIZE);
    for (let n = 0; n < GC_GARBAGE_QUEUE_SIZE; n++) {
      this.garbage_queue[n] = new GarbageQueueElement();
    }
    this.gameStart();
  }

  /** Reset the queue. Mirrors `GarbageGenerator::gameStart` (GarbageGenerator.cxx:46). */
  gameStart(): void {
    this.waiting_count = 0;
    for (let n = 0; n < GC_GARBAGE_QUEUE_SIZE; n++) this.garbage_queue[n]!.active = false;
  }

  /** Pending drops not yet placed (inspection/test helper). */
  get waitingCount(): number {
    return this.waiting_count;
  }

  /**
   * Convert this tick's eliminations in `combo` into garbage. Mirrors
   * `GarbageGenerator::comboElimination` (GarbageGenerator.cxx:53). Consumes the
   * combo's special tally and its normal/special magnitudes.
   */
  comboElimination(combo: ComboTabulator): void {
    // used by blocks to determine death-spark number (cosmetic, but faithful)
    combo.latest_magnitude = combo.special_magnitude + combo.magnitude + combo.multiplier - 1;

    // --- special garbage (per tallied special flavor) ---
    for (let n = BF_NUMBER_SPECIAL; n--;) {
      let count = combo.special[n]!;
      if (count) {
        if (isColorlessCode(n)) combo.special_magnitude -= count;
        while (count--) {
          this.sendSpecialGarbage(mapBlockCodeToGarbageFlavor(n));
        }
        combo.special[n] = 0;
      }
    }

    // --- gray garbage (from leftover special magnitude) ---
    if (combo.special_magnitude >= GC_MIN_PATTERN_LENGTH) {
      combo.special_magnitude -= GC_MIN_PATTERN_LENGTH - 2;
      while (--combo.special_magnitude) {
        this.sendSpecialGarbage(GF_GRAY);
      }
    } else {
      combo.special_magnitude = 0;
    }

    // --- normal garbage (dimensioned by magnitude) ---
    if (combo.magnitude > GC_MIN_PATTERN_LENGTH) {
      if (combo.magnitude <= GC_PLAY_WIDTH) {
        this.sendGarbage(1, combo.magnitude - 1, GF_NORMAL);
      } else if (combo.magnitude < 2 * GC_PLAY_WIDTH - 1) {
        this.sendGarbage(1, combo.magnitude - (combo.magnitude >> 1), GF_NORMAL);
        this.sendGarbage(1, combo.magnitude >> 1, GF_NORMAL);
      } else {
        combo.magnitude += GC_MIN_PATTERN_LENGTH;
        while (combo.magnitude > GC_PLAY_WIDTH - 1) {
          this.sendGarbage(1, GC_PLAY_WIDTH - 1, GF_NORMAL);
          combo.magnitude -= GC_PLAY_WIDTH - 1;
        }
        if (combo.magnitude >= GC_MIN_PATTERN_LENGTH) {
          this.sendGarbage(1, combo.magnitude, GF_NORMAL);
        }
      }
    }

    combo.magnitude = 0;
  }

  /**
   * When a combo finishes, send the multiplier garbage. Mirrors
   * `GarbageGenerator::comboComplete` (GarbageGenerator.cxx:142).
   */
  comboComplete(combo: ComboTabulator): void {
    if (combo.multiplier > 1) {
      this.sendGarbage(combo.multiplier - 1, GC_PLAY_WIDTH, GF_NORMAL);
    }
  }

  /**
   * Queue incoming garbage (e.g. from an opponent) for dropping on this board.
   * Mirrors `GarbageGenerator::addToQueue(height, width, flavor, stamp)`
   * (GarbageGenerator.cxx:154). Special flavors expand per the rules.
   */
  addToQueue(height: number, width: number, flavor: number, stamp: number): void {
    if (!garbageIsSpecialFlavor(flavor)) this.dealLocalGarbage(height, width, flavor, stamp);
    else this.dealSpecialLocalGarbage(flavor, stamp);
  }

  /**
   * Attempt to drop each ready queued slab. Mirrors `GarbageGenerator::timeStep`
   * (GarbageGenerator.cxx:233). A slab whose alarm has passed is dropped if the
   * board has room; otherwise its alarm is pushed back.
   */
  timeStep(): void {
    let c = this.waiting_count;
    for (let n = 0; c; n++) {
      const e = this.garbage_queue[n]!;
      if (!e.active) continue;
      c--;

      if (e.alarm < this.clock.time_step) {
        if (this.garbage.newFallingGarbage(e.height, e.width, e.flavor, this.clock.time_step)) {
          this.waiting_count--;
          e.active = false;
        } else {
          e.alarm = this.clock.time_step + GC_AVERAGE_GARBAGE_DROP_DELAY;
        }
      }
    }
  }

  // --- outbound routing ------------------------------------------------------

  private sendGarbage(height: number, width: number, flavor: number): void {
    if (this.outSink) this.outSink.sendGarbage(height, width, flavor);
    else this.dealLocalGarbage(height, width, flavor, this.clock.time_step);
  }

  private sendSpecialGarbage(flavor: number): void {
    if (this.outSink) this.outSink.sendSpecialGarbage(flavor);
    else this.dealSpecialLocalGarbage(flavor, this.clock.time_step);
  }

  // --- local dealing (solo, or the receiving side) ---------------------------

  /** Mirrors `GarbageGenerator::determineDropTime` (GarbageGenerator.h:56). */
  private determineDropTime(timeStamp: number): number {
    return (
      timeStamp +
      (GC_AVERAGE_GARBAGE_DROP_DELAY - Math.trunc(GC_SPREAD_GARBAGE_DROP_DELAY / 2)) +
      this.rng.number(GC_SPREAD_GARBAGE_DROP_DELAY)
    );
  }

  /** Mirrors `GarbageGenerator::dealLocalGarbage` (GarbageGenerator.cxx:178). */
  private dealLocalGarbage(height: number, width: number, flavor: number, timeStamp: number): void {
    if (this.waiting_count === GC_GARBAGE_QUEUE_SIZE) return;

    let i = 0;
    while (this.garbage_queue[i]!.active) i++;

    const e = this.garbage_queue[i]!;
    e.active = true;
    e.height = height;
    e.width = width;
    e.flavor = flavor;
    e.alarm = this.determineDropTime(timeStamp);

    this.waiting_count++;
  }

  /** Mirrors `GarbageGenerator::dealSpecialLocalGarbage` (GarbageGenerator.cxx:198). */
  private dealSpecialLocalGarbage(flavor: number, timeStamp: number): void {
    switch (flavor) {
      case GF_GRAY:
      case GF_WHITE:
      case GF_COLOR_2:
        this.dealLocalGarbage(1, GC_PLAY_WIDTH, flavor, timeStamp);
        break;

      case GF_BLACK:
        this.dealLocalGarbage(1, 2, GF_BLACK, timeStamp);
        break;

      case GF_COLOR_1:
        if (this.rng.chanceIn2(4)) {
          this.dealLocalGarbage(2, 2, GF_COLOR_1, timeStamp);
          for (let n = 1 + this.rng.number(3); n--;) {
            this.dealLocalGarbage(1, 1, GF_COLOR_1, timeStamp);
          }
        } else {
          for (let n = 5 + this.rng.number(3); n--;) {
            this.dealLocalGarbage(1, 1, GF_COLOR_1, timeStamp);
          }
        }
        break;

      case GF_COLOR_3:
        this.dealLocalGarbage(1, 4, GF_COLOR_3, timeStamp);
        break;

      case GF_COLOR_4:
        this.dealLocalGarbage(1, 3, GF_COLOR_4, timeStamp);
        break;

      case GF_COLOR_5:
        this.dealLocalGarbage(3, 2, GF_COLOR_5, timeStamp);
        break;
    }
  }
}
