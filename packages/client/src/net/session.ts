/**
 * session.ts — the browser side of the relay connection.
 *
 * A thin typed wrapper over WebSocket + the protocol codec: encodes outgoing
 * `ClientMessage`s, decodes and validates incoming `ServerMessage`s, and hands
 * them to a single handler. All flow logic (rooms, lockstep) lives elsewhere;
 * this is deliberately just plumbing.
 */

import {
  ProtocolError,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';

export interface NetClientHandlers {
  onMessage: (msg: ServerMessage) => void;
  /** Socket closed (any reason). Fired at most once. */
  onClose: (reason: string) => void;
}

export class NetClient {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(private readonly handlers: NetClientHandlers) {}

  /** Open the socket; resolves on connect, rejects on failure to connect. */
  connect(url: string): Promise<void> {
    // A NetClient may be reused across reconnect attempts: each connect starts
    // a fresh close-notification cycle.
    this.closed = false;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (ws.readyState !== WebSocket.OPEN) reject(new Error(`cannot reach ${url}`));
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return;
        let msg: ServerMessage;
        try {
          msg = decodeServerMessage(ev.data);
        } catch (e) {
          // A malformed server message means we can't trust the stream.
          this.close(e instanceof ProtocolError ? e.message : 'bad server message');
          return;
        }
        this.handlers.onMessage(msg);
      };
      ws.onclose = () => {
        // A close before open must settle the connect() promise too, or the
        // caller would hang in "connecting…" forever.
        if (!opened) reject(new Error(`connection to ${url} closed before opening`));
        this.notifyClose('connection closed');
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encodeMessage(msg));
    }
  }

  close(reason = 'closed by client'): void {
    this.ws?.close();
    this.notifyClose(reason);
  }

  private notifyClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.onClose(reason);
  }
}
