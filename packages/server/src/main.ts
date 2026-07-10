/**
 * main.ts — CLI entry: `node dist/main.js` (or `pnpm --filter @crack-attack/server start`).
 * PORT/HOST come from the environment; defaults to 8080 on all interfaces.
 * DB selects the SQLite file for identities/records (default
 * ./crack-attack.db; set DB=:memory: for an ephemeral server).
 */

import { SqliteStore } from './sqliteStore.js';
import { DEFAULT_PORT, startRelayWsServer } from './wsServer.js';

/** Parse PORT strictly: an integer in [0, 65535] (0 = ephemeral), else exit. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`invalid PORT ${JSON.stringify(raw)}: expected an integer 0..65535`);
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server
      .close()
      .then(() => store.close())
      .then(() => process.exit(0));
  });
}
