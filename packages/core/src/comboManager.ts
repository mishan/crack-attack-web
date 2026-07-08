/**
 * comboManager.ts
 *
 * Owns the combo-tabulator free store and, each tick, watches for combos that
 * have completed (no blocks left involved) or that eliminated this tick, driving
 * the garbage generator accordingly. Ported from `ComboManager.{h,cxx}`.
 *
 * Score reporting (`Score::reportElimination`/`reportMultiplier` and the
 * `base_*_score` bookkeeping) is display-only and deferred — it does not affect
 * garbage generation, so omitting it keeps the gameplay path faithful.
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

export class ComboManager {
  private readonly tabulatorStore: ComboTabulator[];
  private readonly storeMap: boolean[];
  private combo_count = 0;

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

  /**
   * Allocate and initialize a fresh combo tabulator. Mirrors
   * `ComboManager::newComboTabulator` (ComboManager.h:43).
   */
  newComboTabulator(): ComboTabulator {
    const id = this.findFreeId();
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
    for (let n = 0; c; n++) {
      if (!this.storeMap[n]) continue;
      const combo = this.tabulatorStore[n]!;
      c--;

      if (combo.involvement_count === 0) {
        this.garbageGenerator.comboComplete(combo);
        // circumvent deleteComboTabulator(), matching the C++
        this.freeId(n);
      } else if (combo.time_stamp === this.clock.time_step) {
        // Score::reportElimination / reportMultiplier — display-only, deferred.
        this.garbageGenerator.comboElimination(combo);
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
    this.combo_count++;
  }

  private freeId(id: number): void {
    this.storeMap[id] = false;
    this.combo_count--;
  }
}
