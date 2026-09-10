/**
 * main.ts — CLI entry: `node dist/main.js` (or `pnpm --filter @crack-attack/server start`).
 * PORT/HOST come from the environment; defaults to 8080 on all interfaces.
 * DB selects the SQLite file for identities/records (default
 * ./crack-attack.db; set DB=:memory: for an ephemeral server).
 */

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

const port = parsePort(process.env['PORT']);
const host = process.env['HOST'];
const dbPath = process.env['DB'] ?? './crack-attack.db';

const store = new SqliteStore(dbPath);
const server = await startRelayWsServer({ port, host, store });
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
