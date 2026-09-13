import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '@crack-attack/core';
import type { SoloTicketResponse } from '@crack-attack/protocol';
import { TICKET_SAFETY_MS, TicketPool } from './ticketPool.js';

const NOW = Date.UTC(2026, 8, 13, 12);
const DAY = 24 * 60 * 60 * 1000;

const ticket = (n: number, over: Partial<SoloTicketResponse> = {}): SoloTicketResponse => ({
  runId: String(n).padStart(32, '0'),
  seed: n,
  simVersion: SIM_VERSION,
  expiresAt: NOW + DAY,
  ...over,
});

/** A ticket source whose requests the test settles by hand. */
function manualTickets() {
  const requests: { resolve: (t: SoloTicketResponse) => void; reject: (e: Error) => void }[] = [];
  const fetchTicket = (): Promise<SoloTicketResponse> =>
    new Promise((resolve, reject) => requests.push({ resolve, reject }));
  return { fetchTicket, requests };
}

describe('TicketPool', () => {
  it('keeps one ticket ahead, handing it out and fetching the next', async () => {
    const { fetchTicket, requests } = manualTickets();
    const pool = new TicketPool(fetchTicket, () => NOW);
    pool.refill();
    pool.refill(); // already on its way
    expect(requests).toHaveLength(1);
    expect(pool.fetching).toBe(true);
    expect(pool.take()).toEqual({ reason: 'offline' }); // not here yet

    requests[0]!.resolve(ticket(1));
    await pool.settled();
    expect(pool.ready).toBe(true);
    expect(pool.fetching).toBe(false);
    expect(pool.take()).toEqual({ ticket: ticket(1) });
    expect(requests).toHaveLength(2); // the next one
    expect(pool.ready).toBe(false);
  });

  it('reports offline when the scoreboard is unreachable, and tries again next time', async () => {
    const { fetchTicket, requests } = manualTickets();
    const pool = new TicketPool(fetchTicket, () => NOW);
    pool.refill();
    requests[0]!.reject(new Error('offline'));
    await pool.settled();
    expect(pool.take()).toEqual({ reason: 'offline' });
    expect(requests).toHaveLength(2);
  });

  it('reports stale, and stops asking, when the server runs other rules', async () => {
    const { fetchTicket, requests } = manualTickets();
    const pool = new TicketPool(fetchTicket, () => NOW);
    pool.refill();
    requests[0]!.resolve(ticket(1, { simVersion: SIM_VERSION + 1 }));
    await pool.settled();
    expect(pool.take()).toEqual({ reason: 'stale' });
    pool.refill();
    expect(requests).toHaveLength(1);
  });

  it('drops a ticket too close to expiry for a run to finish', async () => {
    const { fetchTicket, requests } = manualTickets();
    let now = NOW;
    const pool = new TicketPool(fetchTicket, () => now);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    now = NOW + DAY - TICKET_SAFETY_MS;
    expect(pool.ready).toBe(false);
    expect(pool.take()).toEqual({ reason: 'offline' });
    expect(requests).toHaveLength(2);
  });
});
