/**
 * wsServer.ts — WebSocket transport for the relay.
 *
 * The thin Node layer: accepts `ws` connections and forwards them to the
 * transport-free {@link RelayServer}. WebSocket's ordered+reliable delivery
 * subsumes the original's ENet reliable channels (Communicator.h:51).
 * Message handling is async (the relay touches the store on hello/result),
 * so each connection's messages are chained to preserve ordering.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { RelayServer, type ClientConnection, type RelayServerOptions } from './relay.js';

export interface RelayWsServerOptions extends RelayServerOptions {
  /** TCP port; 0 lets the OS pick (tests). Default 8080 (CO_DEFAULT_PORT). */
  port?: number | undefined;
  host?: string | undefined;
}

export interface RelayWsServer {
  /** The bound port (useful when 0 was requested). */
  readonly port: number;
  readonly relay: RelayServer;
  close(): Promise<void>;
}

/** Default port, matching the original (CO_DEFAULT_PORT, Communicator.h:35). */
export const DEFAULT_PORT = 8080;

/**
 * Largest incoming WebSocket message the relay accepts, in bytes (ws's
 * `maxPayload`; its default is 100 MiB). The biggest legitimate client→server
 * message is a full `inputs` batch: MAX_INPUT_FRAMES_PER_MESSAGE (250) frames
 * of at most 2 digits (ACTION_MASK = 63) plus commas, a uint32 startTick and
 * the envelope — about 800 bytes of compact JSON. Everything else is smaller
 * (a worst-case `hello`: a 32-unit name fully \u-escaped is 192 bytes, plus a
 * 32-char token — under 300). 16 KiB leaves ~20x headroom; anything bigger is
 * hostile, and ws closes that connection with 1009 (message too big).
 */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

/** Start a relay on a WebSocket server. Resolves once listening. */
export function startRelayWsServer(options: RelayWsServerOptions = {}): Promise<RelayWsServer> {
  // Entropy defaults to a CSPRNG inside RelayServer itself.
  const relay = new RelayServer({
    entropy: options.entropy,
    inputDelay: options.inputDelay,
    store: options.store,
    graceMs: options.graceMs,
    now: options.now,
  });
  const wss = new WebSocketServer({
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    port: options.port ?? DEFAULT_PORT,
    ...(options.host !== undefined ? { host: options.host } : {}),
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: ClientConnection = {
      send: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      close: () => ws.close(),
    };
    relay.connect(conn);
    // Chain async handling so a connection's messages process in order.
    let pipeline = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      // The protocol is text-only JSON; drop binary frames outright rather
      // than mis-decoding them.
      if (isBinary) return;
      // ws RawData is Buffer | ArrayBuffer | Buffer[]; a naive toString() on
      // an ArrayBuffer yields "[object ArrayBuffer]". Normalize to UTF-8.
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(data).toString('utf8');
      pipeline = pipeline
        .then(() => relay.message(conn, text))
        .catch((err: unknown) => {
          // An unexpected relay failure (e.g. the store erroring during hello
          // or result) must not leave the client hanging silently: log it and
          // close so the client fails fast and reconnects.
          console.error('relay: message handling failed, closing connection:', err);
          ws.close(1011, 'internal error');
        });
    });
    ws.on('close', () => {
      pipeline = pipeline
        .then(() => relay.disconnect(conn))
        .catch((err: unknown) => console.error('relay: disconnect handling failed:', err));
    });
    // On a socket error, ws emits 'close' afterwards; nothing extra to do.
    ws.on('error', () => undefined);
  });

  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.once('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
      resolve({
        port,
        relay,
        close: () =>
          new Promise<void>((res, rej) => {
            relay.shutdown();
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
