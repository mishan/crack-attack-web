import { describe, expect, it } from 'vitest';
import type { StatsSample } from '@crack-attack/server';
import { COLUMNS, toRow } from './columns.js';
import { Aggregate } from './metrics.js';

const MB = 1024 * 1024;

/** A relay stats line with every number distinct, so each can be traced to its cell. */
const STATS: StatsSample = {
  t: 1,
  intervalMs: 10_000,
  loopP50Ms: 2,
  loopP99Ms: 3,
  loopMaxMs: 4,
  cpuPct: 5,
  rssBytes: 6,
  heapUsedBytes: 7,
  fds: 8,
  connections: 9,
  sessions: 10,
  rooms: 11,
  playing: 12,
  spectators: 13,
  dropped: 14,
  maxLedger: 15,
  sockets: 16,
  msgsInPerSec: 17,
  msgsOutPerSec: 18,
  bytesInPerSec: 19,
  bytesOutPerSec: 20,
  bufferedMax: 21,
  bufferedTotal: 22,
  scoreboard: {
    verifierQueued: 101,
    submissionsInFlight: 102,
    scoresCached: 103,
    ticketClients: 104,
    submitClients: 105,
    scoresClients: 106,
    replayClients: 107,
  },
  dbBytes: 201,
  walBytes: 202,
};

describe('toRow', () => {
  const row = toRow('l1', '1game', 'hold', 10, new Aggregate(), STATS);

  it('fills exactly the columns, in order', () => {
    expect(Object.keys(row)).toEqual([...COLUMNS]);
  });

  it('carries every relay STATS number', () => {
    const cells = COLUMNS.filter((c) => c.startsWith('relay') || c.startsWith('sb')).map(
      (c) => row[c],
    );
    // Sizes are shown in MB.
    const shown = (n: number): boolean => cells.some((v) => v === n || v === n / MB);
    // `t` and `intervalMs` are the line's own timing; the row has its own.
    const { t: _t, intervalMs: _interval, scoreboard, ...numbers } = STATS;
    for (const [field, n] of Object.entries({ ...numbers, ...scoreboard })) {
      expect(shown(n as number), field).toBe(true);
    }
  });
});
