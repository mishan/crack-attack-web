/**
 * controller.ts
 *
 * The per-tick input snapshot the simulation consumes. Ported from the abstract
 * action surface of `Controller.{h,cxx}` — the sim only ever reads
 * `moveCommand`/`swapCommand`/`advanceCommand`, never raw keys. Input devices
 * (keyboard, touch, replay, AI) are the caller's problem; they populate an
 * {@link ActionState} each tick and hand it to `GameSim.step`.
 *
 * Commands are bit flags matching the C++ `CC_*` values so ported gameplay code
 * (Swapper/Creep) reads them one-to-one. Pause is a meta concern handled outside
 * the sim, so it is intentionally omitted here.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

// --- Controller command bits (Controller.h:29-34) --------------------------

export const CC_LEFT = 1 << 0;
export const CC_RIGHT = 1 << 1;
export const CC_UP = 1 << 2;
export const CC_DOWN = 1 << 3;
export const CC_SWAP = 1 << 4;
export const CC_ADVANCE = 1 << 5;

/** All movement bits, as returned by {@link ActionState.moveCommand}. */
export const CC_MOVE_MASK = CC_LEFT | CC_RIGHT | CC_UP | CC_DOWN;

/**
 * A snapshot of the controls held on one tick. Mirrors the query surface of
 * `Controller` (moveCommand/swapCommand/advanceCommand) over a bitmask.
 */
export class ActionState {
  constructor(public state = 0) {}

  /** Movement bits currently set. Mirrors `Controller::moveCommand` (Controller.h:50). */
  moveCommand(): number {
    return this.state & CC_MOVE_MASK;
  }

  /** Whether swap is requested. Mirrors `Controller::swapCommand` (Controller.h:53). */
  swapCommand(): boolean {
    return (this.state & CC_SWAP) !== 0;
  }

  /** Whether manual creep advance is requested. Mirrors `Controller::advanceCommand` (Controller.h:56). */
  advanceCommand(): boolean {
    return (this.state & CC_ADVANCE) !== 0;
  }
}

/** A neutral action snapshot (nothing held). Handy default for ticks with no input. */
export function noActions(): ActionState {
  return new ActionState(0);
}
