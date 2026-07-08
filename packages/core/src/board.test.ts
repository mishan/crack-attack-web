import { describe, expect, it } from 'vitest';
import { BF_GRAY, BF_NUMBER_NORMAL, GC_PLAY_HEIGHT, GC_PLAY_WIDTH } from './constants.js';
import { BlockManager } from './block.js';
import { generateInitialBoard, shiftBoardUp } from './board.js';
import { GarbageManager } from './garbage.js';
import { GR_BLOCK, GR_EMPTY, Grid } from './grid.js';
import { Rng } from './rng.js';

interface Board {
  grid: Grid;
  blocks: BlockManager;
  garbage: GarbageManager;
}

const newBoard = (seed: number): Board => {
  const grid = new Grid();
  const rng = new Rng(seed);
  const blocks = new BlockManager(grid, rng);
  const garbage = new GarbageManager(grid);
  return { grid, blocks, garbage };
};

/** Column heights (number of filled block cells, from row 1 up). */
const columnHeights = (grid: Grid): number[] => {
  const heights: number[] = [];
  for (let x = 0; x < GC_PLAY_WIDTH; x++) {
    let h = 0;
    for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
      if (grid.stateAt(x, y) & GR_BLOCK) h++;
      else break;
    }
    heights.push(h);
  }
  return heights;
};

describe('generateInitialBoard', () => {
  it('is deterministic for a given seed', () => {
    const a = newBoard(20260707);
    const b = newBoard(20260707);
    generateInitialBoard(a.grid, a.blocks);
    generateInitialBoard(b.grid, b.blocks);

    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
        expect(a.grid.stateAt(x, y)).toBe(b.grid.stateAt(x, y));
        if (a.grid.stateAt(x, y) & GR_BLOCK) {
          expect(a.grid.flavorAt(x, y)).toBe(b.grid.flavorAt(x, y));
        }
      }
    }
  });

  it('leaves row 0 empty (reserved for the first creep row)', () => {
    const { grid, blocks } = newBoard(1);
    generateInitialBoard(grid, blocks);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(grid.stateAt(x, 0)).toBe(GR_EMPTY);
    }
  });

  it('produces exactly one short column and tall remaining columns', () => {
    const { grid, blocks } = newBoard(42);
    generateInitialBoard(grid, blocks);
    const heights = columnHeights(grid);

    const shortCount = heights.filter((h) => h <= 2).length; // 1 or 2 blocks
    const tallCount = heights.filter((h) => h >= 6).length; // 6 or 7 blocks
    expect(shortCount).toBe(1);
    expect(tallCount).toBe(GC_PLAY_WIDTH - 1);
  });

  it('uses only normal flavors', () => {
    const { grid, blocks } = newBoard(7);
    generateInitialBoard(grid, blocks);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
        if (grid.stateAt(x, y) & GR_BLOCK) {
          const f = grid.flavorAt(x, y);
          expect(f).toBeGreaterThanOrEqual(0);
          expect(f).toBeLessThan(BF_NUMBER_NORMAL);
        }
      }
    }
  });

  it('contains no immediate matches (no equal orthogonal neighbours)', () => {
    // Check many seeds: the fill must never create an eliminable pair.
    for (let seed = 1; seed <= 40; seed++) {
      const { grid, blocks } = newBoard(seed);
      generateInitialBoard(grid, blocks);
      for (let x = 0; x < GC_PLAY_WIDTH; x++) {
        for (let y = 1; y < GC_PLAY_HEIGHT; y++) {
          if (!(grid.stateAt(x, y) & GR_BLOCK)) continue;
          const f = grid.flavorAt(x, y);
          if (y + 1 < GC_PLAY_HEIGHT && grid.stateAt(x, y + 1) & GR_BLOCK) {
            expect(f).not.toBe(grid.flavorAt(x, y + 1));
          }
          if (x + 1 < GC_PLAY_WIDTH && grid.stateAt(x + 1, y) & GR_BLOCK) {
            expect(f).not.toBe(grid.flavorAt(x + 1, y));
          }
        }
      }
    }
  });

  it('sets top_effective_row equal to top_occupied_row at the tallest column', () => {
    const { grid, blocks } = newBoard(99);
    generateInitialBoard(grid, blocks);
    const heights = columnHeights(grid);
    const maxTop = Math.max(...heights.map((h) => h)); // top row index == count (rows 1..h)
    expect(grid.top_occupied_row).toBe(maxTop);
    expect(grid.top_effective_row).toBe(maxTop);
  });
});

describe('newCreepRow', () => {
  it('fills row 0 across the full width with valid flavors', () => {
    const { grid, blocks } = newBoard(123);
    generateInitialBoard(grid, blocks);
    const before = blocks.block_count;

    blocks.newCreepRow();

    expect(blocks.block_count).toBe(before + GC_PLAY_WIDTH);
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(grid.stateAt(x, 0)).toBe(GR_BLOCK);
      // each creep block is a normal flavor (0..4) or the gray special block
      const f = grid.flavorAt(x, 0);
      const isNormal = f >= 0 && f < BF_NUMBER_NORMAL;
      expect(isNormal || f === BF_GRAY).toBe(true);
    }
  });

  it('is deterministic given the shared RNG stream', () => {
    const a = newBoard(555);
    const b = newBoard(555);
    generateInitialBoard(a.grid, a.blocks);
    generateInitialBoard(b.grid, b.blocks);
    a.blocks.newCreepRow();
    b.blocks.newCreepRow();
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      expect(a.grid.flavorAt(x, 0)).toBe(b.grid.flavorAt(x, 0));
    }
  });

  it('fully populates the creep row across many seeds', () => {
    // The creep algorithm avoids three-of-a-kind runs (per column and global
    // history) but may place a horizontal pair, so we only assert the row is
    // always fully filled with valid flavors.
    for (let seed = 1; seed <= 40; seed++) {
      const { grid, blocks } = newBoard(seed);
      generateInitialBoard(grid, blocks);
      blocks.newCreepRow();
      for (let x = 0; x < GC_PLAY_WIDTH; x++) {
        expect(grid.stateAt(x, 0)).toBe(GR_BLOCK);
      }
    }
  });
});

describe('shiftBoardUp', () => {
  it('raises the whole board one row and opens an empty bottom row', () => {
    const { grid, blocks, garbage } = newBoard(2024);
    generateInitialBoard(grid, blocks);

    // snapshot column 0 flavors before the shift
    const before: number[] = [];
    for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
      before.push(grid.stateAt(0, y) & GR_BLOCK ? grid.flavorAt(0, y) : -1);
    }
    const topBefore = grid.top_occupied_row;

    const shifted = shiftBoardUp(grid, blocks, garbage);
    expect(shifted).toBe(true);
    expect(grid.top_occupied_row).toBe(topBefore + 1);

    // row 0 is now empty
    for (let x = 0; x < GC_PLAY_WIDTH; x++) expect(grid.stateAt(x, 0)).toBe(GR_EMPTY);

    // every prior cell moved up exactly one row
    for (let y = 0; y < GC_PLAY_HEIGHT - 1; y++) {
      const after = grid.stateAt(0, y + 1) & GR_BLOCK ? grid.flavorAt(0, y + 1) : -1;
      expect(after).toBe(before[y]);
    }
  });

  it("updates shifted blocks' own y coordinate", () => {
    const { grid, blocks, garbage } = newBoard(11);
    generateInitialBoard(grid, blocks);
    const block = grid.blockAt(0, 1); // a block near the bottom of column 0
    const yBefore = block.y;
    shiftBoardUp(grid, blocks, garbage);
    expect(block.y).toBe(yBefore + 1);
    // and it is now found one row higher
    expect(grid.blockAt(0, 2)).toBe(block);
  });

  it('returns false when the stack already reaches the top', () => {
    const { grid, blocks, garbage } = newBoard(1);
    grid.top_occupied_row = GC_PLAY_HEIGHT - 1;
    expect(shiftBoardUp(grid, blocks, garbage)).toBe(false);
  });
});
