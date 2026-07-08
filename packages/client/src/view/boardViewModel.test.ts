import { describe, expect, it } from 'vitest';
import {
  ActionState,
  CC_ADVANCE,
  CC_RIGHT,
  GC_PLAY_WIDTH,
  GC_SAFE_HEIGHT,
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
