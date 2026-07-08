/**
 * garbage.ts
 *
 * The Garbage object and its fixed-size store/manager. Ported from
 * `Garbage.{h,cxx}` and the store half of `GarbageManager.{h,cxx}`.
 *
 * Scope so far: the data model + allocation (Phase 1.3), the drop-placement
 * `newFallingGarbage(height, width, flavor, timeStep)` that computes a drop row
 * from the stack (Phase 1.5), and the per-tick physics — `timeStep`
 * (fall/land + awaking countdown), `startFalling`, and `initializeAwaking`
 * (Garbage physics). Deferred:
 *   - shatter *trigger*: `startShattering`, the Grid `shatterGarbage`
 *     detection, and the `newAwakingGarbage`/`newAwakingBlock` factories that
 *     turn an eliminated garbage into awaking rows → next branch.
 *
 * As with blocks, the manager is an instance owning its store (not a static
 * singleton), and grid placement is delegated to an injected sink. The
 * cosmetic `GarbageFlavorImage` hooks in the C++ manager are display-layer and
 * intentionally omitted from core.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import type { BlockSimContext } from './block.js';
import {
  GC_FALL_VELOCITY,
  GC_GARBAGE_STORE_SIZE,
  GC_HANG_DELAY,
  GC_INTERNAL_POP_DELAY,
  GC_MAX_GARBAGE_HEIGHT,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
  GC_STEPS_PER_GRID,
} from './constants.js';
import type { ComboTabulator } from './combo.js';
import { GF_BLACK, GF_GRAY, GF_NORMAL } from './flavors.js';
import {
  GR_BLOCK,
  GR_EMPTY,
  GR_FALLING,
  GR_GARBAGE,
  GR_HANGING,
  GR_IMMUTABLE,
  type GarbageGridSink,
  type Grid,
} from './grid.js';
import type { Rng } from './rng.js';

/** Pop-direction bits cycle 1,2,4,8 → back to 1 (Garbage.cxx:175). */
const BR_DIRECTION_4 = 1 << 3;
const BR_DIRECTION_1 = 1 << 0;

// --- Garbage states (Garbage.h:53-56) --------------------------------------
// NOTE: these GS_* are *garbage* states and are a different namespace from the
// GS_* per-game state flags in constants.ts (Game.h). The identifiers don't
// collide (STATIC/FALLING/AWAKING/SHATTERING vs NORMAL/PAUSED/...).

export const GS_STATIC = 1 << 0;
export const GS_FALLING = 1 << 1;
export const GS_AWAKING = 1 << 2;
export const GS_SHATTERING = 1 << 3;

/**
 * A garbage slab. Fields mirror `Garbage` (Garbage.h:60-138) one-to-one.
 * Pooled and reused by {@link GarbageManager}.
 */
export class Garbage {
  /** Free-store id. `Garbage.h:100` */
  id = 0;
  /** Garbage flavor (GF_*). `Garbage.h:103` */
  flavor = 0;
  /** Grid position (lowest/left cell). `Garbage.h:106` */
  x = 0;
  /** Grid position. `Garbage.h:106` */
  y = 0;
  /** Height in rows. `Garbage.h:109` */
  height = 0;
  /** Width in columns. `Garbage.h:109` */
  width = 0;
  /** Fine vertical position: GC_STEPS_PER_GRID increments per cell. `Garbage.h:112` */
  f_y = 0;
  /** Garbage state (garbage GS_*). `Garbage.h:115` */
  state = 0;
  /** Time until awakening. `Garbage.h:118` */
  alarm = 0;
  /** Sections popped while awaking. `Garbage.h:121` */
  sections_popped = 0;
  /** True during an initial fall. `Garbage.h:124` */
  initial_fall = false;
  /** Next rotation direction on popping. `Garbage.h:127` */
  pop_direction = 0;
  /** Time until pop. `Garbage.h:130` */
  pop_alarm = 0;
  /** Color before popping. `Garbage.h:133` */
  pop_color = 0;
  /** Combo to pass on upon awakening. `Garbage.h:137` */
  awaking_combo: ComboTabulator | null = null;

  /**
   * Initialize as resting garbage and stamp all covered cells into the grid.
   * Mirrors `Garbage::initializeStatic` (Garbage.cxx:45).
   */
  initializeStatic(
    x: number,
    y: number,
    height: number,
    width: number,
    flavor: number,
    grid: GarbageGridSink,
  ): void {
    assertGarbageDims(height, width);
    this.x = x;
    this.y = y;
    this.height = height;
    this.width = width;
    this.flavor = flavor;
    this.f_y = 0;

    this.state = GS_STATIC;
    this.alarm = 0;
    this.pop_alarm = 0;
    this.sections_popped = 0;
    this.initial_fall = false;
    this.awaking_combo = null;

    // Forward loops so a negative height/width fails fast (does nothing) rather
    // than hanging — `for (h = height; h--;)` would spin forever on a negative.
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        grid.addGarbage(x + w, y + h, this, GR_GARBAGE);
      }
    }
  }

  /**
   * Initialize as freshly falling garbage and stamp covered cells as FALLING.
   * Mirrors `Garbage::initializeFalling` (Garbage.cxx:68). `Game::time_step` is
   * passed in explicitly (the port keeps the tick out of global state).
   */
  initializeFalling(
    x: number,
    y: number,
    height: number,
    width: number,
    flavor: number,
    timeStep: number,
    grid: GarbageGridSink,
  ): void {
    assertGarbageDims(height, width);
    this.x = x;
    this.y = y;
    this.height = height;
    this.width = width;
    this.flavor = flavor;
    this.f_y = 0;

    this.state = GS_FALLING;
    this.alarm = timeStep + GC_HANG_DELAY;
    this.pop_alarm = 0;
    this.sections_popped = 0;
    this.initial_fall = true;
    this.awaking_combo = null;

    // Forward loops (see initializeStatic): negative dims fail fast, no hang.
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < width; w++) {
        grid.addGarbage(x + w, y + h, this, GR_FALLING);
      }
    }
  }

  /**
   * Whether this slab should shatter given a shattering neighbor `dueTo`
   * (null = shattering because of an adjacent block elimination). Pure decision
   * ported verbatim from `Garbage::considerShattering` (Garbage.h:74). Gray and
   * black only propagate shattering from their own kind.
   */
  considerShattering(dueTo: Garbage | null): boolean {
    if (!dueTo) return true;
    if (this.flavor === GF_GRAY) return dueTo.flavor === GF_GRAY;
    if (this.flavor === GF_BLACK) return dueTo.flavor === GF_BLACK;
    if (dueTo.flavor === GF_GRAY) return false;
    return true;
  }

  /**
   * Initialize as awaking garbage (the transient state a shattered slab passes
   * through before it pops into blocks/garbage) and stamp its cells GR_IMMUTABLE.
   * Mirrors `Garbage::initializeAwaking` (Garbage.cxx:95). Awaking garbage is
   * always full width. Bumps `awaking_count` (Creep won't rise while > 0).
   *
   * Currently only reachable via shattering, which is a later branch; ported
   * here so the awaking half of `timeStep` is complete and testable.
   */
  initializeAwaking(
    x: number,
    y: number,
    height: number,
    popDelay: number,
    awakeDelay: number,
    combo: ComboTabulator | null,
    popColor: number,
    ctx: BlockSimContext,
  ): void {
    // Awaking garbage is always full width: validate the dimensions and require
    // x === 0 up front so a bad call fails fast instead of stamping partway then
    // throwing on an out-of-bounds cell.
    assertGarbageDims(height, GC_PLAY_WIDTH);
    if (x !== 0) {
      throw new RangeError(`Awaking garbage must be full-width at x=0 (got x ${x})`);
    }

    this.x = x;
    this.y = y;
    this.height = height;
    this.width = GC_PLAY_WIDTH;
    this.flavor = GF_NORMAL;
    this.f_y = 0;

    this.state = GS_AWAKING;
    this.alarm = ctx.clock.time_step + awakeDelay;
    this.pop_alarm = ctx.clock.time_step + popDelay;
    this.sections_popped = 0;
    this.pop_direction = ctx.blocks.generatePopDirectionN(height * this.width);
    this.pop_color = popColor;
    this.initial_fall = false;
    this.awaking_combo = combo;

    // Stamp the slab first, then bump the counter — if any addGarbage throws
    // (occupied/out-of-bounds), awaking_count is left untouched so a partial
    // placement can't wrongly freeze Creep's rise.
    for (let h = 0; h < height; h++) {
      for (let w = 0; w < this.width; w++) {
        ctx.grid.addGarbage(x + w, y + h, this, GR_IMMUTABLE);
      }
    }

    ctx.awaking_count++;
  }

  /**
   * One tick of garbage physics. Faithful port of `Garbage::timeStep`
   * (Garbage.cxx:135). Called from the bottom-to-top grid walk with the walk
   * cursor `(lX, lY)`; returns the advanced cursor so a multi-cell slab is
   * visited once. Handles the fall-start check (GS_STATIC), the awaking pop
   * countdown (GS_AWAKING), and the per-cell fall + landing (GS_FALLING).
   */
  timeStep(ctx: BlockSimContext, lX: number, lY: number): [number, number] {
    const grid = ctx.grid;
    const now = ctx.clock.time_step;

    // Advance the grid-walk cursor over our footprint. Full-width (or 1-tall)
    // garbage owns whole rows, so we can skip them; a narrow tall slab is only
    // acted on when the walk reaches its top row.
    if (this.height === 1 || this.width === GC_PLAY_WIDTH) {
      lY += this.height - 1;
      lX += this.width - 1;
    } else {
      lX += this.width - 1;
      if (lY !== this.y + this.height - 1) return [lX, lY];
    }

    // --- states that may change due to falling ---
    if (this.state & GS_STATIC) {
      if (this.isUnsupported(grid)) this.startFalling(ctx);
    } else if (this.state & GS_AWAKING) {
      // Pop one section each GC_INTERNAL_POP_DELAY; the last section doesn't
      // re-arm the pop timer.
      if (this.sections_popped < this.width * this.height && this.pop_alarm === now) {
        this.sections_popped++;
        if (this.sections_popped < this.width * this.height) {
          this.pop_direction =
            this.pop_direction & BR_DIRECTION_4 ? BR_DIRECTION_1 : this.pop_direction << 1;
          this.pop_alarm = now + GC_INTERNAL_POP_DELAY;
        }
      }

      if (this.alarm === now) {
        ctx.awaking_count--;

        if (this.isUnsupported(grid)) {
          // fall, passing the stored combo along to blocks above
          this.startFalling(ctx, this.awaking_combo, true, true);
        } else {
          this.state = GS_STATIC;
          for (let h = 0; h < this.height; h++) {
            for (let w = 0; w < this.width; w++) {
              grid.changeState(this.x + w, this.y + h, this, GR_GARBAGE);
            }
          }
        }
      }
    }

    // --- falling ---
    if (this.state & GS_FALLING) {
      if (this.alarm === now) this.alarm = 0; // hang alarm fires

      if (this.alarm === 0) {
        // at a cell boundary, decide whether to drop another row or land
        if (this.f_y === 0) {
          if (this.isUnsupported(grid)) {
            this.y--;
            this.f_y = GC_STEPS_PER_GRID;
            for (let h = 0; h < this.height; h++) {
              for (let w = 0; w < this.width; w++) {
                grid.remove(this.x + w, this.y + h + 1, this);
              }
            }
            for (let h = 0; h < this.height; h++) {
              for (let w = 0; w < this.width; w++) {
                grid.addGarbage(this.x + w, this.y + h, this, GR_FALLING);
              }
            }
          } else {
            // landed
            this.state = GS_STATIC;
            if (this.initial_fall) {
              this.initial_fall = false;
              grid.notifyImpact(this.y, this.height);
            }
            for (let h = 0; h < this.height; h++) {
              for (let w = 0; w < this.width; w++) {
                grid.changeState(this.x + w, this.y + h, this, GR_GARBAGE);
              }
            }
          }
        }

        if (this.state & GS_FALLING) this.f_y -= GC_FALL_VELOCITY;
      }
    }

    return [lX, lY];
  }

  /**
   * Begin (or continue, for cascade calls) a fall. Faithful port of
   * `Garbage::startFalling` (Garbage.cxx:283). Garbage carries no combo of its
   * own but relays a combo fall to its upward neighbors so a chain keeps its
   * tally. `selfCall` skips the support re-check the caller already did.
   */
  startFalling(
    ctx: BlockSimContext,
    combo: ComboTabulator | null = null,
    noHang = false,
    selfCall = false,
  ): void {
    const grid = ctx.grid;

    if (!selfCall) {
      if (!(this.state & GS_STATIC)) return;
      // not going to fall if anything below isn't empty-or-already-falling
      for (let w = 0; w < this.width; w++) {
        if (!(grid.stateAt(this.x + w, this.y - 1) & (GR_EMPTY | GR_FALLING))) return;
      }
    }

    this.state = GS_FALLING;

    if (noHang) {
      this.alarm = 0;
      for (let h = 0; h < this.height; h++) {
        for (let w = 0; w < this.width; w++) {
          grid.changeState(this.x + w, this.y + h, this, GR_FALLING);
        }
      }
    } else {
      this.alarm = ctx.clock.time_step + GC_HANG_DELAY;
      for (let h = 0; h < this.height; h++) {
        for (let w = 0; w < this.width; w++) {
          grid.changeState(this.x + w, this.y + h, this, GR_HANGING | GR_FALLING);
        }
      }
    }

    // relay a combo fall to whatever rests directly on top of us
    if (this.y + this.height < GC_PLAY_HEIGHT) {
      for (let w = 0; w < this.width; w++) {
        const ax = this.x + w;
        const ay = this.y + this.height;
        const s = grid.stateAt(ax, ay);
        if (s & GR_BLOCK) grid.blockAt(ax, ay).startFalling(ctx, combo, noHang);
        else if (s & GR_GARBAGE) grid.garbageAt(ax, ay).startFalling(ctx, combo, noHang);
      }
    }
  }

  /** Whether every cell directly below the slab is empty (so it may fall). */
  private isUnsupported(grid: Grid): boolean {
    for (let w = 0; w < this.width; w++) {
      if (!(grid.stateAt(this.x + w, this.y - 1) & GR_EMPTY)) return false;
    }
    return true;
  }
}

/**
 * Owns the fixed-size garbage store and hands out/reclaims ids. Ported from the
 * store portion of `GarbageManager` (GarbageManager.h/.cxx). Grid placement is
 * delegated to the injected {@link GarbageGridSink}.
 */
export class GarbageManager {
  /** Number of live garbage slabs. `GarbageManager.h:95` */
  garbage_count = 0;
  /** Pooled garbage objects. `GarbageManager.h:96` */
  readonly garbageStore: Garbage[];
  /** Occupancy map over the store. `GarbageManager.h:97` */
  readonly storeMap: boolean[];

  constructor(
    private readonly grid: Grid,
    /** Shared gameplay RNG (used to place sub-width garbage). */
    private readonly rng: Rng,
  ) {
    this.garbageStore = new Array<Garbage>(GC_GARBAGE_STORE_SIZE);
    this.storeMap = new Array<boolean>(GC_GARBAGE_STORE_SIZE);
    for (let n = 0; n < GC_GARBAGE_STORE_SIZE; n++) {
      this.garbageStore[n] = new Garbage();
      this.garbageStore[n]!.id = n;
      this.storeMap[n] = false;
    }
    this.gameStart();
  }

  /** Reset the store for a new game. Mirrors `GarbageManager::gameStart` (GarbageManager.cxx:38). */
  gameStart(): void {
    this.garbage_count = 0;
    for (let n = 0; n < GC_GARBAGE_STORE_SIZE; n++) {
      this.storeMap[n] = false;
      this.garbageStore[n]!.id = n;
    }
  }

  /** The pooled garbage for an id. Fails fast on an out-of-range id. */
  garbage(id: number): Garbage {
    if (id < 0 || id >= GC_GARBAGE_STORE_SIZE) {
      throw new RangeError(`GarbageManager: garbage id ${id} out of range`);
    }
    return this.garbageStore[id]!;
  }

  /**
   * Allocate falling garbage at an explicit (x, y). Mirrors the inline
   * `GarbageManager::newFallingGarbage(x, y, height, width, flavor)`
   * (GarbageManager.h:55), minus the display-only flavor-image request.
   * No-op when the store is full, as in the C++.
   */
  newFallingGarbageAt(
    x: number,
    y: number,
    height: number,
    width: number,
    flavor: number,
    timeStep: number,
  ): void {
    if (this.garbage_count === GC_GARBAGE_STORE_SIZE) return;

    const id = this.findFreeId();
    this.allocateId(id);
    try {
      this.garbageStore[id]!.initializeFalling(x, y, height, width, flavor, timeStep, this.grid);
    } catch (e) {
      // Roll back so a failed placement (invalid dims / occupied / out-of-bounds
      // cell) doesn't permanently leak a pool slot.
      this.freeId(id);
      throw e;
    }
  }

  /**
   * Try to drop a slab of `height`×`width` onto the board, computing its drop
   * row from the current stack. Returns false (drop later) when there is no
   * room. Mirrors the public `GarbageManager::newFallingGarbage(height, width,
   * flavor)` (GarbageManager.cxx:47). `Grid.top_occupied_row` must be current.
   *
   * A sub-width slab is placed at a random column (one gameplay RNG draw), so
   * this participates in the deterministic gameplay stream. `timeStep` is the
   * current tick, threaded in for the falling garbage's hang alarm.
   */
  newFallingGarbage(height: number, width: number, flavor: number, timeStep: number): boolean {
    // Reject non-positive dimensions before mutating any state — this is the
    // inbound/outbound seam (netcode/AI), so a zero/negative height or width
    // must not silently allocate an empty slab or bump top_occupied_row.
    // (Over-tall garbage is not rejected but clamped to GC_MAX_GARBAGE_HEIGHT
    // below, matching the C++.)
    assertGarbageDims(height, width);

    // Don't commit top_occupied_row if there's no store slot to place into —
    // newFallingGarbageAt would silently no-op, desyncing the stack height.
    // Returning false lets the caller retry when a slot frees up.
    if (this.garbage_count === GC_GARBAGE_STORE_SIZE) return false;

    if (height > GC_MAX_GARBAGE_HEIGHT) height = GC_MAX_GARBAGE_HEIGHT;
    // Clamp width so the random-column draw below never sees a non-positive
    // maximum (rng.number(GC_PLAY_WIDTH + 1 - width)). Garbage is never wider
    // than the board in normal play; this is a defensive guard.
    if (width > GC_PLAY_WIDTH) width = GC_PLAY_WIDTH;

    const dropRow =
      this.grid.top_occupied_row >= GC_SAFE_HEIGHT
        ? this.grid.top_occupied_row + 1
        : GC_SAFE_HEIGHT + 1;

    // No room; leave the top row free for the final creep.
    if (dropRow + height > GC_PLAY_HEIGHT - 1) return false;

    // Place first, commit the stack height only on success. If
    // newFallingGarbageAt throws (stale top_occupied_row → occupied/out-of-bounds
    // cell, invalid dims), it rolls back its own pool slot and we leave
    // top_occupied_row unchanged so later drop logic sees the true stack height.
    if (width === GC_PLAY_WIDTH) {
      this.newFallingGarbageAt(0, dropRow, height, width, flavor, timeStep);
    } else {
      this.newFallingGarbageAt(
        this.rng.number(GC_PLAY_WIDTH + 1 - width),
        dropRow,
        height,
        width,
        flavor,
        timeStep,
      );
    }

    this.grid.top_occupied_row = dropRow + height - 1;

    return true;
  }

  /** Return a garbage slot to the free pool. Mirrors `GarbageManager::deleteGarbage`. */
  deleteGarbage(garbage: Garbage): void {
    this.freeId(garbage.id);
  }

  /**
   * Shift every live garbage up one row. Mirrors `GarbageManager::shiftUp`
   * (GarbageManager.h:75).
   */
  shiftUp(): void {
    let c = this.garbage_count;
    // Scan the whole fixed store (not just until c hits 0): shifts every live
    // slab even if garbage_count is undercounted, and lets c go negative so the
    // final check catches both under- and over-count corruption.
    for (let n = 0; n < GC_GARBAGE_STORE_SIZE; n++) {
      if (this.storeMap[n]) {
        c--;
        this.garbageStore[n]!.y++;
      }
    }
    if (c !== 0) {
      throw new Error(
        `GarbageManager.shiftUp: garbage_count (${this.garbage_count}) out of sync with storeMap`,
      );
    }
  }

  private findFreeId(): number {
    let n = 0;
    while (n < GC_GARBAGE_STORE_SIZE && this.storeMap[n]) n++;
    if (n === GC_GARBAGE_STORE_SIZE) throw new Error('GarbageManager: garbage store exhausted');
    return n;
  }

  private allocateId(id: number): void {
    // Restores the C++ `assert(!storeMap[id])`.
    if (this.storeMap[id]) throw new Error(`GarbageManager: double-allocate of id ${id}`);
    this.storeMap[id] = true;
    this.garbage_count++;
  }

  private freeId(id: number): void {
    // Restores the C++ `assert(storeMap[id])`.
    if (!this.storeMap[id]) throw new Error(`GarbageManager: double-free of id ${id}`);
    this.storeMap[id] = false;
    this.garbage_count--;
  }
}

/** Reject non-positive garbage dimensions up front (would stamp no cells). */
function assertGarbageDims(height: number, width: number): void {
  if (height <= 0 || width <= 0) {
    throw new RangeError(`Garbage dimensions must be positive (height ${height}, width ${width})`);
  }
}
