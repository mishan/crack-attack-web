/**
 * main.ts — CLI entry: `node dist/main.js` (or `pnpm --filter @crack-attack/server start`),
 * and the entry point of the standalone bundle (`node dist/relay.mjs`, see scripts/bundle.mjs).
 * PORT/HOST come from the environment; defaults to 8080 on all interfaces.
 * DB selects the SQLite file for identities, records and the solo scoreboard
 * (default ./crack-attack.db; set DB=:memory: for an ephemeral server).
 * TRUST_PROXY=<n> reads client addresses from X-Forwarded-For, behind n
 * proxies (1 = nginx alone; true = 1); CORS_ORIGIN lets a client on another
 * origin call the scoreboard API.
 * `admin …` runs a scoreboard moderation command instead (see admin.ts).
 */

import { existsSync } from 'node:fs';
import { ADMIN_USAGE, runAdmin } from './admin.js';
import { createScoreboardApi } from './httpApi.js';
import { SoloScoreboard } from './scoreboard.js';
import { SqliteStore } from './sqliteStore.js';
import { DEFAULT_PORT, startRelayWsServer } from './wsServer.js';

/**
 * Parse PORT strictly: base-10 digits only, in [0, 65535] (0 = ephemeral),
 * else exit. Plain `Number(raw)` would admit ops-surprising forms like
 * "1e3" or "0x10".
 */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port > 65535) {
    console.error(`invalid PORT ${JSON.stringify(raw)}: expected a base-10 integer 0..65535`);
    process.exit(1);
  }
  return port;
}

/**
 * Parse TRUST_PROXY: how many proxies in front append to X-Forwarded-For.
 * 0/false (or unset) = none, true = 1, else a base-10 count up to 16; else exit.
 */
function parseProxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === '' || raw === 'false') return 0;
  if (raw === 'true') return 1;
  const hops = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(hops <= 16)) {
    console.error(
      `invalid TRUST_PROXY ${JSON.stringify(raw)}: expected a proxy count 0..16 (or true/false)`,
    );
    process.exit(1);
  }
  return hops;
}

const dbPath = process.env['DB'] ?? './crack-attack.db';

if (process.argv[2] === 'admin') {
  if (dbPath === ':memory:') {
    console.error(`admin needs DB set to the relay's database file\n${ADMIN_USAGE}`);
    process.exit(2);
  }
  // Opening a mistyped path would quietly create (and migrate) an empty database.
  if (!existsSync(dbPath)) {
    console.error(`admin: no database at ${dbPath} (set DB to the relay's database file)`);
    process.exit(2);
  }
  const store = new SqliteStore(dbPath);
  const code = await runAdmin(process.argv.slice(3), store, (line) => console.log(line));
  await store.close();
  process.exit(code);
}

const port = parsePort(process.env['PORT']);
const host = process.env['HOST'];
const trustProxy = parseProxyHops(process.env['TRUST_PROXY']);
const corsOrigin = process.env['CORS_ORIGIN'] || undefined;

const store = new SqliteStore(dbPath);
const scoreboard = new SoloScoreboard({ store });
const server = await startRelayWsServer({
  port,
  host,
  store,
  http: createScoreboardApi(scoreboard, { trustProxy, corsOrigin }),
});
console.log(`crack-attack relay listening on :${server.port} (db: ${dbPath})`);

// Last-resort handlers, installed once listening (startup failures still exit
// as before). A stray rejection is a background store write that failed —
// it cost a stats update, not relay state — so log and keep serving. An
// uncaught exception may have left room/session state half-updated: exit.
process.on('unhandledRejection', (reason) => {
  console.error('relay: unhandled promise rejection (continuing):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('relay: uncaught exception, exiting:', err);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server
      .close()
      .then(() => store.close())
      .then(
        () => process.exit(0),
        (err: unknown) => {
          console.error('relay: shutdown failed:', err);
          process.exit(1);
        },
      );
  });
}
