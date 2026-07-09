import { describe, expect, it } from 'vitest';
import {
  ActionState,
  BS_DYING,
  CC_ADVANCE,
  CC_RIGHT,
  CC_SWAP,
  GC_DYING_DELAY,
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
  GR_BLOCK,
  GameSim,
  noActions,
} from '@crack-attack/core';
import { deriveViewModel } from './boardViewModel.js';

describe('deriveViewModel', () => {
  it('reports playfield dimensions from the core constants', () => {
    const vm = deriveViewModel(new GameSim(1));
    expect(vm.width).toBe(GC_PLAY_WIDTH);
    // Visible height is the safe-height danger line minus one (per core docs).
    expect(vm.visibleHeight).toBe(GC_SAFE_HEIGHT - 1);
  });

  it('flags the creep row (grid row 0) as a preview and no other row', () => {
    const vm = deriveViewModel(new GameSim(1));
    for (const b of vm.blocks) expect(b.preview).toBe(b.y === 0);
  });

  it('exposes a continuous cursor renderY aligned with the cursor grid row', () => {
    const sim = new GameSim(1);
    const vm = deriveViewModel(sim);
    // With no creep accumulated yet, renderY equals the integer grid row.
    expect(vm.cursor.renderY).toBe(vm.cursor.y);
    expect(sim.creep.creep).toBe(0);
  });

  it('reports deathProgress 0 for a fresh board (nothing dying)', () => {
    const vm = deriveViewModel(new GameSim(1));
    for (const b of vm.blocks) {
      expect(b.phase).not.toBe('dying');
      expect(b.deathProgress).toBe(0);
    }
  });

  it("maps a dying block's countdown to deathProgress, reaching 1.0 on its last frame", () => {
    const sim = new GameSim(1);
    // Force one resting block into the dying state and check the mapping at the
    // start (alarm = GC_DYING_DELAY → 0) and at the last visible tick (alarm = 1
    // → 1.0), using the same GC_DYING_DELAY - 1 denominator as the view model.
    let picked = false;
    for (let x = 0; x < GC_PLAY_WIDTH && !picked; x++) {
      for (let y = 1; y < GC_PLAY_HEIGHT && !picked; y++) {
        if (sim.grid.residentTypeAt(x, y) & GR_BLOCK) {
          const block = sim.grid.blockAt(x, y);
          block.state = BS_DYING;

          block.alarm = GC_DYING_DELAY; // just started dying
          const progressAt = (): number =>
            deriveViewModel(sim).blocks.find((s) => s.id === block.id)!.deathProgress;
          expect(progressAt()).toBeCloseTo(0, 5);

          block.alarm = 1; // final frame before it pops
          expect(progressAt()).toBeCloseTo(1, 5);

          picked = true;
        }
      }
    }
    expect(picked).toBe(true);
  });

  it('emits one sprite per live block (matches block_count)', () => {
    const sim = new GameSim(1);
    const vm = deriveViewModel(sim);
    expect(vm.blocks.length).toBe(sim.blocks.block_count);
  });

  it('every block sprite carries a real flavor and a phase', () => {
    const vm = deriveViewModel(new GameSim(7));
    for (const b of vm.blocks) {
      expect(b.flavor).toBeGreaterThanOrEqual(0);
      expect(['resting', 'falling', 'swapping', 'dying', 'awaking']).toContain(b.phase);
      expect(b.renderY).toBeGreaterThanOrEqual(b.y); // f_y offset is non-negative
    }
  });

  it('tracks the swap cursor position', () => {
    const sim = new GameSim(1);
    const before = deriveViewModel(sim).cursor.x;
    sim.step(new ActionState(CC_RIGHT));
    expect(deriveViewModel(sim).cursor.x).toBe(before + 1);
  });

  it('exposes swapping blocks with a rising swapFactor and a move direction', () => {
    const sim = new GameSim(1);
    // The cursor starts over two filled cells; a swap animates them over
    // GC_SWAP_DELAY ticks.
    sim.step(new ActionState(CC_SWAP));

    let swapping = deriveViewModel(sim).blocks.filter((b) => b.phase === 'swapping');
    expect(swapping.length).toBeGreaterThan(0);
    // Each swapping block carries a boolean move direction (right-mover has the
    // BS_SWAP_DIRECTION_MASK set); the left cell of a pair moves right.
    for (const b of swapping) expect(typeof b.swapRight).toBe('boolean');
    // It begins at the start of the swap (factor ~0).
    const startFactor = Math.max(...swapping.map((b) => b.swapFactor));
    expect(startFactor).toBeLessThan(0.2);

    // A couple ticks later the swap has progressed.
    sim.step(noActions());
    sim.step(noActions());
    swapping = deriveViewModel(sim).blocks.filter((b) => b.phase === 'swapping');
    const laterFactor = Math.max(...swapping.map((b) => b.swapFactor));
    expect(laterFactor).toBeGreaterThan(startFactor);
    expect(laterFactor).toBeLessThanOrEqual(1);
  });

  it('reports swapFactor 0 and swapRight false for non-swapping blocks', () => {
    const vm = deriveViewModel(new GameSim(1));
    for (const b of vm.blocks) {
      expect(b.swapFactor).toBe(0);
      expect(b.swapRight).toBe(false);
    }
  });

  it('surfaces HUD counters and a clamped danger fraction', () => {
    const sim = new GameSim(1);
    const vm = deriveViewModel(sim);
    expect(vm.hud.tick).toBe(0);
    expect(vm.hud.lost).toBe(false);
    expect(vm.hud.dangerFraction).toBeGreaterThanOrEqual(0);
    expect(vm.hud.dangerFraction).toBeLessThanOrEqual(1);
  });

  it('advances the HUD tick in lockstep with the sim clock', () => {
    const sim = new GameSim(1);
    for (let i = 0; i < 5; i++) sim.step(noActions());
    expect(deriveViewModel(sim).hud.tick).toBe(5);
  });

  it('emits a garbage slab once, at its origin, after a rise pushes blocks up', () => {
    // Drive a few rises so the board is busy; then no slab should be double-counted.
    const sim = new GameSim(3);
    for (let i = 0; i < 40; i++) sim.step(new ActionState(CC_ADVANCE));
    const vm = deriveViewModel(sim);
    const seen = new Set<string>();
    for (const g of vm.garbage) {
      const key = `${g.x},${g.y}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(g.width).toBeGreaterThan(0);
      expect(g.height).toBeGreaterThan(0);
    }
  });
});
