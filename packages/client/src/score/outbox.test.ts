import { describe, expect, it } from 'vitest';
import type { SoloSubmitRequest, SoloSubmitResponse } from '@crack-attack/protocol';
import { Outbox, type PendingRun, type StorageLike, type SubmitOutcome } from './outbox.js';
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
function setup(storage: StorageLike | null = new MemoryStorage()) {
  const outbox = new Outbox(storage, () => NOW);
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

  it('keeps runs while the scoreboard is unreachable, stopping at the first', async () => {
    const { outbox, outcomes } = setup();
    outbox.add(run(1));
    outbox.add(run(2));
    const offline = new ScoreboardError('network', 'offline');
    let attempts = 0;
    await outbox.flush(() => {
      attempts++;
      return Promise.reject(offline);
    });
    expect(attempts).toBe(1);
    expect(outcomes).toEqual([[rid(1), { ok: false, error: offline, kept: true }]]);
    expect(ids(outbox.pending())).toEqual([rid(1), rid(2)]);
  });

  it('goes round again for a run queued mid-flush', async () => {
    const { outbox } = setup();
    outbox.add(run(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sent: string[] = [];
    const submit = async (request: SoloSubmitRequest) => {
      sent.push(request.runId);
      if (request.runId === rid(1)) await gate;
      return response(sent.length);
    };
    const first = outbox.flush(submit);
    outbox.add(run(2));
    await outbox.flush(submit); // returns at once; the running flush picks it up
    release();
    await first;
    expect(sent).toEqual([rid(1), rid(2)]);
    expect(outbox.pending()).toEqual([]);
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
