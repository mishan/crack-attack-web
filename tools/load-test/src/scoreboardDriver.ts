/**
 * scoreboardDriver.ts — the scoreboard's load. Each fake client stamps its own
 * `X-Forwarded-For` (the relay keys rate limits on it under TRUST_PROXY), so a
 * pool of them looks like a pool of addresses; per-route status codes are
 * tallied. Replays are made ahead of time by the factory and reused, since a
 * ticket only fixes the seed the run scores under — the driver plays the seed
 * with `makeReplay`, which is the honest path. It runs several loops at target
 * rates: tickets, submits, board reads (queries varied to defeat the cache),
 * and replay reads.
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

/** A rate loop: `perSec` calls a second until stopped. */
function everyRate(perSec: number, fn: () => Promise<void> | void): { stop: () => void } {
  if (perSec <= 0) return { stop: () => undefined };
  let stopped = false;
  const period = 1000 / perSec;
  let next = absNow();
  void (async () => {
    while (!stopped) {
      next += period;
      try {
        await fn();
      } catch {
        // A driver error must not kill the loop (a socket hiccup, a 5xx).
      }
      const wait = next - absNow();
      if (wait > 0) await sleep(wait);
      else next = absNow(); // fell behind: don't spiral
    }
  })();
  return {
    stop: () => {
      stopped = true;
    },
  };
}

export interface ScoreboardDriverOptions {
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
    this.loops.push(
      everyRate(o.ticketsPerSec, () => this.getTicket(kinds)),
      everyRate(o.submitsPerSec, () => this.submitReady()),
      everyRate(o.scoresPerSec, () => this.readBoard()),
      everyRate(o.replaysPerSec, () => this.readReplay()),
    );
  }

  stop(): void {
    for (const l of this.loops) l.stop();
  }

  /** Get a ticket, play its seed into the next replay kind, and queue it to submit. */
  private async getTicket(kinds: ReplayKind[]): Promise<void> {
    const issuedAt = absNow();
    const ticket = (await this.fetch('/ticket', { method: 'POST' })) as SoloTicketResponse | null;
    if (!ticket) return;
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
    if (!pending) return;
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
