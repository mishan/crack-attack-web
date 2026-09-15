/**
 * time.ts — the generator's clock. `absNow` is monotonic within a process and
 * comparable across processes on one host (performance's origin plus its
 * clock), so a worker can time an event another worker started.
 */

export const absNow = (): number => performance.timeOrigin + performance.now();

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
