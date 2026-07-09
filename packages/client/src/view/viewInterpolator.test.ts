import { describe, expect, it } from 'vitest';
import type { BoardViewModel } from './boardViewModel.js';
import { ViewInterpolator } from './viewInterpolator.js';

/** A tiny hand-built model: one block (by id/generation) and a cursor. */
function model(
  blockId: number,
  blockRenderY: number,
  cursorRenderY: number,
  generation = 1,
  swapFactor = 0,
): BoardViewModel {
  return {
    width: 6,
    visibleHeight: 12,
    blocks: [
      {
        id: blockId,
        generation,
        x: 0,
        y: Math.floor(blockRenderY),
        renderY: blockRenderY,
        flavor: 0,
        phase: swapFactor > 0 ? 'swapping' : 'falling',
        preview: false,
        deathProgress: 0,
        swapFactor,
        swapRight: true,
      },
    ],
    garbage: [],
    cursor: { x: 2, y: Math.floor(cursorRenderY), renderY: cursorRenderY },
    hud: {
      tick: 0,
      elapsedSeconds: 0,
      awakingCount: 0,
      dyingCount: 0,
      topEffectiveRow: 0,
      dangerFraction: 0,
      lossCountdown: null,
      lost: false,
    },
  };
}

describe('ViewInterpolator', () => {
  it('has no model until something is pushed', () => {
    const vi = new ViewInterpolator();
    expect(vi.hasModel).toBe(false);
    expect(() => vi.sample(0.5)).toThrow();
  });

  it('returns the current model unchanged when there is no previous frame', () => {
    const vi = new ViewInterpolator();
    const m = model(1, 5, 4);
    vi.push(m);
    const s = vi.sample(0.5);
    expect(s.blocks[0]!.renderY).toBe(5);
    expect(s.cursor.renderY).toBe(4);
  });

  it('lerps a matched sprite renderY between the two frames', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4)); // prev
    vi.push(model(1, 5, 4)); // curr (block fell one row)
    expect(vi.sample(0).blocks[0]!.renderY).toBe(6); // alpha 0 → previous
    expect(vi.sample(1).blocks[0]!.renderY).toBe(5); // alpha 1 → current
    expect(vi.sample(0.5).blocks[0]!.renderY).toBeCloseTo(5.5);
  });

  it('interpolates the cursor renderY (creep rise) but keeps its grid x/y', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 5, 4.0));
    vi.push(model(1, 5, 4.5));
    const s = vi.sample(0.5);
    expect(s.cursor.renderY).toBeCloseTo(4.25);
    expect(s.cursor.x).toBe(2);
  });

  it('snaps a sprite with no match in the previous frame', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4)); // prev has block id 1
    vi.push(model(2, 9, 4)); // curr has a *new* block id 2
    expect(vi.sample(0.5).blocks[0]!.renderY).toBe(9); // no lerp — snaps
  });

  it('does NOT lerp a reused id whose generation changed (pool-slot reuse)', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4, 1)); // prev: slot 1, generation 1
    vi.push(model(1, 9, 4, 2)); // curr: slot 1 reused → generation 2 (a new block)
    expect(vi.sample(0.5).blocks[0]!.renderY).toBe(9); // snaps, not lerped from 6
  });

  it('clamps alpha to [0, 1] and snaps a non-finite alpha to the current frame', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4));
    vi.push(model(1, 5, 4));
    expect(vi.sample(2).blocks[0]!.renderY).toBe(5); // clamped to 1
    expect(vi.sample(-1).blocks[0]!.renderY).toBe(6); // clamped to 0
    expect(vi.sample(NaN).blocks[0]!.renderY).toBe(5); // non-finite → current
    expect(vi.sample(Infinity).blocks[0]!.renderY).toBe(5);
  });

  it('lerps a matched sprite swapFactor between the two frames', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 5, 4, 1, 0.2)); // prev: swapping, 20% through
    vi.push(model(1, 5, 4, 1, 0.4)); // curr: 40% through
    expect(vi.sample(0).blocks[0]!.swapFactor).toBeCloseTo(0.2);
    expect(vi.sample(1).blocks[0]!.swapFactor).toBeCloseTo(0.4);
    expect(vi.sample(0.5).blocks[0]!.swapFactor).toBeCloseTo(0.3);
  });

  it('carries current-tick fields (x, y, phase) through unblended', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4));
    vi.push(model(1, 5, 4));
    const b = vi.sample(0.5).blocks[0]!;
    expect(b.y).toBe(5); // curr grid row
    expect(b.phase).toBe('falling');
  });

  it('reset() drops both frames so nothing interpolates across it', () => {
    const vi = new ViewInterpolator();
    vi.push(model(1, 6, 4));
    vi.push(model(1, 5, 4));
    vi.reset();
    expect(vi.hasModel).toBe(false);
    vi.push(model(1, 3, 4));
    expect(vi.sample(0.5).blocks[0]!.renderY).toBe(3); // no previous → snaps
  });
});
