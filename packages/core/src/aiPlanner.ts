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

import { BS_FALLING } from './block.js';
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

/**
 * Snapshot used while blocks are in their hang/fall window. Unlike
 * {@link readPlanBoard}, this includes falling blocks at their current grid
 * cells; the cascade evaluator then settles them after any candidate swap.
 * Dying blocks are omitted because they will pop before gravity settles;
 * awaking/swapping blocks remain absent because their eventual contents cannot
 * be inferred safely from the grid alone.
 *
 * The extra height follows `top_occupied_row`, not `top_effective_row`, because
 * a falling resident may currently sit above the resting stack.
 */
export function readGravityPlanBoard(grid: Grid): PlanBoard {
  const width = GC_PLAY_WIDTH;
  const top = Math.max(grid.top_occupied_row, grid.top_effective_row);
  const height = Math.min(top + 1, GC_PLAY_HEIGHT - 1);
  const cell = new Int16Array(width * height).fill(PLAN_EMPTY);
  for (let y = 0; y < height; y++) {
    const gy = y + 1;
    for (let x = 0; x < width; x++) {
      const resident = grid.residentTypeAt(x, gy);
      if ((resident & GR_GARBAGE) !== 0) {
        cell[x * height + y] = PLAN_GARBAGE;
      } else if ((resident & GR_BLOCK) !== 0) {
        const block = grid.blockAt(x, gy);
        if (block.isStatic() || (block.state & BS_FALLING) !== 0) {
          cell[x * height + y] = block.flavor;
        }
      }
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
function evaluateCascade(b: PlanBoard): Cascade {
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

/** Settle the board without a swap and report the cascade gravity alone creates. */
export function evaluateGravity(board: PlanBoard): Cascade {
  return evaluateCascade({ cell: board.cell.slice(), width: board.width, height: board.height });
}

export function evaluateSwap(board: PlanBoard, x: number, y: number): Cascade {
  const b: PlanBoard = { cell: board.cell.slice(), width: board.width, height: board.height };
  // Apply the swap.
  const tmp = at(b, x, y);
  set(b, x, y, at(b, x + 1, y));
  set(b, x + 1, y, tmp);
  return evaluateCascade(b);
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

/** The next step toward a crossed-column combo worth 2×height blocks. */
export interface BigComboSetupPlan extends SetupPlan {
  /** Blocks the finished trigger clears (8 for four rows, 10 for five). */
  size: number;
}

/** A deterministic pseudo-random rank used only to break equal planner choices. */
function seededRank(seed: number | undefined, ...words: number[]): number {
  if (seed === undefined) return 0;
  let h = seed >>> 0;
  for (const word of words) {
    h ^= Math.imul((word + 1) | 0, 0x9e3779b1);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
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
 * Minimum adjacent swaps needed to put `leftFlavor,rightFlavor` at `(x,x+1)`
 * in one fully occupied row segment. The rest of the row may end in any order.
 */
function rowPairCost(
  board: PlanBoard,
  x: number,
  y: number,
  leftFlavor: number,
  rightFlavor: number,
): number {
  const seg = segmentAround(board, x, y);
  if (!seg || x + 1 > seg[1]) return Infinity;
  let best = Infinity;
  for (let left = seg[0]; left <= seg[1]; left++) {
    if (mapFlavorToBaseFlavor(at(board, left, y)) !== leftFlavor) continue;
    for (let right = seg[0]; right <= seg[1]; right++) {
      if (mapFlavorToBaseFlavor(at(board, right, y)) !== rightFlavor) continue;
      // If the sources are reversed, the one adjacent swap where they cross
      // moves both into place, so the two individual distances double-count it.
      const cost = Math.abs(left - x) + Math.abs(right - (x + 1)) - (left > right ? 1 : 0);
      if (cost < best) best = cost;
    }
  }
  return best;
}

interface BigComboCandidate {
  x: number;
  y0: number;
  height: number;
  leftFlavor: number;
  rightFlavor: number;
  cost: number;
}

/** Remaining lateral-swap cost for one crossed-column target. */
function bigComboCost(board: PlanBoard, candidate: Omit<BigComboCandidate, 'cost'>): number {
  const triggerRow = Math.floor(candidate.height / 2);
  let cost = 0;
  for (let row = 0; row < candidate.height; row++) {
    const crossed = row === triggerRow;
    const rowCost = rowPairCost(
      board,
      candidate.x,
      candidate.y0 + row,
      crossed ? candidate.rightFlavor : candidate.leftFlavor,
      crossed ? candidate.leftFlavor : candidate.rightFlavor,
    );
    if (!Number.isFinite(rowCost)) return Infinity;
    cost += rowCost;
  }
  return cost;
}

/** Find a non-clearing adjacent swap that reduces a crossed-column plan by one step. */
function nextBigComboSwap(
  board: PlanBoard,
  candidate: BigComboCandidate,
  tieSeed: number | undefined,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestRank = 0;
  const scratch: PlanBoard = { cell: board.cell.slice(), width: board.width, height: board.height };
  for (let y = candidate.y0; y < candidate.y0 + candidate.height; y++) {
    for (let x = 0; x < board.width - 1; x++) {
      const a = at(board, x, y);
      const c = at(board, x + 1, y);
      if (a < 0 || c < 0 || mapFlavorToBaseFlavor(a) === mapFlavorToBaseFlavor(c)) continue;
      // Setup moves must not accidentally fire a smaller clear and destroy the
      // construction. The final crossed-row trigger belongs to the fire branch.
      if (makesRun3(board, x, y)) continue;
      scratch.cell.set(board.cell);
      set(scratch, x, y, c);
      set(scratch, x + 1, y, a);
      if (bigComboCost(scratch, candidate) !== candidate.cost - 1) continue;
      const rank = seededRank(tieSeed, 0x424947, x, y);
      if (!best || (tieSeed !== undefined && rank > bestRank)) {
        best = { x, y };
        bestRank = rank;
      }
    }
  }
  return best;
}

/**
 * Build the human crossed-column combo: two adjacent columns of different
 * colours, four or five blocks tall, with their centre pair crossed. Swapping
 * that pair completes both columns at once for an x8 or x10 clear.
 *
 * Setup moves are lateral block↔block swaps inside occupied rows, so gravity
 * cannot invalidate the target. Every returned move reduces the exact adjacent-
 * swap cost by one and completes no match itself; once the construction is
 * ready, the normal fire search sees and executes the centre trigger. Five-row
 * x10 targets outrank four-row x8 targets, then lower cost wins. A seeded rank
 * breaks otherwise equal targets without changing reproducibility.
 */
export function planBigComboSetup(
  board: PlanBoard,
  maxCost: number,
  tieSeed?: number,
): BigComboSetupPlan | null {
  const flavors = [
    ...new Set([...board.cell].filter((v) => v >= 0).map(mapFlavorToBaseFlavor)),
  ].sort((a, b) => a - b);
  let best: (BigComboCandidate & { next: { x: number; y: number }; rank: number }) | null = null;
  const maxHeight = Math.min(5, board.height);
  for (let height = maxHeight; height >= 4; height--) {
    for (let y0 = 0; y0 + height <= board.height; y0++) {
      for (let x = 0; x < board.width - 1; x++) {
        for (const leftFlavor of flavors) {
          for (const rightFlavor of flavors) {
            if (leftFlavor === rightFlavor) continue;
            const base = { x, y0, height, leftFlavor, rightFlavor };
            const cost = bigComboCost(board, base);
            if (cost <= 0 || cost > maxCost) continue;
            const candidate: BigComboCandidate = { ...base, cost };
            const next = nextBigComboSwap(board, candidate, tieSeed);
            if (!next) continue;
            const rank = seededRank(tieSeed, 0x583130, x, y0, leftFlavor, rightFlavor);
            if (
              !best ||
              height > best.height ||
              (height === best.height && cost < best.cost) ||
              (height === best.height &&
                cost === best.cost &&
                tieSeed !== undefined &&
                rank > best.rank)
            ) {
              best = { ...candidate, next, rank };
            }
          }
        }
      }
    }
  }
  return best ? { ...best.next, cost: best.cost, size: best.height * 2 } : null;
}

/**
 * Whether swapping `(x,y)`↔`(x+1,y)` immediately completes a 3+ run, checked
 * statically against post-swap flavours (base-flavour matching). On a settled
 * board (which a `readPlanBoard` snapshot always is, and which gravity-neutral
 * setup swaps preserve) this is **exact** for a cascade's first round when the
 * swap doesn't drop a block — so it serves as a cheap prefilter that lets the
 * full {@link evaluateSwap} run only on genuine trigger candidates.
 */
function makesRun3(b: PlanBoard, x: number, y: number): boolean {
  const va = at(b, x, y);
  const vb = at(b, x + 1, y);
  // Post-swap value at a cell (the two swapped cells exchange).
  const val = (cx: number, cy: number): number => {
    if (cy === y && cx === x) return vb;
    if (cy === y && cx === x + 1) return va;
    return at(b, cx, cy);
  };
  const matches = (v: number, base: number): boolean => v >= 0 && mapFlavorToBaseFlavor(v) === base;

  for (const [ax, v] of [
    [x, vb],
    [x + 1, va],
  ] as const) {
    if (v < 0) continue; // the cell became empty — anchors nothing
    const base = mapFlavorToBaseFlavor(v);
    let run = 1;
    for (let cx = ax - 1; cx >= 0 && matches(val(cx, y), base); cx--) run++;
    for (let cx = ax + 1; cx < b.width && matches(val(cx, y), base); cx++) run++;
    if (run >= 3) return true;
    run = 1;
    for (let cy = y - 1; cy >= 0 && matches(val(ax, cy), base); cy--) run++;
    for (let cy = y + 1; cy < b.height && matches(val(ax, cy), base); cy++) run++;
    if (run >= 3) return true;
  }
  return false;
}

/** What a chain-enabling setup swap buys: the swap plus the enabled payoff. */
export interface ChainSetupPlan {
  /** The setup swap `(x,y)`↔`(x+1,y)`, in plan coordinates. */
  x: number;
  y: number;
  /** Score of the best cascade this setup enables (attackValue + shatter bonus). */
  score: number;
}

/**
 * planChainSetup — the offensive counterpart of {@link planShatterSetup}: a
 * bounded two-ply search for one **setup swap** that fires nothing itself but
 * *enables* a worth-firing cascade one swap later. This is how chains are
 * *built* rather than merely noticed: arrange the board so that a single
 * trigger swap starts a cascade whose falls feed further matches.
 *
 * Setup swaps are lateral block↔block exchanges (gravity-neutral, so the board
 * stays settled and plans survive re-planning) that complete no run of their
 * own — a swap that clears is a clear, owned by the fire/survival branches.
 * For each candidate setup, trigger swaps are scanned with the static
 * {@link makesRun3} prefilter (exact on a settled board); a block dropped into
 * a fall-through gap can also trigger via gravity, so those few candidates get
 * the full cascade evaluation directly. An enabled cascade counts when it
 * meets the caller's fire thresholds (chain depth / run length) — the same
 * bar the fire branch uses, so the enabled trigger is guaranteed to be taken
 * on a later action tick once the setup lands.
 *
 * Incremental depth for free: after the setup executes, re-planning either
 * fires the enabled trigger or discovers a *further* enabler — so multi-swap
 * constructions emerge from repeated one-swap planning without a deeper
 * search. With `opts.lookahead`, a **second level** kicks in only when no
 * single enabler exists (~87% of bank positions, measured): scan setup swaps
 * whose result *contains* a single enabler — a three-swap construction
 * (setup → setup → trigger). The same monotone ladder guarantees progress:
 * a 2-level plan becomes a 1-level plan after its first swap, then a fire.
 * Deterministic: best score wins; an optional seed ranks ties without drawing
 * gameplay RNG. Pure function of the board and options, with no timing.
 */
export function planChainSetup(
  board: PlanBoard,
  opts: {
    minChain: number;
    minRun: number;
    shatterWeight: number;
    lookahead?: boolean;
    tieSeed?: number;
  },
): ChainSetupPlan | null {
  const direct = searchEnabler(board, opts);
  if (direct || !opts.lookahead) return direct;

  // No single enabler exists: look one level deeper. The candidate move is a
  // setup swap after which a single enabler *does* exist; it inherits that
  // enabler's eventual score. Only runs in enabler-less positions, and the
  // run3 prefilter keeps the inner searches cheap.
  let best: ChainSetupPlan | null = null;
  let bestRank = 0;
  const b2: PlanBoard = { cell: board.cell.slice(), width: board.width, height: board.height };
  for (let sy = 0; sy < board.height; sy++) {
    for (let sx = 0; sx < board.width - 1; sx++) {
      const a = at(board, sx, sy);
      const c = at(board, sx + 1, sy);
      if (a < 0 || c < 0) continue; // setups are block↔block only
      if (mapFlavorToBaseFlavor(a) === mapFlavorToBaseFlavor(c)) continue; // no-op
      if (makesRun3(board, sx, sy)) continue; // that's a clear, not a setup
      b2.cell.set(board.cell);
      b2.cell[sx * b2.height + sy] = c;
      b2.cell[(sx + 1) * b2.height + sy] = a;
      const enabled = searchEnabler(b2, opts);
      const rank = seededRank(opts.tieSeed, 0x4c4f4f4b, sx, sy);
      if (
        enabled &&
        (!best ||
          enabled.score > best.score ||
          (enabled.score === best.score && opts.tieSeed !== undefined && rank > bestRank))
      ) {
        best = { x: sx, y: sy, score: enabled.score };
        bestRank = rank;
      }
    }
  }
  return best;
}

/**
 * FNV-1a hash of a plan board's contents. Two boards with equal hash are (for
 * all practical purposes) identical, so a controller can cache board-pure plan
 * results across ticks while the cursor walks — recomputing only when the
 * board actually changes. Any collision would be deterministic too (same
 * boards, same hash, on every client), so lockstep safety is unaffected.
 */
export function hashPlanBoard(b: PlanBoard): number {
  let h = 0x811c9dc5;
  h = Math.imul(h ^ b.width, 0x01000193);
  h = Math.imul(h ^ b.height, 0x01000193);
  for (let i = 0; i < b.cell.length; i++) {
    h = Math.imul(h ^ (b.cell[i]! & 0xffff), 0x01000193);
  }
  return h >>> 0;
}

/** The single-enabler search behind {@link planChainSetup} (one setup + trigger). */
function searchEnabler(
  board: PlanBoard,
  opts: { minChain: number; minRun: number; shatterWeight: number; tieSeed?: number },
): ChainSetupPlan | null {
  let best: ChainSetupPlan | null = null;
  let bestRank = 0;
  const b2: PlanBoard = { cell: board.cell.slice(), width: board.width, height: board.height };

  for (let sy = 0; sy < board.height; sy++) {
    for (let sx = 0; sx < board.width - 1; sx++) {
      const a = at(board, sx, sy);
      const c = at(board, sx + 1, sy);
      if (a < 0 || c < 0) continue; // setups are block↔block only
      if (mapFlavorToBaseFlavor(a) === mapFlavorToBaseFlavor(c)) continue; // no-op
      if (makesRun3(board, sx, sy)) continue; // that's a clear, not a setup
      // Apply the setup on the scratch board (undone below).
      b2.cell.set(board.cell);
      b2.cell[sx * b2.height + sy] = c;
      b2.cell[(sx + 1) * b2.height + sy] = a;

      for (let ty = 0; ty < b2.height; ty++) {
        for (let tx = 0; tx < b2.width - 1; tx++) {
          if (tx === sx && ty === sy) continue; // undoing the setup is pointless
          if (!canSwap(b2, tx, ty)) continue;
          const ta = at(b2, tx, ty);
          const tc = at(b2, tx + 1, ty);
          if (ta >= 0 && tc >= 0 && mapFlavorToBaseFlavor(ta) === mapFlavorToBaseFlavor(tc)) {
            continue; // no-op
          }
          // A block swapped over a fall-through gap triggers via gravity, which
          // the static prefilter can't see — evaluate those in full.
          const fallThrough =
            (ta >= 0 && tc < 0 && ty > 0 && at(b2, tx + 1, ty - 1) < 0) ||
            (tc >= 0 && ta < 0 && ty > 0 && at(b2, tx, ty - 1) < 0);
          if (!fallThrough && !makesRun3(b2, tx, ty)) continue;
          const cas = evaluateSwap(b2, tx, ty);
          if (cas.chainDepth < opts.minChain && cas.maxRound < opts.minRun) continue;
          const score = attackValue(cas) + cas.garbageShattered * opts.shatterWeight;
          const rank = seededRank(opts.tieSeed, 0x43484149, sx, sy);
          if (
            !best ||
            score > best.score ||
            (score === best.score && opts.tieSeed !== undefined && rank > bestRank)
          ) {
            best = { x: sx, y: sy, score };
            bestRank = rank;
          }
        }
      }
    }
  }
  return best;
}

/**
 * planUndermine — the defensive fallback when no shatter setup exists at all:
 * garbage is often perched on a narrow tower of blocks (it lands on the tallest
 * column), where no row has the width to assemble a match. The human technique
 * is to *dismantle the tower*: dig its load-bearing blocks sideways into the
 * neighbouring gap so they fall away and the slab descends, row by row, onto
 * the wider stack — where {@link planShatterSetup} takes over.
 *
 * The direct candidate is a dig swap (a load-bearing block moved into an empty
 * cell it can fall through). If a sole slab support has an adjacent empty cell
 * but the cell below that pocket is occupied, the planner first slides that
 * lower blocker aside; the next pass can pull the support down one row. Direct
 * digs win, then cursor distance; an optional seed ranks exact ties. Returns a
 * swap in plan coordinates, or null.
 */
export function planUndermine(
  board: PlanBoard,
  cursorX: number,
  cursorY: number,
  tieSeed?: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDist = Infinity;
  let bestRank = 0;
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
      const rank = seededRank(tieSeed, 0x444947, x, y);
      if (dist < bestDist || (dist === bestDist && tieSeed !== undefined && rank > bestRank)) {
        bestDist = dist;
        bestRank = rank;
        best = { x, y };
      }
    }
  }
  if (best) return best;

  // A common perched-slab shape has an empty cell beside its sole support, but
  // a block immediately below that destination. A human first moves that lower
  // blocker sideways, creating a one-row-deeper pocket; the next planning pass
  // can then move the support into the pocket and let the slab descend.
  const soleSupport = (x: number, y: number): boolean => {
    if (y + 1 >= board.height || at(board, x, y + 1) !== PLAN_GARBAGE) return false;
    const seen = new Set<number>();
    const pending = [x * board.height + y + 1];
    const supports = new Set<number>();
    while (pending.length > 0) {
      const idx = pending.pop()!;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const gx = Math.floor(idx / board.height);
      const gy = idx % board.height;
      if (gy > 0 && isBlock(board, gx, gy - 1)) supports.add(gx * board.height + gy - 1);
      for (const [nx, ny] of [
        [gx - 1, gy],
        [gx + 1, gy],
        [gx, gy - 1],
        [gx, gy + 1],
      ] as const) {
        if (
          nx >= 0 &&
          nx < board.width &&
          ny >= 0 &&
          ny < board.height &&
          at(board, nx, ny) === PLAN_GARBAGE
        ) {
          pending.push(nx * board.height + ny);
        }
      }
    }
    return supports.size === 1 && supports.has(x * board.height + y);
  };

  best = null;
  bestDist = Infinity;
  bestRank = 0;
  for (let y = 1; y + 1 < board.height; y++) {
    for (let supportX = 0; supportX < board.width; supportX++) {
      if (!isBlock(board, supportX, y) || !soleSupport(supportX, y)) continue;
      for (const dir of [-1, 1] as const) {
        const pocketX = supportX + dir;
        if (pocketX < 0 || pocketX >= board.width || !empty(pocketX, y)) continue;
        if (!isBlock(board, pocketX, y - 1)) continue;
        for (const clearDir of [-1, 1] as const) {
          const clearX = pocketX + clearDir;
          if (clearX < 0 || clearX >= board.width || !empty(clearX, y - 1)) continue;
          const swapX = Math.min(pocketX, clearX);
          if (makesRun3(board, swapX, y - 1)) continue;
          const dist = Math.abs(swapX - cursorX) + Math.abs(y - 1 - cursorY);
          const rank = seededRank(tieSeed, 0x50554c4c, swapX, y - 1);
          if (dist < bestDist || (dist === bestDist && tieSeed !== undefined && rank > bestRank)) {
            best = { x: swapX, y: y - 1 };
            bestDist = dist;
            bestRank = rank;
          }
        }
      }
    }
  }
  return best;
}
