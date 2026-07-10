import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  encodeMessage,
  decodeServerMessage,
  isRoomCode,
  isSessionToken,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { RelayServer, type ClientConnection } from './relay.js';
import { MemoryStore } from './store.js';

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
  /** Last message of a given type, asserted to exist. */
  lastOf<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    for (let i = this.sent.length; i--;) {
      if (this.sent[i]!.type === type) return this.sent[i] as Extract<ServerMessage, { type: T }>;
    }
    throw new Error(`no ${type} was sent`);
  }
  /** All messages of a given type. */
  allOf<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
  /** Drop recorded traffic (focus a test on what follows). */
  clear(): void {
    this.sent.length = 0;
  }
}

/** Deterministic entropy for reproducible seeds/codes/tokens. */
function fixedEntropy(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

async function say(relay: RelayServer, conn: FakeConn, msg: ClientMessage): Promise<void> {
  await relay.message(conn, encodeMessage(msg));
}

async function client(relay: RelayServer, name: string, token?: string): Promise<FakeConn> {
  const conn = new FakeConn();
  relay.connect(conn);
  await say(relay, conn, {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    name,
    ...(token !== undefined ? { token } : {}),
  });
  expect(conn.lastOf('welcome')).toBeTruthy();
  return conn;
}

async function createRoom(relay: RelayServer, host: FakeConn): Promise<string> {
  await say(relay, host, { type: 'create_room' });
  return host.lastOf('room_created').code;
}

/** Two players helloed, in a room, match started. */
async function startedMatch(relay: RelayServer): Promise<[FakeConn, FakeConn, string]> {
  const a = await client(relay, 'alice');
  const b = await client(relay, 'bob');
  const code = await createRoom(relay, a);
  await say(relay, b, { type: 'join_room', code });
  await say(relay, a, { type: 'ready' });
  await say(relay, b, { type: 'ready' });
  expect(a.lastOf('match_start')).toBeTruthy();
  a.clear();
  b.clear();
  return [a, b, code];
}

describe('handshake + identity', () => {
  it('welcomes with a minted token, name, zero record, and a room list', async () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    await say(relay, conn, { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha' });
    const welcome = conn.lastOf('welcome');
    expect(isSessionToken(welcome.token)).toBe(true);
    expect(welcome.name).toBe('misha');
    expect(welcome.record).toEqual({ wins: 0, losses: 0 });
    expect(conn.lastOf('room_list').rooms).toEqual([]);
  });

  it('reclaims identity by token and keeps the record', async () => {
    const store = new MemoryStore();
    const relay = new RelayServer({ store });
    const first = await client(relay, 'misha');
    const token = first.lastOf('welcome').token;
    relay.disconnect(first);

    const again = await client(relay, 'misha2', token);
    const welcome = again.lastOf('welcome');
    expect(welcome.token).toBe(token);
    expect(welcome.name).toBe('misha2');
  });

  it('mints a fresh identity for an unknown token', async () => {
    const relay = new RelayServer();
    const conn = await client(relay, 'misha', 'f'.repeat(32));
    expect(conn.lastOf('welcome').token).not.toBe('f'.repeat(32));
  });

  it('rejects a version mismatch and closes', async () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    await say(relay, conn, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION + 1,
      name: 'misha',
    });
    expect(conn.lastOf('error').code).toBe('version_mismatch');
    expect(conn.closed).toBe(true);
  });

  it('requires hello first and rejects a second hello', async () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    await say(relay, conn, { type: 'create_room' });
    expect(conn.lastOf('error').code).toBe('bad_message');

    const c2 = await client(relay, 'misha');
    await say(relay, c2, { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'again' });
    expect(c2.lastOf('error').code).toBe('bad_message');
  });

  it('rejects malformed JSON with bad_message', async () => {
    const relay = new RelayServer();
    const conn = new FakeConn();
    relay.connect(conn);
    await relay.message(conn, 'not json{');
    expect(conn.lastOf('error').code).toBe('bad_message');
  });
});

describe('room flow + lobby list', () => {
  it('creates and joins by code, and broadcasts room_list on changes', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    const b = await client(relay, 'bob');
    const spectator = await client(relay, 'carol');

    const code = await createRoom(relay, a);
    expect(isRoomCode(code)).toBe(true);
    expect(spectator.lastOf('room_list').rooms).toEqual([
      { code, state: 'waiting', players: [{ name: 'alice', record: { wins: 0, losses: 0 } }] },
    ]);

    await say(relay, b, { type: 'join_room', code });
    expect(b.lastOf('room_joined')).toEqual({
      type: 'room_joined',
      code,
      players: ['alice', 'bob'],
    });
    expect(a.lastOf('peer_joined').name).toBe('bob');
    expect(spectator.lastOf('room_list').rooms[0]!.players).toHaveLength(2);

    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    expect(spectator.lastOf('room_list').rooms[0]!.state).toBe('playing');
  });

  it('reports unknown and full rooms', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    await say(relay, a, { type: 'join_room', code: 'AAAAA' });
    expect(a.lastOf('error').code).toBe('room_not_found');

    const host = await client(relay, 'host');
    const b = await client(relay, 'bob');
    const c = await client(relay, 'carol');
    const code = await createRoom(relay, host);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, c, { type: 'join_room', code });
    expect(c.lastOf('error').code).toBe('room_full');
  });

  it('deletes an empty room and notifies a waiting peer on leave', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'leave_room' });
    expect(b.lastOf('peer_left').name).toBe('alice');
    await say(relay, b, { type: 'leave_room' });
    expect(relay.roomCount).toBe(0);
    expect(b.lastOf('room_list').rooms).toEqual([]);
  });
});

describe('match start', () => {
  it('starts when both are ready, with a shared uint32 seed and distinct indices', async () => {
    const relay = new RelayServer({ entropy: fixedEntropy(0.25, 0.5, 0.75), inputDelay: 4 });
    const a = await client(relay, 'alice');
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    expect(a.allOf('match_start')).toHaveLength(0);
    await say(relay, b, { type: 'ready' });

    const startA = a.lastOf('match_start');
    const startB = b.lastOf('match_start');
    expect(startA.seed).toBe(startB.seed);
    expect(Number.isInteger(startA.seed)).toBe(true);
    expect(startA.playerIndex).toBe(0);
    expect(startB.playerIndex).toBe(1);
    expect(startA.inputDelay).toBe(4);
    expect(startA.players).toEqual(['alice', 'bob']);
  });

  it('rematch: ready during play restarts', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    expect(a.allOf('match_start')).toHaveLength(1);
    expect(b.allOf('match_start')).toHaveLength(1);
  });
});

describe('input relay', () => {
  it('relays contiguous batches with the sender index', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'inputs', startTick: 0, frames: [0, 1, 2] });
    expect(b.lastOf('peer_inputs')).toEqual({
      type: 'peer_inputs',
      playerIndex: 0,
      startTick: 0,
      frames: [0, 1, 2],
    });
    await say(relay, a, { type: 'inputs', startTick: 3, frames: [8] });
    expect(b.lastOf('peer_inputs').startTick).toBe(3);
  });

  it('treats a contiguity violation as fatal', async () => {
    const relay = new RelayServer();
    const [a] = await startedMatch(relay);
    await say(relay, a, { type: 'inputs', startTick: 0, frames: [0] });
    await say(relay, a, { type: 'inputs', startTick: 5, frames: [0] });
    expect(a.lastOf('error').code).toBe('bad_message');
    expect(a.closed).toBe(true);
  });
});

describe('digest comparison', () => {
  it('broadcasts desync and voids the match on mismatch', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'digest', tick: 64, digests: [111, 222] });
    await say(relay, b, { type: 'digest', tick: 64, digests: [111, 999] });
    expect(a.lastOf('desync').tick).toBe(64);
    expect(b.lastOf('match_end')).toEqual({
      type: 'match_end',
      reason: 'desync',
      winner: null,
    });
  });

  it('stays quiet on matching digests, in any order across ticks', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'digest', tick: 32, digests: [1, 1] });
    await say(relay, a, { type: 'digest', tick: 64, digests: [2, 2] });
    await say(relay, b, { type: 'digest', tick: 64, digests: [2, 2] });
    await say(relay, b, { type: 'digest', tick: 32, digests: [1, 1] });
    expect(a.allOf('desync')).toHaveLength(0);
  });
});

describe('results + records', () => {
  it('records an agreed decisive result and ends the match', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'result', winner: 0 });
    expect(a.allOf('match_end')).toHaveLength(0); // waiting for the peer
    await say(relay, b, { type: 'result', winner: 0 });
    expect(a.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'result', winner: 0 });
    const rooms = a.lastOf('room_list').rooms;
    expect(rooms[0]!.state).toBe('waiting');
    expect(rooms[0]!.players).toEqual([
      { name: 'alice', record: { wins: 1, losses: 0 } },
      { name: 'bob', record: { wins: 0, losses: 1 } },
    ]);
  });

  it('does not record a draw', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'result', winner: null });
    await say(relay, b, { type: 'result', winner: null });
    expect(a.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'result', winner: null });
    expect(a.lastOf('room_list').rooms[0]!.players[0]!.record).toEqual({ wins: 0, losses: 0 });
  });

  it('treats disagreeing results as a desync', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 1 });
    expect(a.lastOf('match_end').reason).toBe('desync');
  });

  it('records a concession as a decisive result', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, b, { type: 'concede' });
    expect(a.lastOf('match_end')).toEqual({
      type: 'match_end',
      reason: 'concession',
      winner: 0,
    });
    expect(a.lastOf('room_list').rooms[0]!.players).toEqual([
      { name: 'alice', record: { wins: 1, losses: 0 } },
      { name: 'bob', record: { wins: 0, losses: 1 } },
    ]);
  });

  it('persists records across sessions via the store', async () => {
    const store = new MemoryStore();
    const relay = new RelayServer({ store });
    const a = await client(relay, 'alice');
    const tokenA = a.lastOf('welcome').token;
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    await say(relay, b, { type: 'concede' });
    relay.disconnect(a);

    // A later session with alice's token sees the recorded win.
    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.lastOf('welcome').record).toEqual({ wins: 1, losses: 0 });
  });
});

describe('reconnect grace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function droppedMidMatch(
    relay: RelayServer,
  ): Promise<{ a: FakeConn; b: FakeConn; tokenA: string; code: string }> {
    const a = await client(relay, 'alice');
    const tokenA = a.lastOf('welcome').token;
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    // Some traffic so the resume histories are non-trivial.
    await say(relay, a, { type: 'inputs', startTick: 0, frames: [0, 16, 0] });
    await say(relay, b, { type: 'inputs', startTick: 0, frames: [0, 0] });
    b.clear();
    relay.disconnect(a);
    return { a, b, tokenA, code };
  }

  it('holds the match and notifies the survivor on a mid-match drop', async () => {
    const relay = new RelayServer();
    const { b } = await droppedMidMatch(relay);
    const dropped = b.lastOf('peer_dropped');
    expect(dropped.name).toBe('alice');
    expect(dropped.graceMs).toBe(DEFAULT_RECONNECT_GRACE_MS);
    expect(b.allOf('match_end')).toHaveLength(0);
  });

  it('resumes on rejoin: histories, indices, and live traffic', async () => {
    const relay = new RelayServer();
    const { b, tokenA } = await droppedMidMatch(relay);

    // Survivor keeps sending while the opponent is gone; it lands in the ledger.
    await say(relay, b, { type: 'inputs', startTick: 2, frames: [4] });

    const a2 = await client(relay, 'alice', tokenA);
    const resume = a2.lastOf('match_resume');
    expect(resume.playerIndex).toBe(0);
    expect(resume.players).toEqual(['alice', 'bob']);
    expect(resume.frames).toEqual([
      [0, 16, 0],
      [0, 0, 4],
    ]);
    expect(b.lastOf('peer_rejoined').name).toBe('alice');

    // Live relay resumes in both directions.
    await say(relay, a2, { type: 'inputs', startTick: 3, frames: [2] });
    expect(b.lastOf('peer_inputs')).toEqual({
      type: 'peer_inputs',
      playerIndex: 0,
      startTick: 3,
      frames: [2],
    });
    await say(relay, b, { type: 'inputs', startTick: 3, frames: [1] });
    expect(a2.lastOf('peer_inputs').frames).toEqual([1]);
  });

  it('ignores replayed digests at or below the resume frontier', async () => {
    const relay = new RelayServer();
    const { b, tokenA } = await droppedMidMatch(relay);
    // Survivor had submitted a digest for tick 2 before the drop... simulate
    // the pre-drop matched-and-discarded case: b submits now (pending).
    await say(relay, b, { type: 'digest', tick: 2, digests: [7, 7] });

    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.lastOf('match_resume')).toBeTruthy();
    // a2 replays and resubmits tick 2 with DIFFERENT values than b's pending
    // (impossible for honest clients, but proves the floor drops it).
    await say(relay, a2, { type: 'digest', tick: 2, digests: [9, 9] });
    expect(a2.allOf('desync')).toHaveLength(0);
    expect(b.allOf('desync')).toHaveLength(0);
    // Post-frontier digests compare normally again.
    await say(relay, a2, { type: 'digest', tick: 32, digests: [5, 5] });
    await say(relay, b, { type: 'digest', tick: 32, digests: [5, 6] });
    expect(b.lastOf('desync').tick).toBe(32);
  });

  it('forfeits to the survivor when grace expires, recording the result', async () => {
    const relay = new RelayServer();
    const { b } = await droppedMidMatch(relay);
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_GRACE_MS + 1);
    expect(b.lastOf('match_end')).toEqual({
      type: 'match_end',
      reason: 'disconnect',
      winner: 1,
    });
    expect(b.lastOf('peer_left').name).toBe('alice');
    expect(b.lastOf('room_list').rooms[0]!.players).toEqual([
      { name: 'bob', record: { wins: 1, losses: 0 } },
    ]);
  });

  it('ending the match during grace cancels the timer and evicts the dropped seat', async () => {
    // Regression: a concede while the opponent was in grace left the timer
    // armed; it later fired against the already-ended match and recorded the
    // forfeit a second time.
    const relay = new RelayServer();
    const { b, tokenA } = await droppedMidMatch(relay);
    await say(relay, b, { type: 'concede' });
    // Conceding forfeits to the dropped player; the dead seat is evicted.
    expect(b.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'concession', winner: 0 });
    expect(b.lastOf('peer_left').name).toBe('alice');
    const endsBefore = b.allOf('match_end').length;

    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_GRACE_MS * 2);
    // The grace timer must not fire: no second match_end, no double record.
    expect(b.allOf('match_end')).toHaveLength(endsBefore);
    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.allOf('match_resume')).toHaveLength(0); // nothing to rejoin
    expect(a2.lastOf('welcome').record).toEqual({ wins: 1, losses: 0 }); // once
  });

  it('a rejoin after expiry lands in the lobby, not the dead match', async () => {
    const relay = new RelayServer();
    const { tokenA } = await droppedMidMatch(relay);
    await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_GRACE_MS + 1);
    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.allOf('match_resume')).toHaveLength(0);
    const welcome = a2.lastOf('welcome');
    expect(welcome.record).toEqual({ wins: 0, losses: 1 }); // the forfeit stuck
  });
});
