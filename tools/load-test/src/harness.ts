/**
 * harness.ts — the load engine. It owns this process's bot populations and,
 * on a fast pump loop, drives every game and reconciles the live populations
 * toward their targets, spawning at a bounded rate. It also measures its own
 * health (event-loop delay, CPU): the numbers that tell whether the generator,
 * not the relay, is the bottleneck. One harness runs the whole load in a
 * single-process run, or a share of it inside a forked worker.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Abuser, type AbuseKind } from './abuse.js';
import type {
  AbuseSpec,
  ChurnConfig,
  Directive,
  Populations,
  ScoreboardConfig,
} from './directives.js';
import { Game, type GameKind } from './bots.js';
import { Churner, Idler, RoomSitter } from './lobby.js';
import { Metrics, type WorkerSample } from './metrics.js';
import { ScoreboardDriver } from './scoreboardDriver.js';
import { SpectatorBot } from './spectator.js';
import { absNow } from './time.js';

/** How often the pump loop runs, in ms; also the reconcile cadence's floor. */
const PUMP_MS = 4;
/** Reconcile populations this often (spawning is paced, so not every pump). */
const RECONCILE_MS = 100;
/** New bots started per reconcile, so a big ramp doesn't stall the loop. */
const SPAWN_BUDGET = 40;

let nextId = 0;

export class Harness {
  readonly metrics = new Metrics();
  private url = '';
  private tag = '';
  private rotateMs = 0;
  private inputDelay = 3;

  private readonly games: Game[] = [];
  private readonly spectators: SpectatorBot[] = [];
  private readonly idlers: Idler[] = [];
  private readonly rooms: RoomSitter[] = [];
  private readonly churners: Churner[] = [];
  private readonly abusers: Abuser[] = [];
  private scoreboard: ScoreboardDriver | null = null;

  private target: Required<Populations> = {
    wireGames: 0,
    simGames: 0,
    spectatorsPerGame: 0,
    spectatorsOnFirst: 0,
    idlers: 0,
    rooms: 0,
    churners: 0,
  };
  private churn: ChurnConfig | null = null;

  private readonly loop = monitorEventLoopDelay({ resolution: 1 });
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private churnTimer: ReturnType<typeof setInterval> | null = null;
  private lastPumpAt = 0;
  private lastCpu = process.cpuUsage();
  private lastReconcileAt = 0;
  private peakLoopP99 = 0;
  private peakLoopMax = 0;
  private peakCpu = 0;

  /** Address the scoreboard driver stamps for each fake client. */
  private clientAddresses(n: number): string[] {
    // Distinct /64s (the relay keys IPv6 per /64), so each is its own client.
    return Array.from(
      { length: Math.max(1, n) },
      (_, i) => `2001:db8:${(i & 0xffff).toString(16)}::1`,
    );
  }

  private env(): { url: string; metrics: Metrics; tag: string } {
    return { url: this.url, metrics: this.metrics, tag: this.tag };
  }

  start(): void {
    this.loop.enable();
    this.lastPumpAt = absNow();
    this.lastReconcileAt = absNow();
    this.pumpTimer = setInterval(() => this.pump(), PUMP_MS);
    this.reconcileTimer = setInterval(() => this.reconcile(), RECONCILE_MS);
  }

  handle(directive: Directive): void {
    switch (directive.type) {
      case 'config':
        this.url = directive.url;
        this.tag = directive.tag;
        if (directive.rotateMs !== undefined) this.rotateMs = directive.rotateMs;
        if (directive.inputDelay !== undefined) this.inputDelay = directive.inputDelay;
        return;
      case 'populations':
        Object.assign(this.target, directive.populations);
        return;
      case 'churn':
        this.churn = directive.churn;
        this.restartChurn();
        return;
      case 'abuse':
        this.setAbuse(directive.specs);
        return;
      case 'scoreboard':
        this.setScoreboard(directive.config);
        return;
      case 'reconnectStorm':
        void this.reconnectStorm(directive.fraction, directive.spreadMs);
        return;
      case 'endStorm':
        this.endStorm();
        return;
      case 'lateJoinBurst':
        void this.lateJoinBurst(directive.count);
        return;
      case 'slowReaders':
        this.slowReaders(directive.count, directive.ms);
        return;
      case 'reconnectSome':
        void this.reconnectSome(directive.fraction);
        return;
      case 'sample':
        return;
      case 'shutdown':
        this.shutdown();
        return;
    }
  }

  /** Metrics since the last sample, plus the current populations, then reset counters. */
  sample(): WorkerSample {
    const taken = this.metrics.take();
    const playing = this.games.filter((g) => g.playing).length;
    const sample: WorkerSample = {
      ...taken,
      gauges: {
        games: this.games.length,
        playing,
        simGames: this.games.filter((g) => g.kind === 'sim').length,
        spectators: this.spectators.filter((s) => s.watching).length,
        idlers: this.idlers.length,
        rooms: this.rooms.length,
        churners: this.churners.length,
        abusers: this.abusers.length,
        sockets: this.socketCount(),
      },
      peaks: {
        genLoopP99: this.peakLoopP99,
        genLoopMax: this.peakLoopMax,
        genCpuPct: this.peakCpu,
      },
      games: this.games.map((g) => g.code).filter((c): c is string => c !== null),
    };
    this.peakLoopP99 = 0;
    this.peakLoopMax = 0;
    this.peakCpu = 0;
    return sample;
  }

  private socketCount(): number {
    let n = 0;
    for (const g of this.games) for (const p of g.players) if (p.open) n++;
    for (const list of [this.spectators, this.idlers, this.rooms, this.churners]) {
      for (const b of list) if (b.open) n++;
    }
    return n;
  }

  // --- The loops -------------------------------------------------------------

  private pump(): void {
    const now = absNow();
    const late = now - this.lastPumpAt - PUMP_MS;
    if (late > 0) this.metrics.hist.tickerLate.record(late);
    this.lastPumpAt = now;
    for (const g of this.games) g.pump(now);
  }

  private reconcile(): void {
    const now = absNow();
    // Sample own health once per reconcile.
    const dt = now - this.lastReconcileAt;
    this.lastReconcileAt = now;
    const p99 = this.loop.percentile(99) / 1e6;
    const max = this.loop.max / 1e6;
    this.loop.reset();
    this.peakLoopP99 = Math.max(this.peakLoopP99, p99);
    this.peakLoopMax = Math.max(this.peakLoopMax, max);
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    if (dt > 0) this.peakCpu = Math.max(this.peakCpu, ((cpu.user + cpu.system) / 1000 / dt) * 100);

    this.pruneDead();
    let budget = SPAWN_BUDGET;
    budget = this.reconcileGames('wire', this.target.wireGames, budget);
    budget = this.reconcileGames('sim', this.target.simGames, budget);
    budget = this.reconcileSimple(
      this.idlers,
      this.target.idlers,
      () => new Idler(this.env(), this.name('i')),
      (b) => void b.join().catch(() => this.metrics.count('startFailures')),
      budget,
    );
    budget = this.reconcileSimple(
      this.rooms,
      this.target.rooms,
      () => new RoomSitter(this.env(), this.name('r')),
      (b) => void b.start().catch(() => this.metrics.count('startFailures')),
      budget,
    );
    budget = this.reconcileSimple(
      this.churners,
      this.target.churners,
      () => new Churner(this.env(), this.name('c')),
      (b) => void b.join().catch(() => this.metrics.count('startFailures')),
      budget,
    );
    this.reconcileSpectators(budget);
  }

  private name(prefix: string): string {
    return `${this.tag}${prefix}${nextId++}`;
  }

  private pruneDead(): void {
    for (let i = this.games.length - 1; i >= 0; i--) {
      const g = this.games[i]!;
      if (!g.alive) {
        g.stop();
        this.games.splice(i, 1);
      }
    }
    const prune = (list: { open: boolean }[]): void => {
      for (let i = list.length - 1; i >= 0; i--) if (!list[i]!.open) list.splice(i, 1);
    };
    prune(this.spectators);
    prune(this.idlers);
    prune(this.rooms);
    prune(this.churners);
  }

  private reconcileGames(kind: GameKind, want: number, budget: number): number {
    const have = this.games.filter((g) => g.kind === kind).length;
    if (have < want) {
      const add = Math.min(budget, want - have);
      for (let i = 0; i < add; i++) {
        const game = new Game(this.env(), kind, nextId++, this.rotateMs);
        this.games.push(game);
        game.start().catch(() => {
          this.metrics.count('startFailures');
          game.stop();
          game.alive = false;
        });
      }
      return budget - add;
    }
    if (have > want) {
      let remove = have - want;
      for (let i = this.games.length - 1; i >= 0 && remove > 0; i--) {
        if (this.games[i]!.kind === kind) {
          this.games[i]!.stop();
          this.games.splice(i, 1);
          remove--;
        }
      }
    }
    return budget;
  }

  private reconcileSimple<T extends { open: boolean; close(): void }>(
    list: T[],
    want: number,
    make: () => T,
    begin: (bot: T) => void,
    budget: number,
  ): number {
    if (list.length < want) {
      const add = Math.min(budget, want - list.length);
      for (let i = 0; i < add; i++) {
        const bot = make();
        list.push(bot);
        begin(bot);
      }
      return budget - add;
    }
    while (list.length > want) list.pop()!.close();
    return budget;
  }

  private reconcileSpectators(budget: number): void {
    const playing = this.games.filter((g) => g.playing && g.code);
    const first = playing[0];
    const want =
      playing.length * this.target.spectatorsPerGame + (first ? this.target.spectatorsOnFirst : 0);
    const alive = this.spectators.filter((s) => s.open);
    if (alive.length < want && playing.length > 0) {
      const add = Math.min(budget, want - alive.length);
      for (let i = 0; i < add; i++) {
        // Fill the pile-on quota first (L4a), then spread the rest.
        const onFirst =
          i < this.target.spectatorsOnFirst - alive.filter((s) => s.code === first?.code).length;
        const target = onFirst && first ? first : playing[i % playing.length]!;
        this.addSpectator(target.code!);
      }
    } else if (alive.length > want) {
      let remove = alive.length - want;
      for (let i = this.spectators.length - 1; i >= 0 && remove > 0; i--) {
        this.spectators[i]!.close();
        this.spectators.splice(i, 1);
        remove--;
      }
    }
  }

  private addSpectator(code: string): void {
    const bot = new SpectatorBot(this.env(), this.name('s'), code, (c) =>
      this.games.find((g) => g.code === c),
    );
    this.spectators.push(bot);
    bot.start().catch(() => this.metrics.count('startFailures'));
  }

  private restartChurn(): void {
    if (this.churnTimer) clearInterval(this.churnTimer);
    this.churnTimer = null;
    const churn = this.churn;
    if (!churn || churn.ratePerSec <= 0) return;
    // Spread events across an interval so a burst doesn't land on one tick.
    const periodMs = Math.max(10, 1000 / churn.ratePerSec);
    this.churnTimer = setInterval(() => {
      const active = this.churners.filter((c) => c.open);
      const churner = active[Math.floor(Math.random() * active.length)];
      if (!churner) return;
      const codes = this.games.map((g) => g.code).filter((c): c is string => c !== null);
      churner.step(churn.mode, codes);
    }, periodMs);
  }

  private setAbuse(specs: AbuseSpec[]): void {
    for (const a of this.abusers) a.stop();
    this.abusers.length = 0;
    for (const spec of specs) {
      for (let i = 0; i < spec.count; i++) {
        const abuser = new Abuser(
          { url: this.url, metrics: this.metrics },
          spec.kind as AbuseKind,
          this.name('x'),
          spec.rate,
        );
        this.abusers.push(abuser);
        abuser.start();
      }
    }
  }

  private setScoreboard(config: ScoreboardConfig | null): void {
    this.scoreboard?.stop();
    this.scoreboard = null;
    if (!config) return;
    const baseUrl = this.url.replace(/^ws/, 'http');
    this.scoreboard = new ScoreboardDriver({
      baseUrl,
      metrics: this.metrics,
      clients: this.clientAddresses(config.clientCount ?? 8),
      ticketsPerSec: config.ticketsPerSec,
      submitsPerSec: config.submitsPerSec,
      scoresPerSec: config.scoresPerSec,
      replaysPerSec: config.replaysPerSec,
      submitKinds: config.submitKinds,
      aiTicks: config.aiTicks,
    });
    this.scoreboard.start();
  }

  // --- One-shot actions ------------------------------------------------------

  private async reconnectStorm(fraction: number, spreadMs: number): Promise<void> {
    const playing = this.games.filter((g) => g.playing);
    const victims = playing.slice(0, Math.ceil(playing.length * fraction));
    await Promise.all(
      victims.map((g) => {
        const delay = spreadMs > 0 ? Math.random() * spreadMs : 0;
        return g.players[0].reconnectAfter(delay);
      }),
    );
  }

  private endStorm(): void {
    const now = absNow();
    for (const g of this.games) {
      if (g.kind === 'wire' && g.playing) g.endAt = now;
    }
  }

  private async lateJoinBurst(count: number): Promise<void> {
    const game = this.games.find((g) => g.playing && g.code);
    if (!game) return;
    await Promise.all(
      Array.from({ length: count }, () => {
        const bot = new SpectatorBot(this.env(), this.name('s'), game.code!, (c) =>
          this.games.find((g) => g.code === c),
        );
        this.spectators.push(bot);
        return bot.start().catch(() => this.metrics.count('startFailures'));
      }),
    );
  }

  private slowReaders(count: number, ms: number): void {
    const active = this.spectators.filter((s) => s.watching && !s.paused);
    for (const s of active.slice(0, count)) s.slow(ms);
  }

  private async reconnectSome(fraction: number): Promise<void> {
    const playing = this.games.filter((g) => g.playing && g.kind === 'wire');
    const chosen = playing.filter(() => Math.random() < fraction);
    await Promise.all(
      chosen.map((g) => g.players[Math.random() < 0.5 ? 0 : 1].reconnectAfter(200)),
    );
  }

  shutdown(): void {
    if (this.pumpTimer) clearInterval(this.pumpTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.churnTimer) clearInterval(this.churnTimer);
    this.loop.disable();
    this.scoreboard?.stop();
    for (const a of this.abusers) a.stop();
    for (const g of this.games) g.stop();
    for (const list of [this.spectators, this.idlers, this.rooms, this.churners]) {
      for (const b of list) b.close();
    }
  }
}
