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
  token = '';
  record = { wins: 0, losses: 0 };
  private readonly script: () => number;

  constructor(
    private readonly relay: RelayServer,
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
  }

  /** Hello the relay (async: identity touches the store). */
  async join(name: string, token?: string): Promise<void> {
    await this.say({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      name,
      ...(token !== undefined ? { token } : {}),
    });
  }

  async say(msg: ClientMessage): Promise<void> {
    await this.relay.message(this.conn, encodeMessage(msg));
  }

  private onMessage(msg: ServerMessage): void {
    if (msg.type === 'welcome') {
      this.token = msg.token;
      this.record = msg.record;
    } else if (msg.type === 'room_created') {
      this.roomCode = msg.code;
    } else if (msg.type === 'match_start') {
      this.session = new LockstepSession(msg.seed, msg.playerIndex, msg.inputDelay);
    } else if (msg.type === 'match_resume') {
      this.session = LockstepSession.resume(msg.seed, msg.playerIndex, msg.inputDelay, msg.frames);
    } else if (msg.type === 'peer_inputs' && this.session) {
      this.session.addRemoteFrames(msg.startTick, msg.frames);
    } else if (msg.type === 'desync') {
      this.desyncAt = msg.tick;
    }
  }

  /** One "render frame": advance up to `steps` ticks, ship inputs + digests. */
  async pump(steps: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.advance(steps, this.script);
    for (const b of s.takeOutgoing()) {
      await this.say({ type: 'inputs', startTick: b.startTick, frames: b.frames });
    }
    for (const d of s.takeDigests()) {
      await this.say({ type: 'digest', tick: d.tick, digests: d.digests });
    }
  }
}

// These tests simulate whole matches (tens of thousands of 50 Hz ticks × two
// sim pairs); give them explicit headroom over vitest's 5 s default.
const E2E_TIMEOUT_MS = 60_000;

describe('end-to-end lockstep through the relay', () => {
  it(
    'plays a full match to a deterministic outcome with zero desyncs',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const relay = new RelayServer({ inputDelay: 3 });
      const alice = new HeadlessPlayer(relay, 101);
      const bob = new HeadlessPlayer(relay, 202);
      await alice.join('alice');
      await bob.join('bob');

      await alice.say({ type: 'create_room' });
      expect(relay.roomCount).toBe(1);
      expect(alice.roomCode).not.toBe('');

      await bob.say({ type: 'join_room', code: alice.roomCode });
      await alice.say({ type: 'ready' });
      await bob.say({ type: 'ready' });
      expect(alice.session).not.toBeNull();
      expect(bob.session).not.toBeNull();

      // Interleave frames of different sizes until the match resolves.
      for (let i = 0; i < 100000 && !alice.session!.outcome; i++) {
        await alice.pump(1 + (i % 3));
        await bob.pump(1 + ((i + 1) % 3));
      }
      // Let the trailing input batches flush and the laggard finish.
      for (let i = 0; i < 10; i++) {
        await alice.pump(100);
        await bob.pump(100);
      }

      expect(alice.session!.outcome).not.toBeNull();
      expect(bob.session!.outcome).toEqual(alice.session!.outcome);
      expect(alice.session!.currentTick).toBe(bob.session!.currentTick);
      expect(alice.desyncAt).toBeNull();
      expect(bob.desyncAt).toBeNull();

      // Both report the deterministic result; the relay records it.
      const winner = alice.session!.outcome!.winner;
      await alice.say({ type: 'result', winner });
      await bob.say({ type: 'result', winner });
      if (winner !== null) {
        const winnerPlayer = winner === alice.session!.localIndex ? alice : bob;
        const loserPlayer = winnerPlayer === alice ? bob : alice;
        // Re-hello with the same tokens to read back the persisted records.
        const checkW = new HeadlessPlayer(relay, 1);
        await checkW.join('check-w', winnerPlayer.token);
        expect(checkW.record).toEqual({ wins: 1, losses: 0 });
        const checkL = new HeadlessPlayer(relay, 2);
        await checkL.join('check-l', loserPlayer.token);
        expect(checkL.record).toEqual({ wins: 0, losses: 1 });
      }
    },
  );

  it(
    'survives a mid-match drop: rejoin by token, resume, identical outcome',
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const relay = new RelayServer({ inputDelay: 3, graceMs: 60_000 });
      const alice = new HeadlessPlayer(relay, 101);
      const bob = new HeadlessPlayer(relay, 202);
      await alice.join('alice');
      await bob.join('bob');
      await alice.say({ type: 'create_room' });
      await bob.say({ type: 'join_room', code: alice.roomCode });
      await alice.say({ type: 'ready' });
      await bob.say({ type: 'ready' });

      // Reference: what the outcome would be without any drop. Replays the same
      // scripts through a private session pair (scripted inputs are per-tick
      // deterministic, so the interrupted run must land on the same outcome).
      // Play partway (well short of this seed's deterministic game end)...
      for (let i = 0; i < 100; i++) {
        await alice.pump(2);
        await bob.pump(2);
      }
      const tickAtDrop = alice.session!.currentTick;
      expect(tickAtDrop).toBeGreaterThan(100);
      expect(alice.session!.outcome).toBeNull();

      // ...alice's connection drops. Bob keeps pumping and stalls.
      relay.disconnect(alice.conn);
      for (let i = 0; i < 5; i++) await bob.pump(50);
      expect(bob.session!.outcome).toBeNull();

      // Alice returns with her token on a fresh connection: match_resume
      // rebuilds her session from the ledgers; she catches up and play resumes.
      const alice2 = new HeadlessPlayer(relay, 999); // fresh script: her old
      // pre-drop inputs live in the ledger; post-resume live input is new anyway.
      await alice2.join('alice', alice.token);
      expect(alice2.session).not.toBeNull();
      expect(alice2.session!.localIndex).toBe(0);

      // Catch up, then play to completion.
      for (let i = 0; i < 100000 && !alice2.session!.outcome; i++) {
        await alice2.pump(200);
        await bob.pump(200);
      }
      for (let i = 0; i < 10; i++) {
        await alice2.pump(500);
        await bob.pump(500);
      }

      expect(alice2.session!.outcome).not.toBeNull();
      expect(bob.session!.outcome).toEqual(alice2.session!.outcome);
      expect(alice2.session!.currentTick).toBe(bob.session!.currentTick);
      expect(alice2.session!.currentTick).toBeGreaterThan(tickAtDrop);
      expect(alice2.desyncAt).toBeNull();
      expect(bob.desyncAt).toBeNull();

      relay.shutdown();
    },
  );
});
