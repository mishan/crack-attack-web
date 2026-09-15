/**
 * scoreboardDriver.ts — the scoreboard's load. Each fake client stamps its own
 * `X-Forwarded-For` (the relay keys rate limits on it under TRUST_PROXY), so a
 * pool of them looks like a pool of addresses; per-route status codes are
 * tallied. Each ticket's seed is played into a replay with `makeReplay` (the
 * honest path) and queued until the server's pacing floor would accept it. It
 * runs several loops at target rates — tickets, submits, board reads (queries
 * varied to defeat the cache), and replay reads — each offering its rate
 * whether or not earlier requests have come back.
 */

import { GC_STEPS_PER_SECOND, type SoloReplay } from '@crack-attack/core';
import {
  SOLO_API_PREFIX,
  type SoloSubmitRequest,
  type SoloTicketResponse,
} from '@crack-attack/protocol';
import type { Metrics } from './metrics.js';
import { makeReplay, type ReplayKind } from './replays.js';
import { absNow, sleep } from './time.js';

/** Most calls one rate loop keeps in flight (requests, replay builds) before it skips a beat. */
const MAX_IN_FLIGHT = 32;

/**
 * A rate loop: starts `fn` `perSec` times a second without waiting for earlier
 * calls, so a slow relay doesn't lower the load offered to it. At most
 * {@link MAX_IN_FLIGHT} calls run at once; a beat past that is skipped and
 * `onSkip` counts it, so a rate the driver couldn't sustain shows in the CSV.
 */
function everyRate(
  perSec: number,
  fn: () => Promise<void>,
  onSkip: () => void,
): { stop: () => void } {
  if (perSec <= 0) return { stop: () => undefined };
  let stopped = false;
  let inFlight = 0;
  const period = 1000 / perSec;
  let next = absNow();
  void (async () => {
    while (!stopped) {
      next += period;
      if (inFlight >= MAX_IN_FLIGHT) {
        onSkip();
      } else {
        inFlight++;
        fn()
          // A driver error must not kill the loop (a socket hiccup, a 5xx).
          .catch(() => undefined)
          .finally(() => inFlight--);
      }
      const wait = next - absNow();
      if (wait <= 0) next = absNow(); // fell behind: don't spiral
      await sleep(wait); // yields even when behind
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

/**
 * The HTTP origin of a relay's WebSocket URL, as the client derives it:
 * `wss://example.com/ws` → `https://example.com` (the API is at `/api/`, not
 * under the WebSocket's path).
 */
export function httpOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.origin;
}

export interface ScoreboardDriverOptions {
  /** The relay's HTTP origin ({@link httpOrigin}). */
  baseUrl: string;
  metrics: Metrics;
  /** Fake client addresses to spread requests over. */
  clients: string[];
  ticketsPerSec: number;
  submitsPerSec: number;
  scoresPerSec: number;
  replaysPerSec: number;
  /** Mix of replay kinds to submit; picked round-robin. Default advance + ai. */
  submitKinds?: ReplayKind[] | undefined;
  /** Ticks the `ai` submit kind plays. */
  aiTicks?: number | undefined;
  /** Stop taking tickets once this many runs are made (for a {@link ScoreboardDriver.burst}). */
  prefill?: number | undefined;
}

/** Milliseconds of wall time a run must age before the server will accept it. */
const MS_PER_TICK = 1000 / GC_STEPS_PER_SECOND;
/** Extra margin over the server's pacing floor, so a submit is never a hair too early. */
const PACING_MARGIN_MS = 300;

interface Pending {
  ticket: SoloTicketResponse;
  replay: SoloReplay;
  /** Earliest wall time the server's pacing floor will accept this run. */
  earliestAt: number;
}

export class ScoreboardDriver {
  private readonly loops: { stop: () => void }[] = [];
  /** Verified runs to read back by id. */
  private readonly recordedIds: number[] = [];
  /** Tickets whose replay is ready, awaiting submission. */
  private readonly ready: Pending[] = [];
  /** Tickets asked for or held, against `prefill`. */
  private claimed = 0;
  private kindCursor = 0;
  private clientCursor = 0;

  constructor(private readonly options: ScoreboardDriverOptions) {}

  private nextClient(): string {
    const c = this.options.clients;
    return c[this.clientCursor++ % c.length] ?? '127.0.0.1';
  }

  start(): void {
    const o = this.options;
    const kinds = o.submitKinds ?? ['advance', 'ai'];
    const skipped = (): void => o.metrics.count('scoreboardSkipped');
    this.loops.push(
      everyRate(o.ticketsPerSec, () => this.getTicket(kinds), skipped),
      everyRate(o.submitsPerSec, () => this.submitReady(), skipped),
      everyRate(o.scoresPerSec, () => this.readBoard(), skipped),
      everyRate(o.replaysPerSec, () => this.readReplay(), skipped),
    );
  }

  stop(): void {
    for (const l of this.loops) l.stop();
  }

  /** Submit every run the pacing floor already allows, all at once (verifier saturation). */
  burst(): void {
    const now = absNow();
    for (let i = this.ready.length - 1; i >= 0; i--) {
      const pending = this.ready[i]!;
      if (pending.earliestAt > now) continue;
      this.ready.splice(i, 1);
      void this.submit(pending);
    }
  }

  /** Get a ticket, play its seed into the next replay kind, and queue it to submit. */
  private async getTicket(kinds: ReplayKind[]): Promise<void> {
    const prefill = this.options.prefill;
    if (prefill !== undefined && this.claimed >= prefill) return;
    this.claimed++;
    const ticket = (await this.fetch('/ticket', { method: 'POST' })) as SoloTicketResponse | null;
    if (!ticket) {
      this.claimed--;
      return;
    }
    // The server starts the run's pacing clock when it issues the ticket: time
    // it from the response, which is a little late and so never too early.
    const issuedAt = absNow();
    const kind = kinds[this.kindCursor++ % kinds.length]!;
    const replay = await makeReplay(kind, ticket.seed, { aiTicks: this.options.aiTicks });
    this.options.metrics.count('replaysMade');
    // The server rejects a run submitted before it could have been played (and
    // spends its ticket doing so), so hold it until it has aged past the floor —
    // the honest client, which plays the whole game first, behaves the same.
    const earliestAt = issuedAt + replay.ticks * MS_PER_TICK + PACING_MARGIN_MS;
    // Keep the ready queue bounded, so a slow submit rate can't grow it forever.
    if (this.ready.length < 256) this.ready.push({ ticket, replay, earliestAt });
  }

  private async submitReady(): Promise<void> {
    const now = absNow();
    const i = this.ready.findIndex((p) => p.earliestAt <= now);
    if (i < 0) return;
    const [pending] = this.ready.splice(i, 1);
    if (pending) await this.submit(pending);
  }

  private async submit(pending: Pending): Promise<void> {
    const request: SoloSubmitRequest = {
      runId: pending.ticket.runId,
      name: 'loadtest',
      replay: pending.replay,
    };
    const body = (await this.fetch('/submit', {
      method: 'POST',
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' },
    })) as { id?: number } | null;
    if (body && typeof body.id === 'number') {
      this.options.metrics.count('runsRecorded');
      if (this.recordedIds.length < 1024) this.recordedIds.push(body.id);
    }
  }

  private async readBoard(): Promise<void> {
    // Vary board/period/month so consecutive reads miss the 5 s cache.
    const board = Math.random() < 0.5 ? 'score' : 'mult';
    const period = Math.random() < 0.5 ? 'all' : 'month';
    const limit = 1 + Math.floor(Math.random() * 100);
    await this.fetch(`/scores?board=${board}&period=${period}&limit=${limit}`, { method: 'GET' });
  }

  private async readReplay(): Promise<void> {
    const id = this.recordedIds[Math.floor(Math.random() * this.recordedIds.length)];
    if (id === undefined) return;
    await this.fetch(`/replay/${id}`, { method: 'GET' });
  }

  /** A request against `route`, tallied by status; the parsed JSON, or null on any non-2xx/error. */
  private async fetch(route: string, init: RequestInit): Promise<unknown> {
    const started = absNow();
    const name = route.split(/[/?]/)[1] ?? route;
    try {
      const res = await fetch(`${this.options.baseUrl}${SOLO_API_PREFIX}${route}`, {
        ...init,
        headers: { ...init.headers, 'X-Forwarded-For': this.nextClient() },
      });
      this.options.metrics.hist.http.record(absNow() - started);
      this.options.metrics.httpStatus(name, res.status);
      const text = await res.text();
      if (!res.ok) return null;
      return text ? JSON.parse(text) : null;
    } catch {
      this.options.metrics.hist.http.record(absNow() - started);
      this.options.metrics.httpStatus(name, 'error');
      return null;
    }
  }
}
