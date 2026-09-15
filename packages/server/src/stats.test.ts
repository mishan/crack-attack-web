import { describe, expect, it, vi } from 'vitest';
import { startStatsProbe, STATS_LINE_PREFIX, type StatsSample } from './stats.js';
import type { RelayStats } from './relay.js';
import type { RelayTraffic, RelayWsServer } from './wsServer.js';

/** A stand-in relay server: fixed counts, growing traffic. */
function fakeServer(): { server: RelayWsServer; bump: () => void } {
  const stats: RelayStats = {
    connections: 12,
    sessions: 10,
    rooms: 3,
    playing: 2,
    spectators: 5,
    dropped: 1,
    maxLedger: 9000,
  };
  const traffic: RelayTraffic = {
    messagesIn: 0,
    bytesIn: 0,
    messagesOut: 0,
    bytesOut: 0,
    sockets: 12,
    bufferedMax: 4096,
    bufferedTotal: 8192,
  };
  const server = {
    port: 0,
    relay: { stats: () => stats } as unknown as RelayWsServer['relay'],
    traffic: () => ({ ...traffic }),
    close: () => Promise.resolve(),
  } as RelayWsServer;
  return {
    server,
    bump: () => {
      traffic.messagesIn += 100;
      traffic.bytesIn += 5000;
      traffic.messagesOut += 200;
      traffic.bytesOut += 12000;
    },
  };
}

describe('startStatsProbe', () => {
  it('writes a prefixed JSON line each interval with relay counts and per-second traffic', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const { server, bump } = fakeServer();
      const probe = startStatsProbe({
        server,
        intervalMs: 1000,
        write: (line) => lines.push(line),
      });

      bump(); // 100 msgs in / 200 out over the coming second
      await vi.advanceTimersByTimeAsync(1000);

      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith(STATS_LINE_PREFIX)).toBe(true);
      const sample = JSON.parse(lines[0]!.slice(STATS_LINE_PREFIX.length)) as StatsSample;
      expect(sample.sessions).toBe(10);
      expect(sample.playing).toBe(2);
      expect(sample.maxLedger).toBe(9000);
      expect(sample.bufferedMax).toBe(4096);
      // 100 messages in over ~1 s.
      expect(sample.msgsInPerSec).toBeGreaterThan(50);
      expect(sample.msgsInPerSec).toBeLessThan(200);
      expect(sample.msgsOutPerSec).toBeGreaterThan(sample.msgsInPerSec);
      // No scoreboard and no db path were given.
      expect(sample.scoreboard).toBeNull();
      expect(sample.dbBytes).toBeNull();

      probe.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops writing after stop()', async () => {
    vi.useFakeTimers();
    try {
      const lines: string[] = [];
      const { server } = fakeServer();
      const probe = startStatsProbe({ server, intervalMs: 1000, write: (l) => lines.push(l) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(lines).toHaveLength(1);
      probe.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(lines).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
