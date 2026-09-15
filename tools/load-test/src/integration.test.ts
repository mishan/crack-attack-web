/**
 * integration.test.ts — the generator against a real relay. It starts the
 * server build in its own process (as a run does) and plays a short scenario,
 * asserting the pipeline works end to end: a wire game exchanges input through
 * the relay (forward latency is measured), the relay's STATS line is parsed,
 * and a CSV with the header and rows lands on disk. It builds the server
 * first (incremental: a no-op when the build is current), so a clean checkout
 * runs it too rather than skipping it.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLUMNS } from './columns.js';
import { Coordinator } from './coordinator.js';
import { getScenario } from './scenarios.js';
import { startRelayProcess } from './relayProcess.js';
import { ScoreboardDriver, httpOrigin } from './scoreboardDriver.js';
import { Metrics } from './metrics.js';
import { sleep } from './time.js';

const serverProject = fileURLToPath(
  new URL('../../../packages/server/tsconfig.json', import.meta.url),
);

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-b', serverProject], { stdio: 'inherit' });
}, 180_000);

const dir = mkdtempSync(join(tmpdir(), 'load-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('load-test against a real relay', () => {
  it(
    'plays L1 briefly: forward latency measured, relay stats parsed, CSV written',
    { timeout: 60_000 },
    async () => {
      const csv = join(dir, 'l1.csv');
      const scenario = getScenario('l1')!;
      const logs: string[] = [];
      const coordinator = new Coordinator({
        scenario,
        csvPath: csv,
        workers: 1,
        db: ':memory:',
        intervalMs: 1000,
        rampMs: 2000,
        holdMs: 4000,
        log: (line) => logs.push(line),
      });
      const summaries = await coordinator.run();

      expect(summaries).toHaveLength(1);
      const [l1] = summaries;
      expect(l1!.games).toBe(1);
      // A wire game exchanged input through the relay, so forward latency exists.
      expect(Number.isFinite(l1!.forwardP99)).toBe(true);
      expect(l1!.forwardP99).toBeGreaterThan(0);
      // The relay's STATS line was parsed (loop delay is a number).
      expect(Number.isFinite(l1!.relayLoopP99)).toBe(true);

      const rows = readFileSync(csv, 'utf8').trim().split('\n');
      expect(rows[0]).toBe(COLUMNS.join(','));
      expect(rows.length).toBeGreaterThan(1);
      // The header maps to the right number of cells.
      expect(rows[1]!.split(',').length).toBe(COLUMNS.length);
    },
  );

  it('the scoreboard driver records a run through the relay', { timeout: 60_000 }, async () => {
    const relay = await startRelayProcess({ db: ':memory:', env: { TRUST_PROXY: '1' } });
    try {
      const metrics = new Metrics();
      const driver = new ScoreboardDriver({
        baseUrl: httpOrigin(relay.url),
        metrics,
        clients: ['203.0.113.5'],
        ticketsPerSec: 4,
        submitsPerSec: 4,
        scoresPerSec: 4,
        replaysPerSec: 0,
        submitKinds: ['advance'],
      });
      driver.start();
      // The server won't accept a run until it has aged past its pacing floor
      // (~9 s for the advance replay), so give the driver time to clear it.
      for (let i = 0; i < 100 && metrics.counters.runsRecorded === 0; i++) await sleep(250);
      driver.stop();
      expect(metrics.counters.replaysMade).toBeGreaterThan(0);
      expect(metrics.counters.runsRecorded).toBeGreaterThan(0);
      const ok = Object.entries(metrics.http).some(([k, n]) => k === 'submit 200' && n > 0);
      expect(ok).toBe(true);
    } finally {
      await relay.stop();
    }
  });
});
