import { describe, expect, it } from 'vitest';
import { GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { noActions } from './controller.js';
import { GF_NORMAL } from './flavors.js';
import { GameSim } from './gameSim.js';
import { GR_BLOCK, GR_EMPTY, GR_GARBAGE } from './grid.js';

/** Snapshot the grid as a per-cell string of state|flavor, for equality checks. */
const snapshot = (sim: GameSim): string => {
  const cells: string[] = [];
  for (let x = 0; x < GC_PLAY_WIDTH; x++) {
    for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
      const s = sim.grid.stateAt(x, y);
      const f = s & GR_BLOCK ? sim.grid.flavorAt(x, y) : -1;
      cells.push(`${s}:${f}`);
    }
  }
  return cells.join(',');
};

describe('GameSim gameStart', () => {
  it('starts the clock at zero with no awaking/dying blocks', () => {
    const sim = new GameSim(1);
    expect(sim.clock.time_step).toBe(0);
    expect(sim.awaking_count).toBe(0);
    expect(sim.dying_count).toBe(0);
  });

  it('fills the initial board and the first creep row (row 0)', () => {
    const sim = new GameSim(42);
    // row 0 is the first creep row, fully populated with blocks
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(sim.grid.stateAt(x, 0)).toBe(GR_BLOCK);
    }
    // there are stacked blocks above row 0 too
    expect(sim.blocks.block_count).toBeGreaterThan(GC_PLAY_WIDTH);
  });

  it('is fully determined by the seed', () => {
    expect(snapshot(new GameSim(12345))).toBe(snapshot(new GameSim(12345)));
    expect(snapshot(new GameSim(1))).not.toBe(snapshot(new GameSim(2)));
  });

  it('gameStart reseeds, so a restart reproduces the starting position', () => {
    const sim = new GameSim(777);
    const fresh = snapshot(sim);
    // advance (consuming RNG draws), then restart on the same instance
    for (let i = 0; i < 25; i++) sim.step(noActions());
    sim.gameStart();
    expect(snapshot(sim)).toBe(fresh);
  });

  it('produces no immediate matches in the starting stack (rows 1+)', () => {
    const sim = new GameSim(2026);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
        if (!(sim.grid.stateAt(x, y) & GR_BLOCK)) continue;
        const f = sim.grid.flavorAt(x, y);
        if (y + 1 < GC_PLAY_HEIGHT && sim.grid.stateAt(x, y + 1) & GR_BLOCK) {
          expect(f).not.toBe(sim.grid.flavorAt(x, y + 1));
        }
        if (x + 1 < GC_PLAY_WIDTH && sim.grid.stateAt(x + 1, y) & GR_BLOCK) {
          expect(f).not.toBe(sim.grid.flavorAt(x + 1, y));
        }
      }
    }
  });
});

describe('GameSim.step', () => {
  it('advances the clock exactly one tick per call', () => {
    const sim = new GameSim(1);
    sim.step(noActions());
    expect(sim.clock.time_step).toBe(1);
    sim.step(noActions());
    expect(sim.clock.time_step).toBe(2);
  });

  it('is deterministic across identical seeds and inputs', () => {
    const a = new GameSim(99);
    const b = new GameSim(99);
    for (let i = 0; i < 50; i++) {
      a.step(noActions());
      b.step(noActions());
    }
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it('runs the wired garbage generator each tick (queued garbage eventually drops)', () => {
    const sim = new GameSim(7);
    const garbageBefore = sim.garbageStore.garbage_count;
    // queue a 1x3 normal slab locally at the current tick
    sim.garbageGenerator.addToQueue(1, 3, GF_NORMAL, sim.clock.time_step);
    expect(sim.garbageGenerator.waitingCount).toBe(1);

    let dropped = false;
    for (let i = 0; i < 1000 && !dropped; i++) {
      sim.step(noActions());
      if (sim.garbageStore.garbage_count > garbageBefore) dropped = true;
    }

    expect(dropped).toBe(true);
    expect(sim.garbageGenerator.waitingCount).toBe(0);
    // the dropped slab occupies three cells (resident type GR_GARBAGE)
    let garbageCells = 0;
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
        if (sim.grid.residentTypeAt(x, y) & GR_GARBAGE) garbageCells++;
      }
    }
    expect(garbageCells).toBe(3);
  });

  it('leaves an empty cell reported as GR_EMPTY (sanity on the snapshot helper)', () => {
    const sim = new GameSim(3);
    // the very top row is always empty at game start
    expect(sim.grid.stateAt(0, GC_PLAY_HEIGHT - 1)).toBe(GR_EMPTY);
  });

  it('the starting stack is fully supported, so block physics leaves it unchanged', () => {
    // The initial board fills each column contiguously from the creep row up,
    // so no block is floating and nothing eliminates (no detector yet): stepping
    // must not move any block.
    const sim = new GameSim(20260708);
    const before = snapshot(sim);
    for (let i = 0; i < 20; i++) sim.step(noActions());
    expect(snapshot(sim)).toBe(before);
  });
});
