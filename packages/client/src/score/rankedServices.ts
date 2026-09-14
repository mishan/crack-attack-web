/**
 * rankedServices.ts — what ranked solo play shares across modes: the
 * scoreboard client, the prefetched run ticket, and the submission outbox.
 * Built once per page (see main.ts); null when no scoreboard URL can be
 * worked out, in which case every run is unranked.
 */

import { Outbox, type StorageLike } from './outbox.js';
import { ScoreboardClient, scoreboardUrlFor } from './scoreboardApi.js';
import { loadRankedPlay, rememberOwnRun } from './scoreStore.js';
import { TicketPool } from './ticketPool.js';

export interface RankedServices {
  readonly client: ScoreboardClient;
  readonly tickets: TicketPool;
  readonly outbox: Outbox;
  /** Submit whatever is waiting in the outbox. */
  flush(): void;
}

/** The services for the scoreboard on the relay at `relayUrl`. */
export function createRankedServices(relayUrl: string): RankedServices | null {
  const base = scoreboardUrlFor(relayUrl);
  if (!base) return null;
  const client = new ScoreboardClient(base);
  const outbox = new Outbox(browserStorage());
  // Remember this browser's runs, to highlight them on the boards.
  outbox.listen((_runId, outcome) => {
    if (outcome.ok) rememberOwnRun(outcome.response.id);
  });
  // With ranked play off, the pool's expiry timer leaves the network alone.
  const tickets = new TicketPool(() => client.ticket(), { wanted: loadRankedPlay });
  // A tab left in the background (or a laptop waking up) may hold a ticket
  // that has since aged out, and its timer may have run late: top up on return.
  // Both live as long as the page, like the pool.
  globalThis.document?.addEventListener('visibilitychange', () => {
    if (!document.hidden && loadRankedPlay()) tickets.refill();
  });
  return {
    client,
    tickets,
    outbox,
    flush: () => {
      void outbox.flush((request) => client.submit(request));
    },
  };
}

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked (e.g. some private modes)
  }
}
