/**
 * smoke-bundle.mjs — prove `dist/relay.mjs` really stands alone. Copies it by
 * itself into an empty temp directory (no node_modules to lean on), starts it
 * there on an ephemeral port with an on-disk database, completes a hello →
 * welcome handshake over a real WebSocket, then stops it with SIGTERM and
 * expects a clean exit and a written database. Run after the `bundle` script.
 */

import { spawn } from 'node:child_process';
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
  console.error(`relay smoke test FAILED: ${message}\n--- stdout\n${stdout}--- stderr\n${stderr}`);
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

// 3. A graceful stop, with the player row written to the SQLite file.
stopping = true;
const exitCode = await new Promise((resolve) => {
  relay.once('exit', (code) => resolve(code));
  relay.kill('SIGTERM');
});
if (exitCode !== 0) finish(false, `relay exited with code ${exitCode} on SIGTERM`);
if (!existsSync(join(dir, 'lobby.db'))) finish(false, 'no database file was written');
finish(true, `port ${port}, welcomed "${welcome.name}", clean shutdown, database written`);
