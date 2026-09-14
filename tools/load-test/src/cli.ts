#!/usr/bin/env node
/**
 * cli.ts — run one load-test scenario and write its CSV.
 *
 *   node tools/load-test/dist/cli.js <scenario> [options]
 *
 * Scenarios are the plan's L1–L12 (docs/LOAD_TEST_PLAN.md). By default the CLI
 * starts the relay itself (the server's `dist/relay.mjs` bundle, or `dist/main.js`)
 * with STATS=1 on an ephemeral port; `--relay ws://host:port` targets one that
 * is already running (e.g. behind nginx). See the package README.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { Coordinator } from './coordinator.js';
import { getScenario, SCENARIO_NAMES } from './scenarios.js';

const USAGE = `Usage: load-test <scenario> [options]

Scenarios: ${SCENARIO_NAMES.join(', ')}

Options:
  --relay <url>       Target an already-running relay (default: start one with STATS=1).
  --bundle            Start the deploy bundle (dist/relay.mjs) instead of dist/main.js.
  --db <path>         SQLite file for a relay the CLI starts (default :memory:).
  --trust-proxy <n>   TRUST_PROXY for a relay the CLI starts (needed for the scoreboard driver's per-client keys; default 1).
  --workers <n>       Generator worker processes (default 1; forced to 1 for single-game scenarios).
  --out <path>        CSV path (default docs/load-test-results/<date>/<scenario>.csv).
  --hold <sec>        Reading hold per step (default 120).
  --ramp <sec>        Ramp before each hold (default 15).
  --interval <sec>    Sampling interval (default 10).
  --steps <n>         Run only the first N steps (quick runs).
  --input-delay <n>   Match input delay in ticks (default the relay's).
  --rotate <sec>      Wire games report a result and rematch this often (default 0 = never).
  -h, --help
`;

function fail(message: string): never {
  stderr.write(`${message}\n\n${USAGE}`);
  exit(2);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    allowPositionals: true,
    options: {
      relay: { type: 'string' },
      bundle: { type: 'boolean' },
      db: { type: 'string' },
      'trust-proxy': { type: 'string' },
      workers: { type: 'string' },
      out: { type: 'string' },
      hold: { type: 'string' },
      ramp: { type: 'string' },
      interval: { type: 'string' },
      steps: { type: 'string' },
      'input-delay': { type: 'string' },
      rotate: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help || positionals.length === 0) {
    stdout.write(USAGE);
    exit(values.help ? 0 : 2);
  }
  const name = positionals[0]!;

  const num = (v: string | undefined, dflt: number): number => {
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n)) fail(`not a number: ${v}`);
    return n;
  };

  const holdMs = num(values.hold, 120) * 1000;
  const rampMs = num(values.ramp, 15) * 1000;
  const maxSteps = values.steps === undefined ? undefined : num(values.steps, 0);
  const scenario = getScenario(name, { holdMs, rampMs, maxSteps });
  if (!scenario) fail(`unknown scenario: ${name}`);

  const date = new Date().toISOString().slice(0, 10);
  const out =
    values.out ?? join(process.cwd(), 'docs', 'load-test-results', date, `${scenario.name}.csv`);
  mkdirSync(dirname(out), { recursive: true });

  const relayEnv: Record<string, string> = {
    TRUST_PROXY: values['trust-proxy'] ?? '1',
  };

  const coordinator = new Coordinator({
    scenario,
    csvPath: out,
    workers: Math.max(1, Math.floor(num(values.workers, 1))),
    relayUrl: values.relay,
    bundle: values.bundle ?? false,
    db: values.db ?? ':memory:',
    relayEnv,
    intervalMs: num(values.interval, 10) * 1000,
    rampMs,
    holdMs,
    ...(values['input-delay'] !== undefined ? { inputDelay: num(values['input-delay'], 3) } : {}),
    rotateMs: num(values.rotate, 0) * 1000,
  });

  stdout.write(`load-test: ${scenario.name} — ${scenario.description}\n`);
  await coordinator.run();
}

main().catch((err: unknown) => {
  stderr.write(
    `load-test failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  exit(1);
});
