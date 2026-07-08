/**
 * garbage.ts
 *
 * The Garbage object and its fixed-size store/manager. Ported from
 * `Garbage.{h,cxx}` and the store half of `GarbageManager.{h,cxx}`.
 *
 * Scope for this phase (1.3): the data model and allocation only — the object
 * store, id allocation, `initializeStatic`/`initializeFalling`, the pure
 * `considerShattering` decision, and simple store ops. Deferred:
 *   - drop-placement `newFallingGarbage(height, width, flavor)` (uses
 *     Grid.top_occupied_row + garbage sizing) → Phase 1.5
 *   - awaking/shatter (`initializeAwaking`, `startShattering`) + combos → 1.5
 *   - per-tick physics (`timeStep`, falling) → Phase 1.6
 *
 * As with blocks, the manager is an instance owning its store (not a static
 * singleton), and grid placement is delegated to an injected sink. The
 * cosmetic `GarbageFlavorImage` hooks in the C++ manager are display-layer and
 * intentionally omitted from core.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_GARBAGE_STORE_SIZE, GC_HANG_DELAY } from './constants.js';
import type { ComboTabulator } from './combo.js';
import { GF_BLACK, GF_GRAY } from './flavors.js';
import { GR_FALLING, GR_GARBAGE, type GarbageGridSink } from './grid.js';

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

    for (let h = height; h--;) {
      for (let w = width; w--;) {
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

    for (let h = height; h--;) {
      for (let w = width; w--;) {
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

  constructor(private readonly grid: GarbageGridSink) {
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

  /** The pooled garbage for an id. */
  garbage(id: number): Garbage {
    return this.garbageStore[id]!;
  }

  /**
   * Allocate falling garbage at an explicit (x, y). Mirrors the inline
   * `GarbageManager::newFallingGarbage(x, y, height, width, flavor)`
   * (GarbageManager.h:55), minus the display-only flavor-image request.
   * No-op when the store is full, as in the C++.
   */
  newFallingGarbage(
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
    this.garbageStore[id]!.initializeFalling(x, y, height, width, flavor, timeStep, this.grid);
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
    for (let n = 0; c; n++) {
      if (this.storeMap[n]) {
        c--;
        this.garbageStore[n]!.y++;
      }
    }
  }

  private findFreeId(): number {
    let n = 0;
    while (this.storeMap[n]) n++;
    return n;
  }

  private allocateId(id: number): void {
    this.storeMap[id] = true;
    this.garbage_count++;
  }

  private freeId(id: number): void {
    this.storeMap[id] = false;
    this.garbage_count--;
  }
}
