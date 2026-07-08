/**
 * @crack-attack/core — public API surface.
 *
 * Deterministic, platform-agnostic simulation of Crack Attack!. This barrel
 * re-exports the stable pieces landed so far. As the port progresses (Grid,
 * Swapper/Creep, combos/garbage, GameSim tick driver) their public types are
 * added here.
 */

export * from './constants.js';
export * from './rng.js';
export * from './flavors.js';
export * from './combo.js';
export * from './block.js';
export * from './garbage.js';
export * from './grid.js';
export * from './board.js';
