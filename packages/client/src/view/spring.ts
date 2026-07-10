/**
 * spring.ts — the board's screen-shake spring (pure, render-layer).
 *
 * Faithful port of `Spring.{h,cxx}`: a garbage slab finishing its initial fall
 * kicks the board downward, and a damped spring settles it back. All math is
 * float — this lives strictly on the render side of the determinism boundary
 * (impacts arrive as cosmetic events from the sim; nothing feeds back).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

// Spring constants, if you will (Spring.h:30-33).
const SP_IMPACT_VELOCITY = 0.1;
const SP_GARBAGE_DENSITY = 0.2;
const SP_STIFFNESS = 0.1;
const SP_DRAG = 0.1;

/**
 * The reference's world units per grid cell (DC_GRID_ELEMENT_LENGTH = 2.0):
 * the spring's `y` is in those units; divide by this to get our cell units.
 */
export const SPRING_UNITS_PER_CELL = 2.0;

export class Spring {
  /** Board vertical offset, in the reference's world units. */
  y = 0;
  private v = 0;

  /** Reset for a new game. Mirrors `Spring::gameStart`. */
  gameStart(): void {
    this.y = 0;
    this.v = 0;
  }

  /** A slab of `height` × `width` landed. Mirrors `Spring::notifyImpact` (Spring.h:40). */
  notifyImpact(height: number, width: number): void {
    const dv = (SP_IMPACT_VELOCITY + this.v) * (height * width) * SP_GARBAGE_DENSITY;
    if (dv > 0) this.v -= dv;
  }

  /** Advance one 50 Hz tick. Mirrors `Spring::timeStep` (Spring.h:47). */
  timeStep(): void {
    this.y += this.v;
    this.v -= SP_STIFFNESS * this.y + SP_DRAG * this.v;
  }

  /** The offset in our render units (1 unit = 1 grid cell). */
  get offsetCells(): number {
    return this.y / SPRING_UNITS_PER_CELL;
  }
}
