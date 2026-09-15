/**
 * directives.ts — the command language between the coordinator and a harness.
 * The coordinator turns a scenario step into target populations and one-shot
 * actions; a harness (in-process, or a forked worker) reconciles toward them.
 * Everything is plain JSON so it crosses a `child_process` fork unchanged.
 */

import type { AbuseKind } from './abuse.js';
import type { ChurnMode } from './lobby.js';
import type { ReplayKind } from './replays.js';

/** Target population sizes a harness holds. Absent fields are left unchanged. */
export interface Populations {
  /** Wire-bot games. */
  wireGames?: number;
  /** Sim-bot games (a full sim pair each). */
  simGames?: number;
  /** Spectators spread evenly across this harness's games. */
  spectatorsPerGame?: number;
  /** Extra spectators all piled onto this harness's first game (L4a). */
  spectatorsOnFirst?: number;
  idlers?: number;
  /** Room sitters (an open, empty room each). */
  rooms?: number;
  churners?: number;
}

/** Every population at zero: where a harness, and a scenario, starts. */
export const NO_POPULATIONS: Required<Populations> = {
  wireGames: 0,
  simGames: 0,
  spectatorsPerGame: 0,
  spectatorsOnFirst: 0,
  idlers: 0,
  rooms: 0,
  churners: 0,
};

/** New bots a second, per population. */
export interface ArrivalRates {
  /** Games created and started (wire and sim together). */
  games: number;
  spectators: number;
  idlers: number;
  rooms: number;
  churners: number;
}

/**
 * The plan's arrival rates: rooms created and started at 5 a second (L3),
 * spectators joining at 20 (L4a), idle sessions connecting at 50 (L2). Room
 * sitters and churners, which the plan doesn't pace, come at the idlers' rate.
 */
export const DEFAULT_ARRIVALS: ArrivalRates = {
  games: 5,
  spectators: 20,
  idlers: 50,
  rooms: 50,
  churners: 50,
};

export interface ChurnConfig {
  mode: ChurnMode;
  /** Lobby events a second, across this harness's churners. */
  ratePerSec: number;
}

export interface AbuseSpec {
  kind: AbuseKind;
  count: number;
  /** Per client: `churn` reconnects a second, `malformed`/`bigframes` messages a second. */
  rate?: number;
}

export interface ScoreboardConfig {
  ticketsPerSec: number;
  submitsPerSec: number;
  scoresPerSec: number;
  replaysPerSec: number;
  submitKinds?: ReplayKind[];
  aiTicks?: number;
  /** Distinct fake client addresses this harness stamps. */
  clientCount?: number;
  /**
   * Stop taking tickets once this many runs are made (L11's verifier
   * saturation, whose runs then go out together on a `scoreBurst`).
   */
  prefill?: number;
}

export type Directive =
  | { type: 'config'; url: string; tag: string; rotateMs?: number; arrivals?: ArrivalRates }
  | { type: 'populations'; populations: Populations }
  | { type: 'churn'; churn: ChurnConfig }
  | { type: 'abuse'; specs: AbuseSpec[] }
  | { type: 'scoreboard'; config: ScoreboardConfig | null }
  /** Submit every scoreboard run that's ready, all at once (L11). */
  | { type: 'scoreBurst' }
  /** Cut a fraction of playing games' seat-0 sockets and reconnect after a spread (L8). */
  | { type: 'reconnectStorm'; fraction: number; spreadMs: number }
  /** All wire games report a result now (L9). */
  | { type: 'endStorm' }
  /** N spectators join this harness's first game within a second (L5). */
  | { type: 'lateJoinBurst'; count: number }
  /** Make `count` of this harness's spectators stop reading for `ms` (negative = forever) (L7). */
  | { type: 'slowReaders'; count: number; ms: number }
  /** A fraction of players (at most one seat a game, so up to 0.5) reconnect once (soak rotation). */
  | { type: 'reconnectSome'; fraction: number }
  | { type: 'sample' }
  | { type: 'shutdown' };

/** A worker → coordinator message. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'sample'; sample: import('./metrics.js').WorkerSample }
  | { type: 'log'; line: string }
  | { type: 'stopped' };
