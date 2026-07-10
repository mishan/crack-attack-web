/**
 * main.ts — CLI entry: `node dist/main.js` (or `pnpm --filter @crack-attack/server start`).
 * PORT/HOST come from the environment; defaults to 8080 on all interfaces.
 */

import { DEFAULT_PORT, startRelayWsServer } from './wsServer.js';

const port = process.env['PORT'] ? Number(process.env['PORT']) : DEFAULT_PORT;
const host = process.env['HOST'];

const server = await startRelayWsServer({ port, host });
console.log(`crack-attack relay listening on :${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
