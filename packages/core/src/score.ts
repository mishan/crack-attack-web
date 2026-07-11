/**
 * score.ts
 *
 * The deterministic core does not score — scoring is a solo-only *display*
 * concern in the C++ (`Score.{h,cxx}`, all gated on `CM_SOLO`). But the score is
 * computed from combo state that only the core sees, and only at the exact
 * moment `ComboManager::timeStep` reports an elimination (ComboManager.cxx:73).
 * So the core emits a cosmetic {@link ScoreEvent} snapshot of the reporting
 * combo at that point, and the client's Score port (`view/score.ts`) turns the
 * snapshots into points, the backlog drip, and the record tables.
 *
 * Like signs/sparkles/sound, emitting a snapshot draws **no** gameplay RNG and
 * never enters the digest, so it can't perturb determinism. The snapshot is
 * taken at the report point — before `GarbageGenerator.comboElimination` runs —
 * so it carries the same combo fields the C++ `Score::reportElimination`/
 * `reportMultiplier` read there (magnitude, special tally, multiplier), plus the
 * combo `id` and `creationTimeStamp` so the display layer can key its per-combo
 * bookkeeping and detect pool reuse. Note: `magnitude`/`specialMagnitude`/
 * `special` are the totals for *this* report tick — `comboElimination` consumes
 * and zeros them afterward, so they do not accumulate across a chain's ticks.
 * The cross-tick running sum is the display layer's `base_accumulated_score`.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

/**
 * A snapshot of a combo at the tick it reported an elimination — the inputs the
 * C++ `Score` reads there. `magnitude`/`specialMagnitude`/`special` are this
 * report tick's totals (they're zeroed by `comboElimination` right after, so
 * they don't accumulate across a chain); `multiplier`/`nMultipliers` do persist
 * across the combo's ticks.
 */
export interface ScoreEvent {
  /** Combo free-store id (display keys its per-combo scratch on this). */
  readonly id: number;
  /** Combo creation tick — changes on pool reuse, so the display can reset scratch. */
  readonly creationTimeStamp: number;
  /** Normal-elimination magnitude for this report tick. */
  readonly magnitude: number;
  /** Special (gray/black/white) magnitude for this report tick. */
  readonly specialMagnitude: number;
  /** Chain multiplier so far (persists across the combo's ticks). */
  readonly multiplier: number;
  /** Total multipliers gained so far this combo (monotonic; display diffs it per step). */
  readonly nMultipliers: number;
  /** Special-block tally for this report tick, indexed by special-flavor code. Copied (not aliased). */
  readonly special: readonly number[];
}

/**
 * Where the combo code reports score snapshots. The core hands the display layer
 * these events and never reads them back; a headless run (tests, server, replay)
 * can leave the sink unset, and it has zero effect on simulation state.
 */
export interface ScoreSink {
  reportComboElimination(event: ScoreEvent): void;
}
