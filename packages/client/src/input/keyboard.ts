/**
 * keyboard.ts
 *
 * Maps physical keyboard state to a per-tick {@link ActionState}. The core's
 * `Controller`/`ActionState` is the platform-agnostic input contract; this is
 * the browser adapter that fills it from held keys.
 *
 * Two responsibilities live here on purpose (they're platform-layer policy, not
 * sim rules):
 *  - **Rebindable mapping** from `KeyboardEvent.code` to a `CC_*` command bit.
 *  - **Direction normalization**: the deterministic Swapper faithfully ignores a
 *    movement mask with more than one direction bit (UP+RIGHT matches no case and
 *    produces no move). So when several movement keys are held, we resolve to a
 *    single direction — most-recently-pressed wins — before handing the command
 *    to the sim. Swap and advance are independent and pass through as-is.
 *
 * The class tracks state via `press`/`release`; the browser event listeners in
 * `main.ts` feed it. It has no DOM dependency itself, so it is unit-testable
 * with plain `code` strings.
 */

import {
  ActionState,
  CC_ADVANCE,
  CC_DOWN,
  CC_LEFT,
  CC_MOVE_MASK,
  CC_RIGHT,
  CC_SWAP,
  CC_UP,
} from '@crack-attack/core';

/** A map from `KeyboardEvent.code` to a single `CC_*` command bit. */
export type KeyMap = Readonly<Record<string, number>>;

/** Default bindings: arrows or WASD to move, Z/Space to swap, X/Shift to raise. */
export const DEFAULT_KEYMAP: KeyMap = {
  ArrowLeft: CC_LEFT,
  ArrowRight: CC_RIGHT,
  ArrowUp: CC_UP,
  ArrowDown: CC_DOWN,
  KeyA: CC_LEFT,
  KeyD: CC_RIGHT,
  KeyW: CC_UP,
  KeyS: CC_DOWN,
  KeyZ: CC_SWAP,
  Space: CC_SWAP,
  KeyX: CC_ADVANCE,
  ShiftLeft: CC_ADVANCE,
  ShiftRight: CC_ADVANCE,
};

/** Tracks held keys and resolves them to a per-tick command bitmask. */
export class KeyboardInput {
  private readonly keymap: KeyMap;
  /** Held mapped codes in press order (oldest first); newest movement wins. */
  private readonly order: string[] = [];

  constructor(keymap: KeyMap = DEFAULT_KEYMAP) {
    this.keymap = keymap;
  }

  /** Whether `code` is a binding we care about. */
  handles(code: string): boolean {
    return code in this.keymap;
  }

  /** Register a key press. Ignores unmapped keys and auto-repeat re-presses. */
  press(code: string): void {
    if (!(code in this.keymap)) return;
    if (!this.order.includes(code)) this.order.push(code);
  }

  /** Register a key release. */
  release(code: string): void {
    const i = this.order.indexOf(code);
    if (i >= 0) this.order.splice(i, 1);
  }

  /** Drop all held keys (e.g. on window blur, so nothing sticks). */
  clear(): void {
    this.order.length = 0;
  }

  /**
   * The current command bitmask: one movement bit (the most recently pressed
   * held movement key) OR'd with swap/advance if those are held.
   */
  command(): number {
    let move = 0;
    let extras = 0;
    for (const code of this.order) {
      const bit = this.keymap[code]!;
      if (bit & CC_MOVE_MASK)
        move = bit; // later presses overwrite → most recent wins
      else extras |= bit;
    }
    return move | extras;
  }

  /** Snapshot the current input as an {@link ActionState} for `sim.step`. */
  actionState(): ActionState {
    return new ActionState(this.command());
  }
}
