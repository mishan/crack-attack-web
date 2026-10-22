import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const web = path.join(root, 'packages/client/dist/web');
export const relayMain = path.join(root, 'packages/server/dist/main.js');

/** The built relay on a free port, with an in-memory database. */
export function startRelay(corsOrigin) {
  const child = spawn(process.execPath, [relayMain], {
    env: {
      ...process.env,
      PORT: '0',
      HOST: '127.0.0.1',
      DB: ':memory:',
      CORS_ORIGIN: corsOrigin,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`relay exited (${code})`)));
    child.stdout.on('data', (chunk) => {
      const port = String(chunk).match(/listening on :(\d+)/)?.[1];
      if (port) resolve({ process: child, url: `ws://127.0.0.1:${port}` });
    });
  });
}
