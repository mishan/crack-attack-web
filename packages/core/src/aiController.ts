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
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH, GC_SAFE_HEIGHT } from './constants.js';
import { GR_BLOCK, GR_EMPTY, GR_GARBAGE, type Grid } from './grid.js';
import { flavorMatch } from './flavors.js';
import { SS_SWAPPING, type Swapper } from './swapper.js';
import type { Clock } from './clock.js';
import type { GarbageGenerator } from './garbageGenerator.js';
import {
  PLAN_GARBAGE,
  attackValue,
  canSwap,
  evaluateSwap,
  hashPlanBoard,
  planChainSetup,
  planShatterSetup,
  planUndermine,
  readPlanBoard,
  type ChainSetupPlan,
} from './aiPlanner.js';

export type AiDifficultyLevel = 'easy' | 'medium' | 'hard';

/**
 * Every behavioural knob the controller has, exposed so variants can be paired
 * against each other in the AI-vs-AI arena (`tools/ai-arena`) and tuned by
 * measurement. The named difficulty tiers are presets over this struct
 * ({@link aiTuningFor}); the defaults reproduce their behaviour exactly.
 */
export interface AiTuning {
  /** Ticks the bot pauses after each swap (reaction pacing). */
  readonly cooldown: number;
  /** Whether it digs blocks into gaps when no immediate match exists. */
  readonly flatten: boolean;
  /**
   * The top tier: instead of greedily clearing every 3, it look-ahead-plans
   * (see {@link AiController.planStrategic}) — banking small clears while safe
   * and firing chains / 4+ combos / garbage shatters, which are what actually
   * send garbage. Uses the {@link aiPlanner} cascade evaluator.
   */
  readonly strategic: boolean;
  /** Strategic only: switch to survival (clear anything) at this margin below
   * the safe height. Larger = defends earlier (safer, banks less). */
  readonly dangerMargin: number;
  /** Strategic only: score weight per garbage cell a candidate's cascade shatters. */
  readonly shatterWeight: number;
  /** Strategic only: pursue multi-swap garbage-shatter setups up to this many
   * lateral swaps ({@link planShatterSetup}); 0 disables setup planning. */
  readonly shatterSetupMaxCost: number;
  /** Strategic only: when garbage rests on a tower no setup can reach, dig its
   * support out so the slab descends into range ({@link planUndermine}). */
  readonly undermine: boolean;
  /** Strategic only: when safe with nothing to fire, prefer a bank move that
   * *enables* a chain/combo one trigger swap later ({@link planChainSetup})
   * over generic clustering. */
  readonly chainSetup: boolean;
  /** Strategic only: when no single chain enabler exists, search one level
   * deeper for a setup→setup→trigger construction ({@link planChainSetup}
   * lookahead). Only active with `chainSetup`. */
  readonly chainLookahead: boolean;
  /** Strategic only: **trigger timing** — hold a ready non-shattering fire when
   * an opponent slab will land within this many ticks, so the cascade fires
   * *through* the fresh slab (shattering it) instead of being spent just before
   * it arrives. 0 disables holding — and 0 is the default: arena measurement
   * found no edge (slabs land on *top* of the stack while cascades match deep
   * inside it, so the held fire rarely reaches the fresh slab, and holding
   * costs attack tempo). Kept as a knob for future timing experiments. */
  readonly holdFireTicks: number;
  /** Strategic only: only hold for incoming garbage of at least this many cells
   * (a real slab, not splinters). */
  readonly holdFireMinCells: number;
  /** Strategic only: a cascade at least this deep is worth firing (2 = any chain). */
  readonly fireMinChain: number;
  /** Strategic only: a single run at least this long is worth firing (width garbage). */
  readonly fireMinRun: number;
  /** Build fallback: cluster-score weight of a vertical same-flavour neighbour. */
  readonly clusterVertical: number;
  /** Build fallback: cluster-score weight of a horizontal same-flavour neighbour. */
  readonly clusterHorizontal: number;
}

/**
 * The bot enters "survival" mode (clear anything to stay alive, stop banking)
 * once the stack tops out within this margin of the safe height.
 */
const DANGER_MARGIN = 3;

/** Knobs shared by every tier; the presets below override behaviour per tier. */
const BASE_TUNING: Omit<AiTuning, 'cooldown' | 'flatten' | 'strategic'> = {
  dangerMargin: DANGER_MARGIN,
  shatterWeight: 3,
  shatterSetupMaxCost: 10,
  undermine: true,
  chainSetup: true,
  chainLookahead: true,
  holdFireTicks: 0, // measured neutral-to-negative; see the AiTuning docs
  holdFireMinCells: GC_PLAY_WIDTH,
  fireMinChain: 2,
  fireMinRun: 4,
  clusterVertical: 2,
  clusterHorizontal: 1,
};

// Difficulty is behavioural, not just paced: reaction speed (cooldown) barely
// affects survival — the bot is limited by how well it *finds/creates* matches,
// not how fast it acts — so the tiers differ in strategy, not reflexes.
//   easy   — reactive only: clears what's one swap away, else idles.
//   medium — strategic-lite: fires chains/combos/shatters it sees, survival-
//            clears in danger, undermines garbage towers — but no shatter
//            setups and no chain building. (With `strategic: false` it falls
//            back to the old reactive digger, kept for experiments.)
//   hard   — full strategic: + multi-swap shatter setups and chain building.
// Arena-measured ladder (seeds 1–60): hard > medium 77%, medium > easy 93%,
// each tier decisive but beatable — and medium out-attacks the old digger 3×.
// Cooldown is kept only for *feel* (easy visibly calmer, hard snappier).
const TUNING: Record<AiDifficultyLevel, AiTuning> = {
  easy: { ...BASE_TUNING, cooldown: 20, flatten: false, strategic: false },
  medium: {
    ...BASE_TUNING,
    cooldown: 12,
    flatten: true,
    strategic: true,
    shatterSetupMaxCost: 0,
    chainSetup: false,
  },
  hard: { ...BASE_TUNING, cooldown: 8, flatten: false, strategic: true },
};

/** The tuning preset behind a named difficulty (a copy — safe to spread/override). */
export function aiTuningFor(difficulty: AiDifficultyLevel): AiTuning {
  return { ...TUNING[difficulty] };
}

/**
 * What the controller needs from a sim: the grid, the swap cursor, and — for
 * trigger timing — the clock and the incoming-garbage queue. All lockstep-
 * deterministic state of the AI's own sim, so netplay stays in sync.
 */
export interface AiSimView {
  readonly grid: Grid;
  readonly swapper: Swapper;
  readonly clock: Clock;
  readonly garbageGenerator: GarbageGenerator;
}

interface SwapPlan {
  x: number;
  y: number;
}

export class AiController {
  private readonly tuning: AiTuning;
  /**
   * The Swapper debounces held keys (a move/swap only triggers on a *fresh*
   * press), so the bot alternates a press with a neutral "release" tick. This
   * flag says the next input must be the release.
   */
  private releaseNext = false;
  /** Ticks to wait after a swap before acting again (difficulty pacing). */
  private cooldown = 0;
  /**
   * Chain-setup memo: `planChainSetup` is a pure function of the board alone
   * (not the cursor), and the board is usually unchanged while the cursor
   * walks — so its result is cached by board hash. Purely an optimization:
   * decisions are identical with or without the cache, so lockstep holds.
   */
  private chainCacheHash = -1;
  private chainCachePlan: ChainSetupPlan | null = null;

  constructor(difficulty: AiDifficultyLevel | AiTuning) {
    this.tuning = typeof difficulty === 'string' ? TUNING[difficulty] : difficulty;
  }

  /** Reset to a clean state for a new game (mirrors the sim's gameStart). */
  reset(): void {
    this.releaseNext = false;
    this.cooldown = 0;
    this.chainCacheHash = -1;
    this.chainCachePlan = null;
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
    let target: SwapPlan | null;
    if (this.tuning.strategic) {
      // Trigger timing input: is a real opponent slab about to land?
      const holdFire =
        this.tuning.holdFireTicks > 0 &&
        sim.garbageGenerator.pendingCellsWithin(sim.clock.time_step, this.tuning.holdFireTicks) >=
          this.tuning.holdFireMinCells;
      target = this.planStrategic(grid, swapper.x, swapper.y, holdFire);
    } else {
      target =
        this.findSwap(grid, swapper.x, swapper.y) ??
        (this.tuning.flatten ? this.findFlatten(grid, swapper.x, swapper.y) : null);
    }
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
   * Constructive fallback (top tier): when no clear exists, make the swap that
   * best *clusters* same-flavour blocks — increasing same-flavour adjacencies,
   * weighting vertical pairs higher (they build columns that survive the stack
   * settling). This sets up future matches instead of just churning gaps, so
   * the bot keeps generating clears (and shatters) under pressure. Only positive-
   * gain swaps are considered, so it never oscillates; nearest-cursor breaks ties.
   */
  private findBuild(grid: Grid, cursorX: number, cursorY: number): SwapPlan | null {
    const maxRow = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
    let best: SwapPlan | null = null;
    let bestGain = 0;
    let bestDist = Infinity;
    for (let y = 1; y <= maxRow; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH - 1; x++) {
        if (!this.swappableBlock(grid, x, y) || !this.swappableBlock(grid, x + 1, y)) continue;
        const fa = grid.flavorAt(x, y);
        const fb = grid.flavorAt(x + 1, y);
        if (fa === fb) continue; // no-op swap
        // Gain = clustering after the swap minus before it.
        const before = this.clusterScore(grid, x, y, fa) + this.clusterScore(grid, x + 1, y, fb);
        const after =
          this.clusterScore(grid, x, y, fb, x + 1, fa) +
          this.clusterScore(grid, x + 1, y, fa, x, fb);
        const gain = after - before;
        if (gain <= 0) continue;
        const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
        if (gain > bestGain || (gain === bestGain && dist < bestDist)) {
          bestGain = gain;
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /**
   * Weighted count of same-flavour static-block neighbours of `(x,y)` treated as
   * holding `flavor`. Vertical neighbours score 2 (column matches survive
   * settling), horizontal 1. `swapCol`/`swapFlavor` optionally override one
   * neighbour cell's flavour to reflect a pending swap of `(swapCol,y)`.
   */
  private clusterScore(
    grid: Grid,
    x: number,
    y: number,
    flavor: number,
    swapCol = -1,
    swapFlavor = -1,
  ): number {
    const flavorOf = (cx: number, cy: number): number | null => {
      if (cx === swapCol && cy === y) return swapFlavor;
      if ((grid.stateAt(cx, cy) & GR_BLOCK) === 0) return null;
      if (!grid.blockAt(cx, cy).isStatic()) return null;
      return grid.flavorAt(cx, cy);
    };
    let score = 0;
    const add = (cx: number, cy: number, weight: number): void => {
      const g = flavorOf(cx, cy);
      if (g !== null && flavorMatch(g, flavor)) score += weight;
    };
    const { clusterVertical, clusterHorizontal } = this.tuning;
    if (y + 1 < GC_PLAY_HEIGHT) add(x, y + 1, clusterVertical);
    if (y - 1 >= 1) add(x, y - 1, clusterVertical);
    if (x + 1 < GC_PLAY_WIDTH) add(x + 1, y, clusterHorizontal);
    if (x - 1 >= 0) add(x - 1, y, clusterHorizontal);
    return score;
  }

  /**
   * The strategic tier. Instead of greedily clearing every 3, it evaluates each
   * candidate swap's full cascade ({@link aiPlanner}) and:
   *  - always fires a swap that sends garbage — a chain (chainDepth ≥ 2), a 4+
   *    combo (a run ≥ 4), or a garbage shatter — picking the highest-value one
   *    (except that a non-shattering fire is *held* while an opponent slab is
   *    about to land, so the cascade can fire through the fresh slab instead);
   *  - otherwise, if the stack is getting dangerous, clears the nearest 3 to
   *    survive;
   *  - otherwise, if garbage is on the board with no one-swap shatter, works
   *    toward the cheapest multi-swap shatter setup ({@link planShatterSetup});
   *  - otherwise (safe, nothing worth firing) *banks*: prefers a chain-enabling
   *    setup swap ({@link planChainSetup} — after it, a worth-firing cascade is
   *    one trigger away), falling back to constructive same-colour clustering.
   * Returns the grid cell to swap rightward, or null to idle. Deterministic.
   */
  private planStrategic(
    grid: Grid,
    cursorX: number,
    cursorY: number,
    holdFire: boolean,
  ): SwapPlan | null {
    const board = readPlanBoard(grid);
    const H = board.height;
    let bestFire: SwapPlan | null = null;
    let bestFireScore = -1;
    let bestFireDist = Infinity;
    let bestFireShattered = 0;
    let bestClear: SwapPlan | null = null;
    let bestClearDist = Infinity;

    for (let by = 0; by < H; by++) {
      for (let x = 0; x < board.width - 1; x++) {
        if (!canSwap(board, x, by)) continue;
        const a = board.cell[x * H + by]!;
        const c = board.cell[(x + 1) * H + by]!;
        if (a === c || a === PLAN_GARBAGE || c === PLAN_GARBAGE) continue; // no-op / illegal
        const cascade = evaluateSwap(board, x, by);
        if (cascade.chainDepth === 0) continue; // triggers nothing

        const gy = by + 1; // plan rows are grid rows − 1
        const dist = Math.abs(x - cursorX) + Math.abs(gy - cursorY);

        const worthFiring =
          cascade.chainDepth >= this.tuning.fireMinChain ||
          cascade.maxRound >= this.tuning.fireMinRun ||
          cascade.garbageShattered > 0;
        if (worthFiring) {
          const score = attackValue(cascade) + cascade.garbageShattered * this.tuning.shatterWeight;
          // Highest value wins; the nearest *fire* candidate breaks ties (lands
          // before the creep shifts).
          if (score > bestFireScore || (score === bestFireScore && dist < bestFireDist)) {
            bestFireScore = score;
            bestFireDist = dist;
            bestFire = { x, y: gy };
            bestFireShattered = cascade.garbageShattered;
          }
        }
        if (dist < bestClearDist) {
          bestClearDist = dist;
          bestClear = { x, y: gy };
        }
      }
    }

    const danger = grid.top_effective_row >= GC_SAFE_HEIGHT - this.tuning.dangerMargin;
    if (bestFire) {
      // Trigger timing: a ready fire that shatters nothing is *held* while a
      // real slab is about to land — fired after the slab arrives, the same
      // (or a bigger) cascade shatters it too, instead of being spent just
      // before it lands. Never hold in danger, and never hold a shattering
      // fire (that relief is wanted right now). While holding, the branches
      // below keep banking, which can upgrade the eventual payoff.
      const hold = holdFire && bestFireShattered === 0 && !danger;
      if (!hold) return bestFire; // attack / defend — fire a real payoff
    }
    // In danger a plain clear relieves height *now* (a shatter converts garbage
    // to blocks without lowering the stack), so it comes first.
    if (danger && bestClear) return bestClear;
    // No one-swap shatter exists (the fire branch would have taken it), but
    // garbage may still be clearable in a few moves: work toward the cheapest
    // multi-swap setup that assembles a match against a slab. Once it's one
    // swap from done, the fire branch above executes it.
    if (this.tuning.shatterSetupMaxCost > 0) {
      const setup = planShatterSetup(board, this.tuning.shatterSetupMaxCost);
      if (setup) return { x: setup.x, y: setup.y + 1 }; // plan rows are grid rows − 1
    }
    // No setup reaches the garbage (it's typically perched on a tower): dig
    // the tower out from under it so the slab descends into setup range.
    if (this.tuning.undermine) {
      const dig = planUndermine(board, cursorX, cursorY - 1);
      if (dig) return { x: dig.x, y: dig.y + 1 };
    }
    if (danger) return null; // nothing clearable at all — idle
    // Safe and nothing worth firing: bank blocks. Prefer a *chain enabler* —
    // one setup swap after which a worth-firing cascade is a single trigger
    // swap away (the fire branch takes it next action tick) — over generic
    // same-colour clustering.
    if (this.tuning.chainSetup) {
      // Board-pure and cursor-independent, so memoized by board hash — the
      // lookahead level is only paid when the board actually changes.
      const hash = hashPlanBoard(board);
      if (hash !== this.chainCacheHash) {
        this.chainCacheHash = hash;
        this.chainCachePlan = planChainSetup(board, {
          minChain: this.tuning.fireMinChain,
          minRun: this.tuning.fireMinRun,
          shatterWeight: this.tuning.shatterWeight,
          lookahead: this.tuning.chainLookahead,
        });
      }
      const chain = this.chainCachePlan;
      if (chain) return { x: chain.x, y: chain.y + 1 }; // plan rows are grid rows − 1
    }
    return this.findBuild(grid, cursorX, cursorY);
  }

  /**
   * Find a horizontal swap `(x,y)↔(x+1,y)` of two resting blocks whose exchange
   * completes a 3+ run. Prefers a swap that also *shatters garbage* (its match
   * lands next to a garbage slab) — the single most important thing a player
   * does under garbage pressure, since a shatter turns a whole slab back into
   * matchable blocks and relieves the stack. Among equally-preferred swaps it
   * picks the one closest to the cursor (fewest moves, so it lands before the
   * creep shifts the board). Deterministic: ties broken by the bottom-up,
   * left-to-right scan order.
   */
  private findSwap(grid: Grid, cursorX: number, cursorY: number): SwapPlan | null {
    const maxRow = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
    let best: SwapPlan | null = null;
    let bestDist = Infinity;
    let shatter: SwapPlan | null = null;
    let shatterDist = Infinity;
    for (let y = 1; y <= maxRow; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH - 1; x++) {
        if (!this.swappableBlock(grid, x, y) || !this.swappableBlock(grid, x + 1, y)) continue;
        if (grid.flavorAt(x, y) === grid.flavorAt(x + 1, y)) continue; // no-op swap
        if (!this.swapMakesMatch(grid, x, y)) continue;
        const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
        // A match on a cell touching garbage shatters that slab (the eliminated
        // block is adjacent to it). Either swapped cell anchors the match.
        if (this.garbageNeighbor(grid, x, y) || this.garbageNeighbor(grid, x + 1, y)) {
          if (dist < shatterDist) {
            shatterDist = dist;
            shatter = { x, y };
          }
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = { x, y };
        }
      }
    }
    return shatter ?? best;
  }

  /** A cell that can take part in a swap: a resting (static) block. */
  private swappableBlock(grid: Grid, x: number, y: number): boolean {
    return (grid.stateAt(x, y) & GR_BLOCK) !== 0 && grid.blockAt(x, y).isStatic();
  }

  /** Whether any 4-neighbour of `(x,y)` is a garbage cell (so a match here shatters it). */
  private garbageNeighbor(grid: Grid, x: number, y: number): boolean {
    return (
      (y + 1 < GC_PLAY_HEIGHT && (grid.stateAt(x, y + 1) & GR_GARBAGE) !== 0) ||
      (y - 1 >= 0 && (grid.stateAt(x, y - 1) & GR_GARBAGE) !== 0) ||
      (x + 1 < GC_PLAY_WIDTH && (grid.stateAt(x + 1, y) & GR_GARBAGE) !== 0) ||
      (x - 1 >= 0 && (grid.stateAt(x - 1, y) & GR_GARBAGE) !== 0)
    );
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
