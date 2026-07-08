/**
 * creep.ts
 *
 * The upward "creep" of the board and the loss condition. Ported from
 * `Creep.{h,cxx}`. Each tick the creep timer advances by a speed that ramps up
 * over time; when it accumulates a full grid's worth it raises the whole board
 * one row, spawns a fresh bottom creep row, and links an elimination check
 * across it. When the effective stack reaches the safe height the creep freezes
 * and a loss countdown runs; surviving the countdown (by eliminating back below
 * the safe height) clears the freeze, running out of it loses the game.
 *
 * Like the other subsystems this is an instance (not the C++ static singleton);
 * its per-tick environment is the injected {@link CreepSimContext}. The
 * display-only calls in the original (`LoseBar::highAlertReset`,
 * `LevelLights::notifySafeHeightViolation`) are omitted from core.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  GC_CREEP_ADVANCE_TIMER_STEP,
  GC_CREEP_ADVANCE_VELOCITY,
  GC_CREEP_DELAY,
  GC_CREEP_INCREMENT_DELAY,
  GC_CREEP_INITIAL_TIMER_STEP,
  GC_CREEP_MAX_TIMER_STEP,
  GC_CREEP_TIMER_STEP_INCREMENT,
  GC_LOSS_DELAY,
  GC_LOSS_DELAY_ELIMINATION,
  GC_PLAY_WIDTH,
  GC_STEPS_PER_GRID,
} from './constants.js';
import type { ActionState } from './controller.js';
import type { GridSimContext } from './grid.js';

/**
 * The per-tick environment Creep needs, on top of {@link GridSimContext}
 * (grid + clock + blocks + combos + awaking/dying counters). Implemented by
 * `GameSim`.
 */
export interface CreepSimContext extends GridSimContext {
  /**
   * Raise the whole board one row (grid array + block/garbage stores + swapper).
   * Mirrors the full `Grid::shiftGridUp` (Grid.cxx:339). Returns false when the
   * board can't rise (a block already occupies the top row).
   */
  shiftBoardUp(): boolean;
  /**
   * Signal a game loss: the safe-height violation outlasted the loss countdown.
   * Mirrors `Game::loss` (Game.cxx). In solo play this ends the game.
   */
  notifyLoss(): void;
}

/**
 * Board creep + loss state machine. Fields mirror `Creep` (Creep.h:35-43)
 * one-to-one, including the C++ `snake_case` names, per the port's convention.
 */
export class Creep {
  /** Sub-grid creep offset, 0..GC_STEPS_PER_GRID. `Creep.h:35` */
  creep = 0;
  /** Ticks remaining before a loss while frozen at the safe height. `Creep.h:36` */
  loss_alarm = 0;
  /** Frozen because the stack is pushing against the safe height. `Creep.h:37` */
  creep_freeze = false;

  /** Current per-tick creep speed (ramps toward GC_CREEP_MAX_TIMER_STEP). `Creep.h:40` */
  private creep_timer_step = GC_CREEP_INITIAL_TIMER_STEP;
  /**
   * Accumulated creep progress. Each tick adds `creep_timer_step`; every whole
   * `GC_CREEP_DELAY` of it advances `creep` by one sub-grid step (or
   * `GC_CREEP_ADVANCE_VELOCITY` while advancing), and a board rise happens only
   * once `creep` reaches `GC_STEPS_PER_GRID`. `Creep.h:41`
   */
  private creep_timer = 0;
  /** Tick at which the speed next increases (0 once maxed out). `Creep.h:42` */
  private increase_velocity_alarm = 0;
  /** Manual-advance latch: once advancing, keep advancing until the row lands. `Creep.h:43` */
  private advance = false;

  /**
   * Reset for a new game and spawn the first creep row. Mirrors
   * `Creep::gameStart` (Creep.cxx:52). The initial board fill happens earlier
   * (Grid::gameStart), so this owns only the first `newCreepRow`, matching the
   * C++ RNG draw order (board fill → first creep row).
   */
  gameStart(ctx: CreepSimContext): void {
    this.creep = 0;

    this.creep_timer_step = GC_CREEP_INITIAL_TIMER_STEP;
    this.creep_timer = 0;

    this.increase_velocity_alarm = ctx.clock.time_step + GC_CREEP_INCREMENT_DELAY;

    this.creep_freeze = false;
    this.advance = false;

    ctx.blocks.newCreepRow();
  }

  /**
   * One tick of creep. Faithful port of `Creep::timeStep` (Creep.cxx:68):
   * ramp the speed, handle the safe-height freeze / loss, then accumulate creep
   * and raise the board when a full grid has passed.
   */
  timeStep(ctx: CreepSimContext, actions: ActionState): void {
    const grid = ctx.grid;
    const now = ctx.clock.time_step;

    // Ramp the creep speed on schedule until it reaches the maximum.
    if (this.increase_velocity_alarm === now) {
      if (this.creep_timer_step === GC_CREEP_MAX_TIMER_STEP) {
        this.increase_velocity_alarm = 0;
      } else {
        this.increase_velocity_alarm = now + GC_CREEP_INCREMENT_DELAY;
        this.creep_timer_step += GC_CREEP_TIMER_STEP_INCREMENT;
      }
    }

    // No creeping while blocks are awaking or dying — not a true creep freeze.
    if (ctx.awaking_count !== 0 || ctx.dying_count !== 0) {
      if (this.creep_freeze) {
        // You can't lose within a short delay of your last elimination.
        if (this.loss_alarm < GC_LOSS_DELAY_ELIMINATION) {
          this.loss_alarm = GC_LOSS_DELAY_ELIMINATION;
        }
        // End the freeze if the stack dropped back below the safe height.
        if (!grid.checkSafeHeightViolation()) this.creep_freeze = false;
      }
      return;
    }

    if (this.creep_freeze) {
      // End the freeze if the stack dropped back below the safe height.
      if (!grid.checkSafeHeightViolation()) {
        this.creep_freeze = false;
      } else {
        // Still violating: tick the loss countdown; zero means game over.
        if (--this.loss_alarm === 0) ctx.notifyLoss();
        // ...and don't creep this tick.
        return;
      }
    } else if (grid.checkSafeHeightViolation()) {
      // Freeze the creep for one creep cycle and start the loss countdown.
      this.creep_freeze = true;
      this.loss_alarm = GC_LOSS_DELAY;
    }

    if (this.advance || actions.advanceCommand()) {
      this.creep_timer +=
        this.creep_timer_step < GC_CREEP_ADVANCE_TIMER_STEP
          ? GC_CREEP_ADVANCE_TIMER_STEP
          : this.creep_timer_step;
      this.advance = true;
    } else {
      this.creep_timer += this.creep_timer_step;
    }

    // Raise the board for each full grid of accumulated creep.
    while (this.creep_timer >= GC_CREEP_DELAY) {
      this.creep_timer -= GC_CREEP_DELAY;

      if (!this.advance) {
        this.creep++;
      } else {
        this.creep += GC_CREEP_ADVANCE_VELOCITY;
        if (this.creep > GC_STEPS_PER_GRID) this.creep = GC_STEPS_PER_GRID;
      }

      // A full grid of creeping: raise the board one row.
      if (this.creep === GC_STEPS_PER_GRID) {
        this.creep = 0;

        if (ctx.shiftBoardUp()) {
          // `shiftBoardUp` promoted the previous creep preview (old row 0) up to
          // row 1, where it's now live play; `newCreepRow` then refills row 0
          // with the *next* preview. We link an elimination check across row 1 —
          // the just-promoted row — not row 0: matching row 0 (still a preview,
          // not yet playable) is deliberately excluded. Faithful to
          // `Creep::timeStep` (Creep.cxx:156-161), which checks `blockAt(x, 1)`.
          ctx.blocks.newCreepRow();

          const combo = ctx.combos.newComboTabulator();
          for (let x = GC_PLAY_WIDTH; x--;) {
            grid.requestEliminationCheck(grid.blockAt(x, 1), combo);
          }
        } else {
          // Can't rise (top row occupied); hold at the brink and retry next tick.
          this.creep_timer += GC_CREEP_DELAY;
          this.creep = GC_STEPS_PER_GRID - 1;
        }

        // Drop the advance latch once the button is released.
        if (this.advance && !actions.advanceCommand()) this.advance = false;
      }
    }
  }
}
