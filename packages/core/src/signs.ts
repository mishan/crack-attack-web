/**
 * signs.ts
 *
 * Reward "signs": the little floating badges the original pops up on a combo —
 * a chain multiplier (`×2`, `×3`, …), a big-combo magnitude (the combo size,
 * 4–12), and a special-flavor bonus. In the C++ these are created by
 * `SignManager::createSign` from `ComboTabulator::reportElimination` (multiplier)
 * and `GarbageGenerator::comboElimination` (magnitude/special), then drawn and
 * floated by the Displayer.
 *
 * They are purely cosmetic, so the deterministic core does **not** own their
 * lifetime, position jitter, or rendering (all display-layer). It only *reports*
 * that a sign should appear — as integer grid data on a {@link SignSink} — so the
 * client can spawn a floating sprite. Crucially, emitting a sign draws **no**
 * gameplay RNG (the original's `Random::number()` position jitter is a display
 * concern and is done client-side against the cosmetic stream), so signs can't
 * perturb the load-bearing gameplay draw order or the replay digest.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

/**
 * Which kind of reward a sign represents. Mirrors the C++ sign *types*
 * `ST_MAGNITUDE` / `ST_MULTIPLIER` / `ST_SPECIAL` (SignManager.h:31).
 */
export type SignKind = 'magnitude' | 'multiplier' | 'special';

/**
 * A request to show one reward sign, in the same terms the C++
 * `SignManager::createSign(x, y, type, level)` receives: the kernel grid cell
 * and a `level` index into that type's sign set. The display layer maps `level`
 * to the shown value (magnitude `level` → combo size `level + 4`; multiplier
 * `level` → `×(level + 2)`; special → the bonus badge). `level` is left
 * unclamped here — exactly as the core computes it — and the display clamps to
 * the available art (magnitude ≤ 8, multiplier ≤ 10) as the C++ does.
 */
export interface SignEvent {
  readonly gridX: number;
  readonly gridY: number;
  readonly kind: SignKind;
  readonly level: number;
}

/**
 * Where combo code reports signs. The core hands the display layer these events
 * and never reads them back; a solo run with no display can leave the sink unset
 * (the emitters null-check it), and it has zero effect on simulation state.
 */
export interface SignSink {
  createSign(gridX: number, gridY: number, kind: SignKind, level: number): void;
  /**
   * Cosmetic reward mote (SparkleManager::createRewardMote): the star that
   * flies off when a combo pays out. Fired at the exact C++ call sites
   * (ComboTabulator.cxx:68, GarbageGenerator.cxx:74-133), which sit beside the
   * sign emissions — hence it rides this sink. Same contract as signs: no
   * gameplay RNG, never in the digest, optional.
   */
  createMote?(gridX: number, gridY: number, level: number, sibling: number): void;
}
