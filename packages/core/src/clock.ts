/**
 * clock.ts
 *
 * The simulation tick counter. In the C++ this is the global `Game::time_step`,
 * read all over the codebase (alarms, combo timestamps, garbage drop times).
 * The port keeps it as a small shared object that the future `GameSim` owns and
 * advances once per tick; subsystems hold a reference and read `time_step`.
 *
 * Kept integer-only — it is part of simulation state.
 */

export class Clock {
  /** Current simulation tick. Mirrors `Game::time_step`. */
  time_step = 0;
}
