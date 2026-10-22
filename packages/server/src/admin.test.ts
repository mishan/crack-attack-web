import { describe, expect, it } from 'vitest';
import { ADMIN_USAGE, runAdmin } from './admin.js';
import { MemoryAccountStore } from './accountStore.js';
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

async function admin(
  args: string[],
  store: MemoryScoreStore,
  accounts: MemoryAccountStore = new MemoryAccountStore(),
) {
  const lines: string[] = [];
  const code = await runAdmin(args, { scores: store, accounts }, (line) => lines.push(line));
  return { code, lines };
}

/** An account store holding "Misha" (renamed once, rated) and "bob". */
async function storeWithAccounts(): Promise<MemoryAccountStore> {
  const store = new MemoryAccountStore();
  const at = Date.UTC(2026, 8, 27, 12);
  for (const [n, handle] of [
    [1, 'Misha'],
    [2, 'bob'],
  ] as const) {
    await store.createAccount({
      handle,
      handleFolded: handle.toLowerCase(),
      keyHash: `k${n}`,
      sessionHash: `s${n}`,
      createdAt: at,
    });
  }
  await store.renameAccount(1, 'Misha', 'misha', at + 60_000);
  return store;
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

  it('shows an account, found by its handle as a player would type it', async () => {
    const accounts = await storeWithAccounts();
    expect(await admin(['account', 'ＭＩＳＨＡ'], new MemoryScoreStore(), accounts)).toEqual({
      code: 0,
      lines: ['#1  "Misha"  1500 (rd 350)  0-0-0  created 2026-09-27  renamed 2026-09-27'],
    });
    expect(await admin(['account', 'nobody'], new MemoryScoreStore(), accounts)).toEqual({
      code: 1,
      lines: ['no account "nobody"'],
    });
  });

  it("renames an account without using up its owner's rename", async () => {
    const accounts = await storeWithAccounts();
    const run = (args: string[]) => admin(args, new MemoryScoreStore(), accounts);
    expect(await run(['rename', 'bob', 'Robert'])).toEqual({
      code: 0,
      lines: ['"bob" is now "Robert"'],
    });
    expect((await accounts.accountByHandle('robert'))?.renamedAt).toBeNull();
    expect(await run(['rename', 'robert', 'misha'])).toEqual({
      code: 1,
      lines: ['"misha" is taken'],
    });
    expect(await run(['rename', 'robert', '\u200b'])).toEqual({
      code: 1,
      lines: ['"\u200b" has no visible character'],
    });
  });

  it('hides, restores and resets accounts', async () => {
    const accounts = await storeWithAccounts();
    await accounts.useSession('s1', 0, 0);
    const run = (args: string[]) => admin(args, new MemoryScoreStore(), accounts);
    expect(await run(['hide-account', 'misha'])).toEqual({ code: 0, lines: ['"Misha" hidden'] });
    expect((await run(['account', 'misha'])).lines[0]).toMatch(/\[hidden\]$/);
    expect(await run(['unhide-account', 'misha'])).toEqual({
      code: 0,
      lines: ['"Misha" restored'],
    });
    expect(await run(['reset-rating', 'misha'])).toEqual({
      code: 0,
      lines: ['"Misha"\'s rating starts over'],
    });
    expect((await run(['reset-rating', 'nobody'])).code).toBe(1);
  });

  it.each([
    [['account']],
    [['rename', 'bob']],
    [['rename', 'bob', 'x', 'y']],
    [['account', 'a', 'b']],
  ])('prints usage for account command %j', async (args) => {
    expect(await admin(args, new MemoryScoreStore())).toEqual({ code: 2, lines: [ADMIN_USAGE] });
  });
});
