import { describe, expect, it } from 'vitest';
import {
  PLAN_EMPTY,
  PLAN_GARBAGE,
  attackValue,
  evaluateSwap,
  type PlanBoard,
} from './aiPlanner.js';
import { AiController } from './aiController.js';
import { GameSim } from './gameSim.js';
import { readPlanBoard } from './aiPlanner.js';

/**
 * Build a PlanBoard from ASCII rows given top-to-bottom. `.` = empty, `#` =
 * garbage, a digit = that flavour. Column-major storage, y=0 at the bottom.
 */
function board(rows: string[]): PlanBoard {
  const height = rows.length;
  const width = rows[0]!.length;
  const cell = new Int16Array(width * height);
  for (let r = 0; r < height; r++) {
    const y = height - 1 - r; // top row is the highest y
    for (let x = 0; x < width; x++) {
      const ch = rows[r]![x]!;
      cell[x * height + y] = ch === '.' ? PLAN_EMPTY : ch === '#' ? PLAN_GARBAGE : Number(ch);
    }
  }
  return { cell, width, height };
}

describe('aiPlanner cascade evaluator', () => {
  it('a swap that completes a 3-run clears exactly those blocks (no chain)', () => {
    // Row0 = 1 1 2 1; swapping the 2 and the last 1 makes 1 1 1 …
    const b = board(['....', '1121']);
    const c = evaluateSwap(b, 2, 0);
    expect(c.chainDepth).toBe(1);
    expect(c.totalCleared).toBe(3);
    expect(c.maxRound).toBe(3);
    expect(c.garbageShattered).toBe(0);
  });

  it('gravity forms a 4-wide combo (magnitude drives width garbage)', () => {
    // A floating 1 over a gap drops to complete a 4-in-a-row.
    const b = board(['...1', '111.']);
    const c = evaluateSwap(b, 0, 1); // harmless empty swap; gravity does the work
    expect(c.chainDepth).toBe(1);
    expect(c.totalCleared).toBe(4);
    expect(c.maxRound).toBe(4);
  });

  it('detects a 2-chain: a vertical clear drops a cap into a horizontal match', () => {
    // Swapping the Y/2 at (1,2) with the 1 at (2,2) makes column 1 a vertical
    // 1-1-1 (round 1). Clearing it drops the 3 on top of column 1 to the floor,
    // where it lands next to the 3s in columns 0 and 2 → horizontal match (round 2).
    const b = board([
      '.3.', // y3:  .  G  .
      '.21', // y2:  .  Y  1
      '.11', // y1:  .  1  1
      '313', // y0:  G  1  G
    ]);
    const c = evaluateSwap(b, 1, 2);
    expect(c.chainDepth).toBe(2);
    expect(c.totalCleared).toBe(6);
  });

  it('shatters garbage adjacent to a match', () => {
    const b = board([
      '####', // garbage row
      '1121', // swap makes 1 1 1 under the garbage
    ]);
    const c = evaluateSwap(b, 2, 0);
    expect(c.chainDepth).toBe(1);
    expect(c.garbageShattered).toBe(3); // the 3 garbage cells above the cleared run
  });

  it('a swap that completes nothing returns an all-zero cascade', () => {
    const b = board(['....', '1213']);
    const c = evaluateSwap(b, 0, 0);
    expect(c).toEqual({ chainDepth: 0, totalCleared: 0, maxRound: 0, garbageShattered: 0 });
  });

  it('attackValue ranks a chain far above a same-size single combo', () => {
    const chain = attackValue({ chainDepth: 3, totalCleared: 9, maxRound: 3, garbageShattered: 0 });
    const flat = attackValue({ chainDepth: 1, totalCleared: 9, maxRound: 9, garbageShattered: 0 });
    expect(chain).toBeGreaterThan(flat);
  });
});

describe('aiPlanner on real sims', () => {
  it('readPlanBoard reflects the sim grid dimensions and finds blocks', () => {
    const sim = new GameSim(42);
    for (let t = 0; t < 200; t++) sim.step(new AiController('easy').decide(sim));
    const b = readPlanBoard(sim.grid);
    expect(b.width).toBe(6);
    expect(b.height).toBeGreaterThan(0);
    // The opening board is full of blocks, so some cells are non-empty.
    let blocks = 0;
    for (const v of b.cell) if (v >= 0) blocks++;
    expect(blocks).toBeGreaterThan(0);
  });

  it('the evaluator finds real chain opportunities during play', () => {
    // Over a played-out game there should exist board states where some swap
    // triggers a 2+ chain — proof the engine detects chains in real positions.
    let bestChain = 0;
    for (const seed of [1, 7, 42, 2026]) {
      const sim = new GameSim(seed);
      const ai = new AiController('medium');
      for (let t = 0; t < 3000 && !sim.lost; t++) {
        sim.step(ai.decide(sim));
        if (t % 25 === 0) {
          const b = readPlanBoard(sim.grid);
          for (let y = 0; y < b.height; y++) {
            for (let x = 0; x < b.width - 1; x++) {
              const c = evaluateSwap(b, x, y);
              if (c.chainDepth > bestChain) bestChain = c.chainDepth;
            }
          }
        }
      }
    }
    expect(bestChain).toBeGreaterThanOrEqual(2);
  });
});
