#!/usr/bin/env node
/**
 * cli.ts — command-line entry point for the AI-vs-AI arena.
 *
 * Usage:
 *   ai-arena [--a <spec>] [--b <spec>] [--seeds N] [--first S]
 *            [--max-ticks T] [--verbose]
 *
 * A side spec is a difficulty preset (`easy`/`medium`/`hard`, default
 * `hard` vs `medium`) or a path to a JSON tuning file (overrides over a
 * `base` preset — see config.ts). Seeds run S..S+N-1 (defaults 1..20), so any
 * series is reproducible by naming the same range. Exit code 0 on success,
 * 2 on a usage/IO error (bad flag values, unreadable or invalid tuning file).
 *
 * Example tuning experiment:
 *   ai-arena --a candidate.json --b hard --seeds 50
 *   # candidate.json: { "base": "hard", "shatterWeight": 6 }
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import { GC_STEPS_PER_SECOND, aiTuningFor, type AiTuning } from '@crack-attack/core';
import { DEFAULT_MAX_TICKS, runSeries, type MatchResult } from './arena.js';
import { isPresetSpec, tuningFromJson } from './config.js';

function fail(message: string): never {
  stderr.write(`ai-arena: ${message}\n`);
  return exit(2);
}

/** Resolve a `--a`/`--b` spec: preset name or JSON tuning file path. */
function resolveSpec(spec: string): { label: string; tuning: AiTuning } {
  if (isPresetSpec(spec)) return { label: spec, tuning: aiTuningFor(spec) };
  let text: string;
  try {
    text = readFileSync(spec, 'utf8');
  } catch (e) {
    return fail(`could not read tuning file ${spec}: ${(e as Error).message}`);
  }
  try {
    return { label: spec, tuning: tuningFromJson(JSON.parse(text)) };
  } catch (e) {
    return fail(`invalid tuning file ${spec}: ${(e as Error).message}`);
  }
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fail(`--${name} must be a positive integer`);
  return n;
}

const { values } = parseArgs({
  args: argv.slice(2),
  options: {
    a: { type: 'string', default: 'hard' },
    b: { type: 'string', default: 'medium' },
    seeds: { type: 'string', default: '20' },
    first: { type: 'string', default: '1' },
    'max-ticks': { type: 'string', default: String(DEFAULT_MAX_TICKS) },
    verbose: { type: 'boolean', default: false },
    // Seats are near- but not exactly symmetric (see arena.ts): --both replays
    // every seed with the seats swapped and reports the aggregate, cancelling
    // any seat bias out of a careful comparison.
    both: { type: 'boolean', default: false },
  },
});

const a = resolveSpec(values.a);
const b = resolveSpec(values.b);
const count = positiveInt('seeds', values.seeds);
const first = positiveInt('first', values.first);
const maxTicks = positiveInt('max-ticks', values['max-ticks']);
const seeds = Array.from({ length: count }, (_, i) => first + i);

const secs = (ticks: number): string => (ticks / GC_STEPS_PER_SECOND).toFixed(1);

/** Per-match reporting, always from A's perspective (flip when seats are swapped). */
const onMatchFor =
  (flip: boolean) =>
  (r: MatchResult): void => {
    const outcome = flip && r.outcome === 'a' ? 'b' : flip && r.outcome === 'b' ? 'a' : r.outcome;
    const sentA = flip ? r.sentB : r.sentA;
    const sentB = flip ? r.sentA : r.sentB;
    if (values.verbose) {
      stdout.write(
        `seed ${String(r.seed).padStart(6)}  ${outcome.padEnd(7)}  ` +
          `${secs(r.ticks).padStart(7)}s  sent A ${String(sentA).padStart(4)}  ` +
          `B ${String(sentB).padStart(4)}\n`,
      );
    } else {
      const dot = outcome === 'a' ? 'A' : outcome === 'b' ? 'B' : outcome === 'draw' ? '=' : '·';
      stdout.write(dot);
    }
  };

/** Aggregate results, from A's perspective. */
interface Tally {
  matches: number;
  winsA: number;
  winsB: number;
  draws: number;
  timeouts: number;
  totalTicks: number;
  sentA: number;
  sentB: number;
}

function summarize(t: Tally): void {
  const gameSecs = t.totalTicks / GC_STEPS_PER_SECOND;
  const rate = (cells: number): string => (gameSecs > 0 ? (cells / gameSecs).toFixed(2) : '0');
  stdout.write(
    `matches ${t.matches}   A wins ${t.winsA}   B wins ${t.winsB}   ` +
      `draws ${t.draws}   timeouts ${t.timeouts}\n` +
      `avg length ${secs(t.totalTicks / Math.max(1, t.matches))}s\n` +
      `garbage sent   A ${t.sentA} cells (${rate(t.sentA)}/s)   ` +
      `B ${t.sentB} cells (${rate(t.sentB)}/s)\n`,
  );
}

stdout.write(`A = ${a.label}   vs   B = ${b.label}   (seeds ${first}..${first + count - 1})\n`);
const series = runSeries(a.tuning, b.tuning, seeds, maxTicks, onMatchFor(false));
if (!values.verbose) stdout.write('\n');
const tally: Tally = { ...series, matches: series.matches.length };
summarize(tally);

if (values.both) {
  stdout.write(`swapped seats: A = ${a.label} plays second\n`);
  const swapped = runSeries(b.tuning, a.tuning, seeds, maxTicks, onMatchFor(true));
  if (!values.verbose) stdout.write('\n');
  // The swapped series is reported from A's perspective (A sat in seat B).
  const swappedTally: Tally = {
    matches: swapped.matches.length,
    winsA: swapped.winsB,
    winsB: swapped.winsA,
    draws: swapped.draws,
    timeouts: swapped.timeouts,
    totalTicks: swapped.totalTicks,
    sentA: swapped.sentB,
    sentB: swapped.sentA,
  };
  summarize(swappedTally);
  stdout.write('combined (both orientations):\n');
  summarize({
    matches: tally.matches + swappedTally.matches,
    winsA: tally.winsA + swappedTally.winsA,
    winsB: tally.winsB + swappedTally.winsB,
    draws: tally.draws + swappedTally.draws,
    timeouts: tally.timeouts + swappedTally.timeouts,
    totalTicks: tally.totalTicks + swappedTally.totalTicks,
    sentA: tally.sentA + swappedTally.sentA,
    sentB: tally.sentB + swappedTally.sentB,
  });
}
