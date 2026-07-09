/**
 * grid.ts
 *
 * The playfield: a GC_PLAY_WIDTH × GC_PLAY_HEIGHT array of grid elements, each
 * naming its occupancy state and (optionally) a resident Block or Garbage.
 * Ported from `Grid.{h,cxx}`.
 *
 * Progression: the element store + accessors + check-registry linkage (1.3);
 * `shiftGridUp` grid rise (1.4); and `timeStep` + `handleEliminationCheckRequest`
 * — the block-pattern elimination detector, including garbage shattering
 * (`shatterGarbage` + the shatter-synchronization traversal) — plus the top-row
 * recompute (1.6, this file). The RNG initial board fill lives in `board.ts`.
 * Deferred:
 *   - `LevelLights` integration (Displayer/Communicator subsystem) → Phase 2
 *
 * As with the managers, this is an instance (GameSim owns one), not a static
 * singleton.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  GC_BLOCK_STORE_SIZE,
  GC_FINAL_POP_DELAY,
  GC_INITIAL_POP_DELAY,
  GC_INTERNAL_POP_DELAY,
  GC_MIN_PATTERN_LENGTH,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
} from './constants.js';
import type { Block, BlockSimContext } from './block.js';
import type { ComboManager } from './comboManager.js';
import type { Garbage, GarbageManager } from './garbage.js';
import type { ComboTabulator } from './combo.js';
import { HASH_NONE, type StateHasher } from './digest.js';
import type { SignSink } from './signs.js';
import { GF_BLACK, flavorMatch, isColorlessFlavor } from './flavors.js';

// --- Grid element states (Grid.h:37-43) ------------------------------------
//
// A cell's `state` is a bitmask of GR_* flags (e.g. GR_HANGING | GR_FALLING),
// but GR_BLOCK is used *disjointly* from the movement flags: a resting block
// cell has state GR_BLOCK, and once the block moves the GR_BLOCK bit is cleared
// and replaced by a movement state — GR_FALLING, GR_HANGING | GR_FALLING,
// GR_IMMUTABLE, or GR_SHATTERING (matching the C++ `Grid::changeState`/`addBlock`
// calls exactly). So GR_BLOCK is never combined with a movement flag. The
// "is this cell a block at all?" question is answered by `resident_type` (which
// stays GR_BLOCK for a block in any state), while `state & GR_BLOCK` deliberately
// matches only *resting* blocks — the elimination scan relies on this to avoid
// matching falling/dying blocks.

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
 * The environment `Grid.timeStep` needs to resolve elimination checks: the
 * block-physics context (grid/clock/block store/counters, for `startDying`)
 * plus the combo store. Implemented by `GameSim`.
 */
export interface GridSimContext extends BlockSimContext {
  readonly combos: ComboManager;
  /** Garbage store — the elimination detector shatters touching garbage into it. */
  readonly garbageStore: GarbageManager;
  /** Optional cosmetic sign destination (chain-multiplier reward signs). */
  readonly signSink?: SignSink;
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

  // Scratch state for a single shatter cascade (Grid.h:226-228). Reset at the
  // start of each elimination; used while marking connected garbage.
  private shatter_count = 0;
  private shatter_top = 0;
  private shatter_bottom = GC_PLAY_HEIGHT;

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
    // Fail fast with a clear error rather than silently reading a wrong cell
    // (the flat index would fold an out-of-range coordinate onto another cell)
    // or crashing obscurely via the non-null assertion.
    if (x < 0 || x >= GC_PLAY_WIDTH || y < 0 || y >= GC_PLAY_HEIGHT) {
      throw new RangeError(`Grid cell (${x}, ${y}) out of bounds`);
    }
    return this.elements[this.index(x, y)]!;
  }

  private registryOf(id: number): CheckRegistryElement {
    if (id < 0 || id >= this.check_registry.length) {
      throw new RangeError(`Grid check-registry id ${id} out of bounds`);
    }
    return this.check_registry[id]!;
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

  /**
   * Change only the state flag of a cell whose resident matches `resident`.
   * Mirrors `Grid::changeState` (Grid.h:141), including its `resident == arg`
   * assert. Passing `resident = null` targets an empty cell on purpose: the
   * Swapper marks an empty swap-partner cell GR_IMMUTABLE so nothing falls into
   * it mid-swap. A null argument on a *non-empty* cell still throws (mismatch).
   */
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
   *
   * Divergence from the C++ (intentional): the original increments `check_count`
   * unconditionally, so requesting the same still-marked block twice inflates
   * the count above the number of unique marks — the drain loop in `timeStep`
   * (`for (n = 0; check_count; n++)`) then never settles. We only count a block
   * once until it is drained, keeping `check_count` equal to the number of
   * marked entries. Observable behavior is identical when a block isn't
   * double-requested before draining (the normal case).
   */
  requestEliminationCheck(block: Block, combo: ComboTabulator | null = null): void {
    const c = this.registryOf(block.id);
    if (!c.mark) this.check_count++;
    c.mark = true;
    c.combo = combo;
  }

  /** Number of outstanding elimination checks (test/inspection helper). */
  get checkCount(): number {
    return this.check_count;
  }

  /** Registry entry for a block id (test/inspection helper). */
  checkRegistryOf(id: number): CheckRegistryElement {
    return this.registryOf(id);
  }

  /**
   * Feed the playfield into the sim digest (digest.ts): every cell's state,
   * resident type, and resident identity; the top-row trackers; and the
   * check registry (marks pending next tick are gameplay state). Pure.
   * The shatter scratch fields (`shatter_*`, `gray_shatter`) are excluded:
   * they are reset at the start of each elimination, so their values between
   * ticks never influence future behavior.
   */
  hashState(h: StateHasher): void {
    h.add(this.top_occupied_row);
    h.add(this.top_effective_row);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
        const e = this.elements[this.index(x, y)]!;
        h.add(e.state);
        h.add(e.resident_type);
        h.add(e.resident ? e.resident.id : HASH_NONE);
      }
    }
    h.add(this.check_count);
    for (let n = 0; n < this.check_registry.length; n++) {
      const c = this.check_registry[n]!;
      h.addBool(c.mark);
      h.add(c.combo ? c.combo.id : HASH_NONE);
    }
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
      // TODO(LevelLights): levelRaise(this.top_effective_row) — LevelLights is a
      // display/netcode subsystem (Displayer + Communicator), deferred to Phase 2.
    }
    // TODO(LevelLights): notifyImpact(y, height)
  }

  /**
   * Shift the whole board up one grid cell, opening an empty bottom row for a
   * new creep row. Returns false (no shift) when the stack already reaches the
   * top. Mirrors the grid-array half of `Grid::shiftGridUp` (Grid.cxx:339).
   *
   * The C++ version also calls `BlockManager::shiftUp`, `GarbageManager::shiftUp`,
   * `Swapper::shiftUp`, and `LevelLights::levelRaise`. Those cross-subsystem
   * side-effects are composed by {@link shiftBoardUp} (board.ts) in the same
   * order, keeping this method a pure grid operation.
   */
  shiftGridUp(): boolean {
    if (this.top_occupied_row === GC_PLAY_HEIGHT - 1) return false;

    // Copy rows upward from the top down, so no source is clobbered before use.
    for (let y = this.top_occupied_row + 1; y--;) {
      for (let x = GC_PLAY_WIDTH; x--;) {
        const src = this.at(x, y);
        const dst = this.at(x, y + 1);
        dst.state = src.state;
        dst.resident_type = src.resident_type;
        dst.resident = src.resident;
      }
    }

    // Clear the new bottom row. (The C++ only does this under NDEBUG-off; our
    // accessors always enforce the empty invariant, so we always clear.)
    for (let x = GC_PLAY_WIDTH; x--;) {
      const e = this.at(x, 0);
      e.state = GR_EMPTY;
      e.resident_type = GR_EMPTY;
      e.resident = null;
    }

    this.top_occupied_row++;
    this.top_effective_row++;
    // TODO(LevelLights): levelRaise(this.top_effective_row) — deferred (Phase 2).

    return true;
  }

  /**
   * One tick of grid logic. Mirrors `Grid::timeStep` (Grid.cxx:104): drain the
   * pending elimination checks (detecting patterns and starting matched blocks
   * dying), then recompute the top-occupied and top-effective rows.
   */
  timeStep(ctx: GridSimContext): void {
    // Process elimination check requests. Bounded by the registry size so a
    // corrupted check_count can't run away.
    for (let n = 0; this.check_count > 0 && n < this.check_registry.length; n++) {
      const entry = this.check_registry[n]!;
      if (!entry.mark) continue;
      entry.mark = false;
      this.check_count--;

      const block = ctx.blocks.block(n);
      // only still-static blocks are eligible
      if (!block.isStatic()) continue;

      this.handleEliminationCheckRequest(ctx, block, block.current_combo ?? entry.combo);
    }

    // Recompute top_occupied_row: highest row holding anything. Scan down from
    // the current value; floor at 0 (the creep row is always occupied in play).
    this.top_occupied_row++;
    for (;;) {
      this.top_occupied_row--;
      if (this.top_occupied_row <= 0) break;
      let occupied = false;
      for (let x = GC_PLAY_WIDTH; x--;) {
        if (!(this.stateAt(x, this.top_occupied_row) & GR_EMPTY)) {
          occupied = true;
          break;
        }
      }
      if (occupied) break;
    }

    // Recompute top_effective_row: highest row holding a block or *landed*
    // garbage (initially falling garbage doesn't count). LevelLights::levelLower
    // on a drop is deferred (Phase 2).
    this.top_effective_row++;
    for (;;) {
      this.top_effective_row--;
      if (this.top_effective_row <= 0) break;
      let effective = false;
      for (let x = GC_PLAY_WIDTH; x--;) {
        const rt = this.residentTypeAt(x, this.top_effective_row);
        if (rt & GR_EMPTY) continue;
        if (rt & GR_GARBAGE && this.garbageAt(x, this.top_effective_row).initial_fall) continue;
        effective = true;
        break;
      }
      if (effective) break;
    }
  }

  /**
   * Detect and resolve an elimination pattern kernelled at `block`. Mirrors
   * `Grid::handleEliminationCheckRequest` (Grid.cxx:154): scan four directions
   * for same-flavor runs, and if a run of >= GC_MIN_PATTERN_LENGTH exists in
   * either axis, start every block in the pattern dying and report the combo.
   *
   * Garbage touching the pattern is shattered: `shatterGarbage` marks the
   * connected garbage, then a synchronization pass converts each slab into
   * awaking blocks/garbage with staggered pop timers.
   */
  private handleEliminationCheckRequest(
    ctx: GridSimContext,
    block: Block,
    combo: ComboTabulator | null,
  ): void {
    const x = block.x;
    const y = block.y;

    // Extend the run left/right/down/up while cells are matching blocks.
    let l = x;
    while (l > 0 && this.stateAt(l - 1, y) & GR_BLOCK && this.matchAt(l - 1, y, block)) l--;

    let r = x + 1;
    while (r < GC_PLAY_WIDTH && this.stateAt(r, y) & GR_BLOCK && this.matchAt(r, y, block)) r++;

    let b = y;
    while (b > 1 && this.stateAt(x, b - 1) & GR_BLOCK && this.matchAt(x, b - 1, block)) b--;

    let t = y + 1;
    while (t < GC_PLAY_HEIGHT && this.stateAt(x, t) & GR_BLOCK && this.matchAt(x, t, block)) t++;

    const w = r - l;
    const h = t - b;

    let magnitude = 0;
    let pattern = 0;
    if (w >= GC_MIN_PATTERN_LENGTH) {
      pattern |= PT_HORIZONTAL;
      magnitude += w;
    }
    if (h >= GC_MIN_PATTERN_LENGTH) {
      pattern |= PT_VERTICAL;
      magnitude += h;
    }

    if (pattern === 0) {
      if (combo) block.endComboInvolvement(combo);
      return;
    }

    // create a combo for the elimination if one wasn't passed in
    const activeCombo: ComboTabulator = combo ?? ctx.combos.newComboTabulator();

    // an L/T shape shares the kernel between both runs — count it once
    if (pattern === (PT_HORIZONTAL | PT_VERTICAL)) magnitude--;

    // reset the shatter scratch; gray/black shatter rules depend on the kernel
    this.shatter_count = 0;
    this.shatter_top = 0;
    this.shatter_bottom = GC_PLAY_HEIGHT;
    this.gray_shatter = isColorlessFlavor(block.flavor);

    ctx.combos.specialBlockTally(activeCombo, block);
    block.startDying(ctx, activeCombo, magnitude);

    if (pattern & PT_HORIZONTAL) {
      for (let kx = l; kx < r; kx++) {
        if (kx === x) continue;
        const other = this.blockAt(kx, y);
        ctx.combos.specialBlockTally(activeCombo, other);
        other.startDying(ctx, activeCombo, magnitude);
      }
      if (l > 0) this.shatterGarbage(l - 1, y);
      if (y > 1) for (let kx = l; kx < r; kx++) this.shatterGarbage(kx, y - 1);
      if (r < GC_PLAY_WIDTH) this.shatterGarbage(r, y);
      if (y < GC_PLAY_HEIGHT - 1) for (let kx = l; kx < r; kx++) this.shatterGarbage(kx, y + 1);
    }

    if (pattern & PT_VERTICAL) {
      for (let ky = b; ky < t; ky++) {
        if (ky === y) continue;
        const other = this.blockAt(x, ky);
        ctx.combos.specialBlockTally(activeCombo, other);
        other.startDying(ctx, activeCombo, magnitude);
      }
      if (b > 1) this.shatterGarbage(x, b - 1);
      if (x > 0) for (let ky = b; ky < t; ky++) this.shatterGarbage(x - 1, ky);
      if (t < GC_PLAY_HEIGHT) this.shatterGarbage(x, t);
      if (x < GC_PLAY_WIDTH - 1) for (let ky = b; ky < t; ky++) this.shatterGarbage(x + 1, ky);
    }

    // If any garbage touched the pattern, walk the shatter area and let each slab
    // convert itself into awaking blocks/garbage; `startShattering` advances
    // `sX`/`popDelay` (they'd be by-reference in the C++). Pop timers are
    // synchronized so sections pop left-to-right, bottom-to-top; the whole area
    // finishes awaking together after `awakenDelay`. The `shatter_count > 0` gate
    // keeps the delay formula from evaluating `(count - 1)` at -1 and doesn't rely
    // on the `shatter_bottom > shatter_top` empty-range invariant.
    if (this.shatter_count > 0) {
      const awakenDelay =
        GC_INITIAL_POP_DELAY +
        GC_FINAL_POP_DELAY +
        GC_INTERNAL_POP_DELAY * (this.shatter_count - 1);
      let popDelay = GC_INITIAL_POP_DELAY;
      for (let sY = this.shatter_bottom; sY < this.shatter_top; sY++) {
        let sX = 0;
        while (sX < GC_PLAY_WIDTH) {
          if (this.stateAt(sX, sY) & GR_SHATTERING) {
            const res = this.garbageAt(sX, sY).startShattering(
              ctx,
              sX,
              sY,
              popDelay,
              awakenDelay,
              activeCombo,
            );
            sX = res.sX;
            popDelay = res.popDelay;
          } else {
            sX++;
          }
        }
      }
    }

    activeCombo.reportElimination(magnitude, block, ctx.clock.time_step, ctx.signSink);
  }

  /**
   * Mark the garbage at (x, y) — and every slab connected to it — as shattering,
   * accumulating the shatter bounds and count. Mirrors `Grid::shatterGarbage` +
   * `shatterGarbage_inline_split_` (Grid.h:216 / Grid.cxx:303). Gray/black rules:
   * a slab only shatters if it consents (`considerShattering`), and black needs a
   * gray shatter in progress. The shattered cells are converted later by the
   * synchronization pass in `handleEliminationCheckRequest`.
   */
  private shatterGarbage(x: number, y: number, dueTo: Garbage | null = null): void {
    if (!(this.stateAt(x, y) & GR_GARBAGE)) return;
    const garbage = this.garbageAt(x, y);

    // Ask the garbage whether it shatters; handle black ourselves.
    if (!garbage.considerShattering(dueTo)) return;
    if (garbage.flavor === GF_BLACK && !this.gray_shatter) return;

    // Grow the shatter bounds to the slab's actual vertical span (`garbage.y ..
    // garbage.y + garbage.height`). The C++ derives these from the *contact* row
    // `y` (`y ± garbage.height`), which for a tall slab can run past the grid;
    // its raw array reads tolerate that, but our bounds-checked `stateAt` in the
    // traversal below would throw. Using the true span covers exactly the marked
    // cells (so the traversal visits the same GR_SHATTERING cells in the same
    // order) while keeping every visited row a valid index — garbage never sits
    // on row 0, so the span stays within 1..GC_PLAY_HEIGHT-1.
    if (garbage.y + garbage.height > this.shatter_top) {
      this.shatter_top = garbage.y + garbage.height;
    }
    if (garbage.y < this.shatter_bottom) this.shatter_bottom = garbage.y;

    this.shatter_count += garbage.width * garbage.height;

    // Mark all of the slab's cells shattering.
    for (let h = 0; h < garbage.height; h++) {
      for (let w = 0; w < garbage.width; w++) {
        this.changeState(garbage.x + w, garbage.y + h, garbage, GR_SHATTERING);
      }
    }

    // Recurse into garbage touching each side (passing this slab as `dueTo`).
    if (garbage.x > 0) {
      for (let h = 0; h < garbage.height; h++)
        this.shatterGarbage(garbage.x - 1, garbage.y + h, garbage);
    }
    if (garbage.x + garbage.width < GC_PLAY_WIDTH) {
      for (let h = 0; h < garbage.height; h++) {
        this.shatterGarbage(garbage.x + garbage.width, garbage.y + h, garbage);
      }
    }
    if (garbage.y > 1) {
      for (let w = 0; w < garbage.width; w++)
        this.shatterGarbage(garbage.x + w, garbage.y - 1, garbage);
    }
    if (garbage.y + garbage.height < GC_PLAY_HEIGHT) {
      for (let w = 0; w < garbage.width; w++) {
        this.shatterGarbage(garbage.x + w, garbage.y + garbage.height, garbage);
      }
    }
  }
}
