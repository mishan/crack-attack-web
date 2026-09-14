/**
 * coordinator.ts — plays a scenario. It starts (or targets) the relay, forks
 * the workers, and for each step: divides the target populations across the
 * workers, sends them, waits for connections to establish, then holds — every
 * interval it asks each worker for a sample, merges them with the latest relay
 * `STATS` line, writes a CSV row, and fires any timed actions. At the end it
 * prints one summary line per step (the knee table's raw material).
 */

import { CsvWriter } from './csv.js';
import { COLUMNS, toRow } from './columns.js';
import type { AbuseSpec, ChurnConfig, Directive, ScoreboardConfig } from './directives.js';
import { Aggregate } from './metrics.js';
import { startRelayProcess, type RelayProcess } from './relayProcess.js';
import { splitPopulations } from './split.js';
import type { Scenario, ScenarioAction, ScenarioStep } from './scenarios.js';
import { sleep } from './time.js';
import { ForkedWorker, LocalWorker, type WorkerHandle } from './workerHandle.js';
import type { StatsSample } from '@crack-attack/server';

export interface CoordinatorOptions {
  scenario: Scenario;
  csvPath: string;
  workers: number;
  /** An already-running relay; when unset the coordinator starts one. */
  relayUrl?: string | undefined;
  /** SQLite file for a relay the coordinator starts (`:memory:` = none). */
  db?: string | undefined;
  /** Extra env for a relay the coordinator starts (TRUST_PROXY etc.). */
  relayEnv?: Record<string, string> | undefined;
  /** Run the deploy bundle (`dist/relay.mjs`) instead of `dist/main.js`. */
  bundle?: boolean | undefined;
  /** Reading interval, ms (plan: 10 s). */
  intervalMs?: number | undefined;
  rampMs: number;
  holdMs: number;
  inputDelay?: number | undefined;
  /** Wire games report a result this often and rematch (keeps games flowing). */
  rotateMs?: number | undefined;
  log?: ((line: string) => void) | undefined;
}

interface StepSummary {
  step: string;
  games: number;
  spectators: number;
  forwardP99: number;
  relayLoopP99: number;
  relayCpuPct: number;
}

export class Coordinator {
  private readonly log: (line: string) => void;
  private readonly workers: WorkerHandle[] = [];
  private relay: RelayProcess | null = null;
  private relayUrl = '';
  private latestStats: StatsSample | null = null;
  private csv!: CsvWriter;
  private readonly summaries: StepSummary[] = [];

  constructor(private readonly options: CoordinatorOptions) {
    this.log = options.log ?? ((line) => console.log(line));
  }

  async run(): Promise<StepSummary[]> {
    this.csv = new CsvWriter(this.options.csvPath, COLUMNS);
    await this.startRelay();
    await this.startWorkers();
    const config: Directive = {
      type: 'config',
      url: this.relayUrl,
      tag: '',
      ...(this.options.rotateMs !== undefined ? { rotateMs: this.options.rotateMs } : {}),
      ...(this.options.inputDelay !== undefined ? { inputDelay: this.options.inputDelay } : {}),
    };
    this.workers.forEach((w, i) => w.send({ ...config, tag: `w${i}` }));

    try {
      for (const step of this.options.scenario.steps) {
        await this.runStep(step);
      }
    } finally {
      await this.shutdown();
    }
    this.printSummary();
    return this.summaries;
  }

  private async startRelay(): Promise<void> {
    if (this.options.relayUrl) {
      this.relayUrl = this.options.relayUrl;
      this.log(`load-test: using relay at ${this.relayUrl} (no STATS unless it prints them)`);
      return;
    }
    this.relay = await startRelayProcess({
      db: this.options.db ?? ':memory:',
      env: this.options.relayEnv,
      bundle: this.options.bundle,
      // Print stats at the reading cadence, so a row always has a fresh line.
      statsIntervalMs: this.options.intervalMs ?? 10_000,
      onStats: (sample) => (this.latestStats = sample),
      onLog: (line) => this.log(`relay: ${line}`),
    });
    this.relayUrl = this.relay.url;
    this.log(`load-test: started relay on ${this.relayUrl}`);
  }

  private async startWorkers(): Promise<void> {
    const n = this.options.scenario.singleWorker ? 1 : Math.max(1, this.options.workers);
    if (n === 1) {
      this.workers.push(new LocalWorker());
    } else {
      for (let i = 0; i < n; i++) {
        this.workers.push(await ForkedWorker.spawn((line) => this.log(`worker: ${line}`)));
      }
    }
    this.log(`load-test: ${n} worker${n === 1 ? '' : 's'}`);
  }

  private broadcast(directive: Directive): void {
    for (const w of this.workers) w.send(directive);
  }

  private async runStep(step: ScenarioStep): Promise<void> {
    const label = step.label;
    // Populations (divided across workers).
    if (step.populations) {
      const parts = splitPopulations(step.populations, this.workers.length);
      this.workers.forEach((w, i) => w.send({ type: 'populations', populations: parts[i]! }));
    }
    if (step.churn !== undefined) this.sendChurn(step.churn);
    if (step.scoreboard !== undefined) this.sendScoreboard(step.scoreboard);
    if (step.abuse !== undefined) this.sendAbuse(step.abuse);

    const rampMs = step.rampMs ?? this.options.rampMs;
    this.log(`\n== step ${label}: ramping ${(rampMs / 1000).toFixed(0)}s ==`);
    await this.sampleWindow(label, 'ramp', rampMs);

    const holdMs = step.holdMs ?? this.options.holdMs;
    this.log(`== step ${label}: holding ${(holdMs / 1000).toFixed(0)}s ==`);
    const stepAgg = new Aggregate();
    await this.sampleWindow(label, 'hold', holdMs, step.actions, stepAgg);

    this.recordSummary(label, stepAgg);
  }

  private sendChurn(churn: ChurnConfig | null): void {
    // Split the event rate across workers that hold churners.
    const perWorker = churn ? churn.ratePerSec / this.workers.length : 0;
    for (const w of this.workers) {
      w.send({
        type: 'churn',
        churn: churn
          ? { mode: churn.mode, ratePerSec: perWorker }
          : { mode: 'rooms', ratePerSec: 0 },
      });
    }
  }

  private sendScoreboard(config: ScoreboardConfig | null): void {
    // The scoreboard driver runs on worker 0 only (its rates are modest and
    // its fake-client addresses must not collide across workers).
    this.workers[0]!.send({ type: 'scoreboard', config });
  }

  private sendAbuse(specs: AbuseSpec[]): void {
    // Divide each abusive population across workers.
    const n = this.workers.length;
    this.workers.forEach((w, i) => {
      const share = specs
        .map((s) => ({ ...s, count: Math.floor(s.count / n) + (i < s.count % n ? 1 : 0) }))
        .filter((s) => s.count > 0);
      w.send({ type: 'abuse', specs: share });
    });
  }

  /** Fire a scenario action across the workers (single-game ones on worker 0). */
  private fireAction(action: ScenarioAction): void {
    this.log(`   action @${(action.atMs / 1000).toFixed(0)}s: ${action.type}`);
    switch (action.type) {
      case 'reconnectStorm':
        this.broadcast({
          type: 'reconnectStorm',
          fraction: action.fraction,
          spreadMs: action.spreadMs,
        });
        return;
      case 'endStorm':
        this.broadcast({ type: 'endStorm' });
        return;
      case 'reconnectSome':
        this.broadcast({ type: 'reconnectSome', fraction: action.fraction });
        return;
      case 'lateJoinBurst':
        this.workers[0]!.send({ type: 'lateJoinBurst', count: action.count });
        return;
      case 'slowReaders':
        this.workers[0]!.send({ type: 'slowReaders', count: action.count, ms: action.ms });
        return;
    }
  }

  /**
   * Sample every interval over `windowMs`, writing a CSV row each time and
   * firing actions at their offsets. `stepAgg`, if given, also accumulates the
   * whole window (the step's reading). A first sample is taken and discarded so
   * counters start fresh at the window's edge.
   */
  private async sampleWindow(
    step: string,
    phase: string,
    windowMs: number,
    actions: ScenarioAction[] = [],
    stepAgg?: Aggregate,
  ): Promise<void> {
    const interval = this.options.intervalMs ?? 10_000;
    // Reset the workers' interval counters so the window starts clean.
    await Promise.all(this.workers.map((w) => w.sample()));
    const timers = actions.map((a) =>
      setTimeout(() => this.fireAction(a), Math.max(0, Math.min(a.atMs, windowMs))),
    );
    const start = Date.now();
    let elapsed = 0;
    try {
      while (elapsed < windowMs) {
        await sleep(Math.min(interval, windowMs - elapsed));
        elapsed = Date.now() - start;
        const samples = await Promise.all(this.workers.map((w) => w.sample()));
        const seconds = interval / 1000;
        const agg = new Aggregate();
        agg.addInterval(samples, seconds);
        this.csv.write(
          toRow(
            this.options.scenario.name,
            step,
            phase,
            Math.round(elapsed / 1000),
            agg,
            this.latestStats,
          ),
        );
        stepAgg?.addInterval(samples, seconds);
        this.logProgress(phase, elapsed, windowMs, agg);
      }
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  }

  private logProgress(phase: string, elapsed: number, windowMs: number, agg: Aggregate): void {
    const s = this.latestStats;
    this.log(
      `   ${phase} ${(elapsed / 1000).toFixed(0)}/${(windowMs / 1000).toFixed(0)}s  ` +
        `games=${agg.gauges.playing} spec=${agg.gauges.spectators}  ` +
        `fwd p50=${fmt(agg.hist.forward.percentile(50))} p99=${fmt(agg.hist.forward.percentile(99))}ms  ` +
        `relay loop p99=${fmt(s?.loopP99Ms)}ms cpu=${fmt(s?.cpuPct)}% rss=${fmt(s ? s.rssBytes / 1048576 : undefined)}MB`,
    );
  }

  private recordSummary(step: string, agg: Aggregate): void {
    this.summaries.push({
      step,
      games: Math.round(agg.gauges.playing),
      spectators: Math.round(agg.gauges.spectators),
      forwardP99: agg.hist.forward.percentile(99),
      relayLoopP99: this.latestStats?.loopP99Ms ?? NaN,
      relayCpuPct: this.latestStats?.cpuPct ?? NaN,
    });
  }

  private printSummary(): void {
    this.log(`\n=== ${this.options.scenario.name} summary ===`);
    this.log('step\tgames\tspec\tfwdP99ms\trelayLoopP99ms\trelayCpu%');
    for (const s of this.summaries) {
      this.log(
        `${s.step}\t${s.games}\t${s.spectators}\t${fmt(s.forwardP99)}\t${fmt(s.relayLoopP99)}\t${fmt(s.relayCpuPct)}`,
      );
    }
    this.log(`\nCSV: ${this.options.csvPath}`);
  }

  private async shutdown(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.stop()));
    await this.relay?.stop();
  }
}

function fmt(n: number | undefined): string {
  return n === undefined || Number.isNaN(n) ? '-' : (Math.round(n * 100) / 100).toString();
}
