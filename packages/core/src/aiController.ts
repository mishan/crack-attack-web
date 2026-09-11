/**
 * aiController.ts — a deterministic grid-playing AI (a real bot, not the
 * abstract `ComputerPlayer`).
 *
 * Unlike the reference's gridless `ComputerPlayer`, this drives an actual
 * `GameSim`: each tick it reads the board and the swap cursor and returns the
 * next input (`ActionState`), so its play is fully visible. It is a pure,
 * deterministic function of the sim state, its own small plan/timer, and an
 * optional judgment seed — no clocks and no gameplay-RNG draws. That is what
 * lets a vs-AI netplay match stay in sync across every client: players and
 * spectators run the same seeded controller over the same lockstep-identical
 * AI sim and therefore see identical moves without AI input crossing the wire.
 *
 * Hard evaluates cascades, builds short chains and crossed-column x8/x10
 * combos and dismantles garbage supports. During a block pop/hang/fall it
 * evaluates swaps against the gravity-settled future, while preserving a chain
 * that gravity is already primed to trigger. A per-difficulty think delay paces
 * the visible reactions.
 */

import {
  ActionState,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
} from './controller.js';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH, GC_SAFE_HEIGHT } from './constants.js';
import { BS_DYING, BS_FALLING } from './block.js';
import { GR_BLOCK, GR_EMPTY, GR_FALLING, GR_GARBAGE, GR_HANGING, type Grid } from './grid.js';
import { flavorMatch } from './flavors.js';
import { GS_STATIC } from './garbage.js';
import { SS_SWAPPING, type Swapper } from './swapper.js';
import type { Clock } from './clock.js';
import type { Creep } from './creep.js';
import type { GarbageGenerator } from './garbageGenerator.js';
import {
  PLAN_GARBAGE,
  attackValue,
  canSwap,
  evaluateGravity,
  evaluateSwap,
  hashPlanBoard,
  planBigComboSetup,
  planChainSetup,
  planShatterSetup,
  planUndermine,
  readGravityPlanBoard,
  readPlanBoard,
  type BigComboSetupPlan,
  type ChainSetupPlan,
  type PlanBoard,
} from './aiPlanner.js';

export type AiDifficultyLevel = 'easy' | 'medium' | 'hard';

/**
 * Every behavioural knob the controller has, exposed so variants can be paired
 * against each other in the AI-vs-AI arena (`tools/ai-arena`) and tuned by
 * measurement. The named difficulty tiers are presets over this struct
 * ({@link aiTuningFor}).
 */
export interface AiTuning {
  /** Ticks the bot pauses after each swap (reaction pacing). */
  readonly cooldown: number;
  /** Whether it digs blocks into gaps when nothing better exists — the
   * reactive tiers' churn move, and the strategic tier's last fallback
   * (instead of idling: measured 220 three-second stands per 8 games). */
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
  /** Strategic only: garbage-aware danger — every this-many garbage cells on
   * the board raise the effective danger margin by one row (garbage is dead
   * weight: a garbage-heavy stack at height N has far less clearable material
   * than a clean one, so it is closer to death than its height says).
   * 0 disables — and 0 is the default: measured neutral-to-negative, because
   * the defensive branches (shatter fires/setups, undermine) already act on
   * garbage in any mode, while earlier survival mode costs banking tempo. */
  readonly garbageDangerCells: number;
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
  /** Strategic only: pursue the crossed-column x8/x10 combo construction while
   * safe, up to this many lateral setup swaps. 0 disables it. */
  readonly bigComboSetupMaxCost: number;
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
  // Measured neutral-to-negative (arena 9-14-7 vs off; heavy-stream survival
  // no better): the defensive branches already act on garbage in any mode, so
  // earlier survival mode just downgrades to nearest-clears. Off by default;
  // the knob stays for experiments.
  garbageDangerCells: 0,
  shatterWeight: 3,
  shatterSetupMaxCost: 10,
  undermine: true,
  chainSetup: true,
  chainLookahead: true,
  bigComboSetupMaxCost: 18,
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
//   easy   — reactive only: clears what's one swap away, else advances a row.
//   medium — strategic-lite: fires chains/combos/shatters it sees, survival-
//            clears in danger, undermines garbage towers — but no shatter
//            setups and no chain building. (With `strategic: false` it falls
//            back to the old reactive digger, kept for experiments.)
//   hard   — full strategic: + shatter setups, chains, and x8/x10 building.
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
    bigComboSetupMaxCost: 0,
  },
  hard: { ...BASE_TUNING, cooldown: 8, flatten: true, strategic: true },
};

/** The tuning preset behind a named difficulty (a copy — safe to spread/override). */
export function aiTuningFor(difficulty: AiDifficultyLevel): AiTuning {
  return { ...TUNING[difficulty] };
}

/**
 * What the controller needs from a sim: grid/cursor state, creep state for safe
 * manual advance, and clock/incoming garbage for trigger timing. All lockstep-
 * deterministic state of the AI's own sim, so netplay stays in sync.
 */
export interface AiSimView {
  readonly grid: Grid;
  readonly swapper: Swapper;
  readonly clock: Clock;
  readonly garbageGenerator: GarbageGenerator;
  readonly creep: Creep;
}

interface SwapPlan {
  x: number;
  y: number;
}

/**
 * Derive a controller-only judgment seed for one seat. Gameplay RNG remains
 * shared; this seed varies only equally-valued planner choices. The transform
 * is deterministic, so peers and spectators regenerate the same bot inputs.
 */
export function aiDecisionSeed(matchSeed: number, seat: number): number {
  let h = (matchSeed ^ Math.imul(seat + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class AiController {
  private readonly tuning: AiTuning;
  /** Optional seed for reproducible variety among otherwise equal choices. */
  private readonly decisionSeed: number | null;
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
  /** The more ambitious crossed-column setup is board-pure too. */
  private bigComboCacheHash = -1;
  private bigComboCachePlan: BigComboSetupPlan | null = null;
  /** Board before the last issued swap, used to reject an exact immediate undo. */
  private lastSwapBoardHash = -1;
  private lastSwapPlan: SwapPlan | null = null;

  constructor(difficulty: AiDifficultyLevel | AiTuning, decisionSeed?: number) {
    this.tuning = typeof difficulty === 'string' ? TUNING[difficulty] : difficulty;
    this.decisionSeed = decisionSeed === undefined ? null : decisionSeed >>> 0;
  }

  /** Reset to a clean state for a new game (mirrors the sim's gameStart). */
  reset(): void {
    this.releaseNext = false;
    this.cooldown = 0;
    this.chainCacheHash = -1;
    this.chainCachePlan = null;
    this.bigComboCacheHash = -1;
    this.bigComboCachePlan = null;
    this.lastSwapBoardHash = -1;
    this.lastSwapPlan = null;
  }

  /** Stable pseudo-random rank for an equal choice; 0 preserves scan order when unseeded. */
  private tieRank(kind: number, x: number, y: number): number {
    if (this.decisionSeed === null) return 0;
    let h =
      (this.decisionSeed ^ kind ^ Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>>
      0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return h >>> 0;
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

    // Manual advance is latched by Creep until the row lands. Keep the button
    // released during that interval so the latch drops at the landing tick;
    // holding it would accidentally request another whole row immediately.
    if (sim.creep.isAdvancing) return new ActionState(0);

    // Wait out an in-progress swap, and pace by difficulty after each swap.
    if ((swapper.state & SS_SWAPPING) !== 0) return new ActionState(0);
    const motion = this.boardMotion(grid);
    // Falling blocks and the holes dying blocks will leave can be projected.
    // Awaking blocks and moving garbage cannot: their future shape/content
    // needs more than a grid copy.
    if (motion === 'other') return new ActionState(0);
    if (this.cooldown > 0) {
      this.cooldown--;
      return new ActionState(0);
    }

    const planningBoard = motion === 'gravity' ? readGravityPlanBoard(grid) : readPlanBoard(grid);
    const avoidUndo = this.immediateUndo(planningBoard);

    // The current nearest clearing swap (re-evaluated every action tick); if
    // none, a dig that shifts a block into a gap (harder AIs only) to flatten
    // the surface and open up new matches.
    let target: SwapPlan | null;
    if (motion === 'gravity') {
      // A fall linked to an active combo will score as a chain when it lands.
      // If gravity alone already forms a match, status quo is the best plan:
      // touching its supports could turn a guaranteed chain into a lesser move.
      if (this.hasLinkedGravity(grid) && evaluateGravity(planningBoard).chainDepth > 0) {
        return new ActionState(0);
      }
      target = this.planDuringGravity(grid, planningBoard, swapper.x, swapper.y, avoidUndo);
    } else if (this.tuning.strategic) {
      // Trigger timing input: is a real opponent slab about to land?
      const holdFire =
        this.tuning.holdFireTicks > 0 &&
        sim.garbageGenerator.pendingCellsWithin(sim.clock.time_step, this.tuning.holdFireTicks) >=
          this.tuning.holdFireMinCells;
      target = this.planStrategic(grid, swapper.x, swapper.y, holdFire, avoidUndo);
    } else {
      target =
        this.findSwap(grid, swapper.x, swapper.y) ??
        (this.tuning.flatten ? this.findFlatten(grid, swapper.x, swapper.y) : null);
      if (target && this.samePlan(target, avoidUndo)) target = null;
    }
    if (!target) {
      // Do not raise the board during a live fall. Even with no useful swap,
      // gravity is already supplying the next position to evaluate.
      if (motion === 'gravity') return new ActionState(0);
      // A stable position with no useful swap is not a reason to wait for the
      // slow automatic creep: pull in the next row and give the planners fresh
      // material. Creep ignores this during a freeze/transient, so it is safe to
      // retry until the command latches.
      return new ActionState(sim.creep.creep_freeze ? 0 : CC_ADVANCE);
    }

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
    this.lastSwapBoardHash = hashPlanBoard(planningBoard);
    this.lastSwapPlan = { x: target.x, y: target.y };
    this.cooldown = this.tuning.cooldown;
    this.releaseNext = true;
    return new ActionState(CC_SWAP);
  }

  /** Classify a settled board, predictable block gravity, or another transient. */
  private boardMotion(grid: Grid): 'settled' | 'gravity' | 'other' {
    let gravity = false;
    for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH; x++) {
        const resident = grid.residentTypeAt(x, y);
        if (resident === GR_BLOCK && !grid.blockAt(x, y).isStatic()) {
          if ((grid.blockAt(x, y).state & (BS_FALLING | BS_DYING)) === 0) return 'other';
          gravity = true;
        }
        if (resident === GR_GARBAGE && (grid.garbageAt(x, y).state & GS_STATIC) === 0) {
          return 'other';
        }
      }
    }
    return gravity ? 'gravity' : 'settled';
  }

  /** Whether a falling/dying block belongs to the combo whose next landing can extend it. */
  private hasLinkedGravity(grid: Grid): boolean {
    for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH; x++) {
        if (grid.residentTypeAt(x, y) !== GR_BLOCK) continue;
        const block = grid.blockAt(x, y);
        if ((block.state & (BS_FALLING | BS_DYING)) !== 0 && block.current_combo !== null) {
          return true;
        }
      }
    }
    return false;
  }

  /** Exact copy of the Swapper's per-cell legality checks for a swap rightward. */
  private canSwapNow(grid: Grid, x: number, y: number): boolean {
    if (x < 0 || x >= GC_PLAY_WIDTH - 1 || y < 1 || y >= GC_SAFE_HEIGHT) return false;
    let blocks = 0;
    for (const cx of [x, x + 1]) {
      const state = grid.stateAt(cx, y);
      if ((state & GR_BLOCK) !== 0) {
        blocks++;
        continue;
      }
      if ((state & GR_EMPTY) === 0) return false;
      if ((grid.stateAt(cx, y - 1) & GR_FALLING) !== 0) return false;
      if (y + 1 < GC_PLAY_HEIGHT && (grid.stateAt(cx, y + 1) & GR_HANGING) !== 0) return false;
    }
    return blocks > 0;
  }

  /**
   * Pick a currently legal swap while blocks hang, but score it only after all
   * live gravity has settled. This finds the human timing move: arrange resting
   * blocks during the pause so a combo appears when the linked blocks land.
   */
  private planDuringGravity(
    grid: Grid,
    board: ReturnType<typeof readGravityPlanBoard>,
    cursorX: number,
    cursorY: number,
    avoid: SwapPlan | null,
  ): SwapPlan | null {
    const linkedGravity = this.hasLinkedGravity(grid);
    let best: SwapPlan | null = null;
    let bestScore = -1;
    let bestCleared = -1;
    let bestDist = Infinity;
    let bestRank = 0;
    for (let by = 0; by < board.height; by++) {
      const gy = by + 1;
      for (let x = 0; x < board.width - 1; x++) {
        if (this.samePlan({ x, y: gy }, avoid)) continue;
        if (!this.canSwapNow(grid, x, gy)) continue;
        const a = board.cell[x * board.height + by]!;
        const c = board.cell[(x + 1) * board.height + by]!;
        if (a === c || a === PLAN_GARBAGE || c === PLAN_GARBAGE) continue;
        const cascade = evaluateSwap(board, x, by);
        if (cascade.chainDepth === 0) continue;
        // A non-clearing setup made during a linked fall turns the first future
        // match into a real x2 chain. Account for that full-width garbage row,
        // which the board-only evaluator cannot infer from combo ownership.
        const immediateClear =
          (grid.stateAt(x, gy) & GR_BLOCK) !== 0 &&
          (grid.stateAt(x + 1, gy) & GR_BLOCK) !== 0 &&
          this.swapMakesMatch(grid, x, gy);
        const landingChainBonus = linkedGravity && !immediateClear ? GC_PLAY_WIDTH : 0;
        const score =
          attackValue(cascade) +
          cascade.garbageShattered * this.tuning.shatterWeight +
          landingChainBonus;
        const dist = Math.abs(x - cursorX) + Math.abs(gy - cursorY);
        const rank = this.tieRank(0x47524156, x, gy);
        if (
          score > bestScore ||
          (score === bestScore && cascade.totalCleared > bestCleared) ||
          (score === bestScore &&
            cascade.totalCleared === bestCleared &&
            this.decisionSeed !== null &&
            rank > bestRank) ||
          (score === bestScore &&
            cascade.totalCleared === bestCleared &&
            (this.decisionSeed === null || rank === bestRank) &&
            dist < bestDist)
        ) {
          best = { x, y: gy };
          bestScore = score;
          bestCleared = cascade.totalCleared;
          bestDist = dist;
          bestRank = rank;
        }
      }
    }
    return best;
  }

  private samePlan(a: SwapPlan | null, b: SwapPlan | null): boolean {
    return a !== null && b !== null && a.x === b.x && a.y === b.y;
  }

  /**
   * Return the last swap when performing it again would recreate the exact
   * board from before that swap. Constructive planners may change targets after
   * every move; this prevents two attractive targets from selecting inverse
   * first steps forever.
   */
  private immediateUndo(board: PlanBoard): SwapPlan | null {
    const plan = this.lastSwapPlan;
    if (!plan || this.lastSwapBoardHash < 0) return null;
    const y = plan.y - 1;
    if (y < 0 || y >= board.height || plan.x < 0 || plan.x + 1 >= board.width) return null;
    const left = plan.x * board.height + y;
    const right = (plan.x + 1) * board.height + y;
    const tmp = board.cell[left]!;
    board.cell[left] = board.cell[right]!;
    board.cell[right] = tmp;
    const undoHash = hashPlanBoard(board);
    board.cell[right] = board.cell[left]!;
    board.cell[left] = tmp;
    return undoHash === this.lastSwapBoardHash ? plan : null;
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
    let bestRank = 0;
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
        const rank = this.tieRank(0x464c4154, x, y);
        if (
          dist < bestDist ||
          (dist === bestDist && this.decisionSeed !== null && rank > bestRank)
        ) {
          bestDist = dist;
          bestRank = rank;
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
    let bestRank = 0;
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
        const rank = this.tieRank(0x4255494c, x, y);
        if (
          gain > bestGain ||
          (gain === bestGain && this.decisionSeed !== null && rank > bestRank) ||
          (gain === bestGain &&
            (this.decisionSeed === null || rank === bestRank) &&
            dist < bestDist)
        ) {
          bestGain = gain;
          bestDist = dist;
          bestRank = rank;
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
   *  - otherwise (safe, nothing worth firing) *banks*: first a crossed-column
   *    x8/x10, then a chain-enabling setup ({@link planChainSetup}), then a
   *    productive gravity/plain clear before generic clustering.
   * Returns the grid cell to swap rightward, or null to advance. Deterministic.
   */
  private planStrategic(
    grid: Grid,
    cursorX: number,
    cursorY: number,
    holdFire: boolean,
    avoid: SwapPlan | null,
  ): SwapPlan | null {
    const board = readPlanBoard(grid);
    const H = board.height;
    let bestFire: SwapPlan | null = null;
    let bestFireScore = -1;
    let bestFireDist = Infinity;
    let bestFireShattered = 0;
    let bestFireRank = 0;
    let bestClear: SwapPlan | null = null;
    let bestClearDist = Infinity;
    let bestClearRank = 0;

    for (let by = 0; by < H; by++) {
      for (let x = 0; x < board.width - 1; x++) {
        if (this.samePlan({ x, y: by + 1 }, avoid)) continue;
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
          // Highest value wins; a controller-seeded rank separates equal bots,
          // with cursor distance as the final stable tie-break.
          const rank = this.tieRank(0x46495245, x, gy);
          if (
            score > bestFireScore ||
            (score === bestFireScore && this.decisionSeed !== null && rank > bestFireRank) ||
            (score === bestFireScore &&
              (this.decisionSeed === null || rank === bestFireRank) &&
              dist < bestFireDist)
          ) {
            bestFireScore = score;
            bestFireDist = dist;
            bestFireRank = rank;
            bestFire = { x, y: gy };
            bestFireShattered = cascade.garbageShattered;
          }
        }
        const clearRank = this.tieRank(0x434c4541, x, gy);
        if (
          bestClear === null ||
          (this.decisionSeed !== null && clearRank > bestClearRank) ||
          ((this.decisionSeed === null || clearRank === bestClearRank) && dist < bestClearDist)
        ) {
          bestClearDist = dist;
          bestClearRank = clearRank;
          bestClear = { x, y: gy };
        }
      }
    }

    // Garbage-aware danger: dead-weight cells make the stack effectively
    // taller than its height says, so they widen the survival margin.
    let garbageCells = 0;
    for (const v of board.cell) if (v === PLAN_GARBAGE) garbageCells++;
    const margin =
      this.tuning.dangerMargin +
      (this.tuning.garbageDangerCells > 0
        ? Math.floor(garbageCells / this.tuning.garbageDangerCells)
        : 0);
    const danger = grid.top_effective_row >= GC_SAFE_HEIGHT - margin;

    // On a clean, safe board, compare any immediate fire with the larger
    // crossed-column construction. This is what lets the bot actually finish
    // an x8/x10 instead of abandoning it whenever an incidental x4 appears.
    let big: BigComboSetupPlan | null = null;
    if (!danger && garbageCells === 0 && this.tuning.bigComboSetupMaxCost > 0) {
      const hash = hashPlanBoard(board);
      if (hash !== this.bigComboCacheHash) {
        this.bigComboCacheHash = hash;
        this.bigComboCachePlan = planBigComboSetup(
          board,
          this.tuning.bigComboSetupMaxCost,
          this.decisionSeed === null ? undefined : this.decisionSeed,
        );
      }
      big = this.bigComboCachePlan;
      if (big && this.samePlan({ x: big.x, y: big.y + 1 }, avoid)) big = null;
    }
    if (bestFire) {
      const bigPayoff = big ? big.size - 3 : -1;
      if (big && bestFireShattered === 0 && bestFireScore < bigPayoff) {
        return { x: big.x, y: big.y + 1 };
      }
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
      const plan = setup ? { x: setup.x, y: setup.y + 1 } : null;
      if (plan && !this.samePlan(plan, avoid)) return plan; // plan rows are grid rows − 1
    }
    // No setup reaches the garbage (it's typically perched on a tower): dig
    // the tower out from under it so the slab descends into setup range.
    if (this.tuning.undermine) {
      const dig = planUndermine(
        board,
        cursorX,
        cursorY - 1,
        this.decisionSeed === null ? undefined : this.decisionSeed,
      );
      const plan = dig ? { x: dig.x, y: dig.y + 1 } : null;
      if (plan && !this.samePlan(plan, avoid)) return plan;
    }
    // With room to think, pursue the recognisable human x8/x10 construction:
    // two tall colour columns with their centre pair crossed. It is more
    // ambitious than the short chain enabler below, so give it first refusal.
    if (big) return { x: big.x, y: big.y + 1 };
    if (danger) {
      // Nothing clearable and no garbage plan: dig peaks into gaps — it drops
      // blocks (lowering the stack) and churns up new matches. Far better for
      // survival than standing still.
      const flatten = this.tuning.flatten ? this.findFlatten(grid, cursorX, cursorY) : null;
      return flatten && !this.samePlan(flatten, avoid) ? flatten : null;
    }
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
          ...(this.decisionSeed === null ? {} : { tieSeed: this.decisionSeed }),
        });
      }
      const chain = this.chainCachePlan;
      const plan = chain ? { x: chain.x, y: chain.y + 1 } : null;
      if (plan && !this.samePlan(plan, avoid)) return plan; // plan rows are grid rows − 1
    }
    // No larger construction is available: take a productive plain clear
    // before shuffling or raising the board. This includes the human tactic of
    // sliding a support sideways so its cap falls next to a matching pair.
    if (bestClear) return bestClear;
    // Last swap fallback before advancing: cluster-bank, else dig — measured, the
    // strategic tier otherwise stands still for seconds at a time (the board
    // offers no positive-gain move until creep changes it; digging changes it
    // *now* and feeds the planners fresh shapes).
    const build = this.findBuild(grid, cursorX, cursorY);
    if (build && !this.samePlan(build, avoid)) return build;
    const flatten = this.tuning.flatten ? this.findFlatten(grid, cursorX, cursorY) : null;
    return flatten && !this.samePlan(flatten, avoid) ? flatten : null;
  }

  /**
   * Find a horizontal swap `(x,y)↔(x+1,y)` of two resting blocks whose exchange
   * completes a 3+ run. Prefers a swap that also *shatters garbage* (its match
   * lands next to a garbage slab) — the single most important thing a player
   * does under garbage pressure, since a shatter turns a whole slab back into
   * matchable blocks and relieves the stack. A seeded rank chooses among
   * equally useful swaps; an unseeded controller preserves nearest-cursor,
   * bottom-up/left-to-right behavior.
   */
  private findSwap(grid: Grid, cursorX: number, cursorY: number): SwapPlan | null {
    const maxRow = Math.min(grid.top_effective_row + 1, GC_PLAY_HEIGHT - 1);
    let best: SwapPlan | null = null;
    let bestDist = Infinity;
    let shatter: SwapPlan | null = null;
    let shatterDist = Infinity;
    let bestRank = 0;
    let shatterRank = 0;
    for (let y = 1; y <= maxRow; y++) {
      for (let x = 0; x < GC_PLAY_WIDTH - 1; x++) {
        if (!this.swappableBlock(grid, x, y) || !this.swappableBlock(grid, x + 1, y)) continue;
        if (grid.flavorAt(x, y) === grid.flavorAt(x + 1, y)) continue; // no-op swap
        if (!this.swapMakesMatch(grid, x, y)) continue;
        const dist = Math.abs(x - cursorX) + Math.abs(y - cursorY);
        const rank = this.tieRank(0x53574150, x, y);
        // A match on a cell touching garbage shatters that slab (the eliminated
        // block is adjacent to it). Either swapped cell anchors the match.
        if (this.garbageNeighbor(grid, x, y) || this.garbageNeighbor(grid, x + 1, y)) {
          if (
            shatter === null ||
            (this.decisionSeed !== null && rank > shatterRank) ||
            ((this.decisionSeed === null || rank === shatterRank) && dist < shatterDist)
          ) {
            shatterDist = dist;
            shatterRank = rank;
            shatter = { x, y };
          }
        }
        if (
          best === null ||
          (this.decisionSeed !== null && rank > bestRank) ||
          ((this.decisionSeed === null || rank === bestRank) && dist < bestDist)
        ) {
          bestDist = dist;
          bestRank = rank;
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
