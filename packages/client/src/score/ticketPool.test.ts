import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '@crack-attack/core';
import { SOLO_TICKET_TTL_MS, type SoloTicketResponse } from '@crack-attack/protocol';
import { TICKET_SAFETY_MS, TicketPool, type TicketPoolOptions } from './ticketPool.js';

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

/** A hand-driven clock and timer queue. */
function manualClock(start = NOW) {
  let now = start;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const options: Required<Pick<TicketPoolOptions, 'now' | 'setTimer'>> = {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
  };
  return {
    options,
    live: () => timers.filter((t) => t.live),
    /** Move the clock to `to`, firing the timers due by then. */
    advance(to: number) {
      now = to;
      for (const t of timers.filter((t) => t.live && t.at <= to)) {
        t.live = false;
        t.fn();
      }
    },
    /** Jump the clock (a laptop waking up), firing nothing. */
    jump(to: number) {
      now = to;
    },
  };
}

describe('TicketPool', () => {
  it('keeps one ticket ahead, handing it out and fetching the next', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    pool.refill(); // already on its way
    expect(requests).toHaveLength(1);
    expect(pool.fetching).toBe(true);
    expect(pool.take()).toEqual({ reason: 'offline' }); // not here yet

    requests[0]!.resolve(ticket(1));
    await pool.settled();
    expect(pool.ready).toBe(true);
    expect(pool.fetching).toBe(false);
    expect(pool.take()).toEqual({ ticket: ticket(1), expiresAt: NOW + SOLO_TICKET_TTL_MS });
    expect(requests).toHaveLength(2); // the next one
    expect(pool.ready).toBe(false);
    expect(clock.live()).toEqual([]); // the taken ticket's timer is gone
  });

  it('reports offline when the scoreboard is unreachable, and tries again next time', async () => {
    const { fetchTicket, requests } = manualTickets();
    const pool = new TicketPool(fetchTicket, manualClock().options);
    pool.refill();
    requests[0]!.reject(new Error('offline'));
    await pool.settled();
    expect(pool.take()).toEqual({ reason: 'offline' });
    expect(requests).toHaveLength(2);
  });

  it('reports stale, and stops asking, when the server runs other rules', async () => {
    const { fetchTicket, requests } = manualTickets();
    const pool = new TicketPool(fetchTicket, manualClock().options);
    pool.refill();
    requests[0]!.resolve(ticket(1, { simVersion: SIM_VERSION + 1 }));
    await pool.settled();
    expect(pool.take()).toEqual({ reason: 'stale' });
    pool.refill();
    expect(requests).toHaveLength(1);
  });

  it('drops a ticket too close to expiry for a run to finish', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    clock.jump(NOW + SOLO_TICKET_TTL_MS - TICKET_SAFETY_MS);
    expect(pool.ready).toBe(false);
    expect(pool.take()).toEqual({ reason: 'offline' });
    expect(requests).toHaveLength(2);
  });

  it("times expiry from this browser's clock, not the server's expiresAt", async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    // The server's clock reads two days behind this one: its expiresAt has
    // already passed here, but the ticket is fresh.
    requests[0]!.resolve(ticket(1, { expiresAt: NOW - DAY }));
    await pool.settled();
    expect(pool.ready).toBe(true);
    // And a server clock far ahead doesn't keep an old ticket alive.
    clock.jump(NOW + SOLO_TICKET_TTL_MS);
    expect(pool.ready).toBe(false);
  });

  it('fetches a replacement once the ticket in hand gets too old', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    const dropAt = NOW + SOLO_TICKET_TTL_MS - TICKET_SAFETY_MS;
    expect(clock.live().map((t) => t.at)).toEqual([dropAt]);
    clock.advance(dropAt - 1);
    expect(requests).toHaveLength(1);
    clock.advance(dropAt);
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(ticket(2));
    await pool.settled();
    // The replacement's lifetime runs from when it was requested.
    expect(pool.take()).toEqual({ ticket: ticket(2), expiresAt: dropAt + SOLO_TICKET_TTL_MS });
  });

  it('waits again if its timer fires early', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    const early = clock.live()[0]!;
    early.live = false;
    early.fn(); // fired early: the ticket is still good
    expect(requests).toHaveLength(1);
    expect(pool.ready).toBe(true);
    expect(clock.live()).toHaveLength(1);
  });

  it("leaves the network alone at expiry when tickets aren't wanted", async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    let wanted = true;
    const pool = new TicketPool(fetchTicket, { ...clock.options, wanted: () => wanted });
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    wanted = false; // ranked play turned off
    clock.advance(NOW + DAY);
    expect(requests).toHaveLength(1);
    pool.refill(); // turned back on
    expect(requests).toHaveLength(2);
  });

  it('refills on demand after the clock jumps (a laptop waking up)', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    clock.jump(NOW + 2 * DAY); // the timer hasn't run yet
    pool.refill(); // the page came back into view
    expect(requests).toHaveLength(2);
    expect(clock.live()).toEqual([]); // the old ticket's timer went with it
  });

  it('stops its timer when disposed', async () => {
    const { fetchTicket, requests } = manualTickets();
    const clock = manualClock();
    const pool = new TicketPool(fetchTicket, clock.options);
    pool.refill();
    requests[0]!.resolve(ticket(1));
    await pool.settled();
    pool.dispose();
    expect(clock.live()).toEqual([]);
  });
});
