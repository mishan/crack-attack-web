/**
 * admin.ts — scoreboard moderation, run against the database file:
 * `node relay.mjs admin <command>` (or `node dist/main.js admin …`), with the
 * same `DB` variable as the relay. Safe while the relay is running (SQLite
 * WAL plus a busy timeout).
 */

import type { ScoreStore, StoredSoloScore } from './scoreStore.js';

export const ADMIN_USAGE = `usage: relay admin <command>
  recent [n]    list the n newest runs (default 20); hidden ones are marked
  hide <id>     take a run off the boards
  unhide <id>   put it back`;

/** Run one admin command, writing output lines to `out`; resolves to an exit code. */
export async function runAdmin(
  args: readonly string[],
  store: ScoreStore,
  out: (line: string) => void,
): Promise<number> {
  const [command, arg, ...extra] = args;
  const usage = (): number => {
    out(ADMIN_USAGE);
    return 2;
  };
  if (extra.length > 0) return usage();

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
  return usage();
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
