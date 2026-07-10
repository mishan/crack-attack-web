/**
 * End-to-end: two real LockstepSessions playing a full match *through the
 * relay* — the complete Phase 4 pipeline (sim → input batches → relay →
 * peer sims → digest comparison) with only the WebSocket byte transport
 * substituted by in-process connections (that hop is covered separately in
 * wsServer.integration.test.ts).
 *
 * The client's lockstep driver is imported from source across packages; this
 * is test-only (tests are excluded from tsc builds) and deliberate — the
 * point of this file is exactly the client↔server contract.
 */

import { describe, expect, it } from 'vitest';
import { CC_ADVANCE, CC_LEFT, CC_RIGHT, CC_SWAP, Rng } from '@crack-attack/core';
import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { LockstepSession } from '../../client/src/net/lockstep.js';
import { RelayServer, type ClientConnection } from './relay.js';

/** A headless netplay client: relay connection + lockstep session + input script. */
class HeadlessPlayer {
  readonly conn: ClientConnection & { deliver: (text: string) => void };
  session: LockstepSession | null = null;
  desyncAt: number | null = null;
  roomCode = '';
  private readonly script: () => number;

  constructor(
    private readonly relay: RelayServer,
    name: string,
    scriptSeed: number,
  ) {
    const r = new Rng(scriptSeed);
    this.script = () => {
      let bits = 0;
      const roll = r.number(10);
      if (roll === 0) bits |= CC_LEFT;
      else if (roll === 1) bits |= CC_RIGHT;
      if (r.chanceIn(4)) bits |= CC_SWAP;
      if (r.chanceIn(40)) bits |= CC_ADVANCE;
      return bits;
    };

    this.conn = {
      send: () => undefined, // replaced below; self-reference needed first
      close: () => undefined,
      deliver: () => undefined,
    };
    this.conn.deliver = (text: string) => this.onMessage(decodeServerMessage(text));
    this.conn.send = (text: string) => this.conn.deliver(text);
    relay.connect(this.conn);
    this.say({ type: 'hello', protocolVersion: PROTOCOL_VERSION, name });
  }

  say(msg: ClientMessage): void {
    this.relay.message(this.conn, encodeMessage(msg));
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'room_created') {
      this.roomCode = msg.code;
    } else if (msg.type === 'match_start') {
      this.session = new LockstepSession(msg.seed, msg.playerIndex, msg.inputDelay);
    } else if (msg.type === 'peer_inputs' && this.session) {
      this.session.addRemoteFrames(msg.startTick, msg.frames);
    } else if (msg.type === 'desync') {
      this.desyncAt = msg.tick;
    }
  }

  /** One "render frame": advance up to `steps` ticks, ship inputs + digests. */
  pump(steps: number): void {
    const s = this.session;
    if (!s) return;
    s.advance(steps, this.script);
    for (const b of s.takeOutgoing()) {
      this.say({ type: 'inputs', startTick: b.startTick, frames: b.frames });
    }
    for (const d of s.takeDigests()) {
      this.say({ type: 'digest', tick: d.tick, digests: d.digests });
    }
  }
}

describe('end-to-end lockstep through the relay', () => {
  it('plays a full match to a deterministic outcome with zero desyncs', () => {
    const relay = new RelayServer({ inputDelay: 3 });
    const alice = new HeadlessPlayer(relay, 'alice', 101);
    const bob = new HeadlessPlayer(relay, 'bob', 202);

    alice.say({ type: 'create_room' });
    expect(relay.roomCount).toBe(1);
    expect(alice.roomCode).not.toBe('');

    bob.say({ type: 'join_room', code: alice.roomCode });
    alice.say({ type: 'ready' });
    bob.say({ type: 'ready' });
    expect(alice.session).not.toBeNull();
    expect(bob.session).not.toBeNull();

    // Interleave frames of different sizes until the match resolves.
    for (let i = 0; i < 100000 && !alice.session!.outcome; i++) {
      alice.pump(1 + (i % 3));
      bob.pump(1 + ((i + 1) % 3));
    }
    // Let the trailing input batches flush and the laggard finish.
    for (let i = 0; i < 10; i++) {
      alice.pump(100);
      bob.pump(100);
    }

    expect(alice.session!.outcome).not.toBeNull();
    expect(bob.session!.outcome).toEqual(alice.session!.outcome);
    expect(alice.session!.currentTick).toBe(bob.session!.currentTick);
    expect(alice.desyncAt).toBeNull();
    expect(bob.desyncAt).toBeNull();
  });
});
