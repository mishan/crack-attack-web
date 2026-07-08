import { describe, expect, it } from 'vitest';
import { BF_NORMAL_1, GC_PLAY_HEIGHT, GC_PLAY_WIDTH, GC_SAFE_HEIGHT } from './constants.js';
import { Block } from './block.js';
import { GR_BLOCK, GR_EMPTY, GR_HANGING, Grid } from './grid.js';

const mkBlock = (id: number, flavor: number): Block => {
  const b = new Block();
  b.id = id;
  b.flavor = flavor;
  return b;
};

describe('Grid initial state', () => {
  it('is entirely empty after construction', () => {
    const grid = new Grid();
    for (let x = 0; x < GC_PLAY_WIDTH; x++) {
      for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
        expect(grid.stateAt(x, y)).toBe(GR_EMPTY);
        expect(grid.residentTypeAt(x, y)).toBe(GR_EMPTY);
      }
    }
    expect(grid.top_occupied_row).toBe(0);
    expect(grid.top_effective_row).toBe(0);
    expect(grid.checkCount).toBe(0);
  });
});

describe('Grid add / change / remove', () => {
  it('addBlock occupies a cell and remove empties it', () => {
    const grid = new Grid();
    const b = mkBlock(0, BF_NORMAL_1);

    grid.addBlock(2, 3, b, GR_BLOCK);
    expect(grid.stateAt(2, 3)).toBe(GR_BLOCK);
    expect(grid.residentTypeAt(2, 3)).toBe(GR_BLOCK);
    expect(grid.blockAt(2, 3)).toBe(b);
    expect(grid.flavorAt(2, 3)).toBe(BF_NORMAL_1);

    grid.remove(2, 3, b);
    expect(grid.stateAt(2, 3)).toBe(GR_EMPTY);
    expect(grid.residentTypeAt(2, 3)).toBe(GR_EMPTY);
  });

  it('changeState updates only the state flag', () => {
    const grid = new Grid();
    const b = mkBlock(0, BF_NORMAL_1);
    grid.addBlock(1, 1, b, GR_BLOCK);
    grid.changeState(1, 1, b, GR_HANGING);
    expect(grid.stateAt(1, 1)).toBe(GR_HANGING);
    expect(grid.residentTypeAt(1, 1)).toBe(GR_BLOCK); // resident type unchanged
    expect(grid.blockAt(1, 1)).toBe(b);
  });

  it('rejects placing into an occupied cell', () => {
    const grid = new Grid();
    grid.addBlock(0, 0, mkBlock(0, BF_NORMAL_1), GR_BLOCK);
    expect(() => grid.addBlock(0, 0, mkBlock(1, BF_NORMAL_1), GR_BLOCK)).toThrow();
  });

  it('rejects resident mismatch on change/remove', () => {
    const grid = new Grid();
    const b = mkBlock(0, BF_NORMAL_1);
    grid.addBlock(0, 0, b, GR_BLOCK);
    expect(() => grid.remove(0, 0, mkBlock(1, BF_NORMAL_1))).toThrow();
  });

  it('blockAt throws when the cell does not hold a block', () => {
    const grid = new Grid();
    expect(() => grid.blockAt(0, 0)).toThrow();
  });
});

describe('Grid.matchAt', () => {
  it('matches same-flavor blocks and rejects different flavors', () => {
    const grid = new Grid();
    grid.addBlock(0, 0, mkBlock(0, BF_NORMAL_1), GR_BLOCK);
    expect(grid.matchAt(0, 0, mkBlock(1, BF_NORMAL_1))).toBe(true);
    expect(grid.matchAt(0, 0, mkBlock(2, BF_NORMAL_1 + 1))).toBe(false);
  });
});

describe('Grid bounds validation', () => {
  it('throws a RangeError for out-of-bounds cell access', () => {
    const grid = new Grid();
    expect(() => grid.stateAt(-1, 0)).toThrow(RangeError);
    expect(() => grid.stateAt(GC_PLAY_WIDTH, 0)).toThrow(RangeError);
    expect(() => grid.stateAt(0, GC_PLAY_HEIGHT)).toThrow(RangeError);
  });

  it('throws a RangeError for an out-of-range check-registry id', () => {
    const grid = new Grid();
    expect(() => grid.checkRegistryOf(-1)).toThrow(RangeError);
    expect(() => grid.checkRegistryOf(1_000_000)).toThrow(RangeError);
  });
});

describe('Grid elimination check registry', () => {
  it('requestEliminationCheck marks the block and counts it', () => {
    const grid = new Grid();
    const b = mkBlock(7, BF_NORMAL_1);
    grid.requestEliminationCheck(b);
    expect(grid.checkCount).toBe(1);
    expect(grid.checkRegistryOf(7).mark).toBe(true);
    expect(grid.checkRegistryOf(7).combo).toBe(null);
  });

  it('does not inflate the count when the same block is re-requested', () => {
    const grid = new Grid();
    const b = mkBlock(3, BF_NORMAL_1);
    grid.requestEliminationCheck(b);
    grid.requestEliminationCheck(b);
    grid.requestEliminationCheck(b);
    // still exactly one outstanding unique check
    expect(grid.checkCount).toBe(1);
  });
});

describe('Grid safe-height + impact tracking', () => {
  it('checkSafeHeightViolation triggers at GC_SAFE_HEIGHT - 1', () => {
    const grid = new Grid();
    grid.top_effective_row = GC_SAFE_HEIGHT - 2;
    expect(grid.checkSafeHeightViolation()).toBe(false);
    grid.top_effective_row = GC_SAFE_HEIGHT - 1;
    expect(grid.checkSafeHeightViolation()).toBe(true);
  });

  it('notifyImpact raises the effective top only when higher', () => {
    const grid = new Grid();
    grid.notifyImpact(5, 3); // impact_top = 5 + 3 - 1 = 7
    expect(grid.top_effective_row).toBe(7);
    grid.notifyImpact(2, 2); // impact_top = 3, lower — no change
    expect(grid.top_effective_row).toBe(7);
  });
});

describe('Grid.shiftGridUp', () => {
  it('moves occupied cells up one row and clears the bottom', () => {
    const grid = new Grid();
    const b = mkBlock(0, BF_NORMAL_1);
    grid.addBlock(0, 1, b, GR_BLOCK);
    grid.top_occupied_row = 1;

    expect(grid.shiftGridUp()).toBe(true);
    expect(grid.stateAt(0, 0)).toBe(GR_EMPTY); // new empty bottom row
    expect(grid.stateAt(0, 2)).toBe(GR_BLOCK); // block moved from row 1 to row 2
    expect(grid.blockAt(0, 2)).toBe(b);
    expect(grid.top_occupied_row).toBe(2);
    expect(grid.top_effective_row).toBe(1); // 0 + 1
  });

  it('returns false at the top without shifting', () => {
    const grid = new Grid();
    grid.top_occupied_row = GC_PLAY_HEIGHT - 1;
    expect(grid.shiftGridUp()).toBe(false);
    expect(grid.top_occupied_row).toBe(GC_PLAY_HEIGHT - 1);
  });
});

describe('Grid.gameStart', () => {
  it('clears residents and resets trackers', () => {
    const grid = new Grid();
    grid.addBlock(0, 0, mkBlock(0, BF_NORMAL_1), GR_BLOCK);
    grid.requestEliminationCheck(mkBlock(0, BF_NORMAL_1));
    grid.top_effective_row = 9;

    grid.gameStart();
    expect(grid.stateAt(0, 0)).toBe(GR_EMPTY);
    expect(grid.checkCount).toBe(0);
    expect(grid.top_effective_row).toBe(0);
    expect(grid.checkRegistryOf(0).mark).toBe(false);
  });
});
