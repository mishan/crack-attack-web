/**
 * relayProcess.ts — start the relay under test as its own process (its own
 * core) with `STATS=1`, and collect the stats lines it prints. Used when the
 * CLI isn't pointed at an already-running relay with `--relay`. Prefers the
 * standalone bundle (`packages/server/dist/relay.mjs`) — what a deploy runs —
 * and falls back to `dist/main.js`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATS_LINE_PREFIX, type StatsSample } from '@crack-attack/server';

export interface RelayProcessOptions {
  /** The relay's SQLite file (`:memory:` for none). */
  db: string;
  /** Extra environment (TRUST_PROXY, CORS_ORIGIN, DB overrides). */
  env?: Record<string, string> | undefined;
  /** How often the relay prints a stats line, ms (default its own 10 s). */
  statsIntervalMs?: number | undefined;
  /**
   * Run the standalone bundle (`dist/relay.mjs`) — the deploy artifact — rather
   * than `dist/main.js`. The plan runs the real capacity measurements against
   * the bundle; keep it current with `pnpm --filter @crack-attack/server bundle`.
   * Default false: `main.js` is always fresh after a plain `tsc -b`.
   */
  bundle?: boolean | undefined;
  /** Called for each parsed stats line. */
  onStats?: ((sample: StatsSample) => void) | undefined;
  /** Called for each raw stderr line that isn't a stats line. */
  onLog?: ((line: string) => void) | undefined;
}

export interface RelayProcess {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function serverDist(file: string): string | null {
  const path = fileURLToPath(new URL(`../../../packages/server/dist/${file}`, import.meta.url));
  return existsSync(path) ? path : null;
}

/** Spawn the relay on an ephemeral port and resolve once it reports it. */
export async function startRelayProcess(options: RelayProcessOptions): Promise<RelayProcess> {
  const entry = options.bundle
    ? serverDist('relay.mjs')
    : (serverDist('main.js') ?? serverDist('relay.mjs'));
  if (!entry) {
    throw new Error(
      options.bundle
        ? 'no dist/relay.mjs — run `pnpm --filter @crack-attack/server bundle` first'
        : 'no relay build found — run `pnpm --filter @crack-attack/server build` first',
    );
  }
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env['PATH'] ?? '',
      HOST: '127.0.0.1',
      PORT: '0',
      STATS: '1',
      ...(options.statsIntervalMs !== undefined
        ? { STATS_INTERVAL_MS: String(Math.round(options.statsIntervalMs)) }
        : {}),
      DB: options.db,
      ...options.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr?.setEncoding('utf8');
  createInterface({ input: child.stderr! }).on('line', (line) => {
    if (line.startsWith(STATS_LINE_PREFIX)) {
      try {
        options.onStats?.(JSON.parse(line.slice(STATS_LINE_PREFIX.length)) as StatsSample);
      } catch {
        options.onLog?.(line);
      }
    } else if (line.trim()) {
      options.onLog?.(line);
    }
  });

  const port = await Promise.race([
    (async (): Promise<number> => {
      const rl = createInterface({ input: child.stdout!.setEncoding('utf8') });
      for await (const line of rl) {
        const m = /listening on :(\d+)/.exec(line);
        if (m) {
          rl.close();
          return Number(m[1]);
        }
      }
      throw new Error('relay exited before it started listening');
    })(),
    once(child, 'exit').then(([code]): never => {
      throw new Error(`relay exited before listening (code ${code})`);
    }),
  ]);

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await once(child, 'exit');
      clearTimeout(timer);
    },
  };
}
