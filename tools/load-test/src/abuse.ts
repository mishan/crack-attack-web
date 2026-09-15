/**
 * abuse.ts — misbehaving WebSocket clients (scenario L10), run while real
 * games play. Of the relay's existing rules only the pacing check closes one
 * (the over-pacing player); the rest it answers with an `error` or ignores, so
 * L10 measures what they cost. They count sockets opened, messages sent, and
 * sockets the relay closed (not ones they hung up themselves).
 */

import {
  MAX_INPUT_FRAMES_PER_MESSAGE,
  PROTOCOL_VERSION,
  encodeMessage,
} from '@crack-attack/protocol';
import WebSocket, { type RawData } from 'ws';
import { peekType } from './client.js';
import type { Metrics } from './metrics.js';
import { sleep } from './time.js';

export const ABUSE_KINDS = ['silent', 'churn', 'bigframes', 'malformed', 'flood'] as const;
/**
 * - `silent`: connect and never hello (hang up after two minutes and go again).
 * - `churn`: connect, hello, disconnect, repeat as fast as `rate` allows.
 * - `bigframes`: hello, then send 16 KiB frames (the relay's `maxPayload`), 100 a second.
 * - `malformed`: hello, then send junk that isn't valid JSON, 1,000 a second (the plan's rate).
 * - `flood`: play, then send `inputs` far ahead of real time until the pacing check closes it.
 */
export type AbuseKind = (typeof ABUSE_KINDS)[number];

const BIG_FRAME = 'x'.repeat(16 * 1024 - 32);

/**
 * Yield to the *macrotask* queue, not just microtasks: a tight `while` loop
 * that only `await Promise.resolve()`s never lets the event loop drain socket
 * writes or fire timers, so buffered bytes pile up until the process runs out
 * of memory. `setImmediate` returns control to the loop between sends.
 */
const macroYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A bounded send loop that can't starve its own process: it sends at most
 * `perSec` messages a second, yields to the loop each send, and waits for the
 * OS to drain when its send buffer runs ahead. A rate (rather than truly "as
 * fast as possible") keeps the *generator* from being the thing that falls
 * over — malformed and oversized frames aren't closed by the relay's current
 * rules, so an unbounded flood would drown the generator's own event loop
 * before it measured anything. Runs until the socket closes or `stop`.
 */
async function flood(
  ws: WebSocket,
  perSec: number,
  stopped: () => boolean,
  onSend: () => void,
  next: () => string,
): Promise<void> {
  const gapMs = perSec > 0 ? 1000 / perSec : 0;
  while (ws.readyState === WebSocket.OPEN && !stopped()) {
    if (ws.bufferedAmount > 1 << 20) {
      await sleep(5);
      continue;
    }
    ws.send(next());
    onSend();
    if (gapMs >= 1) await sleep(gapMs);
    else await macroYield();
  }
}

/** One abusive client, restarted on its own loop until stopped. */
export class Abuser {
  private ws: WebSocket | null = null;
  private stopped = false;
  /** Sockets this client hung up itself, so their close isn't counted as the relay's. */
  private readonly hungUp = new WeakSet<WebSocket>();

  constructor(
    private readonly env: { url: string; metrics: Metrics },
    private readonly kind: AbuseKind,
    private readonly name: string,
    /** `churn`: reconnects a second. `malformed`/`bigframes`: messages a second. Kind default otherwise. */
    private readonly rate?: number | undefined,
  ) {}

  /** Reconnects a second for `churn`. */
  private churnRate(): number {
    return this.rate ?? 100;
  }

  /** Messages a second for the bounded flood kinds (see {@link flood}). */
  private floodRate(): number {
    return this.rate ?? (this.kind === 'bigframes' ? 100 : 1000);
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.ws) this.hangUp(this.ws, true);
  }

  private hangUp(ws: WebSocket, abruptly = false): void {
    this.hungUp.add(ws);
    if (abruptly) ws.terminate();
    else ws.close();
  }

  private open(): Promise<WebSocket> {
    const ws = new WebSocket(this.env.url, { perMessageDeflate: false });
    this.ws = ws;
    this.env.metrics.count('abuseOpened');
    let opened = false;
    ws.on('error', () => undefined);
    ws.on('close', () => {
      // Only an open socket the relay closed: not a refusal, not our own hang-up.
      if (opened && !this.hungUp.has(ws)) this.env.metrics.count('abuseClosed');
    });
    return new Promise((resolve, reject) => {
      ws.once('open', () => {
        opened = true;
        resolve(ws);
      });
      ws.once('close', () => reject(new Error('closed before open')));
    });
  }

  private hello(ws: WebSocket): void {
    ws.send(encodeMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: this.name }));
    this.env.metrics.count('abuseSent');
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.round();
      } catch {
        // A refused or dropped socket is the expected outcome; loop again.
      }
      await sleep(this.kind === 'churn' ? 1000 / this.churnRate() : 200);
    }
  }

  private async round(): Promise<void> {
    const ws = await this.open();
    switch (this.kind) {
      case 'silent':
        // Just sit there. The relay has no hello deadline, so hang up after a
        // while (or each round would leave one more socket open) and go again.
        await this.until(ws, 120_000);
        this.hangUp(ws);
        return;
      case 'churn':
        this.hello(ws);
        this.hangUp(ws);
        return;
      case 'malformed':
      case 'bigframes': {
        this.hello(ws);
        const payload = this.kind === 'bigframes' ? BIG_FRAME : '{not valid json';
        await flood(
          ws,
          this.floodRate(),
          () => this.stopped,
          () => this.env.metrics.count('abuseSent'),
          () => payload,
        );
        return;
      }
      case 'flood':
        await this.floodMatch(ws);
        return;
    }
  }

  /**
   * The over-pacing player (the plan's fifth abuse): get into a match, then
   * pour in `inputs` far ahead of real time until the relay's pacing check
   * (`MAX_INPUT_LEAD_TICKS`) fatally closes the socket — the fatal path a real
   * flooding client hits. Uses a vs-AI room so a single ready starts the match
   * with no second party. The loop then reconnects and does it again.
   */
  private async floodMatch(ws: WebSocket): Promise<void> {
    const started = new Promise<void>((resolve) => {
      const onMessage = (data: RawData): void => {
        const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : data.toString();
        if (peekType(text) === 'match_start') {
          ws.off('message', onMessage);
          resolve();
        }
      };
      ws.on('message', onMessage);
      ws.once('close', () => resolve());
    });
    this.hello(ws);
    ws.send(encodeMessage({ type: 'create_room', aiOpponent: { difficulty: 'hard' } }));
    ws.send(encodeMessage({ type: 'ready' }));
    this.env.metrics.count('abuseSent', 2);
    await started;
    // Blast contiguous input batches; the frontier outruns the clock within a
    // batch or two and the relay closes the socket as a fatal pacing violation.
    let start = 0;
    const frames = Array<number>(MAX_INPUT_FRAMES_PER_MESSAGE).fill(0);
    await flood(
      ws,
      0,
      () => this.stopped,
      () => this.env.metrics.count('abuseSent'),
      () => {
        const msg = encodeMessage({ type: 'inputs', startTick: start, frames });
        start += frames.length;
        return msg;
      },
    );
  }

  private until(ws: WebSocket, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
