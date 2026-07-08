/**
 * grid.ts
 *
 * The playfield: a GC_PLAY_WIDTH × GC_PLAY_HEIGHT array of grid elements, each
 * naming its occupancy state and (optionally) a resident Block or Garbage.
 * Ported from `Grid.{h,cxx}`.
 *
 * Scope for this phase (1.3): the element store, its state flags, the inline
 * accessors, the top-row trackers, and the check-registry → combo linkage.
 * Deferred:
 *   - `Grid::timeStep` physics (falling/hanging/shatter/elimination) → Phase 1.6
 *   - RNG-driven initial board generation in `Grid::gameStart` → Phase 1.4
 *   - `LevelLights` integration inside `notifyImpact` → Phase 1.4
 *   - `shatterGarbage` / `handleEliminationCheckRequest` → Phase 1.5
 *
 * As with the managers, this is an instance (the future `GameSim` owns one),
 * not a static singleton.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_BLOCK_STORE_SIZE, GC_PLAY_HEIGHT, GC_PLAY_WIDTH, GC_SAFE_HEIGHT } from './constants.js';
import type { Block } from './block.js';
import type { Garbage } from './garbage.js';
import type { ComboTabulator } from './combo.js';
import { flavorMatch } from './flavors.js';

// --- Grid element states (Grid.h:37-43) ------------------------------------

export const GR_EMPTY = 1 << 0;
export const GR_BLOCK = 1 << 1;
export const GR_GARBAGE = 1 << 2;
export const GR_FALLING = 1 << 3;
export const GR_IMMUTABLE = 1 << 4;
export const GR_SHATTERING = 1 << 5;
export const GR_HANGING = 1 << 6;

// --- Pattern types (Grid.h:46-47) ------------------------------------------

export const PT_HORIZONTAL = 1 << 0;
export const PT_VERTICAL = 1 << 1;

/** What a cell may hold. `null` when empty. */
export type Resident = Block | Garbage | null;

/** One playfield cell. Mirrors `GridElement` (Grid.h:59-64). */
export class GridElement {
  state = GR_EMPTY;
  resident_type = GR_EMPTY;
  resident: Resident = null;
}

/** One entry in the elimination check registry. Mirrors `CheckRegistryElement` (Grid.h:53-57). */
export class CheckRegistryElement {
  mark = false;
  combo: ComboTabulator | null = null;
}

/** Narrow view of the grid used by {@link Block} to register itself. */
export interface BlockGridSink {
  addBlock(x: number, y: number, resident: Block, state: number): void;
}

/** Narrow view of the grid used by {@link Garbage} to register itself. */
export interface GarbageGridSink {
  addGarbage(x: number, y: number, resident: Garbage, state: number): void;
}

/**
 * The playfield store and its accessors. Cells are stored column-major in a
 * flat array (`index = x * GC_PLAY_HEIGHT + y`) so `[x][y]` maps directly.
 */
export class Grid implements BlockGridSink, GarbageGridSink {
  private readonly elements: GridElement[];
  private readonly check_registry: CheckRegistryElement[];
  private check_count = 0;

  /**
   * Top row with anything in it (including initially falling garbage); drives
   * garbage drop height. Updated by physics and garbage spawning. `Grid.h:203`
   */
  top_occupied_row = 0;
  /**
   * Top row holding blocks or landed garbage; drives level lights and the
   * safe-height check. `Grid.h:207`
   */
  top_effective_row = 0;
  /** Whether a gray shatter is in progress. `Grid.h:209` */
  gray_shatter = false;

  constructor() {
    this.elements = new Array<GridElement>(GC_PLAY_WIDTH * GC_PLAY_HEIGHT);
    for (let i = 0; i < this.elements.length; i++) this.elements[i] = new GridElement();

    this.check_registry = new Array<CheckRegistryElement>(GC_BLOCK_STORE_SIZE);
    for (let i = 0; i < GC_BLOCK_STORE_SIZE; i++) {
      this.check_registry[i] = new CheckRegistryElement();
    }

    this.gameStart();
  }

  /**
   * Clear the playfield to empty and reset trackers. Mirrors the clearing half
   * of `Grid::gameStart` (Grid.cxx:48); the RNG-driven initial block fill that
   * follows in the C++ is deferred to Phase 1.4.
   */
  gameStart(): void {
    this.check_count = 0;
    this.top_occupied_row = 0;
    this.top_effective_row = 0;
    this.gray_shatter = false;

    for (let i = 0; i < this.elements.length; i++) {
      const e = this.elements[i]!;
      e.state = GR_EMPTY;
      e.resident_type = GR_EMPTY;
      e.resident = null;
    }
    for (let i = 0; i < this.check_registry.length; i++) {
      const c = this.check_registry[i]!;
      c.mark = false;
      c.combo = null;
    }
  }

  private index(x: number, y: number): number {
    return x * GC_PLAY_HEIGHT + y;
  }

  private at(x: number, y: number): GridElement {
    return this.elements[this.index(x, y)]!;
  }

  /** `Grid::stateAt` (Grid.h:95). */
  stateAt(x: number, y: number): number {
    return this.at(x, y).state;
  }

  /** `Grid::residentTypeAt` (Grid.h:100). */
  residentTypeAt(x: number, y: number): number {
    return this.at(x, y).resident_type;
  }

  /** The resident Block at (x, y). Mirrors `Grid::blockAt` (Grid.h:105). */
  blockAt(x: number, y: number): Block {
    const e = this.at(x, y);
    if (e.resident_type !== GR_BLOCK) {
      throw new Error(`blockAt(${x}, ${y}): cell does not hold a block`);
    }
    return e.resident as Block;
  }

  /** The resident Garbage at (x, y). Mirrors `Grid::garbageAt` (Grid.h:111). */
  garbageAt(x: number, y: number): Garbage {
    const e = this.at(x, y);
    if (e.resident_type !== GR_GARBAGE) {
      throw new Error(`garbageAt(${x}, ${y}): cell does not hold garbage`);
    }
    return e.resident as Garbage;
  }

  /** Flavor of the block at (x, y). Mirrors `Grid::flavorAt` (Grid.h:129). */
  flavorAt(x: number, y: number): number {
    return this.blockAt(x, y).flavor;
  }

  /**
   * Whether `block` matches the block at (x, y) for elimination. Mirrors
   * `Grid::matchAt` (Grid.h:135), delegating to the flavor rules.
   */
  matchAt(x: number, y: number, block: Block): boolean {
    return flavorMatch(block.flavor, this.blockAt(x, y).flavor);
  }

  /** Change only the state flag of an occupied cell. Mirrors `Grid::changeState` (Grid.h:141). */
  changeState(x: number, y: number, resident: Resident, state: number): void {
    const e = this.at(x, y);
    if (e.resident !== resident) throw new Error('changeState: resident mismatch');
    e.state = state;
  }

  /** Place a block into an empty cell. Mirrors `Grid::addBlock` (Grid.h:147). */
  addBlock(x: number, y: number, resident: Block, state: number): void {
    const e = this.at(x, y);
    if (!(e.state & GR_EMPTY)) throw new Error(`addBlock(${x}, ${y}): cell not empty`);
    e.resident = resident;
    e.resident_type = GR_BLOCK;
    e.state = state;
  }

  /** Place garbage into an empty cell. Mirrors `Grid::addGarbage` (Grid.h:157). */
  addGarbage(x: number, y: number, resident: Garbage, state: number): void {
    const e = this.at(x, y);
    if (!(e.state & GR_EMPTY)) throw new Error(`addGarbage(${x}, ${y}): cell not empty`);
    e.resident = resident;
    e.resident_type = GR_GARBAGE;
    e.state = state;
  }

  /** Empty a cell. Mirrors `Grid::remove` (Grid.h:167). */
  remove(x: number, y: number, resident: Resident): void {
    const e = this.at(x, y);
    if (e.resident !== resident) throw new Error('remove: resident mismatch');
    e.resident = null;
    e.resident_type = GR_EMPTY;
    e.state = GR_EMPTY;
  }

  /**
   * Mark a block for an elimination check next tick, optionally attributing it
   * to a combo. Mirrors `Grid::requestEliminationCheck` (Grid.h:175).
   */
  requestEliminationCheck(block: Block, combo: ComboTabulator | null = null): void {
    const c = this.check_registry[block.id]!;
    c.mark = true;
    c.combo = combo;
    this.check_count++;
  }

  /** Number of outstanding elimination checks (test/inspection helper). */
  get checkCount(): number {
    return this.check_count;
  }

  /** Registry entry for a block id (test/inspection helper). */
  checkRegistryOf(id: number): CheckRegistryElement {
    return this.check_registry[id]!;
  }

  /** Whether the effective top has reached the safe height. Mirrors `Grid::checkSafeHeightViolation` (Grid.h:183). */
  checkSafeHeightViolation(): boolean {
    return this.top_effective_row >= GC_SAFE_HEIGHT - 1;
  }

  /**
   * Note a landing/impact of `height` rows at row `y`, raising the effective
   * top if needed. Mirrors `Grid::notifyImpact` (Grid.h:188). The `LevelLights`
   * calls in the C++ version are deferred to Phase 1.4; the effective-row
   * tracking they depend on is implemented here.
   */
  notifyImpact(y: number, height: number): void {
    const impact_top = y + height - 1;
    if (this.top_effective_row < impact_top) {
      this.top_effective_row = impact_top;
      // TODO(Phase 1.4): LevelLights.levelRaise(this.top_effective_row)
    }
    // TODO(Phase 1.4): LevelLights.notifyImpact(y, height)
  }
}
