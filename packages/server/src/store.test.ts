/**
 * Conformance suite run against every LobbyStore implementation, so a future
 * backend (Redis, ...) drops in with the same guarantees.
 */

import { describe, expect, it } from 'vitest';
import type { LobbyStore } from './store.js';
import { MemoryStore } from './store.js';
import { SqliteStore } from './sqliteStore.js';

const T1 = '1'.repeat(32);
const T2 = '2'.repeat(32);

function conformance(name: string, make: () => LobbyStore): void {
  describe(name, () => {
    it('returns null for unknown tokens', async () => {
      const store = make();
      expect(await store.getPlayer(T1, 'misha')).toBeNull();
      await store.close();
    });

    it('creates players with zero records and finds them again', async () => {
      const store = make();
      const created = await store.createPlayer(T1, 'misha');
      expect(created).toEqual({ token: T1, name: 'misha', record: { wins: 0, losses: 0 } });
      expect(await store.getPlayer(T1, 'misha')).toEqual(created);
      await store.close();
    });

    it('updates the stored display name on lookup', async () => {
      const store = make();
      await store.createPlayer(T1, 'misha');
      const renamed = await store.getPlayer(T1, 'misha2');
      expect(renamed?.name).toBe('misha2');
      expect((await store.getPlayer(T1, 'misha2'))?.name).toBe('misha2');
      await store.close();
    });

    it('records decisive results on both sides', async () => {
      const store = make();
      await store.createPlayer(T1, 'winner');
      await store.createPlayer(T2, 'loser');
      await store.recordResult(T1, T2);
      await store.recordResult(T1, T2);
      expect((await store.getPlayer(T1, 'winner'))?.record).toEqual({ wins: 2, losses: 0 });
      expect((await store.getPlayer(T2, 'loser'))?.record).toEqual({ wins: 0, losses: 2 });
      await store.close();
    });

    it('tolerates results for unknown tokens (dropped players)', async () => {
      const store = make();
      await store.createPlayer(T1, 'winner');
      await store.recordResult(T1, T2); // T2 never registered
      expect((await store.getPlayer(T1, 'winner'))?.record).toEqual({ wins: 1, losses: 0 });
      await store.close();
    });
  });
}

conformance('MemoryStore', () => new MemoryStore());
conformance('SqliteStore (:memory:)', () => new SqliteStore(':memory:'));

describe('SqliteStore persistence', () => {
  it('persists across store instances on the same file', async () => {
    const path = `/tmp/crack-attack-store-test-${process.pid}-${Date.now()}.db`;
    const a = new SqliteStore(path);
    await a.createPlayer(T1, 'misha');
    await a.recordResult(T1, T2);
    await a.close();

    const b = new SqliteStore(path);
    expect((await b.getPlayer(T1, 'misha'))?.record).toEqual({ wins: 1, losses: 0 });
    await b.close();
  });
});
