/**
 * digest.ts
 *
 * A compact, deterministic fingerprint of a `GameSim`'s gameplay state at a
 * single tick. This is the unit the golden-master harness compares: two runs
 * (the TS core vs. a stored master, or eventually vs. an instrumented C++ dump)
 * agree iff their per-tick digests match, and the first mismatch pinpoints the
 * tick — and, via {@link snapshotState}, the exact field — that diverged.
 *
 * The digest is deliberately **generator-agnostic**: it hashes observable
 * gameplay state (grid contents, swap cursor, creep, the awaking/dying/loss
 * bookkeeping) but NOT any RNG internal state, since the C++ build uses a
 * different PRNG (glibc `random()`), and RNG-draw order is validated separately
 * by the draw-log approach described in BROWSER_PORT_PLAN.md. Everything hashed
 * here is integer/boolean sim state, so it is portable across runtimes.
 */

import {
  GC_PLAY_HEIGHT,
  GC_PLAY_WIDTH,
  GR_BLOCK,
  GR_EMPTY,
  GR_GARBAGE,
  type GameSim,
} from '@crack-attack/core';

/** Per-cell fingerprint: resident kind + grid state flags + resident flavor. */
export interface CellSnapshot {
  readonly x: number;
  readonly y: number;
  readonly residentType: number;
  readonly state: number;
  /** Block/garbage flavor, or -1 for an empty cell. */
  readonly flavor: number;
}

/** The full structured state a digest is computed from (kept for debugging). */
export interface StateSnapshot {
  readonly timeStep: number;
  readonly topOccupiedRow: number;
  readonly topEffectiveRow: number;
  readonly awakingCount: number;
  readonly dyingCount: number;
  readonly lost: boolean;
  readonly swapperX: number;
  readonly swapperY: number;
  readonly swapperState: number;
  readonly creep: number;
  readonly creepFreeze: boolean;
  readonly lossAlarm: number;
  readonly blockCount: number;
  readonly garbageCount: number;
  /** Only the non-empty cells, in column-major order. */
  readonly cells: readonly CellSnapshot[];
}

/**
 * Capture the gameplay state of `sim` as a structured snapshot. Reads only the
 * public gameplay surface; never touches render/cosmetic state or the RNG.
 */
export function snapshotState(sim: GameSim): StateSnapshot {
  const grid = sim.grid;
  const cells: CellSnapshot[] = [];

  for (let x = 0; x < GC_PLAY_WIDTH; x++) {
    for (let y = 0; y < GC_PLAY_HEIGHT; y++) {
      const residentType = grid.residentTypeAt(x, y);
      if (residentType & GR_EMPTY) continue;

      let flavor = -1;
      if (residentType & GR_BLOCK) flavor = grid.blockAt(x, y).flavor;
      else if (residentType & GR_GARBAGE) flavor = grid.garbageAt(x, y).flavor;

      cells.push({ x, y, residentType, state: grid.stateAt(x, y), flavor });
    }
  }

  return {
    timeStep: sim.clock.time_step,
    topOccupiedRow: grid.top_occupied_row,
    topEffectiveRow: grid.top_effective_row,
    awakingCount: sim.awaking_count,
    dyingCount: sim.dying_count,
    lost: sim.lost,
    swapperX: sim.swapper.x,
    swapperY: sim.swapper.y,
    swapperState: sim.swapper.state,
    creep: sim.creep.creep,
    creepFreeze: sim.creep.creep_freeze,
    lossAlarm: sim.creep.loss_alarm,
    blockCount: sim.blocks.block_count,
    garbageCount: sim.garbageStore.garbage_count,
    cells,
  };
}

/**
 * Serialize a snapshot to the canonical string that gets hashed. Stable field
 * order is load-bearing: the C++ instrumentation must emit these same fields in
 * this same order for cross-validation to be meaningful.
 */
export function canonicalize(s: StateSnapshot): string {
  let out =
    `t=${s.timeStep};to=${s.topOccupiedRow};te=${s.topEffectiveRow};` +
    `aw=${s.awakingCount};dy=${s.dyingCount};lo=${s.lost ? 1 : 0};` +
    `sx=${s.swapperX};sy=${s.swapperY};ss=${s.swapperState};` +
    `cr=${s.creep};cf=${s.creepFreeze ? 1 : 0};la=${s.lossAlarm};` +
    `bc=${s.blockCount};gc=${s.garbageCount}|`;
  for (const c of s.cells) out += `${c.x},${c.y},${c.residentType},${c.state},${c.flavor};`;
  return out;
}

/**
 * 32-bit FNV-1a hash of a string, as 8 lowercase hex chars. Small and
 * dependency-free; collisions are astronomically unlikely for our short inputs,
 * and the harness re-derives the full snapshot at a divergent tick anyway.
 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, kept in 32-bit range via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The per-tick digest string for `sim`: hash of its canonical state snapshot. */
export function digestState(sim: GameSim): string {
  return fnv1a(canonicalize(snapshotState(sim)));
}
