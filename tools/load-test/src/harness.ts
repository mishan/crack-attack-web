/**
 * harness.ts — the load engine. It owns this process's bot populations and,
 * on a fast pump loop, drives every game and reconciles the live populations
 * toward their targets, starting each population's bots at its arrival rate.
 * It also measures its own health (event-loop delay, CPU): the numbers that
 * tell whether the generator, not the relay, is the bottleneck. One harness
 * runs the whole load in a single-process run, or a share of it inside a
 * forked worker.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Abuser, type AbuseKind } from './abuse.js';
import type { BotClient } from './client.js';
import {
  DEFAULT_ARRIVALS,
  NO_POPULATIONS,
  type AbuseSpec,
  type ArrivalRates,
  type ChurnConfig,
  type Directive,
  type Populations,
  type ScoreboardConfig,
} from './directives.js';
import { Game, type GameKind } from './bots.js';
import { Churner, Idler, RoomSitter } from './lobby.js';
import { Metrics, type WorkerSample } from './metrics.js';
import { ScoreboardDriver, httpOrigin } from './scoreboardDriver.js';
import { SpectatorBot } from './spectator.js';
import { absNow } from './time.js';

/** How often the pump loop runs, in ms; also the reconcile cadence's floor. */
const PUMP_MS = 4;
/** Reconcile populations this often (spawning is paced, so not every pump). */
const RECONCILE_MS = 100;

type Arrival = keyof ArrivalRates;

let nextId = 0;

export class Harness {
  readonly metrics = new Metrics();
  private url = '';
  private tag = '';
  private rotateMs = 0;
  private arrivals: ArrivalRates = DEFAULT_ARRIVALS;
  /** Bots each population may start now; refilled at its arrival rate. */
  private readonly allowance: Record<Arrival, number> = {
    games: 1,
    spectators: 1,
    idlers: 1,
    rooms: 1,
    churners: 1,
  };

  private readonly games: Game[] = [];
  private readonly spectators: SpectatorBot[] = [];
  /** A late-join burst's watchers: kept out of reconciliation, so they stay to be measured. */
  private readonly lateJoiners: SpectatorBot[] = [];
  private readonly idlers: Idler[] = [];
  private readonly rooms: RoomSitter[] = [];
  private readonly churners: Churner[] = [];
  private readonly abusers: Abuser[] = [];
  private scoreboard: ScoreboardDriver | null = null;
  /** Fake scoreboard client addresses handed out so far. */
  private clientsIssued = 0;
  /** Where the next spread spectator goes, round the games. */
  private spreadCursor = 0;

  private target: Required<Populations> = { ...NO_POPULATIONS };
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

  /**
   * Addresses for a new scoreboard driver's fake clients. Each is its own /48
   * (the relay keys IPv6 limits per /64 and per /48), and none was used by an
   * earlier driver, so a step doesn't start on buckets an earlier step spent.
   */
  private clientAddresses(n: number): string[] {
    const count = Math.max(1, n);
    const first = this.clientsIssued;
    this.clientsIssued += count;
    return Array.from(
      { length: count },
      (_, i) => `2001:db8:${((first + i) & 0xffff).toString(16)}::1`,
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
        if (directive.arrivals !== undefined) this.arrivals = directive.arrivals;
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
      case 'scoreBurst':
        this.scoreboard?.burst();
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
    const open = (list: readonly BotClient[]): number => list.filter((b) => b.open).length;
    const sample: WorkerSample = {
      ...taken,
      gauges: {
        games: this.games.length,
        playing,
        simGames: this.games.filter((g) => g.kind === 'sim').length,
        spectators: [...this.spectators, ...this.lateJoiners].filter((s) => s.watching).length,
        idlers: open(this.idlers),
        rooms: open(this.rooms),
        churners: open(this.churners),
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

  private lobbyLists(): BotClient[][] {
    return [this.spectators, this.lateJoiners, this.idlers, this.rooms, this.churners];
  }

  private socketCount(): number {
    let n = 0;
    for (const g of this.games) for (const p of g.players) if (p.open) n++;
    for (const list of this.lobbyLists()) for (const b of list) if (b.open) n++;
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

    this.refill(dt);
    this.pruneDead();
    this.reconcileGames('wire', this.target.wireGames);
    this.reconcileGames('sim', this.target.simGames);
    this.reconcileSimple(
      this.idlers,
      this.target.idlers,
      'idlers',
      () => new Idler(this.env(), this.name('i')),
      (b) => void b.join().catch(() => this.failed(b)),
    );
    this.reconcileSimple(
      this.rooms,
      this.target.rooms,
      'rooms',
      () => new RoomSitter(this.env(), this.name('r')),
      (b) => void b.start().catch(() => this.failed(b)),
    );
    this.reconcileSimple(
      this.churners,
      this.target.churners,
      'churners',
      () => new Churner(this.env(), this.name('c')),
      (b) => void b.join().catch(() => this.failed(b)),
    );
    this.reconcileSpectators();
  }

  /** Add `dt` ms of each population's arrival rate to its allowance. */
  private refill(dt: number): void {
    for (const kind of Object.keys(this.allowance) as Arrival[]) {
      const rate = this.arrivals[kind];
      // Bank at most two reconciles' worth (and at least one bot), so a late
      // reconcile catches up without the pacing turning into bursts.
      const cap = Math.max(1, (rate * 2 * RECONCILE_MS) / 1000);
      this.allowance[kind] = Math.min(cap, this.allowance[kind] + (rate * dt) / 1000);
    }
  }

  /** How many of `wanted` bots a population may start now; spends its allowance. */
  private take(kind: Arrival, wanted: number): number {
    const n = Math.max(0, Math.min(wanted, Math.floor(this.allowance[kind])));
    this.allowance[kind] -= n;
    return n;
  }

  /** A bot that didn't start: count it and hang up, so it's pruned and replaced. */
  private failed(bot: BotClient): void {
    this.metrics.count('startFailures');
    bot.close();
  }

  private name(prefix: string): string {
    return `${this.tag}${prefix}${nextId++}`;
  }

  /** Drop finished games and closed bots. Bots still connecting stay: they count toward targets. */
  private pruneDead(): void {
    for (let i = this.games.length - 1; i >= 0; i--) {
      const g = this.games[i]!;
      if (!g.alive) {
        g.stop();
        this.games.splice(i, 1);
      }
    }
    for (const list of this.lobbyLists()) {
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.gone) list.splice(i, 1);
    }
  }

  private reconcileGames(kind: GameKind, want: number): void {
    const have = this.games.filter((g) => g.kind === kind).length;
    if (have < want) {
      const add = this.take('games', want - have);
      for (let i = 0; i < add; i++) {
        const game = new Game(this.env(), kind, nextId++, this.rotateMs);
        this.games.push(game);
        game.start().catch(() => {
          this.metrics.count('startFailures');
          game.stop();
          game.alive = false;
        });
      }
      return;
    }
    let remove = have - want;
    for (let i = this.games.length - 1; i >= 0 && remove > 0; i--) {
      if (this.games[i]!.kind === kind) {
        this.games[i]!.stop();
        this.games.splice(i, 1);
        remove--;
      }
    }
  }

  private reconcileSimple<T extends BotClient>(
    list: T[],
    want: number,
    kind: Arrival,
    make: () => T,
    begin: (bot: T) => void,
  ): void {
    if (list.length < want) {
      const add = this.take(kind, want - list.length);
      for (let i = 0; i < add; i++) {
        const bot = make();
        list.push(bot);
        begin(bot);
      }
      return;
    }
    while (list.length > want) list.pop()!.close();
  }

  private reconcileSpectators(): void {
    // Watch any game with a room (the relay seats watchers in waiting rooms
    // too), so a rematch's moment between matches doesn't drop its watchers.
    const hosts = this.games.filter((g) => g.alive && g.code !== null);
    const first = hosts[0];
    const want =
      hosts.length * this.target.spectatorsPerGame + (first ? this.target.spectatorsOnFirst : 0);
    // Watchers still connecting count: they're on their way.
    const have = this.spectators.length;
    if (have < want) {
      const add = this.take('spectators', want - have);
      // Fill the pile-on quota first (L4a), then spread the rest round the games.
      let onFirst = first
        ? this.target.spectatorsOnFirst -
          this.spectators.filter((s) => s.code === first.code).length
        : 0;
      for (let i = 0; i < add; i++) {
        const game = onFirst-- > 0 ? first! : hosts[this.spreadCursor++ % hosts.length]!;
        this.addSpectator(game.code!);
      }
      return;
    }
    while (this.spectators.length > want) this.spectators.pop()!.close();
  }

  private newSpectator(code: string): SpectatorBot {
    return new SpectatorBot(this.env(), this.name('s'), code, (c) =>
      this.games.find((g) => g.code === c),
    );
  }

  private addSpectator(code: string): void {
    const bot = this.newSpectator(code);
    this.spectators.push(bot);
    bot.start().catch(() => this.failed(bot));
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
    this.scoreboard = new ScoreboardDriver({
      baseUrl: httpOrigin(this.url),
      metrics: this.metrics,
      clients: this.clientAddresses(config.clientCount ?? 8),
      ticketsPerSec: config.ticketsPerSec,
      submitsPerSec: config.submitsPerSec,
      scoresPerSec: config.scoresPerSec,
      replaysPerSec: config.replaysPerSec,
      submitKinds: config.submitKinds,
      aiTicks: config.aiTicks,
      prefill: config.prefill,
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
        const bot = this.newSpectator(game.code!);
        this.lateJoiners.push(bot);
        return bot.start().catch(() => this.failed(bot));
      }),
    );
  }

  private slowReaders(count: number, ms: number): void {
    const active = this.spectators.filter((s) => s.watching && !s.paused);
    for (const s of active.slice(0, count)) s.slow(ms);
  }

  /**
   * `fraction` of the players reconnect once. One seat per chosen game (both
   * seats gone at once isn't a reconnect), so games are chosen at twice the
   * rate; a fraction over one half is capped there.
   */
  private async reconnectSome(fraction: number): Promise<void> {
    const playing = this.games.filter((g) => g.playing && g.kind === 'wire');
    const chosen = playing.filter(() => Math.random() < Math.min(1, fraction * 2));
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
    for (const list of this.lobbyLists()) for (const b of list) b.close();
  }
}
