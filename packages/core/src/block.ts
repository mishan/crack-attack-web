/**
 * block.ts
 *
 * The Block object and its fixed-size store/manager. Ported from `Block.{h,cxx}`
 * and the store half of `BlockManager.{h,cxx}`.
 *
 * Scope so far: the data model + allocation (Phase 1.3), RNG-driven creep-row
 * generation (Phase 1.4), and the per-tick Block physics — `timeStep`
 * (fall/hang/dying/awaking), `startFalling`/`startDying`/`startSwapping`/
 * `finishSwapping`, and `initializeAwaking` (Phase 1.6, this file). Physics runs
 * against a {@link BlockSimContext} (implemented by GameSim). Deferred:
 *   - the Swapper `notifyLanding` and Garbage-fall hooks (stubbed in the context
 *     until Swapper/Garbage physics land)
 *   - SparkleManager death sparks / Sound cues (cosmetic) and X-mode
 *
 * Architectural departure from the C++ (as the port plan calls for): the manager
 * is an instance owning its store, not a static singleton, so many sims can
 * coexist (AI, server verification, replays, parallel tests). The logic is
 * unchanged.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  BF_GRAY,
  BF_NUMBER_NORMAL,
  GC_BLOCK_STORE_SIZE,
  GC_DYING_DELAY,
  GC_FALL_VELOCITY,
  GC_HANG_DELAY,
  GC_NO_SPECIAL_BLOCK_CHANCE_IN,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_STEPS_PER_GRID,
  GC_X_NO_SPECIAL_BLOCK_CHANCE_IN,
} from './constants.js';
import type { Clock } from './clock.js';
import type { ComboTabulator } from './combo.js';
import type { Garbage } from './garbage.js';
import type { Rng } from './rng.js';
import {
  GR_BLOCK,
  GR_EMPTY,
  GR_FALLING,
  GR_GARBAGE,
  GR_HANGING,
  GR_IMMUTABLE,
  type BlockGridSink,
  type Grid,
} from './grid.js';

// --- Swap action flags (Swapper.h:41-43) -----------------------------------
// Defined here because Block's swap methods key off them; the Swapper imports
// these when it lands.

export const SA_LEFT = 1 << 0;
export const SA_RIGHT = 1 << 1;

/**
 * The per-tick environment Block physics needs. Implemented by `GameSim`, which
 * owns the grid, clock, block store, and the awaking/dying counters. The two
 * hooks bridge to subsystems not yet ported: `notifyLanding` (Swapper) and
 * `startGarbageFalling` (Garbage physics) are no-ops until those land.
 *
 * `awaking_count`/`dying_count` are mutable (Block adjusts them as blocks enter
 * and leave those states), mirroring the global `Game::awaking_count` /
 * `dying_count`.
 */
export interface BlockSimContext {
  readonly grid: Grid;
  readonly clock: Clock;
  readonly blocks: BlockManager;
  awaking_count: number;
  dying_count: number;
  /** Unsynced cosmetic RNG (death rotation axis); never perturbs the gameplay stream. */
  readonly cosmeticRng: Rng;
  /** Swapper landing notification (Swapper.cxx notifyLanding). No-op until Swapper lands. */
  notifyLanding(x: number, y: number, block: Block, combo: ComboTabulator): void;
  /** Start a garbage slab falling (Garbage::startFalling). No-op until Garbage physics lands. */
  startGarbageFalling(garbage: Garbage, combo: ComboTabulator | null, noHang: boolean): void;
}

// --- Block states (Block.h:33-38) ------------------------------------------

export const BS_STATIC = 1 << 0;
export const BS_SWAPPING = 1 << 1;
export const BS_FALLING = 1 << 2;
export const BS_DYING = 1 << 3;
export const BS_AWAKING = 1 << 4;
export const BS_SWAP_DIRECTION_MASK = 1 << 5;

// --- Pop directions (Block.h:41-44) ----------------------------------------

export const BR_DIRECTION_1 = 1 << 0;
export const BR_DIRECTION_2 = 1 << 1;
export const BR_DIRECTION_3 = 1 << 2;
export const BR_DIRECTION_4 = 1 << 3;

/**
 * A single block. Fields mirror `Block` (Block.h:46-109) one-to-one. Objects
 * are pooled in {@link BlockManager} and reused; initializers set only the
 * fields the C++ initializers set, so reused state is faithful.
 */
export class Block {
  /** Free-store id (index into the manager's store). `Block.h:74` */
  id = 0;
  /**
   * TS-only: how many times this pool slot has been (re)allocated. `id` alone is
   * a reusable slot index — the same `id` can name a different block after a
   * delete + allocate — so `(id, generation)` is the stable per-lifetime key the
   * client uses to match a sprite across ticks. Not a ported field; never in the
   * sim digest and never drawn from the RNG.
   */
  generation = 0;
  /** Block color/flavor (BF_*). `Block.h:77` */
  flavor = 0;
  /** Grid column; for a block between cells this is the lowest/left edge. `Block.h:81` */
  x = 0;
  /** Grid row. `Block.h:81` */
  y = 0;
  /** Fine vertical position: GC_STEPS_PER_GRID increments per cell. `Block.h:84` */
  f_y = 0;
  /** Block state (BS_*). `Block.h:87` */
  state = 0;
  /** Time until pop; also reused as scratch timing. `Block.h:90` */
  pop_alarm = 0;
  /** Combo currently involved with, if any. `Block.h:93` */
  current_combo: ComboTabulator | null = null;
  /** Time until awakening. `Block.h:96` */
  alarm = 0;
  /** Death rotation axis — render-only (cosmetic float; never in sim digest). `Block.h:99` */
  axis_x = 0;
  /** Death rotation axis — render-only. `Block.h:99` */
  axis_y = 0;
  /** Rotation direction on popping (BR_*). `Block.h:102` */
  pop_direction = 0;
  /** Color before popping. `Block.h:105` */
  pop_color = 0;
  /** Extreme-mode scratch (X-mode; deferred). `Block.h:108` */
  X = 0;

  /**
   * Initialize as a plain resting block and register it in the grid.
   * Mirrors `Block::initializeStatic` (Block.cxx:42). The wild/special-color
   * X-mode activation at the tail of the C++ version is deferred (Phase 6).
   */
  initializeStatic(x: number, y: number, flavor: number, grid: BlockGridSink): void {
    this.x = x;
    this.y = y;
    this.flavor = flavor;
    this.f_y = 0;

    this.state = BS_STATIC;
    this.alarm = 0;
    // pop_alarm intentionally not reset (matches C++ commented-out line).
    this.current_combo = null;

    grid.addBlock(x, y, this, GR_BLOCK);
  }

  /** Whether the block is resting and eligible for elimination checks (BS_STATIC). */
  isStatic(): boolean {
    return (this.state & BS_STATIC) !== 0;
  }

  /**
   * Switch the block's combo involvement to `newCombo` (leaving any previous
   * one). Mirrors `Block::beginComboInvolvement` (Block.h:57).
   */
  beginComboInvolvement(newCombo: ComboTabulator): void {
    if (this.current_combo) this.current_combo.decrementInvolvement();
    this.current_combo = newCombo;
    this.current_combo.incrementInvolvement();
  }

  /**
   * Leave `oldCombo` if that is the block's current combo. Mirrors
   * `Block::endComboInvolvement` (Block.h:65).
   */
  endComboInvolvement(oldCombo: ComboTabulator): void {
    if (this.current_combo && this.current_combo === oldCombo) {
      this.current_combo.decrementInvolvement();
      this.current_combo = null;
    }
  }

  /**
   * Initialize as an awaking block (a section of shattered garbage) and register
   * it in the grid as immutable. Mirrors `Block::initializeAwaking` (Block.cxx:64).
   * The block pops its appearance at `pop_delay` and finishes awaking at
   * `awake_delay`, after which `timeStep` returns it to play.
   */
  initializeAwaking(
    ctx: BlockSimContext,
    x: number,
    y: number,
    flavor: number,
    popDelay: number,
    awakeDelay: number,
    combo: ComboTabulator,
    popColor: number,
  ): void {
    this.x = x;
    this.y = y;
    this.flavor = flavor;
    this.f_y = 0;

    this.state = BS_AWAKING;
    this.alarm = ctx.clock.time_step + awakeDelay;
    this.pop_alarm = ctx.clock.time_step + popDelay;
    this.pop_direction = ctx.blocks.generatePopDirection();
    this.pop_color = popColor;
    this.current_combo = combo;

    combo.incrementInvolvement();
    ctx.awaking_count++;

    ctx.grid.addBlock(x, y, this, GR_IMMUTABLE);
  }

  /**
   * One tick of block physics. Mirrors `Block::timeStep` (Block.cxx:89): a
   * static block that has lost its support starts falling; an awaking block
   * counts down then returns to play; a falling block hangs then descends a
   * cell at a time and lands; a dying block counts down then pops and is
   * removed, pulling the block/garbage above into a combo fall.
   *
   * Called only for blocks at y >= 1 (GameSim iterates rows 1..H-1), so reads of
   * `y - 1` stay in bounds.
   */
  timeStep(ctx: BlockSimContext): void {
    const grid = ctx.grid;
    const now = ctx.clock.time_step;

    if (this.state & BS_STATIC) {
      // We may have to fall.
      if (grid.stateAt(this.x, this.y - 1) & GR_EMPTY) this.startFalling(ctx);
      else return;
    } else if (this.state & BS_AWAKING) {
      // pop_alarm only switches appearance (a sound cue in the C++).
      if (this.pop_alarm === now) this.pop_alarm = 0;

      if (this.alarm === now) {
        ctx.awaking_count--;
        // startFalling() and elimination checks look for BS_STATIC.
        this.state = BS_STATIC;

        if (grid.stateAt(this.x, this.y - 1) & GR_EMPTY) {
          this.startFalling(ctx, this.current_combo, true);
        } else {
          grid.changeState(this.x, this.y, this, GR_BLOCK);
          grid.requestEliminationCheck(this, this.current_combo);
        }
      } else {
        return;
      }
    }

    // Deal with all other states (note the fall-through from STATIC/AWAKING).

    if (this.state & BS_FALLING) {
      // Blocks below us have already been stepped this tick.
      if (this.alarm === now) this.alarm = 0; // hang alarm goes off

      if (this.alarm === 0) {
        if (this.f_y === 0) {
          if (grid.stateAt(this.x, this.y - 1) & GR_EMPTY) {
            // shift down one row
            this.y--;
            this.f_y = GC_STEPS_PER_GRID;
            grid.remove(this.x, this.y + 1, this);
            grid.addBlock(this.x, this.y, this, GR_FALLING);
          } else {
            // we've landed
            this.state = BS_STATIC;
            grid.changeState(this.x, this.y, this, GR_BLOCK);
            grid.requestEliminationCheck(this, this.current_combo);
            // if the block below is swapping, its combo may need switching
            if (this.current_combo) {
              ctx.notifyLanding(this.x, this.y, this, this.current_combo);
            }
          }
        }

        if (this.state & BS_FALLING) this.f_y -= GC_FALL_VELOCITY;
      }
    } else if (this.state & BS_DYING) {
      if (--this.alarm === 0) {
        ctx.dying_count--;
        grid.remove(this.x, this.y, this);

        // pull our upward neighbour into a combo fall
        if (this.y < GC_PLAY_HEIGHT - 1) {
          if (grid.stateAt(this.x, this.y + 1) & GR_BLOCK) {
            grid.blockAt(this.x, this.y + 1).startFalling(ctx, this.current_combo);
          } else if (grid.stateAt(this.x, this.y + 1) & GR_GARBAGE) {
            ctx.startGarbageFalling(grid.garbageAt(this.x, this.y + 1), this.current_combo, false);
          }
        }

        // a dying block always has a combo (set in startDying)
        this.current_combo!.decrementInvolvement();
        // SparkleManager death sparks + X-mode deactivation omitted (cosmetic).
        ctx.blocks.deleteBlock(this);
      } else if (this.alarm === GC_DYING_DELAY - 1) {
        // grab the elimination magnitude from our combo (used for spark count)
        this.pop_alarm = this.current_combo!.latest_magnitude;
      }
    }
  }

  /**
   * Begin a fall for a resting block, linking it to an elimination `combo` if
   * given, and cascade the fall up the column. Mirrors `Block::startFalling`
   * (Block.cxx:234). This is a no-op unless the block is BS_STATIC: a block that
   * is already falling (or swapping/dying) is left as-is, which also terminates
   * the upward cascade at the first non-resting block.
   */
  startFalling(ctx: BlockSimContext, combo: ComboTabulator | null = null, noHang = false): void {
    if (!(this.state & BS_STATIC)) return;

    this.state = BS_FALLING;

    // Grid element `state` is an *exclusive* value: a moving block is GR_FALLING
    // (or GR_HANGING | GR_FALLING / GR_IMMUTABLE) with GR_BLOCK cleared — exactly
    // as the C++ sets it. `resident_type` still reports GR_BLOCK, and
    // `state & GR_BLOCK` deliberately matches only *resting* blocks (so the
    // elimination scan and cascade skip moving ones). See grid.ts for the design.
    const grid = ctx.grid;
    if (noHang) {
      this.alarm = 0;
      grid.changeState(this.x, this.y, this, GR_FALLING);
    } else {
      this.alarm = ctx.clock.time_step + GC_HANG_DELAY;
      grid.changeState(this.x, this.y, this, GR_HANGING | GR_FALLING);
    }

    if (combo) this.beginComboInvolvement(combo);

    // cascade to the block/garbage directly above (passing our own combo)
    if (this.y < GC_PLAY_HEIGHT - 1) {
      if (grid.stateAt(this.x, this.y + 1) & GR_BLOCK) {
        grid.blockAt(this.x, this.y + 1).startFalling(ctx, this.current_combo, noHang);
      } else if (grid.stateAt(this.x, this.y + 1) & GR_GARBAGE) {
        ctx.startGarbageFalling(grid.garbageAt(this.x, this.y + 1), this.current_combo, noHang);
      }
    }
  }

  /**
   * Begin dying as part of an elimination. Mirrors `Block::startDying`
   * (Block.cxx:268). Sets the dying countdown and a cosmetic rotation axis.
   */
  startDying(ctx: BlockSimContext, combo: ComboTabulator, sparkNumber: number): void {
    void sparkNumber; // used only for the (omitted) death sound

    ctx.dying_count++;
    this.beginComboInvolvement(combo);
    this.state = BS_DYING;
    this.alarm = GC_DYING_DELAY;
    ctx.grid.changeState(this.x, this.y, this, GR_IMMUTABLE);

    // cosmetic death rotation axis — render-only, drawn from the unsynced
    // cosmetic RNG so it never perturbs the gameplay stream.
    const angle = 2 * Math.PI * ctx.cosmeticRng.numberFloat();
    this.axis_x = Math.cos(angle);
    this.axis_y = Math.sin(angle);
  }

  /**
   * Enter the swapping state, moving in `direction` (SA_LEFT/SA_RIGHT). Mirrors
   * `Block::startSwapping` (Block.cxx:293). The cell becomes immutable until the
   * swap completes.
   */
  startSwapping(ctx: BlockSimContext, direction: number): void {
    this.state = BS_SWAPPING | (direction & SA_RIGHT ? BS_SWAP_DIRECTION_MASK : 0);
    ctx.grid.changeState(this.x, this.y, this, GR_IMMUTABLE);
  }

  /**
   * Complete a swap, re-homing at column `sX` as a static block. Mirrors
   * `Block::finishSwapping` (Block.cxx:302).
   */
  finishSwapping(ctx: BlockSimContext, sX: number): void {
    this.state = BS_STATIC;
    this.x = sX;
    ctx.grid.addBlock(this.x, this.y, this, GR_BLOCK);
  }
}

/**
 * Owns the fixed-size block store and hands out/reclaims block ids. Ported from
 * the store portion of `BlockManager` (BlockManager.h/.cxx). Placement into the
 * grid is delegated to the injected {@link BlockGridSink} (the Grid), mirroring
 * the C++ calls to `Grid::addBlock`.
 */
export class BlockManager {
  /** Number of live blocks. `BlockManager.h:198` */
  block_count = 0;
  /** Pooled block objects, one per store slot. `BlockManager.h:199` */
  readonly blockStore: Block[];
  /** Occupancy map over the store. `BlockManager.h:200` */
  readonly storeMap: boolean[];

  /** Next pop-direction in the round-robin sequence. `BlockManager.h:228` */
  private next_pop_direction = BR_DIRECTION_1;

  // Creep-generation flavor history — the "no three in a row (globally or per
  // column)" avoidance state. `BlockManager.h:230-233, 202`.
  private last_flavor_c = 0;
  private second_to_last_flavor_c = 0;
  /** Per-column last creep base-flavor. Public: the initial board fill seeds it. `BlockManager.h:202` */
  readonly last_row_c: number[];
  /** Per-column second-to-last creep base-flavor. Public: seeded by the board fill. `BlockManager.h:202` */
  readonly second_to_last_row_c: number[];
  // Awaking-block flavor history (the `*_a` set) — the same no-three-in-a-row
  // avoidance, but for blocks minted when garbage shatters. `BlockManager.h:230-233`.
  private last_flavor_a = 0;
  private second_to_last_flavor_a = 0;
  private readonly last_row_a: number[];
  private readonly second_to_last_row_a: number[];
  /** Column chosen to receive a special block this creep row, or -1. `BlockManager.h:233` */
  private special_block_location = -1;

  /**
   * X-mode (extreme) flag. When false (default) creep generation uses the
   * standard path; the X-mode special-block generation is deferred (Phase 6).
   */
  xMode = false;

  constructor(
    private readonly grid: BlockGridSink,
    /** Shared gameplay RNG stream (the sim owns one; draw order is load-bearing). */
    readonly rng: Rng,
  ) {
    this.blockStore = new Array<Block>(GC_BLOCK_STORE_SIZE);
    this.storeMap = new Array<boolean>(GC_BLOCK_STORE_SIZE);
    this.last_row_c = new Array<number>(GC_PLAY_WIDTH).fill(0);
    this.second_to_last_row_c = new Array<number>(GC_PLAY_WIDTH).fill(0);
    this.last_row_a = new Array<number>(GC_PLAY_WIDTH).fill(0);
    this.second_to_last_row_a = new Array<number>(GC_PLAY_WIDTH).fill(0);
    for (let n = 0; n < GC_BLOCK_STORE_SIZE; n++) {
      this.blockStore[n] = new Block();
      this.blockStore[n]!.id = n;
      this.storeMap[n] = false;
    }
    this.gameStart();
  }

  /**
   * Reset the store for a new game. Mirrors `BlockManager::gameStart`
   * (BlockManager.cxx:49) for the parts implemented so far; the creep
   * flavor-history bookkeeping is added with `newCreepRow` in Phase 1.4.
   */
  gameStart(): void {
    this.block_count = 0;
    for (let n = 0; n < GC_BLOCK_STORE_SIZE; n++) {
      this.storeMap[n] = false;
      this.blockStore[n]!.id = n;
      this.blockStore[n]!.generation = 0;
    }

    this.last_flavor_a = 0;
    this.second_to_last_flavor_a = 0;
    this.last_flavor_c = 0;
    this.second_to_last_flavor_c = 0;
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      this.last_row_a[x] = 0;
      this.second_to_last_row_a[x] = 0;
      this.last_row_c[x] = 0;
      this.second_to_last_row_c[x] = 0;
    }

    this.next_pop_direction = BR_DIRECTION_1;
    this.special_block_location = -1;
  }

  /** The pooled block for an id. Fails fast on an out-of-range id. */
  block(id: number): Block {
    if (id < 0 || id >= GC_BLOCK_STORE_SIZE) {
      throw new RangeError(`BlockManager: block id ${id} out of range`);
    }
    return this.blockStore[id]!;
  }

  /**
   * Allocate a resting block at (x, y). Mirrors the static-flavor
   * `BlockManager::newBlock` (BlockManager.h:62). No-op when the store is full,
   * exactly as the C++ (silently drops).
   */
  newBlock(x: number, y: number, flavor: number): void {
    if (this.block_count === GC_BLOCK_STORE_SIZE) return;

    const id = this.findFreeId();
    this.allocateId(id);
    try {
      this.blockStore[id]!.initializeStatic(x, y, flavor, this.grid);
    } catch (e) {
      // Roll back so a failed placement (occupied/out-of-bounds cell) doesn't
      // permanently leak a pool slot.
      this.freeId(id);
      throw e;
    }
  }

  /**
   * Allocate an awaking block at (x, y) — a block minted when garbage shatters.
   * Mirrors `BlockManager::newAwakingBlock` (BlockManager.cxx:71): pick a flavor
   * avoiding three-in-a-row (globally and per column) against the awaking-block
   * history, then build it in the awaking state. One gameplay RNG draw (retried
   * on a repeat), so draw order is load-bearing.
   *
   * The RNG draw and history update happen *before* the store-full check — on
   * purpose, and faithfully: the C++ `newAwakingBlock` always draws and updates
   * history, then delegates to `newBlock`, whose store-full guard is *internal*.
   * So the reference consumes this draw even when the store is full. Skipping it
   * to make this a "true no-op on exhaustion" would drop a draw the C++ makes and
   * desync the shared gameplay stream — the opposite of the intent. (The store
   * holds one slot per cell, so exhaustion doesn't arise in normal play anyway.)
   */
  newAwakingBlock(
    ctx: BlockSimContext,
    x: number,
    y: number,
    popDelay: number,
    awakeDelay: number,
    combo: ComboTabulator,
    popColor: number,
  ): void {
    let flavor: number;
    do {
      flavor = this.rng.number(BF_NUMBER_NORMAL);
    } while (
      (flavor === this.last_flavor_a && this.last_flavor_a === this.second_to_last_flavor_a) ||
      (flavor === this.last_row_a[x] && this.last_row_a[x] === this.second_to_last_row_a[x])
    );

    this.second_to_last_row_a[x] = this.last_row_a[x]!;
    this.last_row_a[x] = flavor;
    this.second_to_last_flavor_a = this.last_flavor_a;
    this.last_flavor_a = flavor;

    // Store-full guard mirrors the C++ `newBlock` internal check (see above).
    if (this.block_count === GC_BLOCK_STORE_SIZE) return;

    const id = this.findFreeId();
    this.allocateId(id);
    try {
      this.blockStore[id]!.initializeAwaking(
        ctx,
        x,
        y,
        flavor,
        popDelay,
        awakeDelay,
        combo,
        popColor,
      );
    } catch (e) {
      this.freeId(id);
      throw e;
    }
  }

  /**
   * Generate a fresh bottom creep row (row 0). Picks whether/where a special
   * block goes, then fills each column right-to-left. Mirrors
   * `BlockManager::newCreepRow` (BlockManager.h:45).
   *
   * RNG draw order is load-bearing: one `chanceIn`, then possibly one
   * `number(GC_PLAY_WIDTH)`, then per-column draws from x = WIDTH-1 down to 0.
   */
  newCreepRow(): void {
    const noSpecialChance = this.xMode
      ? GC_X_NO_SPECIAL_BLOCK_CHANCE_IN
      : GC_NO_SPECIAL_BLOCK_CHANCE_IN;

    if (this.rng.chanceIn(noSpecialChance)) {
      this.special_block_location = -1;
    } else {
      this.special_block_location = this.rng.number(GC_PLAY_WIDTH);
    }

    for (let x = GC_PLAY_WIDTH; x--;) this.newCreepBlock(x);
  }

  /**
   * Generate one creep block for column `x` at row 0. Mirrors
   * `BlockManager::newCreepBlock` (BlockManager.cxx:91), non-X path. The
   * do/while enforces "no three of the same flavor in a row, globally or within
   * the column". The X-mode special-block generation (the big `switch` on
   * `Random::number(10)`) is deferred to Phase 6.
   */
  private newCreepBlock(x: number): void {
    let flavor = 0;

    const repeats = (f: number): boolean =>
      (f === this.last_flavor_c && this.last_flavor_c === this.second_to_last_flavor_c) ||
      (f === this.last_row_c[x]! && this.last_row_c[x] === this.second_to_last_row_c[x]);

    if (x !== this.special_block_location) {
      do {
        flavor = this.rng.number(BF_NUMBER_NORMAL);
      } while (repeats(flavor));

      this.second_to_last_row_c[x] = this.last_row_c[x]!;
      this.last_row_c[x] = flavor;
      this.second_to_last_flavor_c = this.last_flavor_c;
      this.last_flavor_c = flavor;
    } else {
      if (this.xMode) {
        throw new Error('X-mode creep special-block generation is not yet ported (Phase 6)');
      }

      let base_flavor = 0;
      if (
        (BF_GRAY === this.last_flavor_c && this.last_flavor_c === this.second_to_last_flavor_c) ||
        (BF_GRAY === this.last_row_c[x]! && this.last_row_c[x] === this.second_to_last_row_c[x])
      ) {
        do {
          flavor = this.rng.number(BF_NUMBER_NORMAL);
        } while (repeats(flavor));
      } else {
        flavor = BF_GRAY;
      }
      base_flavor = flavor;

      this.second_to_last_row_c[x] = this.last_row_c[x]!;
      this.last_row_c[x] = base_flavor;
      this.second_to_last_flavor_c = this.last_flavor_c;
      this.last_flavor_c = base_flavor;
    }

    this.newBlock(x, 0, flavor);
  }

  /** Return a block's slot to the free pool. Mirrors `BlockManager::deleteBlock`. */
  deleteBlock(block: Block): void {
    this.freeId(block.id);
  }

  /**
   * Shift every live block up one row. Mirrors `BlockManager::shiftUp`
   * (BlockManager.h:91) — walks the occupancy map, incrementing each live
   * block's y. Used by creep.
   */
  shiftUp(): void {
    let c = this.block_count;
    // Scan the whole fixed store (not just until c hits 0): this shifts every
    // live block even if block_count is undercounted, and lets c go negative so
    // the final check catches both under- and over-count corruption.
    for (let n = 0; n < GC_BLOCK_STORE_SIZE; n++) {
      if (this.storeMap[n]) {
        c--;
        this.blockStore[n]!.y++;
      }
    }
    if (c !== 0) {
      throw new Error(
        `BlockManager.shiftUp: block_count (${this.block_count}) out of sync with storeMap`,
      );
    }
  }

  /**
   * Advance and return the next pop direction (round-robin over the 4 BR_*
   * bits). Mirrors `BlockManager::generatePopDirection()` (BlockManager.h:101).
   */
  generatePopDirection(): number {
    if (this.next_pop_direction & BR_DIRECTION_4) {
      return (this.next_pop_direction = BR_DIRECTION_1);
    }
    return (this.next_pop_direction <<= 1);
  }

  /**
   * Advance the pop-direction sequence and return the *first* advanced value,
   * then advance it `n - 1` more times. Mirrors the `generatePopDirection(int n)`
   * overload (BlockManager.h:109): it always advances at least once (the value
   * returned is one step past the previous state), then steps `n - 1` further.
   * `n` is expected to be >= 1; the `--n > 0` guard makes a non-positive `n`
   * behave as `n == 1` (a single advance) rather than spinning forever like the
   * C++ `while (--n)` would.
   */
  generatePopDirectionN(n: number): number {
    let npd: number;
    if (this.next_pop_direction & BR_DIRECTION_4) {
      npd = this.next_pop_direction = BR_DIRECTION_1;
    } else {
      npd = this.next_pop_direction <<= 1;
    }
    while (--n > 0) {
      if (this.next_pop_direction & BR_DIRECTION_4) {
        this.next_pop_direction = BR_DIRECTION_1;
      } else {
        this.next_pop_direction <<= 1;
      }
    }
    return npd;
  }

  /**
   * First free slot (linear scan, matching the C++). `BlockManager.h:207`.
   * Bounded by the store size and throws if the pool is unexpectedly full, so a
   * corrupted `block_count` can't return an out-of-range id and start writing
   * past the fixed-size pool. Callers already guard `block_count === STORE_SIZE`.
   */
  private findFreeId(): number {
    let n = 0;
    while (n < GC_BLOCK_STORE_SIZE && this.storeMap[n]) n++;
    if (n === GC_BLOCK_STORE_SIZE) throw new Error('BlockManager: block store exhausted');
    return n;
  }

  private allocateId(id: number): void {
    // Restores the C++ `assert(!storeMap[id])` — a double-allocate would
    // silently corrupt block_count and the store-full guard.
    if (this.storeMap[id]) throw new Error(`BlockManager: double-allocate of id ${id}`);
    this.storeMap[id] = true;
    this.block_count++;
    // Bump the slot's lifetime counter so reused ids get a fresh (id, generation).
    this.blockStore[id]!.generation++;
  }

  private freeId(id: number): void {
    // Restores the C++ `assert(storeMap[id])` — a double-free corrupts state.
    if (!this.storeMap[id]) throw new Error(`BlockManager: double-free of id ${id}`);
    this.storeMap[id] = false;
    this.block_count--;
  }
}
