import { describe, expect, it } from 'vitest';
import { ADMIN_USAGE, runAdmin } from './admin.js';
import { MemoryScoreStore } from './scoreStore.js';

async function storeWithRuns(): Promise<MemoryScoreStore> {
  const store = new MemoryScoreStore();
  for (const [n, name] of [
    [1, 'misha'],
    [2, 'bob\u001b[31m'],
  ] as const) {
    const runId = String(n).padStart(32, '0');
    await store.addTicket({ runId, seed: 1, simVersion: 1, issuedAt: 0 });
    await store.recordRun({
      runId,
      name,
      score: 48 * n,
      topMultiplier: 3,
      ticks: 2757,
      simVersion: 1,
      createdAt: Date.UTC(2026, 8, 13, 12, n),
      replay: '{}',
    });
  }
  return store;
}

async function admin(args: string[], store: MemoryScoreStore) {
  const lines: string[] = [];
  const code = await runAdmin(args, store, (line) => lines.push(line));
  return { code, lines };
}

describe('runAdmin', () => {
  it('lists recent runs, newest first, with names quoted', async () => {
    const store = await storeWithRuns();
    expect(await admin(['recent'], store)).toEqual({
      code: 0,
      lines: [
        '#2  2026-09-13 12:02  96 pts  x3  0:55  "bob\\u001b[31m"',
        '#1  2026-09-13 12:01  48 pts  x3  0:55  "misha"',
      ],
    });
    expect((await admin(['recent', '1'], store)).lines).toHaveLength(1);
    expect(await admin(['recent'], new MemoryScoreStore())).toEqual({
      code: 0,
      lines: ['no runs yet'],
    });
  });

  it('hides and restores runs', async () => {
    const store = await storeWithRuns();
    expect(await admin(['hide', '1'], store)).toEqual({ code: 0, lines: ['run 1 hidden'] });
    expect((await admin(['recent'], store)).lines[1]).toMatch(/\[hidden\]$/);
    expect(await admin(['unhide', '1'], store)).toEqual({ code: 0, lines: ['run 1 restored'] });
    expect((await admin(['recent'], store)).lines[1]).not.toMatch(/hidden/);
    expect(await admin(['hide', '9'], store)).toEqual({ code: 1, lines: ['no run 9'] });
  });

  it.each([
    [[]],
    [['hide']],
    [['hide', 'x']],
    [['recent', '0']],
    [['bogus']],
    [['hide', '1', '2']],
  ])('prints usage for %j', async (args) => {
    expect(await admin(args, await storeWithRuns())).toEqual({ code: 2, lines: [ADMIN_USAGE] });
  });
});
