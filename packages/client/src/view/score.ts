/**
 * score.ts — pure solo scoring, ported from `Score.{h,cxx}` (display layer).
 *
 * Scoring is a solo-only display concern in the original. The deterministic core
 * emits a {@link ScoreEvent} snapshot of a combo each time it reports an
 * elimination (ComboManager.cxx:73); this module turns those snapshots into
 * points and runs the "backlog" that drips into the shown total, plus the
 * top-multiplier tracking and the record-table insertion. All integer, all
 * deterministic, no DOM — `render`/`main` own the pixels and persistence.
 *
 * The math is faithful to the C++:
 *   - `Score::reportElimination` — per-elimination points from the accumulated
 *     magnitude / gray magnitude / special-block tally (Score.h:120-152).
 *   - `ComboManager::timeStep` base_* bookkeeping (ComboManager.cxx:73-80) and
 *     `Score::reportMultiplier` chain bonus (Score.h:104-118), reconstructed
 *     per-combo from the snapshot (keyed by id + creationTimeStamp for pool
 *     reuse; the per-step multiplier count is the monotonic `nMultipliers`
 *     diffed across a combo's report ticks).
 *   - `Score::timeStepPlay` — the speed-ramping backlog drip (Score.h:60-77).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  GC_GRAY_SCORE,
  GC_MAX_SCORE_INCREMENT_DELAY,
  GC_MIN_NUMBER_DIGITS_DISPLAYED,
  GC_MIN_PATTERN_LENGTH,
  GC_MIN_PATTERN_SCORE,
  GC_MIN_SCORE_INCREMENT_DELAY,
  GC_SCORE_DELAY_SLOPE,
  type ScoreEvent,
} from '@crack-attack/core';

/**
 * Per-special-flavor point bonuses, indexed by special-flavor code
 * (`flavor - (BF_GRAY + 1)`): black, white, then the five special colors
 * (purple, blue, green, yellow, orange). Verbatim from Score.cxx:47-54.
 */
export const SPECIAL_BLOCK_SCORES = [30, 30, 5, 5, 8, 15, 10] as const;

/**
 * Points for one elimination snapshot — `Score::reportElimination` (Score.h:120)
 * without the `backlog +=` side effect (the caller adds it). The snapshot's
 * magnitude / special tally are this report tick's totals (the core zeroes them
 * after each report tick), exactly what the C++ reads at the same point; the
 * cross-tick running sum lives in {@link ScoreState} as `base_accumulated_score`.
 */
export function scorePoints(e: ScoreEvent): number {
  let points = 0;

  if (e.specialMagnitude > 0) {
    // gray/black/white elimination
    points +=
      GC_GRAY_SCORE *
      (e.specialMagnitude === GC_MIN_PATTERN_LENGTH ? GC_MIN_PATTERN_SCORE : e.specialMagnitude);
  } else {
    // colored elimination
    points += e.magnitude === GC_MIN_PATTERN_LENGTH ? GC_MIN_PATTERN_SCORE : e.magnitude;
  }

  // special-block bonuses
  for (let n = 0; n < SPECIAL_BLOCK_SCORES.length; n++) {
    points += (e.special[n] ?? 0) * SPECIAL_BLOCK_SCORES[n]!;
  }

  return points;
}

/** Per-combo scratch mirroring the C++ `base_*_score` / per-step multiplier state. */
interface ComboScratch {
  creationTimeStamp: number;
  /** `base_accumulated_score` — total points on this combo so far. */
  accumulated: number;
  /** `base_score_this_step` — points since the last multiplier payout. */
  step: number;
  /** Last seen `nMultipliers` (monotonic), to diff the per-step multiplier count. */
  prevNMultipliers: number;
}

/**
 * Running solo score: the displayed total, the pending backlog, the drip timer,
 * and the highest chain multiplier this game. Feed it {@link report} for each
 * drained {@link ScoreEvent}, then {@link timeStep} once per played sim tick.
 */
export class ScoreState {
  /** The displayed total (backlog drips into this). */
  score = 0;
  /** Points earned but not yet dripped into {@link score}. */
  backlog = 0;
  /** Highest chain multiplier reached this game (for the multiplier record). */
  topMultiplier = 0;
  /** Digits to show, min GC_MIN_NUMBER_DIGITS_DISPLAYED; grows, never shrinks. */
  nDigitsDisplayed = GC_MIN_NUMBER_DIGITS_DISPLAYED;

  /** `Score::fade_timer` — ticks until the next backlog drip. */
  private fadeTimer = 0;
  private readonly scratch = new Map<number, ComboScratch>();

  /** Reset for a fresh game (Score::initialize). */
  reset(): void {
    this.score = 0;
    this.backlog = 0;
    this.topMultiplier = 0;
    this.nDigitsDisplayed = GC_MIN_NUMBER_DIGITS_DISPLAYED;
    this.fadeTimer = 0;
    this.scratch.clear();
  }

  /**
   * Fold one combo-elimination snapshot into the score, reproducing the
   * ComboManager base_* bookkeeping + Score::reportMultiplier chain bonus.
   */
  report(e: ScoreEvent): void {
    let s = this.scratch.get(e.id);
    if (!s || s.creationTimeStamp !== e.creationTimeStamp) {
      // A fresh combo (or a reused pool slot) — start clean bookkeeping.
      s = { creationTimeStamp: e.creationTimeStamp, accumulated: 0, step: 0, prevNMultipliers: 0 };
      this.scratch.set(e.id, s);
    }

    const points = scorePoints(e);
    s.accumulated += points;
    s.step += points;
    this.backlog += points;

    // Per-step multiplier count = new multipliers since this combo's last report.
    const nMultipliersThisStep = e.nMultipliers - s.prevNMultipliers;
    s.prevNMultipliers = e.nMultipliers;
    if (nMultipliersThisStep !== 0) {
      if (e.multiplier > this.topMultiplier) this.topMultiplier = e.multiplier;
      // Score::reportMultiplier (Score.h:110-117).
      this.backlog += s.step * (e.multiplier - nMultipliersThisStep - 1);
      this.backlog += s.accumulated * nMultipliersThisStep;
    }
    s.step = 0;
  }

  /**
   * Advance the backlog drip by `ticks` played sim ticks. Faithful to
   * `Score::timeStepPlay` (Score.h:60-77): one point drips when the fade timer
   * hits zero, and the next delay shrinks as the backlog grows (so a big backlog
   * catches up fast), clamped to [GC_MIN, GC_MAX] increment delay.
   */
  timeStep(ticks: number): void {
    for (let t = 0; t < ticks; t++) {
      if (this.fadeTimer === 0) {
        if (this.backlog > 0) {
          this.backlog--;
          this.score++;
          this.growDigits();
          let delay = GC_MAX_SCORE_INCREMENT_DELAY - GC_SCORE_DELAY_SLOPE * this.backlog;
          if (delay < GC_MIN_SCORE_INCREMENT_DELAY) delay = GC_MIN_SCORE_INCREMENT_DELAY;
          this.fadeTimer = delay;
        }
      } else {
        this.fadeTimer--;
      }
    }
  }

  /**
   * Immediately drip any remaining backlog into the score. Used at game over so
   * the final shown total (and the record it submits) reflects everything earned,
   * rather than freezing mid-drip.
   */
  flush(): void {
    this.score += this.backlog;
    this.backlog = 0;
    this.growDigits();
  }

  /** Zero-padded to the shown width, e.g. "000042" (Score display). */
  formatted(): string {
    return String(this.score).padStart(this.nDigitsDisplayed, '0');
  }

  /** Grow the shown digit count as the score gains digits (never shrinks). */
  private growDigits(): void {
    const n = String(this.score).length;
    if (n > this.nDigitsDisplayed) this.nDigitsDisplayed = n;
  }
}
