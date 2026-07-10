import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  encodeMessage,
  decodeServerMessage,
  isRoomCode,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { RelayServer, type ClientConnection } from './relay.js';

/** A fake connection capturing everything the relay sends. */
class FakeConn implements ClientConnection {
  readonly sent: ServerMessage[] = [];
  closed = false;
  send(text: string): void {
    this.sent.push(decodeServerMessage(text));
  }
  close(): void {
    this.closed = true;
  }
  /** Last message sent, asserted to exist. */
  last(): ServerMessage {
    expect(this.sent.length).toBeGreaterThan(0);
    return this.sent[this.sent.length - 1]!;
  }
  /** Drop recorded traffic (focus a test on what follows). */
  clear(): void {
    this.sent.length = 0;
  }
}

/** Deterministic entropy for reproducible seeds/codes. */
function fixedEntropy(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

function client(relay: RelayServer, name: string): FakeConn {
  const conn = new FakeConn();
  relay.connect(conn);
  say(relay, conn, { type: 'hello', protocolVersion: PROTOCOL_VERSION, name });
  expect(conn.last().type).toBe('welcome');
  conn.clear();
  return conn;
}

function say(relay: RelayServer, conn: FakeConn, msg: ClientMessage): void {
  relay.message(conn, encodeMessage(msg));
}

/** Two players helloed, in a room, match started. Returns [host, joiner, code]. */
function startedMatch(relay: RelayServer): [FakeConn, FakeConn, string] {
  const a = client(relay, 'alice');
  const b = client(relay, 'bob');
  say(relay, a, { type: 'create_room' });
  const created = a.last();
  if (created.type !== 'room_created') throw new Error('expected room_created');
  say(relay, b, { type: 'join_room', code: created.code });
  say(relay, a, { type: 'ready' });
  say(relay, b, { type: 'ready' });
  a.clear();
  b.clear();
  // match_start was consumed by clear() above in callers that don't care; the
  // dedicated test below re-derives it. Re-send is not possible, so callers
  // needing the message should not use this helper.
  return [a, b, created.code];
}

describe('handshake', () => {
  it('welcomes a matching protocol version', () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    say(relay, conn, { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha' });
    expect(conn.last()).toEqual({ type: 'welcome', protocolVersion: PROTOCOL_VERSION });
  });

  it('rejects a version mismatch and closes', () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    say(relay, conn, { type: 'hello', protocolVersion: PROTOCOL_VERSION + 1, name: 'misha' });
    const err = conn.last();
    expect(err.type === 'error' && err.code).toBe('version_mismatch');
    expect(conn.closed).toBe(true);
  });

  it('requires hello first and rejects a second hello', () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    say(relay, conn, { type: 'create_room' });
    expect(conn.last().type).toBe('error');

    const c2 = client(relay, 'misha');
    say(relay, c2, { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'again' });
    expect(c2.last().type).toBe('error');
  });

  it('rejects malformed JSON with bad_message', () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    relay.message(conn, 'not json{');
    const err = conn.last();
    expect(err.type === 'error' && err.code).toBe('bad_message');
  });
});

describe('room flow', () => {
  it('creates a room with a well-formed code and joins it', () => {
    const relay = new RelayServer();
    const a = client(relay, 'alice');
    const b = client(relay, 'bob');

    say(relay, a, { type: 'create_room' });
    const created = a.last();
    expect(created.type).toBe('room_created');
    const code = created.type === 'room_created' ? created.code : '';
    expect(isRoomCode(code)).toBe(true);
    expect(relay.roomCount).toBe(1);

    say(relay, b, { type: 'join_room', code });
    expect(b.last()).toEqual({ type: 'room_joined', code, players: ['alice', 'bob'] });
    expect(a.last()).toEqual({ type: 'peer_joined', name: 'bob' });
  });

  it('reports unknown and full rooms', () => {
    const relay = new RelayServer();
    const a = client(relay, 'alice');
    say(relay, a, { type: 'join_room', code: 'AAAAA' });
    const err = a.last();
    expect(err.type === 'error' && err.code).toBe('room_not_found');

    const host = client(relay, 'host');
    const b = client(relay, 'bob');
    const c = client(relay, 'carol');
    say(relay, host, { type: 'create_room' });
    const created = host.last();
    const code = created.type === 'room_created' ? created.code : '';
    say(relay, b, { type: 'join_room', code });
    say(relay, c, { type: 'join_room', code });
    const full = c.last();
    expect(full.type === 'error' && full.code).toBe('room_full');
  });

  it('deletes an empty room and notifies a waiting peer on leave', () => {
    const relay = new RelayServer();
    const a = client(relay, 'alice');
    const b = client(relay, 'bob');
    say(relay, a, { type: 'create_room' });
    const code = (() => {
      const m = a.last();
      return m.type === 'room_created' ? m.code : '';
    })();
    say(relay, b, { type: 'join_room', code });
    say(relay, a, { type: 'leave_room' });
    expect(b.last()).toEqual({ type: 'peer_left', name: 'alice' });
    say(relay, b, { type: 'leave_room' });
    expect(relay.roomCount).toBe(0);
  });
});

describe('match start', () => {
  it('starts when both are ready, with a shared uint32 seed and distinct indices', () => {
    const relay = new RelayServer({ entropy: fixedEntropy(0.25, 0.5, 0.75), inputDelay: 4 });
    const a = client(relay, 'alice');
    const b = client(relay, 'bob');
    say(relay, a, { type: 'create_room' });
    const code = (() => {
      const m = a.last();
      return m.type === 'room_created' ? m.code : '';
    })();
    say(relay, b, { type: 'join_room', code });
    say(relay, a, { type: 'ready' });
    // Not started yet — only one ready.
    expect(a.sent.filter((m) => m.type === 'match_start')).toHaveLength(0);
    say(relay, b, { type: 'ready' });

    const startA = a.sent.find((m) => m.type === 'match_start');
    const startB = b.sent.find((m) => m.type === 'match_start');
    if (!startA || startA.type !== 'match_start') throw new Error('A missing match_start');
    if (!startB || startB.type !== 'match_start') throw new Error('B missing match_start');
    expect(startA.seed).toBe(startB.seed);
    expect(Number.isInteger(startA.seed)).toBe(true);
    expect(startA.playerIndex).toBe(0);
    expect(startB.playerIndex).toBe(1);
    expect(startA.inputDelay).toBe(4);
    expect(startA.players).toEqual(['alice', 'bob']);
  });

  it('rematch: ready during play restarts with a fresh seed', () => {
    const relay = new RelayServer({ entropy: Math.random });
    const a = client(relay, 'alice');
    const b = client(relay, 'bob');
    say(relay, a, { type: 'create_room' });
    const code = (() => {
      const m = a.last();
      return m.type === 'room_created' ? m.code : '';
    })();
    say(relay, b, { type: 'join_room', code });
    say(relay, a, { type: 'ready' });
    say(relay, b, { type: 'ready' });
    a.clear();
    b.clear();
    // Both games ended client-side (deterministically); both re-ready.
    say(relay, a, { type: 'ready' });
    say(relay, b, { type: 'ready' });
    expect(a.sent.filter((m) => m.type === 'match_start')).toHaveLength(1);
    expect(b.sent.filter((m) => m.type === 'match_start')).toHaveLength(1);
  });
});

describe('input relay', () => {
  it('relays contiguous batches with the sender index', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    say(relay, a, { type: 'inputs', startTick: 0, frames: [0, 1, 2] });
    expect(b.last()).toEqual({
      type: 'peer_inputs',
      playerIndex: 0,
      startTick: 0,
      frames: [0, 1, 2],
    });
    say(relay, b, { type: 'inputs', startTick: 0, frames: [4] });
    expect(a.last()).toEqual({ type: 'peer_inputs', playerIndex: 1, startTick: 0, frames: [4] });
    say(relay, a, { type: 'inputs', startTick: 3, frames: [8] });
    expect(b.last()).toEqual({ type: 'peer_inputs', playerIndex: 0, startTick: 3, frames: [8] });
  });

  it('treats a contiguity violation as fatal', () => {
    const relay = new RelayServer();
    const [a] = startedMatch(relay);
    say(relay, a, { type: 'inputs', startTick: 0, frames: [0] });
    say(relay, a, { type: 'inputs', startTick: 5, frames: [0] });
    const err = a.last();
    expect(err.type === 'error' && err.code).toBe('bad_message');
    expect(a.closed).toBe(true);
  });

  it('rejects inputs outside a match', () => {
    const relay = new RelayServer();
    const a = client(relay, 'alice');
    say(relay, a, { type: 'inputs', startTick: 0, frames: [0] });
    const err = a.last();
    expect(err.type === 'error' && err.code).toBe('not_in_room');
  });
});

describe('digest comparison', () => {
  it('stays quiet on matching digests', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    say(relay, a, { type: 'digest', tick: 32, digests: [111, 222] });
    say(relay, b, { type: 'digest', tick: 32, digests: [111, 222] });
    expect(a.sent.filter((m) => m.type === 'desync')).toHaveLength(0);
    expect(b.sent.filter((m) => m.type === 'desync')).toHaveLength(0);
  });

  it('broadcasts desync and voids the match on mismatch', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    say(relay, a, { type: 'digest', tick: 64, digests: [111, 222] });
    say(relay, b, { type: 'digest', tick: 64, digests: [111, 999] });
    expect(a.sent.find((m) => m.type === 'desync')).toEqual({ type: 'desync', tick: 64 });
    expect(b.sent.find((m) => m.type === 'desync')).toEqual({ type: 'desync', tick: 64 });
    expect(a.sent.find((m) => m.type === 'match_end')).toEqual({
      type: 'match_end',
      reason: 'desync',
      winner: null,
    });
  });

  it('compares digests submitted out of order across ticks', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    say(relay, a, { type: 'digest', tick: 32, digests: [1, 1] });
    say(relay, a, { type: 'digest', tick: 64, digests: [2, 2] });
    say(relay, b, { type: 'digest', tick: 64, digests: [2, 2] });
    say(relay, b, { type: 'digest', tick: 32, digests: [1, 1] });
    expect(a.sent.filter((m) => m.type === 'desync')).toHaveLength(0);
  });
});

describe('lifecycle', () => {
  it('concession ends the match with the peer as winner', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    say(relay, b, { type: 'concede' });
    expect(a.last()).toEqual({ type: 'match_end', reason: 'concession', winner: 0 });
    expect(b.last()).toEqual({ type: 'match_end', reason: 'concession', winner: 0 });
  });

  it('mid-match disconnect forfeits to the survivor, preserving indices', () => {
    const relay = new RelayServer();
    const [a, b] = startedMatch(relay);
    relay.disconnect(a); // player 0 drops
    const end = b.sent.find((m) => m.type === 'match_end');
    expect(end).toEqual({ type: 'match_end', reason: 'disconnect', winner: 1 });
    expect(b.sent.find((m) => m.type === 'peer_left')).toEqual({
      type: 'peer_left',
      name: 'alice',
    });
  });

  it('survivor can host a rematch room lifecycle after a disconnect', () => {
    const relay = new RelayServer();
    const [a, b, code] = startedMatch(relay);
    relay.disconnect(a);
    // Room still exists with bob; a new player can join and play.
    const c = client(relay, 'carol');
    say(relay, c, { type: 'join_room', code });
    expect(c.last()).toEqual({ type: 'room_joined', code, players: ['bob', 'carol'] });
    say(relay, b, { type: 'ready' });
    say(relay, c, { type: 'ready' });
    expect(c.sent.find((m) => m.type === 'match_start')).toBeTruthy();
  });
});
