/**
 * @crack-attack/replay-check — the golden-master faithfulness harness API.
 *
 * Runs a seed + action stream through `@crack-attack/core`, digests each tick,
 * and diffs against a reference stream (a stored golden master, or an
 * instrumented C++ dump). See the individual modules for detail; the CLI
 * (`cli.ts`) wires these together for command-line use.
 */

export * from './digest.js';
export * from './replay.js';
export * from './diff.js';
