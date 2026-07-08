/**
 * swapper.ts
 *
 * The cursor the player swaps blocks with. Ported from `Swapper.{h,cxx}`.
 *
 * The swapper occupies two horizontally-adjacent cells (`x` = the left half).
 * Movement is rate-limited by a move-pause; a swap exchanges the two blocks
 * (either may be empty) over GC_SWAP_DELAY ticks and then registers the moved
 * blocks for elimination checks — a two-sided swap links them through a shared
 * combo so a chain formed by the swap is counted together.
 *
 * Deferred/omitted (faithful to the C++ where noted):
 *   - X-mode `reverseControls()` (X is a Phase 6 subsystem) — treated as false.
 *   - `CountDownManager::start_pause_alarm` intro-countdown gate — treated as 0
 *     (swaps always allowed); the countdown is a display/meta concern.
 *   - `swap_factor` / `color` are render-only; the client derives the swap
 *     animation from `swap_alarm` and the clock, so they are not kept here
 *     (keeps the sim state integer-only).
 *
 * Input arrives as an {@link ActionState} snapshot; the sim never reads raw keys.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  GC_INITIAL_SWAPPER_LOCATION_X,
  GC_INITIAL_SWAPPER_LOCATION_Y,
  GC_MOVE_DELAY,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
  GC_SWAP_DELAY,
} from './constants.js';
import type { Block } from './block.js';
import { SA_LEFT, SA_RIGHT } from './block.js';
import { type ActionState, CC_DOWN, CC_LEFT, CC_RIGHT, CC_UP } from './controller.js';
import { flavorMatch } from './flavors.js';
import { GR_BLOCK, GR_EMPTY, GR_FALLING, GR_HANGING, GR_IMMUTABLE } from './grid.js';
import type { ComboTabulator } from './combo.js';
import type { GridSimContext } from './grid.js';

// --- Swapper states (Swapper.h:32-39) --------------------------------------

export const SS_SWAPPING = 1 << 0;
export const SS_MOVE_PAUSE = 1 << 1;
export const SS_MOVE_UP = 1 << 2;
export const SS_MOVE_DOWN = 1 << 3;
export const SS_MOVE_LEFT = 1 << 4;
export const SS_MOVE_RIGHT = 1 << 5;
export const SS_MOVE_MASK = SS_MOVE_UP | SS_MOVE_DOWN | SS_MOVE_LEFT | SS_MOVE_RIGHT;

/** Swap "this side is blocked/illegal" flag (SA_LEFT/SA_RIGHT live in block.ts). `Swapper.h:43` */
export const SA_DISALLOWED = 1 << 2;

export class Swapper {
  /** Grid column of the swapper's left half. `Swapper.h:67` */
  x = GC_INITIAL_SWAPPER_LOCATION_X;
  /** Grid row. `Swapper.h:67` */
  y = GC_INITIAL_SWAPPER_LOCATION_Y;
  /** Swapper state (SS_*). `Swapper.h:76` */
  state = 0;
  /** Fires when a move-pause ends. `Swapper.h:70` */
  move_pause_alarm = 0;
  /** Fires when a swap completes. `Swapper.h:73` */
  swap_alarm = 0;

  /** Type of swap in progress (SA_* bits). `Swapper.h:86` */
  private swap = 0;
  private left_block: Block | null = null;
  private right_block: Block | null = null;

  // Debounce + queue so control feels crisp (mirrors the C++). `Swapper.h:93-99`
  private button_down_move = 0;
  private button_down_swap = false;
  private queued_move = 0;
  private queued_swap = false;

  /** Reset for a new game. Mirrors `Swapper::gameStart` (Swapper.cxx:52). */
  gameStart(): void {
    this.x = GC_INITIAL_SWAPPER_LOCATION_X;
    this.y = GC_INITIAL_SWAPPER_LOCATION_Y;
    this.state = 0;
    this.swap_alarm = 0;
    this.move_pause_alarm = 0;
    this.button_down_swap = false;
    this.button_down_move = 0;
    this.queued_move = 0;
    this.queued_swap = false;
    this.swap = 0;
    this.left_block = null;
    this.right_block = null;
  }

  /**
   * Move the swapper up with the rising board. Mirrors `Swapper::shiftUp`
   * (Swapper.h:50), which is a bare `y++`. We keep the cursor riding up with the
   * blocks (this is digest-relevant, so we do NOT clamp to GC_SAFE_HEIGHT - 1 as
   * the move code does), but cap at the last row whose `y + 1` neighbour is still
   * in the grid so a swap probe can't RangeError. In real play the loss mechanic
   * ends the game while the cursor is near GC_SAFE_HEIGHT, far below this cap, so
   * it never triggers — it only guards a degenerate, unterminated sim.
   */
  shiftUp(): void {
    if (this.y < GC_PLAY_HEIGHT - 2) this.y++;
  }

  /**
   * One tick of swapper logic. Mirrors `Swapper::timeStep` (Swapper.cxx:71):
   * complete an in-progress swap, then process queued/held move and swap input.
   *
   * `moveCommand()` may carry more than one direction bit if the caller sets
   * them (e.g. UP + RIGHT). The `switch` below matches only single-direction
   * values, so a combined mask produces no move — this is faithful to the C++,
   * which does the same. Choosing a single direction from simultaneous key
   * presses is the input layer's job (build the ActionState with one movement
   * bit), so the deterministic sim stays a 1:1 mirror of the reference.
   */
  timeStep(ctx: GridSimContext, actions: ActionState): void {
    const grid = ctx.grid;
    const now = ctx.clock.time_step;
    const move = actions.moveCommand();
    const swapCmd = actions.swapCommand();

    if (!move) this.button_down_move = 0;
    if (!swapCmd) this.button_down_swap = false;

    if (this.state & SS_MOVE_PAUSE) {
      if (this.move_pause_alarm === now) {
        this.state &= ~SS_MOVE_PAUSE;
      } else if (!this.button_down_swap && swapCmd) {
        if (this.queued_move) this.queued_move = 0;
        this.queued_swap = true;
        this.button_down_swap = true;
      } else if (move && this.button_down_move !== move && !this.queued_swap) {
        this.queued_move = this.button_down_move = move;
      }
    }

    if (this.state & SS_SWAPPING) {
      if (this.swap_alarm === now) {
        this.state &= ~SS_SWAPPING;

        // Vacate the swapped cells (either side may be an empty placeholder that
        // startSwapping marked GR_IMMUTABLE; reset it so finishSwapping's
        // addBlock sees an empty cell — the C++ does this only under NDEBUG-off,
        // but our accessors always enforce the empty invariant).
        if (this.swap & SA_LEFT) grid.remove(this.x, this.y, this.left_block);
        if (this.swap & SA_RIGHT) grid.remove(this.x + 1, this.y, this.right_block);
        if (!(this.swap & SA_LEFT)) grid.changeState(this.x, this.y, null, GR_EMPTY);
        if (!(this.swap & SA_RIGHT)) grid.changeState(this.x + 1, this.y, null, GR_EMPTY);

        if (this.swap & SA_LEFT) this.left_block!.finishSwapping(ctx, this.x + 1);
        if (this.swap & SA_RIGHT) this.right_block!.finishSwapping(ctx, this.x);

        // A two-sided swap links both blocks through one combo so a chain the
        // swap forms is tallied together; a one-sided swap checks independently.
        const combo: ComboTabulator | null =
          this.swap === (SA_LEFT | SA_RIGHT) ? ctx.combos.newComboTabulator() : null;
        if (this.swap & SA_LEFT) grid.requestEliminationCheck(this.left_block!, combo);
        if (this.swap & SA_RIGHT) grid.requestEliminationCheck(this.right_block!, combo);

        // Swap done: drop the block references so we don't retain stale pointers
        // into the block store for the rest of the game (they're only read while
        // SS_SWAPPING is set, which we just cleared).
        this.left_block = null;
        this.right_block = null;

        if (!this.button_down_move && move) this.queued_move = this.button_down_move = move;

        // no further commands the tick a swap completes
        return;
      }
      // (swap animation `swap_factor` is render-only and computed in the client)
    }

    if (this.state & SS_SWAPPING) {
      if (!this.button_down_move && move) this.queued_move = this.button_down_move = move;
      return;
    }

    // --- movement --------------------------------------------------------------
    if (
      !(this.state & (SS_MOVE_PAUSE | SS_SWAPPING)) &&
      (this.queued_move || (move && this.button_down_move !== move))
    ) {
      const cmd = this.queued_move ? this.queued_move : move;
      switch (cmd) {
        case CC_LEFT:
          if (this.x > 0) {
            this.x--;
            this.state = (this.state & ~SS_MOVE_MASK) | (SS_MOVE_LEFT | SS_MOVE_PAUSE);
            this.move_pause_alarm = now + GC_MOVE_DELAY;
            this.button_down_move = CC_LEFT;
          }
          break;
        case CC_RIGHT:
          if (this.x < GC_PLAY_WIDTH - 2) {
            this.x++;
            this.state = (this.state & ~SS_MOVE_MASK) | (SS_MOVE_RIGHT | SS_MOVE_PAUSE);
            this.move_pause_alarm = now + GC_MOVE_DELAY;
            this.button_down_move = CC_RIGHT;
          }
          break;
        case CC_UP:
          if (this.y < GC_SAFE_HEIGHT - 1) {
            this.y++;
            this.state = (this.state & ~SS_MOVE_MASK) | (SS_MOVE_UP | SS_MOVE_PAUSE);
            this.move_pause_alarm = now + GC_MOVE_DELAY;
            this.button_down_move = CC_UP;
          }
          break;
        case CC_DOWN:
          if (this.y > 1) {
            this.y--;
            this.state = (this.state & ~SS_MOVE_MASK) | (SS_MOVE_DOWN | SS_MOVE_PAUSE);
            this.move_pause_alarm = now + GC_MOVE_DELAY;
            this.button_down_move = CC_DOWN;
          }
          break;
      }
      this.queued_move = 0;
    }

    // --- swap initiation -------------------------------------------------------
    // CountDownManager::start_pause_alarm gate deferred (treated as 0 = allowed).
    if (
      !(this.state & (SS_MOVE_PAUSE | SS_SWAPPING)) &&
      (this.queued_swap || (swapCmd && !this.button_down_swap))
    ) {
      this.button_down_swap = true;
      this.queued_swap = false;

      this.swap = 0;
      if (grid.stateAt(this.x, this.y) & GR_BLOCK) {
        this.left_block = grid.blockAt(this.x, this.y);
        this.swap |= SA_LEFT;
      } else if (
        !(grid.stateAt(this.x, this.y) & GR_EMPTY) ||
        grid.stateAt(this.x, this.y - 1) & GR_FALLING ||
        grid.stateAt(this.x, this.y + 1) & GR_HANGING
      ) {
        this.swap |= SA_DISALLOWED;
      }

      if (grid.stateAt(this.x + 1, this.y) & GR_BLOCK) {
        this.right_block = grid.blockAt(this.x + 1, this.y);
        this.swap |= SA_RIGHT;
      } else if (
        !(grid.stateAt(this.x + 1, this.y) & GR_EMPTY) ||
        grid.stateAt(this.x + 1, this.y - 1) & GR_FALLING ||
        grid.stateAt(this.x + 1, this.y + 1) & GR_HANGING
      ) {
        this.swap |= SA_DISALLOWED;
      }

      if (!(this.swap & SA_DISALLOWED) && this.swap !== 0) {
        this.state |= SS_SWAPPING;
        this.swap_alarm = now + GC_SWAP_DELAY;

        if (this.swap & SA_LEFT) this.left_block!.startSwapping(ctx, SA_RIGHT);
        else grid.changeState(this.x, this.y, null, GR_IMMUTABLE);

        if (this.swap & SA_RIGHT) this.right_block!.startSwapping(ctx, SA_LEFT);
        else grid.changeState(this.x + 1, this.y, null, GR_IMMUTABLE);
      }
    }
  }

  /**
   * Called when a block lands at (`x`, `y`); if it lands directly on top of a
   * block that is mid-swap and matches, fold it into that swap's combo. Mirrors
   * `Swapper::notifyLanding` (Swapper.h:53).
   */
  notifyLanding(x: number, y: number, block: Block, combo: ComboTabulator): void {
    if (!(this.state & SS_SWAPPING)) return;
    if (y - 1 !== this.y) return;
    if (
      x === this.x &&
      this.swap & SA_RIGHT &&
      flavorMatch(block.flavor, this.right_block!.flavor)
    ) {
      this.right_block!.beginComboInvolvement(combo);
    } else if (
      x === this.x + 1 &&
      this.swap & SA_LEFT &&
      flavorMatch(block.flavor, this.left_block!.flavor)
    ) {
      this.left_block!.beginComboInvolvement(combo);
    }
  }
}
