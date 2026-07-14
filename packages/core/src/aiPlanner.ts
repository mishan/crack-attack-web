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
import { flavorMatch, mapFlavorToBaseFlavor } from './flavors.js';

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

/** The next step of a multi-swap garbage-shattering setup. */
export interface SetupPlan {
  /** The next lateral swap to make: `(x,y)`↔`(x+1,y)`, in plan coordinates. */
  x: number;
  y: number;
  /** Lateral swaps the full plan still needs from here (≥ 1). */
  cost: number;
}

/** Whether `(x,y)` is 4-adjacent to a garbage cell. */
function cellTouchesGarbage(b: PlanBoard, x: number, y: number): boolean {
  return (
    (y + 1 < b.height && at(b, x, y + 1) === PLAN_GARBAGE) ||
    (y > 0 && at(b, x, y - 1) === PLAN_GARBAGE) ||
    (x + 1 < b.width && at(b, x + 1, y) === PLAN_GARBAGE) ||
    (x > 0 && at(b, x - 1, y) === PLAN_GARBAGE)
  );
}

/** The maximal contiguous run of blocks in row `y` containing `x`, or null. */
function segmentAround(b: PlanBoard, x: number, y: number): readonly [number, number] | null {
  if (!isBlock(b, x, y)) return null;
  let s = x;
  while (s > 0 && isBlock(b, s - 1, y)) s--;
  let e = x;
  while (e + 1 < b.width && isBlock(b, e + 1, y)) e++;
  return [s, e];
}

/**
 * Per base flavour, the nearest source to `x` within row `y`'s segment around
 * `x`: base flavour → `[distance, position]` (nearest position wins; leftmost
 * on ties, from the ascending scan).
 */
function nearestByFlavor(b: PlanBoard, x: number, y: number): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const seg = segmentAround(b, x, y);
  if (!seg) return out;
  for (let p = seg[0]; p <= seg[1]; p++) {
    const base = mapFlavorToBaseFlavor(at(b, p, y));
    const d = Math.abs(p - x);
    const cur = out.get(base);
    if (!cur || d < cur[0]) out.set(base, [d, p]);
  }
  return out;
}

/** A winning candidate: how to assemble a 3-run in a garbage-adjacent window. */
type SetupCandidate =
  | { kind: 'h'; y: number; x0: number; sources: readonly [number, number, number] }
  | { kind: 'v'; x: number; y0: number; positions: readonly [number, number, number] };

/**
 * planShatterSetup — goal-directed defensive planning: when no *single* swap
 * shatters garbage, find the cheapest **sequence of lateral swaps** that
 * assembles a 3-run of one colour in a window 4-adjacent to a garbage slab
 * (under it, on top of it, or beside it) — the moves a human makes when buried.
 *
 * Two window orientations are searched:
 *  - **horizontal**: 3 adjacent cells in one row, filled by shuttling three
 *    same-colour blocks along that row's contiguous block segment;
 *  - **vertical**: 3 stacked cells in one column, each row supplying one
 *    same-colour block laterally from its own segment (the classic "stack a
 *    colour against the slab" technique — much more often available, since a
 *    row only needs *one* matching block rather than three).
 *
 * Only block↔block swaps inside fully-occupied row segments are considered:
 * those never change column occupancy, so they are gravity-neutral — the plan
 * cannot destabilise the stack, and re-planning every action tick converges
 * (each executed swap reduces the remaining cost by exactly 1 while the board
 * is otherwise still, so the best plan's cost strictly decreases; a rising or
 * settling board simply re-plans). The final run-completing swap needs no
 * special case: once a plan is one swap from done, the strategic planner's
 * fire branch sees a swap whose cascade shatters garbage and takes it.
 *
 * Colours group by base flavour ({@link mapFlavorToBaseFlavor}), matching the
 * elimination rules. Horizontal windows take the cheapest order-preserving
 * assignment of three sources to the window slots (brute force; segments are
 * ≤ 6 wide, so ≤ 20 subsets); vertical windows take each row's nearest source.
 * The next move is chosen so it can never swap two matching blocks (for
 * horizontal, a matching neighbour would have been a strictly cheaper source
 * of the *minimal* subset; for vertical, the cell between the nearest source
 * and the target would have been nearer), so execution always makes progress.
 * A cost-0 window is an already-standing match the sim is about to clear —
 * skipped, so the planner never plans around transient states.
 *
 * Deterministic: candidates scan bottom-up / left-to-right (horizontal rows
 * first) and ties keep the first find, so lower windows win. Returns the next
 * swap plus remaining cost, or null if no plan costs ≤ maxCost.
 */
export function planShatterSetup(board: PlanBoard, maxCost: number): SetupPlan | null {
  let bestCost = maxCost + 1;
  let best: SetupCandidate | null = null;

  // --- Horizontal windows, rows bottom-up. ---
  for (let y = 0; y < board.height; y++) {
    for (let segStart = 0; segStart < board.width; segStart++) {
      if (!isBlock(board, segStart, y)) continue;
      let segEnd = segStart;
      while (segEnd + 1 < board.width && isBlock(board, segEnd + 1, y)) segEnd++;

      if (segEnd - segStart >= 2) {
        // Source positions per base flavour within the segment (ascending x).
        const groups = new Map<number, number[]>();
        for (let x = segStart; x <= segEnd; x++) {
          const base = mapFlavorToBaseFlavor(at(board, x, y));
          const g = groups.get(base);
          if (g) g.push(x);
          else groups.set(base, [x]);
        }
        for (let x0 = segStart; x0 <= segEnd - 2; x0++) {
          if (
            !cellTouchesGarbage(board, x0, y) &&
            !cellTouchesGarbage(board, x0 + 1, y) &&
            !cellTouchesGarbage(board, x0 + 2, y)
          ) {
            continue;
          }
          for (const sources of groups.values()) {
            if (sources.length < 3) continue;
            // Cheapest order-preserving assignment of any 3 sources to the
            // window slots x0..x0+2. The *minimal* subset must be taken — the
            // progress guarantee (no matching-blocks swap) relies on it.
            let wfCost = Infinity;
            let wfSources: readonly [number, number, number] | null = null;
            for (let i = 0; i < sources.length - 2; i++) {
              for (let j = i + 1; j < sources.length - 1; j++) {
                for (let k = j + 1; k < sources.length; k++) {
                  const cost =
                    Math.abs(sources[i]! - x0) +
                    Math.abs(sources[j]! - (x0 + 1)) +
                    Math.abs(sources[k]! - (x0 + 2));
                  if (cost < wfCost) {
                    wfCost = cost;
                    wfSources = [sources[i]!, sources[j]!, sources[k]!];
                  }
                }
              }
            }
            if (wfCost === 0 || wfCost >= bestCost || !wfSources) continue;
            bestCost = wfCost;
            best = { kind: 'h', y, x0, sources: wfSources };
          }
        }
      }
      segStart = segEnd; // the for-loop ++ steps past the segment
    }
  }

  // --- Vertical windows, columns left-to-right, bottom-up. ---
  for (let x = 0; x < board.width; x++) {
    for (let y0 = 0; y0 + 2 < board.height; y0++) {
      if (!isBlock(board, x, y0) || !isBlock(board, x, y0 + 1) || !isBlock(board, x, y0 + 2)) {
        continue;
      }
      if (
        !cellTouchesGarbage(board, x, y0) &&
        !cellTouchesGarbage(board, x, y0 + 1) &&
        !cellTouchesGarbage(board, x, y0 + 2)
      ) {
        continue;
      }
      // Each row supplies its nearest block of the candidate colour laterally.
      const rows = [
        nearestByFlavor(board, x, y0),
        nearestByFlavor(board, x, y0 + 1),
        nearestByFlavor(board, x, y0 + 2),
      ] as const;
      for (const [base, [d0, p0]] of rows[0]) {
        const r1 = rows[1].get(base);
        const r2 = rows[2].get(base);
        if (!r1 || !r2) continue;
        const cost = d0 + r1[0] + r2[0];
        if (cost === 0 || cost >= bestCost) continue; // standing match / not better
        bestCost = cost;
        best = { kind: 'v', x, y0, positions: [p0, r1[1], r2[1]] };
      }
    }
  }

  if (!best) return null;
  if (best.kind === 'h') {
    const slots = [best.x0, best.x0 + 1, best.x0 + 2] as const;
    // Rightmost source that must move right, else leftmost that must move left.
    for (let i = 2; i >= 0; i--) {
      if (best.sources[i]! < slots[i]!) return { x: best.sources[i]!, y: best.y, cost: bestCost };
    }
    for (let i = 0; i < 3; i++) {
      if (best.sources[i]! > slots[i]!) {
        return { x: best.sources[i]! - 1, y: best.y, cost: bestCost };
      }
    }
    /* v8 ignore next 2 -- cost > 0 implies some source is out of place */
    return null;
  }
  // Vertical: the lowest row whose source is out of place steps toward x.
  for (let i = 0; i < 3; i++) {
    const p = best.positions[i]!;
    if (p < best.x) return { x: p, y: best.y0 + i, cost: bestCost };
    if (p > best.x) return { x: p - 1, y: best.y0 + i, cost: bestCost };
  }
  /* v8 ignore next 2 -- cost > 0 implies some source is out of place */
  return null;
}

/**
 * planUndermine — the defensive fallback when no shatter setup exists at all:
 * garbage is often perched on a narrow tower of blocks (it lands on the tallest
 * column), where no row has the width to assemble a match. The human technique
 * is to *dismantle the tower*: dig its load-bearing blocks sideways into the
 * neighbouring gap so they fall away and the slab descends, row by row, onto
 * the wider stack — where {@link planShatterSetup} takes over.
 *
 * A candidate is a dig swap (a block moved into a laterally-adjacent empty
 * cell it can fall through, exactly {@link AiController.findFlatten}'s rule)
 * whose block is **load-bearing under garbage**: the cells above it in its
 * column are contiguous blocks capped by a garbage cell. Every such dig
 * strictly lowers the total potential energy of the stack, so repeated
 * undermining always terminates (the slab keeps descending). Nearest to the
 * cursor wins; scan order (bottom-up, left-to-right) breaks ties. Returns the
 * swap in plan coordinates, or null.
 */
export function planUndermine(
  board: PlanBoard,
  cursorX: number,
  cursorY: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  const empty = (x: number, y: number): boolean => at(board, x, y) === PLAN_EMPTY;
  const supportsGarbage = (x: number, y: number): boolean => {
    for (let yy = y + 1; yy < board.height; yy++) {
      const v = at(board, x, yy);
      if (v === PLAN_GARBAGE) return true;
      if (v < 0) return false; // a gap — nothing above rests on this block
    }
    return false;
  };
  for (let y = 1; y < board.height; y++) {
    for (let x = 0; x < board.width - 1; x++) {
      // Exactly one side is a load-bearing block, the other an empty the block
      // can drop through (empty below the destination).
      const digRight =
        isBlock(board, x, y) && empty(x + 1, y) && empty(x + 1, y - 1) && supportsGarbage(x, y);
      const digLeft =
        isBlock(board, x + 1, y) && empty(x, y) && empty(x, y - 1) && supportsGarbage(x + 1, y);
      if (!digRight && !digLeft) continue;
      const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x, y };
      }
    }
  }
  return best;
}
