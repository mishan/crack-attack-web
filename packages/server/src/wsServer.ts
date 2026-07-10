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

import { randomBytes } from 'node:crypto';
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

/** CSPRNG-backed float source for seeds, room codes, and session tokens. */
export function cryptoEntropy(): number {
  return randomBytes(4).readUInt32BE(0) / 0x100000000;
}

/** Start a relay on a WebSocket server. Resolves once listening. */
export function startRelayWsServer(options: RelayWsServerOptions = {}): Promise<RelayWsServer> {
  const relay = new RelayServer({
    entropy: options.entropy ?? cryptoEntropy,
    inputDelay: options.inputDelay,
    store: options.store,
    graceMs: options.graceMs,
  });
  const wss = new WebSocketServer({
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
      pipeline = pipeline.then(() => relay.message(conn, text)).catch(() => undefined);
    });
    ws.on('close', () => {
      pipeline = pipeline.then(() => relay.disconnect(conn)).catch(() => undefined);
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
