/**
 * worker.ts — a forked generator process. It runs one {@link Harness} and
 * takes {@link Directive}s from the coordinator over the fork's IPC channel,
 * replying to a `sample` directive with its measurements. `--workers N` forks
 * N of these so timer jitter on any one process stays off the latency numbers.
 */

import type { Directive, WorkerMessage } from './directives.js';
import { Harness } from './harness.js';

const harness = new Harness();
harness.start();

const post = (msg: WorkerMessage): void => {
  process.send?.(msg);
};

process.on('message', (directive: Directive) => {
  if (directive.type === 'sample') {
    post({ type: 'sample', sample: harness.sample() });
    return;
  }
  if (directive.type === 'shutdown') {
    harness.shutdown();
    post({ type: 'stopped' });
    // Give the reply a turn to flush, then exit.
    setTimeout(() => process.exit(0), 100);
    return;
  }
  harness.handle(directive);
});

post({ type: 'ready' });
