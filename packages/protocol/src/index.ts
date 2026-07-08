/**
 * @crack-attack/protocol — wire message types shared by client and server.
 *
 * WORK IN PROGRESS. Phase 4 (multiplayer) fleshes this out. For now it pins the
 * protocol version and sketches the tiny netcode surface described in
 * BROWSER_PORT_PLAN.md: per-period garbage events plus a status word. Encoding
 * starts as JSON; a binary codec can replace it later without touching call
 * sites if these stay the single source of truth.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 */

/** Bumped whenever the wire format changes incompatibly. Both peers must match. */
export const PROTOCOL_VERSION = '0.0.0';

/**
 * A single garbage drop sent to the opponent. Mirrors the original's per-period
 * garbage event {time_stamp, height, width, flavor}.
 */
export interface GarbageEvent {
  /** Sender-local tick at which this garbage was generated. */
  timeStamp: number;
  width: number;
  height: number;
  flavor: number;
}

/**
 * Per-period status word exchanged alongside garbage events. Mirrors the
 * original {level_lights, game_state, loss_time_stamp, sync}.
 */
export interface StatusWord {
  levelLights: number;
  gameState: number;
  lossTimeStamp: number;
  sync: number;
}

/** The packet exchanged every communication period. */
export interface PeriodPacket {
  /** Communication period index (tick / CO_COMMUNICATION_PERIOD). */
  period: number;
  garbage: GarbageEvent[];
  status: StatusWord;
  /**
   * Optional per-tick state digest for early desync detection (an improvement
   * over the original, which had none). Filled in once the core exposes it.
   */
  digest?: number;
}
