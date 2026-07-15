#!/usr/bin/env node
/**
 * cli.ts — analyze a saved human-vs-AI replay.
 *
 * Usage:
 *   replay-analyze <replay.json> [--timeline]
 *
 * `<replay.json>` is the file the client's vs-AI screen saves ("Save replay").
 * Prints per-seat attack/defense stats and, with `--timeline`, every fire in
 * order. Exit code 0 on success, 2 on a usage/IO error.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { GC_STEPS_PER_SECOND } from '@crack-attack/core';
import { analyzeReplay, validateReplay, type SeatReport } from './analyze.js';

function fail(message: string): never {
  stderr.write(`replay-analyze: ${message}\n`);
  return exit(2);
}

const { values, positionals } = parseArgs({
  args: argv.slice(2),
  options: { timeline: { type: 'boolean', default: false } },
  allowPositionals: true,
});
if (positionals.length !== 1) fail('usage: replay-analyze <replay.json> [--timeline]');

let replay;
try {
  replay = validateReplay(JSON.parse(readFileSync(positionals[0]!, 'utf8')));
} catch (e) {
  fail(`could not load ${positionals[0]}: ${(e as Error).message}`);
}

const a = analyzeReplay(replay);
const secs = (ticks: number): string => (ticks / GC_STEPS_PER_SECOND).toFixed(1);
const gameSecs = a.ticks / GC_STEPS_PER_SECOND;

const seat = (name: string, s: SeatReport): string => {
  const opp = s.sampledTicks > 0 ? Math.round((100 * s.opportunityTicks) / s.sampledTicks) : 0;
  return (
    `${name}\n` +
    `  swaps ${s.swaps} (${(s.swaps / Math.max(1, gameSecs)).toFixed(2)}/s)   ` +
    `garbage sent ${s.garbageSent} cells (${(s.garbageSent / Math.max(1, gameSecs)).toFixed(2)}/s)\n` +
    `  chains ${s.chains} (best ×${s.bestChain})   4+ combos ${s.combos} (best ${s.bestCombo})\n` +
    `  time in danger ${secs(s.dangerTicks)}s   ` +
    `fire opportunity on board ${opp}% of sampled time\n`
  );
};

stdout.write(
  `vs-AI replay: seed ${a.seed}, difficulty ${a.difficulty}\n` +
    `length ${secs(a.ticks)}s   winner: ${a.outcome === 'ongoing' ? '(game unfinished)' : a.outcome}\n\n` +
    seat('YOU', a.human) +
    seat(`CPU (${a.difficulty})`, a.ai),
);

if (values.timeline) {
  stdout.write('\ntimeline:\n');
  for (const ev of a.timeline) {
    stdout.write(`  ${secs(ev.tick).padStart(7)}s  ${ev.seat.padEnd(5)}  ${ev.what}\n`);
  }
}
