/**
 * @crack-attack/client — browser entry point.
 *
 * Placeholder. Phase 2 builds the Three.js scene, the 50 Hz sim accumulator,
 * interpolated rendering, input mapping, and the HUD. For now it just proves
 * the client can consume the deterministic core.
 */

import { GC_STEPS_PER_SECOND, Rng } from '@crack-attack/core';

export function bootInfo(): string {
  const rng = new Rng(1);
  return `Crack Attack! web client — sim runs at ${GC_STEPS_PER_SECOND} Hz (rng check: ${rng.number(6)})`;
}
