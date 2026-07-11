/**
 * comboManager.ts
 *
 * Owns the combo-tabulator free store and, each tick, watches for combos that
 * have completed (no blocks left involved) or that eliminated this tick, driving
 * the garbage generator accordingly. Ported from `ComboManager.{h,cxx}`.
 *
 * Score reporting is display-only: the points math and `base_*_score`
 * bookkeeping (`Score::reportElimination`/`reportMultiplier`) live in the
 * client's Score port. The core only emits a cosmetic {@link ScoreEvent}
 * snapshot of the reporting combo at the elimination point — no RNG, not in the
 * digest — so the gameplay path stays faithful and deterministic.
 *
 * Instance-based (owns its store) rather than a static singleton.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_COMBO_TABULATOR_STORE_SIZE } from './constants.js';
import type { Block } from './block.js';
import type { Clock } from './clock.js';
import { ComboTabulator } from './combo.js';
import type { GarbageGenerator } from './garbageGenerator.js';
import { isBaseFlavor, mapSpecialFlavorToCode } from './flavors.js';
import type { StateHasher } from './digest.js';
import type { ScoreSink } from './score.js';

export class ComboManager {
  private readonly tabulatorStore: ComboTabulator[];
  private readonly storeMap: boolean[];
  private combo_count = 0;

  /**
   * Optional cosmetic score-snapshot destination (solo display scoring). Set by
   * GameSim; null in a headless run. Emitting draws no RNG and never enters the
   * digest, so it can't affect determinism.
   */
  scoreSink: ScoreSink | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly garbageGenerator: GarbageGenerator,
  ) {
    this.tabulatorStore = new Array<ComboTabulator>(GC_COMBO_TABULATOR_STORE_SIZE);
    this.storeMap = new Array<boolean>(GC_COMBO_TABULATOR_STORE_SIZE);
    for (let n = 0; n < GC_COMBO_TABULATOR_STORE_SIZE; n++) {
      this.tabulatorStore[n] = new ComboTabulator();
      this.tabulatorStore[n]!.id = n;
      this.storeMap[n] = false;
    }
    this.gameStart();
  }

  /** Reset the store. Mirrors `ComboManager::gameStart` (ComboManager.cxx:41). */
  gameStart(): void {
    for (let n = 0; n < GC_COMBO_TABULATOR_STORE_SIZE; n++) {
      this.storeMap[n] = false;
      this.tabulatorStore[n]!.id = n;
    }
    this.combo_count = 0;
  }

  /** Number of live combos (inspection/test helper). */
  get comboCount(): number {
    return this.combo_count;
  }

  /** Feed the store occupancy and every live combo into the sim digest. Pure. */
  hashState(h: StateHasher): void {
    h.add(this.combo_count);
    for (let n = 0; n < GC_COMBO_TABULATOR_STORE_SIZE; n++) {
      h.addBool(this.storeMap[n]!);
      if (this.storeMap[n]) this.tabulatorStore[n]!.hashState(h);
    }
  }

  /**
   * Allocate and initialize a fresh combo tabulator. Mirrors
   * `ComboManager::newComboTabulator` (ComboManager.h:43).
   */
  newComboTabulator(): ComboTabulator {
    const id = this.findFreeId();
    if (id === GC_COMBO_TABULATOR_STORE_SIZE) {
      // Fail fast rather than index past the store. Callers need a live combo
      // to link blocks to, so there is no safe no-op; exhaustion signals a
      // logic error upstream.
      throw new Error('ComboManager: combo tabulator store exhausted');
    }
    this.allocateId(id);
    const combo = this.tabulatorStore[id]!;
    combo.initialize(this.clock.time_step);
    return combo;
  }

  /** Return a combo to the free pool. Mirrors `ComboManager::deleteComboTabulator`. */
  deleteComboTabulator(combo: ComboTabulator): void {
    this.freeId(combo.id);
  }

  /**
   * Tally an eliminated special block into a combo. Mirrors
   * `ComboManager::specialBlockTally` (ComboManager.h:58).
   */
  specialBlockTally(combo: ComboTabulator, block: Block): void {
    if (isBaseFlavor(block.flavor)) return;
    const code = mapSpecialFlavorToCode(block.flavor);
    combo.special[code] = combo.special[code]! + 1;
  }

  /**
   * Per-tick sweep of live combos. Mirrors `ComboManager::timeStep`
   * (ComboManager.cxx:51): a combo with no remaining involvement completes
   * (multiplier garbage, then freed); a combo that eliminated this tick emits
   * its elimination garbage.
   */
  timeStep(): void {
    let c = this.combo_count;
    // Scan the whole fixed store (not just until c hits 0): every live combo is
    // processed even if combo_count is undercounted, and c can go negative so
    // the final check catches both under- and over-count corruption.
    for (let n = 0; n < GC_COMBO_TABULATOR_STORE_SIZE; n++) {
      if (!this.storeMap[n]) continue;
      const combo = this.tabulatorStore[n]!;
      c--;

      // The if/else-if (complete OR eliminated-this-tick, not both) is faithful
      // to the C++ and correct given the tick order: an elimination is reported
      // in Grid::timeStep, which also starts the matched blocks *dying*
      // (raising involvement_count). So a combo can never be both "eliminated
      // this tick" and "at zero involvement" on the same ComboManager sweep —
      // eliminations raise involvement; it only returns to zero once the dying
      // blocks finish, GC_DYING_DELAY ticks later, on a tick with no new
      // elimination. Preserving this exclusivity keeps the port replay-faithful.
      if (combo.involvement_count === 0) {
        this.garbageGenerator.comboComplete(combo);
        // circumvent deleteComboTabulator(), matching the C++
        this.freeId(n);
      } else if (combo.time_stamp === this.clock.time_step) {
        // Emit a cosmetic score snapshot at the exact C++ Score::reportElimination
        // call point (ComboManager.cxx:73). Display-only: no RNG, not in the
        // digest. The base_* bookkeeping and points math live in the client's
        // Score port, which reads these accumulated fields.
        this.scoreSink?.reportComboElimination({
          id: combo.id,
          creationTimeStamp: combo.creation_time_stamp,
          magnitude: combo.magnitude,
          specialMagnitude: combo.special_magnitude,
          multiplier: combo.multiplier,
          // NOTE: despite its name, `n_multipliers_this_step` is *monotonic* in
          // this port — it's only reset at combo creation (the C++ solo-only
          // reset lives in Score::reportMultiplier, which we don't run here). The
          // client Score port relies on that: it diffs this value across a
          // combo's report ticks to recover the per-step multiplier count. Do not
          // "fix" it to reset per tick without updating that reconstruction.
          nMultipliers: combo.n_multipliers_this_step,
          special: combo.special.slice(),
        });
        this.garbageGenerator.comboElimination(combo);
      }
    }
    if (c !== 0) {
      throw new Error(
        `ComboManager.timeStep: combo_count (${this.combo_count}) out of sync with storeMap`,
      );
    }
  }

  /** First free slot, or GC_COMBO_TABULATOR_STORE_SIZE when the pool is full. */
  private findFreeId(): number {
    let n = 0;
    while (n < GC_COMBO_TABULATOR_STORE_SIZE && this.storeMap[n]) n++;
    return n;
  }

  private allocateId(id: number): void {
    // Fail fast on a double-allocate (mirrors the block/garbage stores' guards),
    // so combo_count can't drift and desync the timeStep integrity check.
    if (this.storeMap[id]) throw new Error(`ComboManager: double-allocate of id ${id}`);
    this.storeMap[id] = true;
    this.combo_count++;
  }

  private freeId(id: number): void {
    // Fail fast on a double-free rather than driving combo_count negative.
    if (!this.storeMap[id]) throw new Error(`ComboManager: double-free of id ${id}`);
    this.storeMap[id] = false;
    this.combo_count--;
  }
}
