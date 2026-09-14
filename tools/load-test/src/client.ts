/**
 * client.ts — one bot's WebSocket to the relay: hello, waits for a given
 * server message, and inbound/outbound accounting. Messages are parsed
 * without the codec's validation (the relay under test is trusted, and the
 * generator's CPU isn't free), and a `room_list` push isn't parsed at all
 * unless a bot waits for one: at 10,000 idlers it is most of the traffic.
 */

import {
  PROTOCOL_VERSION,
  encodeMessage,
  type ClientMessage,
  type ErrorMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@crack-attack/protocol';
import WebSocket, { type RawData } from 'ws';
import type { Metrics } from './metrics.js';
import { absNow } from './time.js';

export type ServerType = ServerMessage['type'];
export type ServerOf<T extends ServerType> = Extract<ServerMessage, { type: T }>;

/** How long a bot waits for a reply by default. */
export const DEFAULT_WAIT_MS = 30_000;

/** What every bot in a worker shares. */
export interface BotEnv {
  url: string;
  metrics: Metrics;
  /** Prefix for bot names, so runs and workers are told apart in the relay's logs. */
  tag: string;
}

const TYPE_PREFIX = '{"type":"';

/** The `type` of an encoded server message, without parsing it (the relay writes `type` first). */
export function peekType(text: string): string {
  if (!text.startsWith(TYPE_PREFIX)) return '';
  return text.slice(TYPE_PREFIX.length, text.indexOf('"', TYPE_PREFIX.length));
}

export function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

interface Waiter {
  type: ServerType;
  resolve: (msg: ServerMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BotClient {
  ws: WebSocket | null = null;
  /** From the last `welcome`; a later join presents it to reclaim the identity. */
  token: string | undefined;
  /** When the last `hello` went out. */
  helloAt = 0;
  /** When the message being handled arrived (before parsing). */
  protected receivedAt = 0;
  /** Set while the bot closes its own socket, so the close isn't blamed on the relay. */
  private closingSelf = false;
  private waiters: Waiter[] = [];

  constructor(
    protected readonly env: BotEnv,
    readonly name: string,
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Open a socket; resolves once it's open. */
  connect(): Promise<void> {
    this.closingSelf = false;
    const ws = new WebSocket(this.env.url, {
      perMessageDeflate: false,
      handshakeTimeout: DEFAULT_WAIT_MS,
    });
    this.ws = ws;
    let opened = false;
    ws.on('message', (data) => this.receive(data));
    ws.on('error', () => undefined); // 'close' follows
    return new Promise((resolve, reject) => {
      ws.once('open', () => {
        opened = true;
        resolve();
      });
      ws.on('close', () => {
        if (!opened) {
          if (!this.closingSelf) this.env.metrics.count('connectFailures');
          reject(new Error(`${this.name}: the socket closed before it opened`));
        }
        this.closed(ws, opened);
      });
    });
  }

  /** Connect and hello, presenting the token from an earlier welcome if there is one. */
  async join(): Promise<WelcomeMessage> {
    const started = absNow();
    await this.connect();
    const welcome = this.expect('welcome');
    this.helloAt = absNow();
    this.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name: this.name,
      ...(this.token !== undefined ? { token: this.token } : {}),
    });
    const msg = await welcome;
    this.token = msg.token;
    this.env.metrics.hist.welcome.record(absNow() - started);
    return msg;
  }

  send(msg: ClientMessage): void {
    this.sendText(encodeMessage(msg));
  }

  sendText(text: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(text);
    this.env.metrics.counters.msgsOut++;
    this.env.metrics.counters.bytesOut += text.length;
  }

  /** Send `msg` and wait for a `type` reply (registered first: a reply can't slip past). */
  request<T extends ServerType>(
    msg: ClientMessage,
    type: T,
    timeoutMs = DEFAULT_WAIT_MS,
  ): Promise<ServerOf<T>> {
    const reply = this.expect(type, timeoutMs);
    this.send(msg);
    return reply;
  }

  /** The next `type` message; rejects on timeout or when the socket closes. */
  expect<T extends ServerType>(type: T, timeoutMs = DEFAULT_WAIT_MS): Promise<ServerOf<T>> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        type,
        resolve: resolve as (msg: ServerMessage) => void,
        reject,
        timer: setTimeout(() => {
          this.unwait(waiter);
          reject(new Error(`${this.name}: no ${type} within ${timeoutMs} ms`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** Close the socket (not counted against the relay). */
  close(): void {
    this.closingSelf = true;
    this.ws?.close();
  }

  /** Drop the socket without a closing handshake, as a network cut would. */
  terminate(): void {
    this.closingSelf = true;
    this.ws?.terminate();
  }

  /** Stop reading from the socket (the relay's send buffer for it then fills). */
  pause(): void {
    this.ws?.pause();
  }

  resume(): void {
    this.ws?.resume();
  }

  /** A parsed server message (not a `room_list` nobody waits for). */
  protected onMessage(_msg: ServerMessage): void {}

  /** Every `room_list`, unparsed. */
  protected onRoomList(_text: string): void {}

  /** The relay turned a request down. */
  protected onError(_msg: ErrorMessage): void {
    this.env.metrics.count('errors');
  }

  /** The socket closed; `byRelay` unless the bot closed it. */
  protected onClose(_byRelay: boolean): void {}

  private receive(data: RawData): void {
    this.receivedAt = absNow();
    const text = rawText(data);
    const counters = this.env.metrics.counters;
    counters.msgsIn++;
    counters.bytesIn += text.length;
    if (peekType(text) === 'room_list') {
      counters.roomLists++;
      counters.roomListBytes += text.length;
      this.onRoomList(text);
      if (!this.waiters.some((w) => w.type === 'room_list')) return;
    }
    const msg = JSON.parse(text) as ServerMessage;
    if (msg.type === 'error') this.onError(msg);
    const waiter = this.waiters.find((w) => w.type === msg.type);
    if (waiter) {
      this.unwait(waiter);
      waiter.resolve(msg);
    }
    this.onMessage(msg);
  }

  private closed(ws: WebSocket, opened: boolean): void {
    if (ws !== this.ws) return; // an earlier socket, already replaced
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error(`${this.name}: the socket closed`));
    }
    if (!opened) return;
    const byRelay = !this.closingSelf;
    if (byRelay) this.env.metrics.count('fatalCloses');
    this.onClose(byRelay);
  }

  private unwait(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1);
  }
}
