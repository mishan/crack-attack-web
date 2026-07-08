/**
 * cli.ts — command-line entry point for the replay-check harness.
 *
 * Usage:
 *   replay-check <replay.json>                    run and print the digest stream
 *   replay-check <replay.json> <reference.json>   run and diff against a reference
 *
 * A `<replay.json>` is a {@link Replay} ({ seed, ticks, actions }). A
 * `<reference.json>` is either a raw `string[]` of digests or a
 * {@link DigestStream} ({ seed, digests }) — e.g. a stored golden master or an
 * instrumented C++ dump. Exit code is 0 when the streams match (or when just
 * printing), 1 on a divergence, 2 on a usage/IO error.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { firstDivergence, formatDivergence } from './diff.js';
import { runReplay, type Replay } from './replay.js';

function fail(message: string, code = 2): never {
  stderr.write(`replay-check: ${message}\n`);
  return exit(code);
}

function loadJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return fail(`could not read ${path}: ${(e as Error).message}`);
  }
}

/** Accept either a bare `string[]` or a `{ digests }` object as a reference. */
function asDigests(value: unknown, path: string): string[] {
  const arr = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { digests?: unknown }).digests)
      ? (value as { digests: unknown }).digests
      : undefined;
  // Validate element types in both cases: a malformed reference (non-string
  // entries) should fail loudly, not surface as a spurious digest mismatch.
  if (!Array.isArray(arr) || !arr.every((d) => typeof d === 'string')) {
    return fail(`${path} is not a string[] or { digests: string[] }`);
  }
  return arr as string[];
}

function main(): void {
  const [replayPath, referencePath] = argv.slice(2);
  if (!replayPath) fail('usage: replay-check <replay.json> [reference.json]');

  const replay = loadJson(replayPath) as Replay;
  let stream;
  try {
    stream = runReplay(replay);
  } catch (e) {
    return fail(`replay failed: ${(e as Error).message}`);
  }

  if (!referencePath) {
    stdout.write(JSON.stringify(stream, null, 2) + '\n');
    return;
  }

  const reference = asDigests(loadJson(referencePath), referencePath);
  const divergence = firstDivergence(stream.digests, reference);
  stdout.write(formatDivergence(divergence) + '\n');
  if (divergence) exit(1);
}

main();
