import { describe, expect, it } from 'vitest';
import * as C from './constants.js';

// These assert the *derived* constants resolve to the same literal values the
// C++ preprocessor/compiler computes in Game.h. A mistranscription of a base
// value shows up here rather than as a mysterious desync later.
describe('constants derived values', () => {
  it('grid geometry', () => {
    expect(C.GC_GRID_SIZE).toBe(270); // 6 * 45
    expect(C.GC_GARBAGE_STORE_SIZE).toBe(90); // 2 * 45
    expect(C.GC_BLOCK_STORE_SIZE).toBe(270);
  });

  it('timing', () => {
    expect(C.GC_TIME_STEP_PERIOD).toBe(20); // 1000 / 50
    expect(C.GC_SWAP_DELAY).toBe(6); // 60 / 10
    expect(C.GC_CREEP_INCREMENT_DELAY).toBe(500); // 10 * 50
    expect(C.GC_LOSS_DELAY).toBe(350); // 7 * 50
    expect(C.GC_LOSS_DELAY_ELIMINATION).toBe(50); // 1 * 50
  });

  it('pop delays', () => {
    expect(C.GC_INITIAL_POP_DELAY).toBe(65); // 50 + 15
    expect(C.GC_FINAL_POP_DELAY).toBe(50);
    expect(C.GC_INTERNAL_POP_DELAY).toBe(15);
  });

  it('fall velocity divides the grid subdivision', () => {
    expect(C.GC_STEPS_PER_GRID % C.GC_FALL_VELOCITY).toBe(0);
  });

  it('initial swapper location', () => {
    expect(C.GC_INITIAL_SWAPPER_LOCATION_X).toBe(2); // 6/2 - 1
    expect(C.GC_INITIAL_SWAPPER_LOCATION_Y).toBe(4);
  });

  it('block flavor counts', () => {
    expect(C.BF_NUMBER_NORMAL).toBe(5);
    expect(C.BF_NUMBER).toBe(14);
    expect(C.BF_NUMBER_SPECIAL).toBe(7); // 14 - (6 + 1)
    expect(C.BF_FINAL_GRAY_SPECIAL).toBe(C.BF_WHITE);
  });

  it('game state flags are distinct single bits', () => {
    const flags = [
      C.GS_NORMAL,
      C.GS_PAUSED,
      C.GS_UNPAUSED,
      C.GS_SYNC_WAIT,
      C.GS_MAY_HAVE_LOST,
      C.GS_WON,
      C.GS_LOST,
      C.GS_MUST_CONFIRM_LOSS,
      C.GS_CONFIRMATION_HOLD,
      C.GS_END_PLAY,
      C.GS_CONCESSION,
    ];
    // each a distinct power of two
    const or = flags.reduce((a, b) => a | b, 0);
    expect(or).toBe((1 << flags.length) - 1);
  });

  it('random angle table size is a power of two', () => {
    expect(C.GC_SIZE_RANDOM_ANGLE_TABLE & (C.GC_SIZE_RANDOM_ANGLE_TABLE - 1)).toBe(0);
  });
});
