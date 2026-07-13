/**
 * aiPlanner.ts — a pure look-ahead evaluator for the strategic AI tier.
 *
 * The greedy matcher only ever executes a 3-in-a-row that's one swap away — but
 * a plain 3-match sends *no garbage* (GarbageGenerator: normal garbage needs
 * magnitude > GC_MIN_PATTERN_LENGTH = 3, and chain garbage needs multiplier > 1).
 * To actually attack, the bot must build **4+ combos** (width garbage) and,
 * above all, **chains** — each chain link ships a full-width garbage row
 * (`comboComplete` sends `multiplier - 1` full rows).
 *
 * This module evaluates a candidate swap by simulating its *logical cascade* on
 * a lightweight copy of the static-block grid: apply the swap, settle gravity,
 * remove any 3+ runs (shattering adjacent garbage), and repeat — counting the
 * chain depth (≈ the sim's multiplier), the blocks cleared (≈ magnitude), and
 * the garbage shattered. It is a pure, deterministic function of the board (no
 * RNG, no timing), cheap enough to run over every candidate each decision. It
 * deliberately approximates: shattered garbage is removed rather than converted
 * to blocks, and timing windows are ignored — so it *guides* the planner toward
 * combo/chain setups; the real sim is authoritative for what actually fires.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { GR_BLOCK, GR_GARBAGE, type Grid } from './grid.js';
import { flavorMatch } from './flavors.js';

/** Logical cell codes (non-negative values are block flavours). */
export const PLAN_EMPTY = -1;
export const PLAN_GARBAGE = -2;

/** A lightweight, mutable copy of the board for cascade simulation. */
export interface PlanBoard {
  /** Column-major cells: `cell[x * height + y]`, y = 0 at the bottom playable row. */
  cell: Int16Array;
  width: number;
  height: number;
}

/** The outcome of simulating one candidate swap's cascade. */
export interface Cascade {
  /** Match rounds triggered (≈ combo multiplier; round 1 isn't a chain link). */
  chainDepth: number;
  /** Total blocks eliminated across all rounds (≈ combo magnitude). */
  totalCleared: number;
  /** Largest single round's elimination (drives width garbage). */
  maxRound: number;
  /** Garbage cells shattered. */
  garbageShattered: number;
}

/**
 * Snapshot the static-block grid into a {@link PlanBoard}. Non-static (falling/
 * dying) cells read as empty — they aren't stable to plan around. Rows are read
 * from grid row 1 (bottom playable) up to the top of the stack (+1 headroom).
 */
export function readPlanBoard(grid: Grid): PlanBoard {
  const width = GC_PLAY_WIDTH;
  const height = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
  const cell = new Int16Array(width * height).fill(PLAN_EMPTY);
  for (let y = 0; y < height; y++) {
    const gy = y + 1; // grid rows are 1-based (row 0 is the incoming creep)
    for (let x = 0; x < width; x++) {
      const state = grid.stateAt(x, gy);
      if ((state & GR_GARBAGE) !== 0) cell[x * height + y] = PLAN_GARBAGE;
      else if ((state & GR_BLOCK) !== 0 && grid.blockAt(x, gy).isStatic())
        cell[x * height + y] = grid.flavorAt(x, gy);
    }
  }
  return { cell, width, height };
}

const at = (b: PlanBoard, x: number, y: number): number => b.cell[x * b.height + y]!;
const set = (b: PlanBoard, x: number, y: number, v: number): void => {
  b.cell[x * b.height + y] = v;
};

/** Whether `(x,y)` holds a static block (a non-negative flavour). */
const isBlock = (b: PlanBoard, x: number, y: number): boolean => at(b, x, y) >= 0;

/**
 * Whether the two horizontally-adjacent cells `(x,y)`/`(x+1,y)` can be swapped:
 * neither is garbage, and at least one is a block (a block↔empty move counts;
 * empty↔empty and same-flavour swaps are no-ops the caller filters).
 */
export function canSwap(b: PlanBoard, x: number, y: number): boolean {
  const a = at(b, x, y);
  const c = at(b, x + 1, y);
  if (a === PLAN_GARBAGE || c === PLAN_GARBAGE) return false;
  return a >= 0 || c >= 0;
}

/** Settle every block straight down onto the floor / garbage / the block below. */
function applyGravity(b: PlanBoard): void {
  for (let x = 0; x < b.width; x++) {
    // `write` is the next free row from the bottom of the current segment.
    // Garbage is fixed (blocks rest on it), so it resets the segment.
    let write = 0;
    for (let y = 0; y < b.height; y++) {
      const v = at(b, x, y);
      if (v === PLAN_GARBAGE) {
        write = y + 1; // blocks above land on top of the garbage
      } else if (v >= 0) {
        if (write !== y) {
          set(b, x, write, v);
          set(b, x, y, PLAN_EMPTY);
        }
        write++;
      }
      // empty cells are skipped; their slot is reused by a falling block above
    }
  }
}

/**
 * Find every cell in a 3+ run (horizontal or vertical) of matching flavours.
 * Returns the marked cells (as `x*height+y` indices) and the largest single run.
 */
function findMatches(b: PlanBoard): { marked: Set<number>; largest: number } {
  const marked = new Set<number>();
  let largest = 0;
  // Horizontal runs.
  for (let y = 0; y < b.height; y++) {
    let run = 1;
    for (let x = 1; x <= b.width; x++) {
      const same =
        x < b.width &&
        isBlock(b, x, y) &&
        isBlock(b, x - 1, y) &&
        flavorMatch(at(b, x, y), at(b, x - 1, y));
      if (same) {
        run++;
      } else {
        if (run >= 3) {
          largest = Math.max(largest, run);
          for (let k = x - run; k < x; k++) marked.add(k * b.height + y);
        }
        run = 1;
      }
    }
  }
  // Vertical runs.
  for (let x = 0; x < b.width; x++) {
    let run = 1;
    for (let y = 1; y <= b.height; y++) {
      const same =
        y < b.height &&
        isBlock(b, x, y) &&
        isBlock(b, x, y - 1) &&
        flavorMatch(at(b, x, y), at(b, x, y - 1));
      if (same) {
        run++;
      } else {
        if (run >= 3) {
          largest = Math.max(largest, run);
          for (let k = y - run; k < y; k++) marked.add(x * b.height + k);
        }
        run = 1;
      }
    }
  }
  return { marked, largest };
}

/** Remove garbage cells 4-adjacent to any matched cell; return how many. */
function shatterAdjacent(b: PlanBoard, marked: Set<number>): number {
  const toClear: number[] = [];
  for (let x = 0; x < b.width; x++) {
    for (let y = 0; y < b.height; y++) {
      if (at(b, x, y) !== PLAN_GARBAGE) continue;
      const touches =
        (x > 0 && marked.has((x - 1) * b.height + y)) ||
        (x + 1 < b.width && marked.has((x + 1) * b.height + y)) ||
        (y > 0 && marked.has(x * b.height + (y - 1))) ||
        (y + 1 < b.height && marked.has(x * b.height + (y + 1)));
      if (touches) toClear.push(x * b.height + y);
    }
  }
  for (const idx of toClear) b.cell[idx] = PLAN_EMPTY;
  return toClear.length;
}

/**
 * Simulate the cascade after swapping `(x,y)`↔`(x+1,y)` on a copy of `board`.
 * Returns the chain depth, blocks cleared, largest round, and garbage shattered.
 * A swap that triggers nothing returns an all-zero cascade.
 */
export function evaluateSwap(board: PlanBoard, x: number, y: number): Cascade {
  const b: PlanBoard = { cell: board.cell.slice(), width: board.width, height: board.height };
  // Apply the swap.
  const tmp = at(b, x, y);
  set(b, x, y, at(b, x + 1, y));
  set(b, x + 1, y, tmp);

  const result: Cascade = { chainDepth: 0, totalCleared: 0, maxRound: 0, garbageShattered: 0 };
  for (;;) {
    applyGravity(b);
    const { marked, largest } = findMatches(b);
    if (marked.size === 0) break;
    result.chainDepth++;
    result.totalCleared += marked.size;
    result.maxRound = Math.max(result.maxRound, largest);
    result.garbageShattered += shatterAdjacent(b, marked);
    for (const idx of marked) b.cell[idx] = PLAN_EMPTY;
  }
  return result;
}

/**
 * Attack value of a cascade, in units of "garbage rows sent", per the generator:
 * each chain link past the first ships a full-width row (`multiplier - 1`), and a
 * combo whose total exceeds 3 ships width garbage (~`total - 3` cells ≈ fraction
 * of a row). Chains dominate, exactly as in real play.
 */
export function attackValue(c: Cascade): number {
  const chainRows = Math.max(0, c.chainDepth - 1);
  const widthCells = Math.max(0, c.totalCleared - 3);
  return chainRows * GC_PLAY_WIDTH + widthCells;
}
