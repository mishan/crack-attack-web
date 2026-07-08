/**
 * block.ts
 *
 * The Block object and its fixed-size store/manager. Ported from `Block.{h,cxx}`
 * and the store half of `BlockManager.{h,cxx}`.
 *
 * Scope for this phase (1.3): the data model and allocation only — the object
 * store, id allocation, `initializeStatic`, and the simple store operations
 * (delete, shiftUp, pop-direction sequencing). Deferred to later phases:
 *   - RNG-driven creep generation (`newCreepRow`/`newCreepBlock`) → Phase 1.4
 *   - awaking blocks + combo involvement (`initializeAwaking`, ...) → Phase 1.5
 *   - per-tick physics (`timeStep`, falling/dying/swapping) → Phase 1.6
 *
 * Architectural departure from the C++ (as the port plan calls for): the manager
 * is an instance owning its store, not a static singleton, so many sims can
 * coexist (AI, server verification, replays, parallel tests). The logic is
 * unchanged.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_BLOCK_STORE_SIZE } from './constants.js';
import type { ComboTabulator } from './combo.js';
import { GR_BLOCK, type BlockGridSink } from './grid.js';

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

  constructor(private readonly grid: BlockGridSink) {
    this.blockStore = new Array<Block>(GC_BLOCK_STORE_SIZE);
    this.storeMap = new Array<boolean>(GC_BLOCK_STORE_SIZE);
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
    }
    this.next_pop_direction = BR_DIRECTION_1;
  }

  /** The pooled block for an id. */
  block(id: number): Block {
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
    this.blockStore[id]!.initializeStatic(x, y, flavor, this.grid);
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
    for (let n = 0; c; n++) {
      if (this.storeMap[n]) {
        c--;
        this.blockStore[n]!.y++;
      }
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
   * Return the current pop direction, then advance the sequence by `n` steps.
   * Mirrors the `generatePopDirection(int n)` overload (BlockManager.h:109).
   */
  generatePopDirectionN(n: number): number {
    let npd: number;
    if (this.next_pop_direction & BR_DIRECTION_4) {
      npd = this.next_pop_direction = BR_DIRECTION_1;
    } else {
      npd = this.next_pop_direction <<= 1;
    }
    while (--n) {
      if (this.next_pop_direction & BR_DIRECTION_4) {
        this.next_pop_direction = BR_DIRECTION_1;
      } else {
        this.next_pop_direction <<= 1;
      }
    }
    return npd;
  }

  /** First free slot (linear scan, matching the C++). `BlockManager.h:207` */
  private findFreeId(): number {
    let n = 0;
    while (this.storeMap[n]) n++;
    return n;
  }

  private allocateId(id: number): void {
    this.storeMap[id] = true;
    this.block_count++;
  }

  private freeId(id: number): void {
    this.storeMap[id] = false;
    this.block_count--;
  }
}
