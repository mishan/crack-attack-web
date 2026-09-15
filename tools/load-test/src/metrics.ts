/**
 * metrics.ts — what the generator measures. Each worker keeps a
 * {@link Metrics} and hands the coordinator a {@link WorkerSample} every
 * interval (and resets); the coordinator adds samples up with
 * {@link Aggregate}, once per CSV row and once per scenario step.
 */

import { Histogram, type HistogramData } from './histogram.js';

/** Latency histograms, all in ms. */
export const HISTOGRAMS = [
  /** A player's `inputs` batch sent → the peer's matching `peer_inputs` received. The headline. */
  'forward',
  /** The same batch → a spectator's `peer_inputs`. */
  'spectator',
  /** `spectate` sent → a mid-match `spectate_start` received (whole message). */
  'lateJoin',
  /** Reconnecting `hello` sent → `match_resume` received. */
  'reconnect',
  /** Socket opening → `welcome` received. */
  'welcome',
  /** The moment a game's players were told to report a result → its `match_end` received. */
  'matchEnd',
  /** `peer_dropped` → `match_end` (disconnect) at the survivor, less the reconnect grace. */
  'graceError',
  /**
   * A lobby event sent → each idler's next `room_list`, timed from the oldest
   * event that idler hadn't seen (see {@link Metrics.pushReceived}); the p99 is
   * the tail of one push's fan-out.
   */
  'push',
  /** How late the generator's ticker ran: its own health, not the relay's. */
  'tickerLate',
  /** Scoreboard request → response. */
  'http',
] as const;
export type HistogramName = (typeof HISTOGRAMS)[number];

/** Event counts; summed across workers. */
export const COUNTERS = [
  'msgsIn',
  'bytesIn',
  'msgsOut',
  'bytesOut',
  /** Relay `error` messages to a well-behaved bot. */
  'errors',
  /** Well-behaved bot sockets closed by the relay. */
  'fatalCloses',
  /** Sockets that never opened, and bot starts that failed (a timeout, a refusal). */
  'connectFailures',
  'startFailures',
  /** A `peer_inputs` batch that didn't continue its stream. */
  'contiguityErrors',
  'desyncs',
  /** Ticks a player's lockstep was stuck more than `inputDelay` behind the clock. */
  'stallTicks',
  'matchStarts',
  'matchEnds',
  /** Reconnects that got a `match_resume`. */
  'resumed',
  /** Forfeits seen by a survivor after the reconnect grace ran out. */
  'forfeits',
  /** Reconnects that came back to no match (after the grace). */
  'lateForfeits',
  'roomLists',
  'roomListBytes',
  'lobbyEvents',
  /** Abusive clients: connections opened, closed by the relay, and messages sent. */
  'abuseOpened',
  'abuseClosed',
  'abuseSent',
  /** Scoreboard replays generated, and submissions accepted. */
  'replaysMade',
  'runsRecorded',
  /**
   * Scoreboard driver beats skipped because too many of its requests were
   * still in flight: the configured rate wasn't sustained.
   */
  'scoreboardSkipped',
] as const;
export type CounterName = (typeof COUNTERS)[number];

/** Population sizes right now; summed across workers. */
export const GAUGES = [
  'games',
  'playing',
  'simGames',
  'spectators',
  'idlers',
  'rooms',
  'churners',
  'abusers',
  'sockets',
] as const;
export type GaugeName = (typeof GAUGES)[number];

/** Per-worker health; the worst worker wins. */
export const PEAKS = ['genLoopP99', 'genLoopMax', 'genCpuPct'] as const;
export type PeakName = (typeof PEAKS)[number];

export interface WorkerSample {
  hist: Record<HistogramName, HistogramData>;
  counters: Record<CounterName, number>;
  gauges: Record<GaugeName, number>;
  peaks: Record<PeakName, number>;
  /** Scoreboard responses by `route status`, e.g. `submit 429`. */
  http: Record<string, number>;
  /** Room codes of this worker's games, in creation order (for spectator placement). */
  games: string[];
}

const zeros = <K extends string>(names: readonly K[]): Record<K, number> =>
  Object.fromEntries(names.map((n) => [n, 0])) as Record<K, number>;

/** Lobby events remembered for push timing (a power of two). */
const LOBBY_RING = 64;

/** A worker's running measurements since the last sample. */
export class Metrics {
  readonly hist = Object.fromEntries(HISTOGRAMS.map((n) => [n, new Histogram()])) as Record<
    HistogramName,
    Histogram
  >;
  counters = zeros(COUNTERS);
  http: Record<string, number> = {};
  /** Lobby events this worker's bots have sent, ever (not reset by a take). */
  lobbySeq = 0;
  private readonly lobbyTimes = new Float64Array(LOBBY_RING);

  count(name: CounterName, n = 1): void {
    this.counters[name] += n;
  }

  httpStatus(route: string, status: number | string): void {
    const key = `${route} ${status}`;
    this.http[key] = (this.http[key] ?? 0) + 1;
  }

  /** A bot sent a lobby event (each one a room-list push to every session) at `at`. */
  lobbyEvent(at: number): void {
    this.lobbySeq++;
    this.lobbyTimes[this.lobbySeq & (LOBBY_RING - 1)] = at;
    this.count('lobbyEvents');
  }

  /**
   * A session that had seen lobby events up to `seen` got a room list at `at`.
   * Times it from the oldest event it hadn't seen: when events come faster than
   * pushes, an upper bound, never a flattering one. Returns the events now seen.
   */
  pushReceived(seen: number, at: number): number {
    if (seen >= this.lobbySeq) return seen;
    const oldest = Math.max(seen + 1, this.lobbySeq - LOBBY_RING + 1);
    this.hist.push.record(at - this.lobbyTimes[oldest & (LOBBY_RING - 1)]!);
    return this.lobbySeq;
  }

  /** Everything since the last take, as plain data; then start afresh. */
  take(): Pick<WorkerSample, 'hist' | 'counters' | 'http'> {
    const hist = Object.fromEntries(
      HISTOGRAMS.map((n) => {
        const data = this.hist[n].toData();
        this.hist[n].reset();
        return [n, data];
      }),
    ) as Record<HistogramName, HistogramData>;
    const out = { hist, counters: this.counters, http: this.http };
    this.counters = zeros(COUNTERS);
    this.http = {};
    return out;
  }
}

/** Samples added up: across workers for one interval, or across a step's intervals. */
export class Aggregate {
  readonly hist = Object.fromEntries(HISTOGRAMS.map((n) => [n, new Histogram()])) as Record<
    HistogramName,
    Histogram
  >;
  readonly counters = zeros(COUNTERS);
  /** The latest gauges (summed over the workers of the latest interval). */
  gauges = zeros(GAUGES);
  readonly peaks = zeros(PEAKS);
  readonly http: Record<string, number> = {};
  /** Seconds of samples added. */
  seconds = 0;

  /** Add one interval, `seconds` long: every worker's sample for it. */
  addInterval(samples: readonly WorkerSample[], seconds: number): void {
    const gauges = zeros(GAUGES);
    for (const s of samples) {
      for (const n of HISTOGRAMS) this.hist[n].merge(s.hist[n]);
      for (const n of COUNTERS) this.counters[n] += s.counters[n];
      for (const n of GAUGES) gauges[n] += s.gauges[n];
      for (const n of PEAKS) this.peaks[n] = Math.max(this.peaks[n], s.peaks[n]);
      for (const [k, v] of Object.entries(s.http)) this.http[k] = (this.http[k] ?? 0) + v;
    }
    this.gauges = gauges;
    this.seconds += seconds;
  }

  /** A counter per second over the samples added. */
  rate(name: CounterName): number {
    return this.seconds > 0 ? this.counters[name] / this.seconds : NaN;
  }
}
