/**
 * wsServer.ts — WebSocket transport for the relay.
 *
 * The thin Node layer: accepts `ws` connections and forwards them to the
 * transport-free {@link RelayServer}. WebSocket's ordered+reliable delivery
 * subsumes the original's ENet reliable channels (Communicator.h:51).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { RelayServer, type ClientConnection } from './relay.js';

export interface RelayWsServerOptions {
  /** TCP port; 0 lets the OS pick (tests). Default 8080 (CO_DEFAULT_PORT). */
  port?: number | undefined;
  host?: string | undefined;
  entropy?: (() => number) | undefined;
  inputDelay?: number | undefined;
}

export interface RelayWsServer {
  /** The bound port (useful when 0 was requested). */
  readonly port: number;
  readonly relay: RelayServer;
  close(): Promise<void>;
}

/** Default port, matching the original (CO_DEFAULT_PORT, Communicator.h:35). */
export const DEFAULT_PORT = 8080;

/** Start a relay on a WebSocket server. Resolves once listening. */
export function startRelayWsServer(options: RelayWsServerOptions = {}): Promise<RelayWsServer> {
  const relay = new RelayServer({ entropy: options.entropy, inputDelay: options.inputDelay });
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
    ws.on('message', (data) => {
      relay.message(conn, typeof data === 'string' ? data : data.toString());
    });
    ws.on('close', () => relay.disconnect(conn));
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
            for (const client of wss.clients) client.terminate();
            wss.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
