/**
 * aiController.ts — a deterministic grid-playing AI (a real bot, not the
 * abstract `ComputerPlayer`).
 *
 * Unlike the reference's gridless `ComputerPlayer`, this drives an actual
 * `GameSim`: each tick it reads the board and the swap cursor and returns the
 * next input (`ActionState`), so its play is fully visible. It is a pure,
 * deterministic function of the sim state plus its own small plan/timer — no
 * clocks, no RNG — which is what lets a vs-AI netplay match stay in sync across
 * every client: both players and all spectators run the same controller over
 * the same (lockstep-identical) AI sim and therefore see identical moves,
 * without any AI input crossing the wire.
 *
 * Strategy (deliberately simple but functional): find a single horizontal swap
 * of two resting blocks that completes a 3-in-a-row (or 3-in-a-column), prefer
 * the lowest such swap (clear from the bottom), walk the cursor there, and swap.
 * A per-difficulty "think delay" paces it so Easy plays slowly and Hard reacts
 * almost instantly.
 */

import { ActionState, CC_DOWN, CC_LEFT, CC_RIGHT, CC_SWAP, CC_UP } from './controller.js';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { GR_BLOCK, GR_EMPTY, type Grid } from './grid.js';
import { flavorMatch } from './flavors.js';
import { SS_SWAPPING, type Swapper } from './swapper.js';

export type AiDifficultyLevel = 'easy' | 'medium' | 'hard';

interface DifficultyTuning {
  /** Ticks the bot pauses after each swap (reaction pacing). */
  readonly cooldown: number;
  /** Whether it also digs blocks into gaps when no immediate match exists. */
  readonly flatten: boolean;
}

// Note: a very short cooldown is counter-productive — the bot re-swaps before
// blocks settle and churns the board. The sweet spot for the flattening AIs is
// ~8 ticks, so Hard (best) sits there and Medium is paced a touch slower.
const TUNING: Record<AiDifficultyLevel, DifficultyTuning> = {
  easy: { cooldown: 22, flatten: false }, // slow, only reactive clears
  medium: { cooldown: 16, flatten: true },
  hard: { cooldown: 8, flatten: true }, // paced to actually keep the stack down
};

/** What the controller needs from a sim: the grid and the swap cursor. */
export interface AiSimView {
  readonly grid: Grid;
  readonly swapper: Swapper;
}

interface SwapPlan {
  x: number;
  y: number;
}

export class AiController {
  private readonly tuning: DifficultyTuning;
  /**
   * The Swapper debounces held keys (a move/swap only triggers on a *fresh*
   * press), so the bot alternates a press with a neutral "release" tick. This
   * flag says the next input must be the release.
   */
  private releaseNext = false;
  /** Ticks to wait after a swap before acting again (difficulty pacing). */
  private cooldown = 0;

  constructor(difficulty: AiDifficultyLevel) {
    this.tuning = TUNING[difficulty];
  }

  /** Reset to a clean state for a new game (mirrors the sim's gameStart). */
  reset(): void {
    this.releaseNext = false;
    this.cooldown = 0;
  }

  /**
   * The input to feed `sim.step` this tick. Deterministic in `sim`. Re-picks the
   * nearest clearing swap every action tick (rather than committing to a stale
   * plan) so the ever-rising board never leaves it walking to a target that has
   * shifted away.
   */
  decide(sim: AiSimView): ActionState {
    const { grid, swapper } = sim;

    // A press must be followed by a neutral tick so the Swapper's debounce
    // re-arms; otherwise a held key only registers once.
    if (this.releaseNext) {
      this.releaseNext = false;
      return new ActionState(0);
    }

    // Wait out an in-progress swap, and pace by difficulty after each swap.
    if ((swapper.state & SS_SWAPPING) !== 0) return new ActionState(0);
    if (this.cooldown > 0) {
      this.cooldown--;
      return new ActionState(0);
    }

    // The current nearest clearing swap (re-evaluated every action tick); if
    // none, a dig that shifts a block into a gap (harder AIs only) to flatten
    // the surface and open up new matches.
    const target =
      this.findSwap(grid, swapper.x, swapper.y) ??
      (this.tuning.flatten ? this.findFlatten(grid, swapper.x, swapper.y) : null);
    if (!target) return new ActionState(0); // nothing to do — idle

    // Walk the cursor toward it, one axis at a time, pulsing each press.
    let dir = 0;
    if (swapper.x < target.x) dir = CC_RIGHT;
    else if (swapper.x > target.x) dir = CC_LEFT;
    else if (swapper.y < target.y) dir = CC_UP;
    else if (swapper.y > target.y) dir = CC_DOWN;

    if (dir !== 0) {
      this.releaseNext = true;
      return new ActionState(dir);
    }

    // Aligned: swap, then pace by difficulty.
    this.cooldown = this.tuning.cooldown;
    this.releaseNext = true;
    return new ActionState(CC_SWAP);
  }

  /**
   * Find the nearest "dig" swap: a static block beside an empty cell it would
   * *fall* into (the cell below the empty is also empty), which lowers a peak and
   * shuffles colours around to create new matches. Returns the cursor cell, or
   * null. Only used as a fallback when no clearing swap exists.
   */
  private findFlatten(grid: Grid, cursorX: number, cursorY: number): SwapPlan | null {
    const maxRow = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
    let best: SwapPlan | null = null;
    let bestDist = Infinity;
    for (let y = 2; y <= maxRow; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH - 1; x++) {
        const leftBlock = this.swappableBlock(grid, x, y);
        const rightBlock = this.swappableBlock(grid, x + 1, y);
        const leftEmpty = (grid.stateAt(x, y) & GR_EMPTY) !== 0;
        const rightEmpty = (grid.stateAt(x + 1, y) & GR_EMPTY) !== 0;
        // Exactly one side is a movable block, the other an empty the block can
        // drop through (empty below the destination).
        const canDig =
          (leftBlock && rightEmpty && (grid.stateAt(x + 1, y - 1) & GR_EMPTY) !== 0) ||
          (rightBlock && leftEmpty && (grid.stateAt(x, y - 1) & GR_EMPTY) !== 0);
        if (!canDig) continue;
        const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /**
   * Find a horizontal swap `(x,y)↔(x+1,y)` of two resting blocks whose exchange
   * completes a 3+ run, choosing the one *closest to the cursor* (fewest moves,
   * so it lands before the creep shifts the board). Deterministic: ties broken
   * by the bottom-up, left-to-right scan order.
   */
  private findSwap(grid: Grid, cursorX: number, cursorY: number): SwapPlan | null {
    const maxRow = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
    let best: SwapPlan | null = null;
    let bestDist = Infinity;
    for (let y = 1; y <= maxRow; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH - 1; x++) {
        if (!this.swappableBlock(grid, x, y) || !this.swappableBlock(grid, x + 1, y)) continue;
        if (grid.flavorAt(x, y) === grid.flavorAt(x + 1, y)) continue; // no-op swap
        if (!this.swapMakesMatch(grid, x, y)) continue;
        const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
        if (dist < bestDist) {
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** A cell that can take part in a swap: a resting (static) block. */
  private swappableBlock(grid: Grid, x: number, y: number): boolean {
    return (grid.stateAt(x, y) & GR_BLOCK) !== 0 && grid.blockAt(x, y).isStatic();
  }

  /**
   * Whether swapping `(x,y)↔(x+1,y)` completes a 3+ run in the row or in either
   * touched column. Evaluated against the *post-swap* flavors (the two cells
   * exchange; every other cell is read from the grid).
   */
  private swapMakesMatch(grid: Grid, x: number, y: number): boolean {
    const fa = grid.flavorAt(x, y);
    const fb = grid.flavorAt(x + 1, y);

    // Post-swap flavor at a cell, or null if it can't be part of a match.
    const at = (cx: number, cy: number): number | null => {
      if (cy === y && cx === x) return fb;
      if (cy === y && cx === x + 1) return fa;
      if ((grid.stateAt(cx, cy) & GR_BLOCK) === 0) return null;
      if (!grid.blockAt(cx, cy).isStatic()) return null;
      return grid.flavorAt(cx, cy);
    };

    // Each swapped cell anchors a horizontal run (its row) and a vertical run
    // (its column). Any 3+ run means the swap eliminates.
    for (const [ax, f] of [
      [x, fb],
      [x + 1, fa],
    ] as const) {
      let run = 1;
      for (let cx = ax - 1; cx >= 0; cx--) {
        const g = at(cx, y);
        if (g === null || !flavorMatch(g, f)) break;
        run++;
      }
      for (let cx = ax + 1; cx < GC_PLAY_WIDTH; cx++) {
        const g = at(cx, y);
        if (g === null || !flavorMatch(g, f)) break;
        run++;
      }
      if (run >= 3) return true;

      run = 1;
      for (let cy = y - 1; cy >= 1; cy--) {
        const g = at(ax, cy);
        if (g === null || !flavorMatch(g, f)) break;
        run++;
      }
      for (let cy = y + 1; cy < GC_PLAY_HEIGHT; cy++) {
        const g = at(ax, cy);
        if (g === null || !flavorMatch(g, f)) break;
        run++;
      }
      if (run >= 3) return true;
    }
    return false;
  }
}
