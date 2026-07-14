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
 * series is reproducible by naming the same range. Exit code 0.
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
  },
});

const a = resolveSpec(values.a);
const b = resolveSpec(values.b);
const count = positiveInt('seeds', values.seeds);
const first = positiveInt('first', values.first);
const maxTicks = positiveInt('max-ticks', values['max-ticks']);
const seeds = Array.from({ length: count }, (_, i) => first + i);

const secs = (ticks: number): string => (ticks / GC_STEPS_PER_SECOND).toFixed(1);
const onMatch = (r: MatchResult): void => {
  if (values.verbose) {
    stdout.write(
      `seed ${String(r.seed).padStart(6)}  ${r.outcome.padEnd(7)}  ` +
        `${secs(r.ticks).padStart(7)}s  sent A ${String(r.sentA).padStart(4)}  ` +
        `B ${String(r.sentB).padStart(4)}\n`,
    );
  } else {
    const dot =
      r.outcome === 'a' ? 'A' : r.outcome === 'b' ? 'B' : r.outcome === 'draw' ? '=' : '·';
    stdout.write(dot);
  }
};

stdout.write(`A = ${a.label}   vs   B = ${b.label}   (seeds ${first}..${first + count - 1})\n`);
const series = runSeries(a.tuning, b.tuning, seeds, maxTicks, onMatch);
if (!values.verbose) stdout.write('\n');

const n = series.matches.length;
const gameSecs = series.totalTicks / GC_STEPS_PER_SECOND;
const rate = (cells: number): string => (gameSecs > 0 ? (cells / gameSecs).toFixed(2) : '0');
stdout.write(
  `matches ${n}   A wins ${series.winsA}   B wins ${series.winsB}   ` +
    `draws ${series.draws}   timeouts ${series.timeouts}\n` +
    `avg length ${secs(series.totalTicks / Math.max(1, n))}s\n` +
    `garbage sent   A ${series.sentA} cells (${rate(series.sentA)}/s)   ` +
    `B ${series.sentB} cells (${rate(series.sentB)}/s)\n`,
);
