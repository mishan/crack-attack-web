/**
 * boardViewModel.ts
 *
 * Turns the deterministic `GameSim` state into a flat, render-ready description
 * the Three.js layer can consume without knowing anything about sim internals.
 * This keeps the renderer dumb (it just draws sprites at positions) and makes
 * the view mapping unit-testable without a GPU.
 *
 * Continuous vertical position comes from each resident's own sub-cell field
 * (`f_y`, in GC_STEPS_PER_GRID units): a resting cell sits exactly on its row, a
 * falling one hovers `f_y` of a cell above its target row. That already gives
 * smooth motion at 50 Hz; `alpha` (the render fraction between ticks) is accepted
 * for future frame-rate-independent tweening and currently left to the renderer.
 */

import {
  BS_AWAKING,
  BS_DYING,
  BS_FALLING,
  BS_SWAPPING,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_DYING_DELAY,
  GC_SAFE_HEIGHT,
  GC_STEPS_PER_GRID,
  GC_STEPS_PER_SECOND,
  GR_BLOCK,
  GR_EMPTY,
  GR_GARBAGE,
  GS_AWAKING,
  type GameSim,
} from '@crack-attack/core';

/** Coarse render phase for a block, derived from its BS_* state. */
export type BlockPhase = 'resting' | 'falling' | 'swapping' | 'dying' | 'awaking';

export interface BlockSprite {
  /**
   * Pool-slot id. NOT stable on its own — the core reuses slot ids after a block
   * is deleted — so pair it with {@link generation} to match a sprite across
   * ticks (see {@link ViewInterpolator}).
   */
  readonly id: number;
  /** Slot (re)allocation count; `(id, generation)` is the stable per-lifetime key. */
  readonly generation: number;
  /** Grid column. */
  readonly x: number;
  /** Grid row (integer target row). */
  readonly y: number;
  /**
   * Continuous render row: `y + f_y / GC_STEPS_PER_GRID` plus the sub-cell creep
   * rise, so falling looks smooth and the whole board eases upward as it creeps.
   */
  readonly renderY: number;
  readonly flavor: number;
  readonly phase: BlockPhase;
  /** True for the incoming creep row (grid row 0) — not yet playable; drawn dim. */
  readonly preview: boolean;
  /**
   * For a `dying` block, how far through its pop countdown it is (0 at the start,
   * →1 as it's about to be removed). 0 for every other phase. Drives the
   * shrink/spin pop animation.
   */
  readonly deathProgress: number;
}

export interface GarbageSprite {
  /**
   * Pool-slot id, reused after a slab is deleted — pair it with {@link generation}
   * to match a slab across ticks (see {@link ViewInterpolator}).
   */
  readonly id: number;
  /** Slot (re)allocation count; `(id, generation)` is the stable per-lifetime key. */
  readonly generation: number;
  /** Origin (lowest-left) cell. */
  readonly x: number;
  readonly y: number;
  readonly renderY: number;
  readonly width: number;
  readonly height: number;
  readonly flavor: number;
  readonly awaking: boolean;
}

export interface Hud {
  readonly tick: number;
  /** Elapsed play time in seconds (`tick / GC_STEPS_PER_SECOND`). */
  readonly elapsedSeconds: number;
  readonly awakingCount: number;
  readonly dyingCount: number;
  readonly topEffectiveRow: number;
  /** Fraction of the way to the safe-height loss line, clamped to [0, 1]. */
  readonly dangerFraction: number;
  /**
   * Ticks left before losing while the stack is frozen against the safe height,
   * or null when not in the loss countdown. Drives the urgent HUD warning.
   */
  readonly lossCountdown: number | null;
  readonly lost: boolean;
}

export interface BoardViewModel {
  /** Playfield width in cells. */
  readonly width: number;
  /** Visible playfield height in cells (`GC_SAFE_HEIGHT - 1`, the danger line). */
  readonly visibleHeight: number;
  readonly blocks: readonly BlockSprite[];
  readonly garbage: readonly GarbageSprite[];
  /** Swap cursor: grid cell `(x, y)` plus its continuous `renderY` (creep rise). */
  readonly cursor: { readonly x: number; readonly y: number; readonly renderY: number };
  readonly hud: Hud;
}

function blockPhase(state: number): BlockPhase {
  if (state & BS_DYING) return 'dying';
  if (state & BS_AWAKING) return 'awaking';
  if (state & BS_SWAPPING) return 'swapping';
  if (state & BS_FALLING) return 'falling';
  return 'resting';
}

/**
 * Build the render model for `sim` at its current tick. Smooth motion between
 * ticks is the job of the {@link ViewInterpolator}, which blends two of these.
 */
export function deriveViewModel(sim: GameSim): BoardViewModel {
  const grid = sim.grid;
  const blocks: BlockSprite[] = [];
  const garbage: GarbageSprite[] = [];

  // The board eases upward as creep accumulates; a full grid (GC_STEPS_PER_GRID)
  // is one row. Row 0 is the incoming preview that rises into play from below.
  const creepOffset = sim.creep.creep / GC_STEPS_PER_GRID;

  for (let x = 0; x < GC_PLAY_WIDTH; x++) {
    for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
      const rt = grid.residentTypeAt(x, y);
      if (rt & GR_EMPTY) continue;

      if (rt & GR_BLOCK) {
        const b = grid.blockAt(x, y);
        const phase = blockPhase(b.state);
        // A dying block is drawn with `alarm` ranging over [GC_DYING_DELAY .. 1]
        // (it's removed the tick `alarm` would hit 0), so divide by
        // `GC_DYING_DELAY - 1` to run deathProgress 0 → 1 across those visible
        // frames — reaching a full 1.0 on the last frame before it pops.
        const deathProgress =
          phase === 'dying'
            ? Math.max(0, Math.min(1, (GC_DYING_DELAY - b.alarm) / (GC_DYING_DELAY - 1)))
            : 0;
        blocks.push({
          id: b.id,
          generation: b.generation,
          x,
          y,
          renderY: y + b.f_y / GC_STEPS_PER_GRID + creepOffset,
          flavor: b.flavor,
          phase,
          preview: y === 0,
          deathProgress,
        });
      } else if (rt & GR_GARBAGE) {
        const g = grid.garbageAt(x, y);
        // Emit each slab once, at its origin cell.
        if (g.x === x && g.y === y) {
          garbage.push({
            id: g.id,
            generation: g.generation,
            x,
            y,
            renderY: y + g.f_y / GC_STEPS_PER_GRID + creepOffset,
            width: g.width,
            height: g.height,
            flavor: g.flavor,
            awaking: (g.state & GS_AWAKING) !== 0,
          });
        }
      }
    }
  }

  const dangerLine = GC_SAFE_HEIGHT - 1;
  const dangerFraction = Math.max(0, Math.min(1, grid.top_effective_row / dangerLine));

  return {
    width: GC_PLAY_WIDTH,
    visibleHeight: GC_SAFE_HEIGHT - 1,
    blocks,
    garbage,
    cursor: { x: sim.swapper.x, y: sim.swapper.y, renderY: sim.swapper.y + creepOffset },
    hud: {
      tick: sim.clock.time_step,
      elapsedSeconds: sim.clock.time_step / GC_STEPS_PER_SECOND,
      awakingCount: sim.awaking_count,
      dyingCount: sim.dying_count,
      topEffectiveRow: grid.top_effective_row,
      dangerFraction,
      lossCountdown: sim.creep.creep_freeze ? sim.creep.loss_alarm : null,
      lost: sim.lost,
    },
  };
}
