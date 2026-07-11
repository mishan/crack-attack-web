/**
 * loseBar.ts — the stylized danger bar state machine, ported from
 * `LoseBar.{h,cxx}` + the draw colours in `DrawExternalCandy.cxx`.
 *
 * A horizontal bar under the board that reflects the loss countdown. It is
 * driven by two Creep fields per tick: `creep_freeze` (the stack is violating
 * the safe height, so the loss timer is running) and `loss_alarm` (that timer,
 * counting down from GC_LOSS_DELAY = 350 to 0). The bar fills in two phases —
 * blue (inactive) → magenta (low alert, 7s→1s) → red (high alert, 1s→0s) — with
 * 20-tick colour fades on every transition.
 *
 * This is pure, DOM-free decision logic (like `view/levelLights.ts`);
 * `render/loseBarView.ts` draws it. It draws no RNG and reads only display
 * state, so it never touches determinism.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_LOSS_DELAY, GC_LOSS_DELAY_ELIMINATION } from '@crack-attack/core';

// LoseBar states (LoseBar.h:33-38).
export const LB_INACTIVE = 1 << 0;
export const LB_LOW_ALERT = 1 << 1;
export const LB_HIGH_ALERT = 1 << 2;
export const LB_FADE_LOW_TO_INACTIVE = 1 << 3;
export const LB_FADE_HIGH_TO_INACTIVE = 1 << 4;
export const LB_FADE_RESET_HIGH = 1 << 5;

/** Ticks a colour fade takes (DC_LOSEBAR_FADE_TIME). */
export const LOSEBAR_FADE_TIME = 20;

export type Rgb = readonly [number, number, number];

// Bar colours (Displayer.h:526-534).
const INACTIVE_COLOR: Rgb = [0, 0, 1]; // blue
const LOW_ALERT_COLOR: Rgb = [0.8, 0, 0.8]; // magenta
const HIGH_ALERT_COLOR: Rgb = [1, 0, 0]; // red

function lerp(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/**
 * The danger bar. Feed {@link tick} the Creep `creep_freeze` / `loss_alarm` once
 * per sim tick; read {@link bar} (0..1 fill) and {@link color1}/{@link color2}
 * (the filled and empty colours, already faded) to render.
 */
export class LoseBarState {
  /** Current LB_* state. */
  state = LB_INACTIVE;
  /** Fill fraction 0..1 (the colour boundary sweeps right as this grows). */
  bar = 0;

  private fadeTimer = 0;
  private prevLossAlarm = 0;

  /** Reset to inactive for a fresh game (LoseBar::initialize). */
  gameStart(): void {
    this.state = LB_INACTIVE;
    this.bar = 0;
    this.fadeTimer = 0;
    this.prevLossAlarm = 0;
  }

  /**
   * Advance one sim tick. Faithful to `LoseBar::timeStep`, plus the
   * `LoseBar::highAlertReset` that Creep triggers (Creep.cxx:89) when a pop
   * bumps `loss_alarm` back up to the elimination floor during high alert —
   * detected here as `loss_alarm` rising to that floor while on high alert.
   */
  tick(creepFreeze: boolean, lossAlarm: number): void {
    // highAlertReset: a reprieve pop during high alert re-flashes the bar.
    if (
      this.state === LB_HIGH_ALERT &&
      creepFreeze &&
      lossAlarm > this.prevLossAlarm &&
      lossAlarm === GC_LOSS_DELAY_ELIMINATION
    ) {
      this.fadeTimer = LOSEBAR_FADE_TIME;
      this.state = LB_FADE_RESET_HIGH;
    }

    // --- state update (LoseBar.cxx:63-107) ---
    if ((this.state & (LB_INACTIVE | LB_FADE_LOW_TO_INACTIVE | LB_FADE_HIGH_TO_INACTIVE)) !== 0) {
      if (
        (this.state & (LB_FADE_LOW_TO_INACTIVE | LB_FADE_HIGH_TO_INACTIVE)) !== 0 &&
        --this.fadeTimer === 0
      ) {
        this.state = LB_INACTIVE;
      }
      if (creepFreeze) {
        this.state = LB_LOW_ALERT;
        this.fadeTimer = 0;
      }
    } else if (this.state === LB_LOW_ALERT) {
      if (!creepFreeze) {
        this.fadeTimer = LOSEBAR_FADE_TIME;
        this.state = LB_FADE_LOW_TO_INACTIVE;
      } else if (lossAlarm <= GC_LOSS_DELAY_ELIMINATION) {
        this.state = LB_HIGH_ALERT;
      }
    } else if (this.state === LB_HIGH_ALERT) {
      if (!creepFreeze) {
        this.fadeTimer = LOSEBAR_FADE_TIME;
        this.state = LB_FADE_HIGH_TO_INACTIVE;
      }
    } else if (this.state === LB_FADE_RESET_HIGH) {
      if (--this.fadeTimer === 0) this.state = LB_HIGH_ALERT;
    }

    // --- bar value (LoseBar.cxx:110-117) ---
    // Divergence from the C++: it recomputes `bar` only in LOW/HIGH alert, so
    // during the reset re-flash the fill would freeze at its pre-reset value even
    // though `loss_alarm` has jumped back to the elimination floor. We include
    // LB_FADE_RESET_HIGH (a high-alert sub-state) in the update so the fill always
    // tracks the live `loss_alarm` and the timer never disagrees with reality.
    if ((this.state & (LB_LOW_ALERT | LB_HIGH_ALERT | LB_FADE_RESET_HIGH)) !== 0) {
      if ((this.state & LB_LOW_ALERT) !== 0) {
        this.bar = (GC_LOSS_DELAY - lossAlarm) / (GC_LOSS_DELAY - GC_LOSS_DELAY_ELIMINATION);
      } else {
        this.bar = (GC_LOSS_DELAY_ELIMINATION - lossAlarm) / GC_LOSS_DELAY_ELIMINATION;
      }
    }

    this.prevLossAlarm = lossAlarm;
  }

  /** Fade progress 0..1 (1 = just entered the fade). */
  private fade(): number {
    return this.fadeTimer / LOSEBAR_FADE_TIME;
  }

  /**
   * The "filled" colour (the alert side sweeping in from the left), faded per
   * state. Verbatim from the DrawExternalCandy.cxx colour switch.
   */
  color1(): Rgb {
    switch (this.state) {
      case LB_INACTIVE:
        return INACTIVE_COLOR;
      case LB_LOW_ALERT:
        return LOW_ALERT_COLOR;
      case LB_HIGH_ALERT:
        return HIGH_ALERT_COLOR;
      case LB_FADE_LOW_TO_INACTIVE:
        return lerp(INACTIVE_COLOR, LOW_ALERT_COLOR, this.fade());
      case LB_FADE_HIGH_TO_INACTIVE:
        return lerp(INACTIVE_COLOR, HIGH_ALERT_COLOR, this.fade());
      case LB_FADE_RESET_HIGH:
        return lerp(LOW_ALERT_COLOR, HIGH_ALERT_COLOR, this.fade());
      default:
        return INACTIVE_COLOR;
    }
  }

  /**
   * The "empty" colour (the lower-alert side to the right of the boundary). For
   * INACTIVE it equals color1, so the bar renders as a uniform blue tube.
   */
  color2(): Rgb {
    switch (this.state) {
      case LB_HIGH_ALERT:
        return LOW_ALERT_COLOR;
      case LB_FADE_HIGH_TO_INACTIVE:
        return lerp(INACTIVE_COLOR, LOW_ALERT_COLOR, this.fade());
      case LB_FADE_RESET_HIGH:
        return LOW_ALERT_COLOR;
      // INACTIVE / LOW_ALERT / FADE_LOW_TO_INACTIVE: empty side is inactive blue.
      default:
        return INACTIVE_COLOR;
    }
  }
}
