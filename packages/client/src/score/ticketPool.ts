/**
 * ticketPool.ts — keeps one solo run ticket in hand, so a ranked run can start
 * the moment its board is created: the seed decides the board, so it must be
 * known before the countdown (docs/SCOREBOARD_PLAN.md).
 *
 * Expiry is kept on this browser's clock: a ticket lasts SOLO_TICKET_TTL_MS
 * from when it was asked for, whatever the server's `expiresAt` reads here, so
 * a skewed clock can't make a fresh ticket look stale (or an old one fresh). A
 * timer fetches a replacement once the ticket gets too close to expiry, and the
 * page can call {@link TicketPool.refill} when it comes back into view (a
 * sleeping laptop's timers run late).
 */

import { SIM_VERSION } from '@crack-attack/core';
import { SOLO_TICKET_TTL_MS, type SoloTicketResponse } from '@crack-attack/protocol';

/** A ticket this close to expiry is dropped: a run started on it might not finish in time. */
export const TICKET_SAFETY_MS = 60 * 60 * 1000;

/**
 * Why there's no ticket for a run: `offline` (none in hand — the scoreboard is
 * unreachable, or the request is still on its way) or `stale` (the server runs
 * newer rules than this page; reloading fixes it).
 */
export type NoTicketReason = 'offline' | 'stale';

/** A ticket taken for a run. */
export interface HeldTicket {
  ticket: SoloTicketResponse;
  /** When the ticket expires, on this browser's clock (epoch ms). */
  expiresAt: number;
}

/** Run `fn` once after `ms`; returns a function that cancels it. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export interface TicketPoolOptions {
  now?: () => number;
  setTimer?: SetTimer;
  /** Whether tickets are wanted (ranked play on); the expiry timer refills only then. */
  wanted?: () => boolean;
}

const browserTimer: SetTimer = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export class TicketPool {
  private held: HeldTicket | null = null;
  private inFlight: Promise<void> | null = null;
  private stale = false;
  private cancelTimer: (() => void) | null = null;
  private readonly now: () => number;
  private readonly setTimer: SetTimer;
  private readonly wanted: () => boolean;

  constructor(
    private readonly fetchTicket: () => Promise<SoloTicketResponse>,
    opts: TicketPoolOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? browserTimer;
    this.wanted = opts.wanted ?? (() => true);
  }

  /** Whether a usable ticket is in hand. */
  get ready(): boolean {
    return this.held !== null && this.now() < this.dropAt(this.held);
  }

  /** Whether a ticket request is on its way. */
  get fetching(): boolean {
    return this.inFlight !== null;
  }

  /** Fetch a ticket in the background, unless one is in hand or on its way. */
  refill(): void {
    if (this.ready || this.inFlight || this.stale) return;
    this.hold(null);
    // The server issues the ticket after this, so it expires no sooner than a
    // full lifetime from now.
    const expiresAt = this.now() + SOLO_TICKET_TTL_MS;
    this.inFlight = this.fetchTicket()
      .then(
        (ticket) => {
          if (ticket.simVersion === SIM_VERSION) this.hold({ ticket, expiresAt });
          else this.stale = true; // asking again would get the same answer
        },
        () => undefined, // unreachable: the next refill tries again
      )
      .finally(() => {
        this.inFlight = null;
      });
  }

  /** Take the ticket for a new run (and start fetching the next), or say why there's none. */
  take(): HeldTicket | { reason: NoTicketReason } {
    const held = this.ready ? this.held : null;
    this.hold(null);
    this.refill();
    if (held) return held;
    return { reason: this.stale ? 'stale' : 'offline' };
  }

  /** Resolves once the request on its way, if any, has settled. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  /** Stop the expiry timer (the pool normally lives as long as the page). */
  dispose(): void {
    this.hold(null);
  }

  /** Keep `held` (or nothing), with a timer to replace it when it gets too old. */
  private hold(held: HeldTicket | null): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.held = held;
    if (!held) return;
    this.cancelTimer = this.setTimer(
      () => {
        this.cancelTimer = null;
        if (this.ready) {
          this.hold(this.held); // fired early: wait again
        } else if (this.wanted()) {
          this.refill();
        }
      },
      Math.max(0, this.dropAt(held) - this.now()),
    );
  }

  private dropAt(held: HeldTicket): number {
    return held.expiresAt - TICKET_SAFETY_MS;
  }
}
