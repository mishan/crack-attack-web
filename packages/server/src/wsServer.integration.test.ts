/**
 * Integration: the relay over real WebSockets on an ephemeral port. Two
 * clients hello, form a room, start a match, exchange an input batch and a
 * digest — the full Phase 4 happy path minus the game itself.
 */

import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  encodeMessage,
  decodeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { startRelayWsServer, type RelayWsServer } from './wsServer.js';

class TestClient {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiter: (() => void) | null = null;

  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (data) => {
      this.inbox.push(decodeServerMessage(data.toString()));
      this.waiter?.();
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(encodeMessage(msg));
  }

  /** Wait for (and consume) the next message of the given type. */
  async next<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) {
        return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 25);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

describe('relay over WebSocket', () => {
  let server: RelayWsServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it('runs the full room → match → traffic happy path', async () => {
    server = await startRelayWsServer({ port: 0 });

    const alice = new TestClient(server.port);
    const bob = new TestClient(server.port);
    await alice.open();
    await bob.open();

    alice.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'alice' });
    bob.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'bob' });
    await alice.next('welcome');
    await bob.next('welcome');

    alice.send({ type: 'create_room' });
    const { code } = await alice.next('room_created');

    bob.send({ type: 'join_room', code });
    const joined = await bob.next('room_joined');
    expect(joined.players).toEqual(['alice', 'bob']);
    await alice.next('peer_joined');

    alice.send({ type: 'ready' });
    bob.send({ type: 'ready' });
    const startA = await alice.next('match_start');
    const startB = await bob.next('match_start');
    expect(startA.seed).toBe(startB.seed);
    expect(startA.playerIndex).toBe(0);
    expect(startB.playerIndex).toBe(1);

    alice.send({ type: 'inputs', startTick: 0, frames: [0, 16, 0] });
    const relayed = await bob.next('peer_inputs');
    expect(relayed).toEqual({
      type: 'peer_inputs',
      playerIndex: 0,
      startTick: 0,
      frames: [0, 16, 0],
    });

    alice.send({ type: 'digest', tick: 32, digests: [123, 456] });
    bob.send({ type: 'digest', tick: 32, digests: [123, 456] });

    // A mismatched digest then voids the match for both.
    alice.send({ type: 'digest', tick: 64, digests: [1, 2] });
    bob.send({ type: 'digest', tick: 64, digests: [1, 3] });
    const desyncA = await alice.next('desync');
    expect(desyncA.tick).toBe(64);
    const endB = await bob.next('match_end');
    expect(endB.reason).toBe('desync');

    alice.close();
    bob.close();
  });

  it('holds a grace window on a socket drop, then forfeits to the survivor', async () => {
    server = await startRelayWsServer({ port: 0, graceMs: 150 });
    const alice = new TestClient(server.port);
    const bob = new TestClient(server.port);
    await alice.open();
    await bob.open();
    alice.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'alice' });
    bob.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'bob' });
    await alice.next('welcome');
    await bob.next('welcome');
    alice.send({ type: 'create_room' });
    const { code } = await alice.next('room_created');
    bob.send({ type: 'join_room', code });
    await bob.next('room_joined');
    alice.send({ type: 'ready' });
    bob.send({ type: 'ready' });
    await bob.next('match_start');

    alice.close();
    const dropped = await bob.next('peer_dropped');
    expect(dropped).toEqual({ type: 'peer_dropped', name: 'alice', graceMs: 150 });
    const end = await bob.next('match_end');
    expect(end).toEqual({ type: 'match_end', reason: 'disconnect', winner: 1 });

    bob.close();
  });

  it('resumes a match when the dropped player reconnects with their token', async () => {
    server = await startRelayWsServer({ port: 0, graceMs: 5000 });
    const alice = new TestClient(server.port);
    const bob = new TestClient(server.port);
    await alice.open();
    await bob.open();
    alice.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'alice' });
    bob.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'bob' });
    const tokenA = (await alice.next('welcome')).token;
    await bob.next('welcome');
    alice.send({ type: 'create_room' });
    const { code } = await alice.next('room_created');
    bob.send({ type: 'join_room', code });
    await bob.next('room_joined');
    alice.send({ type: 'ready' });
    bob.send({ type: 'ready' });
    await alice.next('match_start');
    await bob.next('match_start');
    alice.send({ type: 'inputs', startTick: 0, frames: [0, 16] });
    await bob.next('peer_inputs');

    alice.close();
    await bob.next('peer_dropped');

    const alice2 = new TestClient(server.port);
    await alice2.open();
    alice2.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'alice', token: tokenA });
    await alice2.next('welcome');
    const resume = await alice2.next('match_resume');
    expect(resume.playerIndex).toBe(0);
    expect(resume.frames[0]).toEqual([0, 16]);
    await bob.next('peer_rejoined');

    // Live traffic flows again.
    alice2.send({ type: 'inputs', startTick: 2, frames: [4] });
    const relayed = await bob.next('peer_inputs');
    expect(relayed.startTick).toBe(2);

    alice2.close();
    bob.close();
  });
});
