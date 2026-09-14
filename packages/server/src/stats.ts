/**
 * stats.ts — the relay's `STATS=1` probe (docs/LOAD_TEST_PLAN.md). Every
 * interval it writes one line, `stats {json}`, with event-loop delay, the
 * process's CPU, memory and file descriptors, socket traffic and
 * backpressure, room and session counts, the scoreboard's queue, cache and
 * limiter sizes, and the database's size on disk. It only observes: nothing
 * the relay does changes with it on.
 */

import { readdirSync, statSync } from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RelayStats } from './relay.js';
import type { ScoreboardStats, SoloScoreboard } from './scoreboard.js';
import type { RelayWsServer } from './wsServer.js';

/** Every probe line starts with this, so a log reader can pick them out. */
export const STATS_LINE_PREFIX = 'stats ';

export const DEFAULT_STATS_INTERVAL_MS = 10_000;

/** One probe line's JSON: the interval just ended. */
export interface StatsSample extends RelayStats {
  /** Epoch ms at the end of the interval. */
  t: number;
  intervalMs: number;
  loopP50Ms: number;
  loopP99Ms: number;
  loopMaxMs: number;
  /** CPU time over wall time, in percent of one core. */
  cpuPct: number;
  rssBytes: number;
  heapUsedBytes: number;
  /** Open file descriptors; null without /proc. */
  fds: number | null;
  sockets: number;
  msgsInPerSec: number;
  msgsOutPerSec: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
  bufferedMax: number;
  bufferedTotal: number;
  /** Null when the relay serves no scoreboard. */
  scoreboard: ScoreboardStats | null;
  /** Database and write-ahead log sizes; null for an in-memory database. */
  dbBytes: number | null;
  walBytes: number | null;
}

export interface StatsProbeOptions {
  server: RelayWsServer;
  scoreboard?: SoloScoreboard | undefined;
  /** The SQLite file, for its size; omit for `:memory:`. */
  dbPath?: string | undefined;
  intervalMs?: number | undefined;
  /** Where lines go; default stderr. */
  write?: ((line: string) => void) | undefined;
}

export interface StatsProbe {
  stop(): void;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function openFds(): number | null {
  try {
    // Less the descriptor readdir itself holds open.
    return readdirSync('/proc/self/fd').length - 1;
  } catch {
    return null;
  }
}

/** Start writing a probe line every interval. */
export function startStatsProbe(options: StatsProbeOptions): StatsProbe {
  const intervalMs = options.intervalMs ?? DEFAULT_STATS_INTERVAL_MS;
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Fine resolution so an idle loop reads near zero, not one resolution unit —
  // the plan's knee is a p99 of a few ms, which a 10 ms floor would swallow.
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  let lastAt = performance.now();
  let lastCpu = process.cpuUsage();
  let lastTraffic = options.server.traffic();

  const timer = setInterval(() => {
    const at = performance.now();
    const elapsedMs = at - lastAt;
    const cpu = process.cpuUsage(lastCpu);
    const traffic = options.server.traffic();
    const perSec = (now: number, before: number) => round(((now - before) * 1000) / elapsedMs);
    const memory = process.memoryUsage();
    const sample: StatsSample = {
      t: Date.now(),
      intervalMs: Math.round(elapsedMs),
      loopP50Ms: round(loop.percentile(50) / 1e6),
      loopP99Ms: round(loop.percentile(99) / 1e6),
      loopMaxMs: round(loop.max / 1e6),
      cpuPct: round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 100),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      fds: openFds(),
      ...options.server.relay.stats(),
      sockets: traffic.sockets,
      msgsInPerSec: perSec(traffic.messagesIn, lastTraffic.messagesIn),
      msgsOutPerSec: perSec(traffic.messagesOut, lastTraffic.messagesOut),
      bytesInPerSec: perSec(traffic.bytesIn, lastTraffic.bytesIn),
      bytesOutPerSec: perSec(traffic.bytesOut, lastTraffic.bytesOut),
      bufferedMax: traffic.bufferedMax,
      bufferedTotal: traffic.bufferedTotal,
      scoreboard: options.scoreboard?.stats() ?? null,
      dbBytes: options.dbPath === undefined ? null : fileSize(options.dbPath),
      walBytes: options.dbPath === undefined ? null : fileSize(`${options.dbPath}-wal`),
    };
    write(STATS_LINE_PREFIX + JSON.stringify(sample));
    loop.reset();
    lastAt = at;
    lastCpu = process.cpuUsage();
    lastTraffic = traffic;
  }, intervalMs);
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
      loop.disable();
    },
  };
}
