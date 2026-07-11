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
 * never enters the digest, so it can't perturb determinism. The snapshot carries
 * the *accumulated* combo fields (magnitude, special tally, multiplier) the C++
 * `Score::reportElimination`/`reportMultiplier` read, plus the combo `id` and
 * `creationTimeStamp` so the display layer can key its per-combo bookkeeping and
 * detect pool reuse.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

/**
 * A snapshot of a combo at the tick it reported an elimination — the inputs the
 * C++ `Score` reads. All fields are the combo's *accumulated* values (magnitude
 * grows across a chain), exactly as `Score::reportElimination` sees them.
 */
export interface ScoreEvent {
  /** Combo free-store id (display keys its per-combo scratch on this). */
  readonly id: number;
  /** Combo creation tick — changes on pool reuse, so the display can reset scratch. */
  readonly creationTimeStamp: number;
  /** Accumulated normal-elimination magnitude. */
  readonly magnitude: number;
  /** Accumulated special (gray/black/white) magnitude. */
  readonly specialMagnitude: number;
  /** Accumulated chain multiplier. */
  readonly multiplier: number;
  /** Total multipliers gained so far this combo (monotonic; display diffs it per step). */
  readonly nMultipliers: number;
  /** Accumulated special-block tally, indexed by special-flavor code. Copied (not aliased). */
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
