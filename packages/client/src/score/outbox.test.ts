import { describe, expect, it } from 'vitest';
import type { SoloSubmitRequest, SoloSubmitResponse } from '@crack-attack/protocol';
import {
  FAILURE_SPACING_MS,
  MAX_RUN_FAILURES,
  Outbox,
  type PendingRun,
  type StorageLike,
  type SubmitOutcome,
} from './outbox.js';
import { ScoreboardError } from './scoreboardApi.js';

const NOW = Date.UTC(2026, 8, 13, 12);
const rid = (n: number): string => String(n).padStart(32, '0');

class MemoryStorage implements StorageLike {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const run = (n: number, over: Partial<PendingRun> = {}): PendingRun => ({
  request: { runId: rid(n), name: 'misha', replay: { n } },
  expiresAt: NOW + 60_000,
  ...over,
});

const response = (id: number): SoloSubmitResponse => ({
  id,
  name: 'misha',
  score: 10,
  topMultiplier: 0,
  ticks: 500,
  standing: { all: { rank: 1, total: 1 }, month: { rank: 1, total: 1 } },
});

/** An outbox plus a log of the outcomes it reports. */
function setup(storage: StorageLike | null = new MemoryStorage(), now: () => number = () => NOW) {
  const outbox = new Outbox(storage, now);
  const outcomes: [string, SubmitOutcome][] = [];
  outbox.listen((runId, outcome) => outcomes.push([runId, outcome]));
  return { outbox, outcomes };
}

const ids = (runs: PendingRun[]) => runs.map((r) => r.request.runId);

describe('Outbox', () => {
  it('keeps runs across visits, dropping expired ones', () => {
    const storage = new MemoryStorage();
    const { outbox } = setup(storage);
    outbox.add(run(1));
    outbox.add(run(2, { expiresAt: NOW - 1 }));
    expect(ids(new Outbox(storage, () => NOW).pending())).toEqual([rid(1)]);
  });

  it('holds a run once, and at most twenty', () => {
    const { outbox } = setup();
    outbox.add(run(1));
    outbox.add(run(1));
    expect(outbox.pending()).toHaveLength(1);
    for (let n = 2; n <= 25; n++) outbox.add(run(n));
    expect(ids(outbox.pending())).toHaveLength(20);
    expect(ids(outbox.pending())[0]).toBe(rid(6));
  });

  it('works without storage, and ignores a corrupt entry', () => {
    const { outbox } = setup(null);
    outbox.add(run(1));
    expect(ids(outbox.pending())).toEqual([rid(1)]);

    const storage = new MemoryStorage();
    storage.setItem('crack-attack.outbox', '{not json');
    expect(new Outbox(storage, () => NOW).pending()).toEqual([]);
  });

  it('carries on in memory when storage is full', () => {
    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const { outbox } = setup(full);
    outbox.add(run(1));
    expect(ids(outbox.pending())).toEqual([rid(1)]);
  });

  it('submits waiting runs in order and reports each', async () => {
    const { outbox, outcomes } = setup();
    outbox.add(run(1));
    outbox.add(run(2));
    const sent: string[] = [];
    await outbox.flush((request: SoloSubmitRequest) => {
      sent.push(request.runId);
      return Promise.resolve(response(sent.length));
    });
    expect(sent).toEqual([rid(1), rid(2)]);
    expect(outcomes).toEqual([
      [rid(1), { ok: true, response: response(1) }],
      [rid(2), { ok: true, response: response(2) }],
    ]);
    expect(outbox.pending()).toEqual([]);
  });

  it('drops a run the server rejects and goes on to the next', async () => {
    const { outbox, outcomes } = setup();
    outbox.add(run(1));
    outbox.add(run(2));
    const rejected = new ScoreboardError('invalid_replay', 'nope');
    await outbox.flush((request) =>
      request.runId === rid(1) ? Promise.reject(rejected) : Promise.resolve(response(2)),
    );
    expect(outcomes).toEqual([
      [rid(1), { ok: false, error: rejected, kept: false }],
      [rid(2), { ok: true, response: response(2) }],
    ]);
    expect(outbox.pending()).toEqual([]);
  });

  it('stops at a failure every run would hit, reporting each run kept', async () => {
    for (const code of ['network', 'rate_limited'] as const) {
      const { outbox, outcomes } = setup();
      outbox.add(run(1));
      outbox.add(run(2));
      outbox.add(run(3));
      const failure = new ScoreboardError(code, 'try later');
      let attempts = 0;
      await outbox.flush(() => {
        attempts++;
        return Promise.reject(failure);
      });
      expect(attempts).toBe(1);
      expect(outcomes).toEqual([
        [rid(1), { ok: false, error: failure, kept: true }],
        [rid(2), { ok: false, error: failure, kept: true }],
        [rid(3), { ok: false, error: failure, kept: true }],
      ]);
      expect(ids(outbox.pending())).toEqual([rid(1), rid(2), rid(3)]);
    }
  });

  it('reports a later run kept when an earlier one stops the flush', async () => {
    const { outbox, outcomes } = setup();
    outbox.add(run(1));
    outbox.add(run(2));
    const offline = new ScoreboardError('network', 'offline');
    await outbox.flush((request) =>
      request.runId === rid(1) ? Promise.resolve(response(1)) : Promise.reject(offline),
    );
    expect(outcomes).toEqual([
      [rid(1), { ok: true, response: response(1) }],
      [rid(2), { ok: false, error: offline, kept: true }],
    ]);
    expect(ids(outbox.pending())).toEqual([rid(2)]);
  });

  it("goes on past a run's own failure, keeping it", async () => {
    for (const code of ['busy', 'internal', 'bad_response'] as const) {
      const { outbox, outcomes } = setup();
      outbox.add(run(1));
      outbox.add(run(2));
      const failure = new ScoreboardError(code, 'not now');
      await outbox.flush((request) =>
        request.runId === rid(1) ? Promise.reject(failure) : Promise.resolve(response(2)),
      );
      expect(outcomes).toEqual([
        [rid(1), { ok: false, error: failure, kept: true }],
        [rid(2), { ok: true, response: response(2) }],
      ]);
      expect(ids(outbox.pending())).toEqual([rid(1)]);
    }
  });

  it('drops a run the server keeps failing on, counting failures an hour apart', async () => {
    const storage = new MemoryStorage();
    const broken = new ScoreboardError('internal', 'oops');
    const failing = () => Promise.reject(broken);
    // Long-lived tickets, so the hours below stay within them.
    setup(storage).outbox.add(run(1, { expiresAt: NOW + 24 * FAILURE_SPACING_MS }));
    for (let n = 1; n < MAX_RUN_FAILURES; n++) {
      const at = NOW + (n - 1) * FAILURE_SPACING_MS;
      const { outbox, outcomes } = setup(storage, () => at); // a fresh page each time
      await outbox.flush(failing);
      expect(outcomes).toEqual([[rid(1), { ok: false, error: broken, kept: true }]]);
      expect(outbox.pending()[0]).toMatchObject({ failures: n, lastFailureAt: at });
    }
    const last = NOW + (MAX_RUN_FAILURES - 1) * FAILURE_SPACING_MS;
    const { outbox, outcomes } = setup(storage, () => last);
    await outbox.flush(failing);
    expect(outcomes).toEqual([[rid(1), { ok: false, error: broken, kept: false }]]);
    expect(outbox.pending()).toEqual([]);
  });

  it("doesn't count failures within an hour of the last counted one (an outage)", async () => {
    const storage = new MemoryStorage();
    let now = NOW;
    const { outbox, outcomes } = setup(storage, () => now);
    const expiresAt = NOW + 24 * FAILURE_SPACING_MS;
    outbox.add(run(1, { expiresAt }));
    outbox.add(run(2, { expiresAt }));
    const proxyDown = new ScoreboardError('internal', 'HTTP 502');
    for (let n = 0; n < 3 * MAX_RUN_FAILURES; n++) {
      now = NOW + n * 60_000; // a game a minute
      await outbox.flush(() => Promise.reject(proxyDown));
    }
    expect(outcomes.every(([, o]) => !o.ok && o.kept)).toBe(true);
    expect(outcomes).toHaveLength(2 * 3 * MAX_RUN_FAILURES); // each run, every flush
    expect(outbox.pending().map((r) => [r.failures, r.lastFailureAt])).toEqual([
      [1, NOW],
      [1, NOW],
    ]);
    now = NOW + FAILURE_SPACING_MS; // an hour after the first counted one
    await outbox.flush(() => Promise.reject(proxyDown));
    expect(outbox.pending().map((r) => r.failures)).toEqual([2, 2]);
  });

  it("doesn't count busy or unreachable against a run", async () => {
    const { outbox } = setup();
    outbox.add(run(1));
    for (let n = 0; n < MAX_RUN_FAILURES + 1; n++) {
      await outbox.flush(() => Promise.reject(new ScoreboardError('busy', 'queue full')));
      await outbox.flush(() => Promise.reject(new ScoreboardError('network', 'offline')));
    }
    expect(outbox.pending()).toEqual([run(1)]);
  });

  it('reads runs stored before failures were counted', async () => {
    const storage = new MemoryStorage();
    storage.setItem('crack-attack.outbox', JSON.stringify([run(1)]));
    const { outbox } = setup(storage);
    expect(ids(outbox.pending())).toEqual([rid(1)]);
    await outbox.flush(() => Promise.reject(new ScoreboardError('bad_response', 'html')));
    expect(outbox.pending()[0]).toMatchObject({ failures: 1, lastFailureAt: NOW });
    storage.setItem('crack-attack.outbox', JSON.stringify([{ ...run(2), failures: 'x' }]));
    expect(outbox.pending()).toEqual([]);
    storage.setItem('crack-attack.outbox', JSON.stringify([{ ...run(3), lastFailureAt: 'x' }]));
    expect(outbox.pending()).toEqual([]);
  });

  it("doesn't retry a kept run when going round again", async () => {
    const { outbox } = setup();
    outbox.add(run(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const submit = async (request: SoloSubmitRequest) => {
      sent.push(request.runId);
      if (request.runId === rid(1)) {
        await gate;
        throw new ScoreboardError('internal', 'oops');
      }
      return response(2);
    };
    const first = outbox.flush(submit);
    outbox.add(run(2));
    await outbox.flush(submit);
    release();
    await first;
    expect(sent).toEqual([rid(1), rid(2)]);
    expect(outbox.pending()[0]?.failures).toBe(1);
  });

  it('stops telling a listener that has left', async () => {
    const outbox = new Outbox(new MemoryStorage(), () => NOW);
    const heard: string[] = [];
    const stop = outbox.listen((runId) => heard.push(runId));
    stop();
    outbox.add(run(1));
    await outbox.flush(() => Promise.resolve(response(1)));
    expect(heard).toEqual([]);
  });
});
