/**
 * smoke-bundle.mjs — prove `dist/relay.mjs` really stands alone. Copies it by
 * itself into an empty temp directory (no node_modules to lean on), starts it
 * there on an ephemeral port with an on-disk database, completes a hello →
 * welcome handshake over a real WebSocket, gets a solo run ticket and the
 * (empty) board from the scoreboard's HTTP API on the same port, then stops it
 * with SIGTERM and expects a clean exit and a written database. Run after the
 * `bundle` script.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, encodeMessage } from '@crack-attack/protocol';

const TIMEOUT_MS = 15_000;

const bundle = fileURLToPath(new URL('../dist/relay.mjs', import.meta.url));
if (!existsSync(bundle)) {
  console.error('relay smoke test: dist/relay.mjs is missing — run the bundle script first');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'relay-smoke-'));
copyFileSync(bundle, join(dir, 'relay.mjs'));

const relay = spawn(process.execPath, ['relay.mjs'], {
  cwd: dir,
  env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: '0', DB: 'lobby.db' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
relay.stdout.on('data', (d) => (stdout += d));
relay.stderr.on('data', (d) => (stderr += d));

let stopping = false;
const finish = (ok, message) => {
  clearTimeout(timer);
  if (!ok) relay.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
  if (ok) {
    console.log(`relay smoke test passed: ${message}`);
    process.exit(0);
  }
  // Each captured stream as its own block, even when it doesn't end in a newline.
  const block = (label, text) => `--- ${label}\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  console.error(
    `relay smoke test FAILED: ${message}\n${block('stdout', stdout)}${block('stderr', stderr)}`,
  );
  process.exit(1);
};
const timer = setTimeout(() => finish(false, `timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
relay.on('exit', (code, signal) => {
  if (!stopping) finish(false, `relay exited early (code ${code}, signal ${signal})`);
});

// 1. It starts and reports the port it bound.
const port = await new Promise((resolve) => {
  const check = () => {
    const m = /listening on :(\d+)/.exec(stdout);
    if (m) resolve(Number(m[1]));
  };
  relay.stdout.on('data', check);
  check();
});

// 2. A real client handshake (any path works, as behind an nginx /ws location).
const welcome = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.onopen = () =>
    ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'smoke' }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === 'welcome') {
      ws.close();
      resolve(msg);
    }
  };
  ws.onerror = () => reject(new Error('WebSocket error'));
}).catch((err) => finish(false, err.message));

// 3. The scoreboard API on the same port: a run ticket, then the empty board.
const api = `http://127.0.0.1:${port}/api/solo`;
const ticket = await (async () => {
  const res = await fetch(`${api}/ticket`, { method: 'POST' });
  if (res.status !== 200) throw new Error(`ticket request returned ${res.status}`);
  const body = await res.json();
  if (typeof body.runId !== 'string' || typeof body.seed !== 'number') {
    throw new Error(`malformed ticket ${JSON.stringify(body)}`);
  }
  const board = await (await fetch(`${api}/scores`)).json();
  if (board.total !== 0) throw new Error(`expected an empty board, got ${JSON.stringify(board)}`);
  return body;
})().catch((err) => finish(false, `scoreboard API: ${err.message}`));

// 4. A graceful stop, with the player row written to the SQLite file.
stopping = true;
const exitCode = await new Promise((resolve) => {
  relay.once('exit', (code) => resolve(code));
  relay.kill('SIGTERM');
});
if (exitCode !== 0) finish(false, `relay exited with code ${exitCode} on SIGTERM`);
if (!existsSync(join(dir, 'lobby.db'))) finish(false, 'no database file was written');

// 5. The admin CLI works on that database, and refuses a path with none there
//    rather than creating an empty one.
const admin = (db) =>
  spawnSync(process.execPath, ['relay.mjs', 'admin', 'recent'], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? '', DB: db },
    encoding: 'utf8',
  });
const recent = admin('lobby.db');
if (recent.status !== 0 || !recent.stdout.includes('no runs yet')) {
  finish(false, `admin recent exited ${recent.status}: ${recent.stdout}${recent.stderr}`);
}
const missing = admin('typo.db');
if (missing.status === 0 || !missing.stderr.includes('no database at')) {
  finish(false, `admin on a missing database exited ${missing.status}: ${missing.stderr}`);
}
if (existsSync(join(dir, 'typo.db'))) finish(false, 'admin created a database at a mistyped path');
finish(
  true,
  `port ${port}, welcomed "${welcome.name}", ticket ${ticket.runId.slice(0, 8)}…, ` +
    'clean shutdown, database written, admin CLI ok',
);
