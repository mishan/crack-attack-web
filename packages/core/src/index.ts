/**
 * @crack-attack/core — public API surface.
 *
 * Deterministic, platform-agnostic simulation of Crack Attack!. This barrel
 * re-exports the stable pieces landed so far. As the port progresses (Grid,
 * Swapper/Creep, combos/garbage, GameSim tick driver) their public types are
 * added here.
 */

export * from './constants.js';
export * from './digest.js';
export * from './rng.js';
export * from './clock.js';
export * from './flavors.js';
export * from './combo.js';
export * from './block.js';
export * from './garbage.js';
export * from './grid.js';
export * from './board.js';
export * from './comboManager.js';
export * from './garbageGenerator.js';
export * from './controller.js';
export * from './swapper.js';
export * from './creep.js';
export * from './signs.js';
export * from './sound.js';
export * from './score.js';
export * from './computerPlayer.js';
export * from './gameSim.js';
