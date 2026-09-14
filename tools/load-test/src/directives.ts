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
  /** Spectators spread evenly across this harness's playing games. */
  spectatorsPerGame?: number;
  /** Extra spectators all piled onto this harness's first game (L4a). */
  spectatorsOnFirst?: number;
  idlers?: number;
  /** Room sitters (an open, empty room each). */
  rooms?: number;
  churners?: number;
}

export interface ChurnConfig {
  mode: ChurnMode;
  /** Lobby events a second, across this harness's churners. */
  ratePerSec: number;
}

export interface AbuseSpec {
  kind: AbuseKind;
  count: number;
  /** `churn`: reconnects a second per client. */
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
}

export type Directive =
  | { type: 'config'; url: string; tag: string; rotateMs?: number; inputDelay?: number }
  | { type: 'populations'; populations: Populations }
  | { type: 'churn'; churn: ChurnConfig }
  | { type: 'abuse'; specs: AbuseSpec[] }
  | { type: 'scoreboard'; config: ScoreboardConfig | null }
  /** Cut a fraction of playing games' seat-0 sockets and reconnect after a spread (L8). */
  | { type: 'reconnectStorm'; fraction: number; spreadMs: number }
  /** All wire games report a result now (L9). */
  | { type: 'endStorm' }
  /** N spectators join this harness's first game within a second (L5). */
  | { type: 'lateJoinBurst'; count: number }
  /** Make `count` of this harness's spectators stop reading for `ms` (negative = forever) (L7). */
  | { type: 'slowReaders'; count: number; ms: number }
  /** A fraction of players reconnect once (soak rotation). */
  | { type: 'reconnectSome'; fraction: number }
  | { type: 'sample' }
  | { type: 'shutdown' };

/** A worker → coordinator message. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'sample'; sample: import('./metrics.js').WorkerSample }
  | { type: 'log'; line: string }
  | { type: 'stopped' };
