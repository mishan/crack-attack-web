/**
 * viewInterpolator.ts
 *
 * Smooths rendering between the sim's discrete 50 Hz ticks. The simulation
 * updates positions in whole ticks; the browser renders faster (and at an
 * unrelated cadence), so drawing the latest tick verbatim looks stepped. This
 * keeps the previous and current tick's {@link BoardViewModel}s and, each frame,
 * blends them by the fixed-timestep `alpha` (how far the render clock has
 * progressed into the next tick).
 *
 * Sprites are matched across frames by their per-lifetime key `(id, generation)`
 * — a pool `id` alone is reused after a delete, so it can name a different entity
 * next tick. A sprite present in both frames gets a lerped `renderY`; anything
 * new (a fresh creep row, a just-awoken block) snaps to its current position.
 * Only the continuous `renderY` is blended; every discrete field (grid `x`/`y`,
 * phase, flavor, …) is taken straight from the current tick, which is what the
 * renderer keys colour/where-to-swap off of.
 */

import type { BlockSprite, BoardViewModel, GarbageSprite } from './boardViewModel.js';

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class ViewInterpolator {
  private prev: BoardViewModel | null = null;
  private curr: BoardViewModel | null = null;

  /** Record the newest tick's model. Call once per sim step. */
  push(vm: BoardViewModel): void {
    this.prev = this.curr;
    this.curr = vm;
  }

  /** Whether a model has been pushed yet (nothing to render before the first). */
  get hasModel(): boolean {
    return this.curr !== null;
  }

  /**
   * The two most recent frames with each matched sprite's `renderY` blended by
   * `alpha`: at `alpha = 0` `renderY` is the previous frame's, at `alpha = 1` it
   * is the current frame's (positions ease from where they were toward where they
   * now are). Every *other* field is the current tick's, unblended — only the
   * continuous `renderY` (and the cursor's) is interpolated. `alpha` is clamped
   * to `[0, 1]`; a non-finite value (NaN/±Infinity) resolves to 1 (current) so it
   * can't poison render positions. With no previous frame yet, the current model
   * is returned as-is.
   */
  sample(alpha: number): BoardViewModel {
    const curr = this.curr;
    if (!curr) throw new Error('ViewInterpolator.sample() before any push()');
    const prev = this.prev;
    if (!prev) return curr;

    // NaN/Infinity → 1 (current), otherwise clamp to [0, 1].
    const t = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;

    // At t === 1 (including clamped/non-finite alpha) the blend is exactly the
    // current frame, so skip the Map builds and per-sprite object churn.
    if (t === 1) return curr;

    // Match on (id, generation): a pool-slot `id` alone is reused across
    // lifetimes (a block/slab can be deleted and a new one allocated into the
    // same slot in one tick), so keying on id alone could lerp between unrelated
    // sprites. `id` is unique within a frame, so map by that number (no string
    // allocation in the render hot path) and confirm the generation matches.
    const prevBlocks = new Map<number, BlockSprite>();
    for (const b of prev.blocks) prevBlocks.set(b.id, b);
    const prevGarbage = new Map<number, GarbageSprite>();
    for (const g of prev.garbage) prevGarbage.set(g.id, g);

    const blocks = curr.blocks.map((b) => {
      const p = prevBlocks.get(b.id);
      // Blend renderY and the continuous animation progresses (swap + awaking pop);
      // every other field is taken from the current tick. swapFactor/awakeProgress
      // are only *used* in their respective phases, but blending them
      // unconditionally is harmless and keeps the motion smooth above 50 Hz.
      return p && p.generation === b.generation
        ? {
            ...b,
            renderY: lerp(p.renderY, b.renderY, t),
            swapFactor: lerp(p.swapFactor, b.swapFactor, t),
            awakeProgress: lerp(p.awakeProgress, b.awakeProgress, t),
          }
        : b;
    });
    const garbage = curr.garbage.map((g) => {
      const p = prevGarbage.get(g.id);
      return p && p.generation === g.generation
        ? { ...g, renderY: lerp(p.renderY, g.renderY, t) }
        : g;
    });
    const cursor = {
      x: curr.cursor.x,
      y: curr.cursor.y,
      renderY: lerp(prev.cursor.renderY, curr.cursor.renderY, t),
    };

    return { ...curr, blocks, garbage, cursor };
  }

  /** Forget both frames (e.g. after a restart, so nothing interpolates across it). */
  reset(): void {
    this.prev = null;
    this.curr = null;
  }
}
