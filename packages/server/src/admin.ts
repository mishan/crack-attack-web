/**
 * admin.ts — scoreboard and account moderation, run against the database file:
 * `node relay.mjs admin <command>` (or `node dist/main.js admin …`), with the
 * same `DB` variable as the relay. Safe while the relay is running (SQLite
 * WAL plus a busy timeout).
 */

import { foldHandle, normalizeHandle } from '@crack-attack/protocol';
import type { AccountStore, StoredAccount } from './accountStore.js';
import type { ScoreStore, StoredSoloScore } from './scoreStore.js';

export const ADMIN_USAGE = `usage: relay admin <command>
  recent [n]                   list the n newest runs (default 20); hidden ones are marked
  hide <id>                    take a run off the boards
  unhide <id>                  put it back
  account <handle>             show an account
  rename <handle> <new>        change an account's handle (the owner's own renames are unaffected)
  hide-account <handle>        keep an account off the leaderboard
  unhide-account <handle>      put it back
  reset-rating <handle>        start an account's rating over`;

/** The stores the commands work on: in the relay, one SqliteStore is both. */
export interface AdminStores {
  scores: ScoreStore;
  accounts: AccountStore;
}

/** Run one admin command, writing output lines to `out`; resolves to an exit code. */
export async function runAdmin(
  args: readonly string[],
  stores: AdminStores,
  out: (line: string) => void,
): Promise<number> {
  const [command, arg, ...extra] = args;
  const usage = (): number => {
    out(ADMIN_USAGE);
    return 2;
  };
  if (command === 'rename') {
    if (arg === undefined || extra.length !== 1) return usage();
    return renameAccount(stores.accounts, arg, extra[0]!, out);
  }
  if (extra.length > 0) return usage();
  const store = stores.scores;

  if (command === 'recent') {
    const n = arg === undefined ? 20 : positiveInt(arg);
    if (n === null) return usage();
    const runs = await store.recentScores(n);
    if (runs.length === 0) out('no runs yet');
    for (const run of runs) out(formatRun(run));
    return 0;
  }
  if (command === 'hide' || command === 'unhide') {
    const id = arg === undefined ? null : positiveInt(arg);
    if (id === null) return usage();
    const found = await store.setHidden(id, command === 'hide');
    out(found ? `run ${id} ${command === 'hide' ? 'hidden' : 'restored'}` : `no run ${id}`);
    return found ? 0 : 1;
  }
  if (
    command === 'account' ||
    command === 'hide-account' ||
    command === 'unhide-account' ||
    command === 'reset-rating'
  ) {
    if (arg === undefined) return usage();
    const account = await findAccount(stores.accounts, arg, out);
    if (!account) return 1;
    if (command === 'account') {
      out(formatAccount(account));
    } else if (command === 'reset-rating') {
      await stores.accounts.resetRating(account.id);
      out(`${JSON.stringify(account.handle)}'s rating starts over`);
    } else {
      const hide = command === 'hide-account';
      await stores.accounts.setAccountHidden(account.id, hide);
      out(`${JSON.stringify(account.handle)} ${hide ? 'hidden' : 'restored'}`);
    }
    return 0;
  }
  return usage();
}

/** The account a handle names, as a player would type it; says so if there's none. */
async function findAccount(
  accounts: AccountStore,
  raw: string,
  out: (line: string) => void,
): Promise<StoredAccount | null> {
  const handle = normalizeHandle(raw);
  const account = handle === null ? null : await accounts.accountByHandle(foldHandle(handle));
  if (!account) out(`no account ${JSON.stringify(raw)}`);
  return account;
}

async function renameAccount(
  accounts: AccountStore,
  from: string,
  to: string,
  out: (line: string) => void,
): Promise<number> {
  const handle = normalizeHandle(to);
  if (handle === null) {
    out(`${JSON.stringify(to)} has no visible character`);
    return 1;
  }
  const account = await findAccount(accounts, from, out);
  if (!account) return 1;
  // A null renamedAt: the owner's next rename is as free as it was.
  const renamed = await accounts.renameAccount(account.id, handle, foldHandle(handle), null);
  if (!renamed) {
    out(`${JSON.stringify(handle)} is taken`);
    return 1;
  }
  out(`${JSON.stringify(account.handle)} is now ${JSON.stringify(renamed.handle)}`);
  return 0;
}

function positiveInt(text: string): number | null {
  return /^[1-9]\d{0,8}$/.test(text) ? Number(text) : null;
}

/** One line per run; the name is JSON-quoted so odd characters can't mangle the terminal. */
export function formatRun(run: StoredSoloScore): string {
  const seconds = Math.floor(run.ticks / 50);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const when = new Date(run.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const hidden = run.hidden ? '  [hidden]' : '';
  return `#${run.id}  ${when}  ${run.score} pts  x${run.topMultiplier}  ${clock}  ${JSON.stringify(run.name)}${hidden}`;
}

/** One line per account; the handle is JSON-quoted, as for runs. */
export function formatAccount(account: StoredAccount): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const rating = `${Math.round(account.rating)} (rd ${Math.round(account.rd)})`;
  const record = `${account.wins}-${account.losses}-${account.draws}`;
  const renamed = account.renamedAt === null ? '' : `  renamed ${day(account.renamedAt)}`;
  const hidden = account.hidden ? '  [hidden]' : '';
  return `#${account.id}  ${JSON.stringify(account.handle)}  ${rating}  ${record}  created ${day(account.createdAt)}${renamed}${hidden}`;
}
