/**
 * ticketPool.ts — keeps one solo run ticket in hand, so a ranked run can start
 * the moment its board is created: the seed decides the board, so it must be
 * known before the countdown (docs/SCOREBOARD_PLAN.md).
 */

import { SIM_VERSION } from '@crack-attack/core';
import type { SoloTicketResponse } from '@crack-attack/protocol';

/** A ticket this close to expiry is dropped: a run started on it might not finish in time. */
export const TICKET_SAFETY_MS = 60 * 60 * 1000;

/**
 * Why there's no ticket for a run: `offline` (none in hand — the scoreboard is
 * unreachable, or the request is still on its way) or `stale` (the server runs
 * newer rules than this page; reloading fixes it).
 */
export type NoTicketReason = 'offline' | 'stale';

export class TicketPool {
  private ticket: SoloTicketResponse | null = null;
  private inFlight: Promise<void> | null = null;
  private stale = false;

  constructor(
    private readonly fetchTicket: () => Promise<SoloTicketResponse>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a usable ticket is in hand. */
  get ready(): boolean {
    return this.ticket !== null && !this.expiring(this.ticket);
  }

  /** Whether a ticket request is on its way. */
  get fetching(): boolean {
    return this.inFlight !== null;
  }

  /** Fetch a ticket in the background, unless one is in hand or on its way. */
  refill(): void {
    if (this.ready || this.inFlight || this.stale) return;
    this.ticket = null;
    this.inFlight = this.fetchTicket()
      .then(
        (ticket) => {
          if (ticket.simVersion === SIM_VERSION) this.ticket = ticket;
          else this.stale = true; // asking again would get the same answer
        },
        () => undefined, // unreachable: the next refill tries again
      )
      .finally(() => {
        this.inFlight = null;
      });
  }

  /** Take the ticket for a new run (and start fetching the next), or say why there's none. */
  take(): { ticket: SoloTicketResponse } | { reason: NoTicketReason } {
    const ticket = this.ready ? this.ticket : null;
    this.ticket = null;
    this.refill();
    if (ticket) return { ticket };
    return { reason: this.stale ? 'stale' : 'offline' };
  }

  /** Resolves once the request on its way, if any, has settled. */
  settled(): Promise<void> {
    return this.inFlight ?? Promise.resolve();
  }

  private expiring(ticket: SoloTicketResponse): boolean {
    return this.now() >= ticket.expiresAt - TICKET_SAFETY_MS;
  }
}
