/**
 * board.ts
 *
 * Cross-subsystem board setup and rise, coordinating the Grid with the object
 * stores. These are the parts of the C++ that live on `Grid`/`Creep` but reach
 * across into `BlockManager`/`GarbageManager`; in the port they are free
 * functions the future `GameSim` calls, keeping Grid and the managers free of
 * mutual references.
 *
 * Ported here:
 *   - `generateInitialBoard` — the RNG initial block fill from `Grid::gameStart`
 *     (Grid.cxx:61-101).
 *   - `shiftBoardUp` — the full effect of `Grid::shiftGridUp` (Grid.cxx:339):
 *     the grid shift plus the block/garbage store shifts, in the C++ order.
 *
 * The gameplay RNG stream is the one owned by the `BlockManager`, so the board
 * fill and subsequent creep rows draw from a single sequence — draw order is
 * load-bearing for cross-runtime determinism.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { BF_NUMBER_NORMAL, GC_PLAY_WIDTH } from './constants.js';
import type { BlockManager } from './block.js';
import type { GarbageManager } from './garbage.js';
import { GR_EMPTY, type Grid } from './grid.js';
import type { Swapper } from './swapper.js';

/**
 * Fill the initial board with resting blocks. Mirrors the generation half of
 * `Grid::gameStart` (Grid.cxx:61-101). Assumes `grid.gameStart()` has already
 * cleared the playfield (top rows at 0).
 *
 * One column is "short" (height ~2), the rest are ~7, each plus 0/1 rows of
 * jitter. Flavors avoid an immediate vertical or rightward match, and the
 * bottom two rows seed the block manager's creep flavor history so the first
 * creep rows continue the sequence faithfully.
 *
 * RNG draw order (single shared stream): `number(WIDTH)` for the short column,
 * then per column x = WIDTH-1..0 a `number2(2)` height jitter followed by a
 * `number(BF_NUMBER_NORMAL)` per filled cell (retried on a match).
 */
export function generateInitialBoard(grid: Grid, blocks: BlockManager): void {
  const rng = blocks.rng;

  const shortColumn = rng.number(GC_PLAY_WIDTH);

  for (let x = GC_PLAY_WIDTH; x--;) {
    const height = (shortColumn === x ? 2 : 7) + rng.number2(2);
    if (height - 1 > grid.top_occupied_row) grid.top_occupied_row = height - 1;

    for (let y = height; --y;) {
      let flavor: number;
      for (;;) {
        flavor = rng.number(BF_NUMBER_NORMAL);

        // reject a vertical match with the block just placed above
        if (!(grid.stateAt(x, y + 1) & GR_EMPTY) && grid.blockAt(x, y + 1).flavor === flavor) {
          continue;
        }
        // last column has no right neighbour to consider
        if (x === GC_PLAY_WIDTH - 1) break;
        // reject a horizontal match with the already-filled column to the right
        if (!(grid.stateAt(x + 1, y) & GR_EMPTY) && grid.blockAt(x + 1, y).flavor === flavor) {
          continue;
        }
        break;
      }

      // seed the creep flavor history for the bottom two rows
      if (y === 2) blocks.second_to_last_row_c[x] = flavor;
      else if (y === 1) blocks.last_row_c[x] = flavor;

      blocks.newBlock(x, y, flavor);
    }
  }

  grid.top_effective_row = grid.top_occupied_row;
}

/**
 * Raise the whole board one cell and shift the object stores to match. Mirrors
 * the full behavior of `Grid::shiftGridUp` (Grid.cxx:339): the grid array shift
 * (via `grid.shiftGridUp`) followed by `BlockManager::shiftUp`,
 * `GarbageManager::shiftUp`, and `Swapper::shiftUp`, in that order. Returns
 * false when the board can't rise (already at the top). The `swapper` is
 * optional so board-only tests can shift without a cursor; `LevelLights::
 * levelRaise` stays deferred (Phase 2).
 */
export function shiftBoardUp(
  grid: Grid,
  blocks: BlockManager,
  garbage: GarbageManager,
  swapper?: Swapper,
): boolean {
  if (!grid.shiftGridUp()) return false;

  blocks.shiftUp();
  garbage.shiftUp();
  swapper?.shiftUp();
  // TODO: LevelLights.levelRaise (Phase 2).

  return true;
}
