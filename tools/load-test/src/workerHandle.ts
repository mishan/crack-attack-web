/**
 * workerHandle.ts — the coordinator's view of a generator: send it directives,
 * ask it for a sample. Two implementations behind one interface: a forked
 * child process (`--workers N`), and an in-process harness (a single-worker
 * run, and the tests), so the coordinator doesn't care which it drives.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Directive, WorkerMessage } from './directives.js';
import { Harness } from './harness.js';
import type { WorkerSample } from './metrics.js';

export interface WorkerHandle {
  send(directive: Directive): void;
  sample(): Promise<WorkerSample>;
  stop(): Promise<void>;
}

/** A harness in this process (no fork). */
export class LocalWorker implements WorkerHandle {
  private readonly harness = new Harness();

  constructor() {
    this.harness.start();
  }

  send(directive: Directive): void {
    this.harness.handle(directive);
  }

  sample(): Promise<WorkerSample> {
    return Promise.resolve(this.harness.sample());
  }

  stop(): Promise<void> {
    this.harness.shutdown();
    return Promise.resolve();
  }
}

/** A forked worker process. */
export class ForkedWorker implements WorkerHandle {
  private readonly child: ChildProcess;
  private pendingSample: ((sample: WorkerSample) => void) | null = null;
  private readonly onLog: (line: string) => void;

  private constructor(child: ChildProcess, onLog: (line: string) => void) {
    this.child = child;
    this.onLog = onLog;
    child.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'sample' && this.pendingSample) {
        const resolve = this.pendingSample;
        this.pendingSample = null;
        resolve(msg.sample);
      } else if (msg.type === 'log') {
        this.onLog(msg.line);
      }
    });
  }

  /** Fork a worker and resolve once it signals ready. */
  static spawn(onLog: (line: string) => void): Promise<ForkedWorker> {
    const entry = fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = fork(entry, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const worker = new ForkedWorker(child, onLog);
    return new Promise((resolve, reject) => {
      const ready = (msg: WorkerMessage): void => {
        if (msg.type === 'ready') {
          child.off('message', ready);
          resolve(worker);
        }
      };
      child.on('message', ready);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0 && code !== null) reject(new Error(`worker exited with code ${code}`));
      });
    });
  }

  send(directive: Directive): void {
    this.child.send(directive);
  }

  sample(): Promise<WorkerSample> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingSample = null;
        reject(new Error('worker did not answer a sample request'));
      }, 30_000);
      this.pendingSample = (sample) => {
        clearTimeout(timer);
        resolve(sample);
      };
      this.child.send({ type: 'sample' });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      // A fallback only: a worker that exits cleanly clears it.
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 5_000);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      this.child.send({ type: 'shutdown' });
    });
  }
}
