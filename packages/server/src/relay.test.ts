import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CC_ADVANCE, GC_STEPS_PER_SECOND, NetMatch } from '@crack-attack/core';
import {
  DEFAULT_INPUT_DELAY_TICKS,
  DEFAULT_RECONNECT_GRACE_MS,
  MAX_INPUT_FRAMES_PER_MESSAGE,
  MAX_MATCH_FRAMES,
  PROTOCOL_VERSION,
  encodeMessage,
  decodeServerMessage,
  isRoomCode,
  isSessionToken,
  type ClientMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { MAX_INPUT_LEAD_TICKS, RelayServer, type ClientConnection } from './relay.js';
import { MemoryAccountStore, type NewRatedGame } from './accountStore.js';
import { secretHash } from './accounts.js';
import { MemoryStore } from './store.js';
import { Verifier } from './verifier.js';

/** A store whose result writes fail, like a SQLITE_BUSY or closed-DB backend. */
class FailingRecordStore extends MemoryStore {
  override recordResult(): Promise<void> {
    return Promise.reject(new Error('SQLITE_BUSY: database is locked'));
  }
}

/** `n` neutral input frames. */
function neutral(n: number): number[] {
  return new Array<number>(n).fill(0);
}

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

/** Get a started match past its countdown: a concession is refused before. */
async function beginPlay(relay: RelayServer, ...conns: FakeConn[]): Promise<void> {
  for (const conn of conns) {
    await say(relay, conn, {
      type: 'inputs',
      startTick: 0,
      frames: neutral(DEFAULT_INPUT_DELAY_TICKS + 1),
    });
  }
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
      {
        code,
        state: 'waiting',
        rated: false,
        players: [{ name: 'alice', record: { wins: 0, losses: 0 }, rating: null }],
        spectators: [],
      },
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

  it('treats a batch pushing the ledger past MAX_MATCH_FRAMES as fatal', async () => {
    let ms = 0;
    const relay = new RelayServer({ now: () => ms });
    const [a, b] = await startedMatch(relay);
    ms = 1e12; // far in the future, so pacing never binds: isolate the cap
    const batch = neutral(MAX_INPUT_FRAMES_PER_MESSAGE);
    for (let t = 0; t < MAX_MATCH_FRAMES; t += batch.length) {
      await say(relay, a, { type: 'inputs', startTick: t, frames: batch });
      b.clear();
    }
    expect(a.closed).toBe(false); // exactly at the cap is fine
    await say(relay, a, { type: 'inputs', startTick: MAX_MATCH_FRAMES, frames: [0] });
    expect(a.lastOf('error').code).toBe('bad_message');
    expect(a.closed).toBe(true);
    expect(b.allOf('peer_inputs')).toHaveLength(0); // rejected, not relayed
  });

  it('treats inputs running ahead of real time as fatal', async () => {
    let ms = 0;
    const relay = new RelayServer({ now: () => ms });
    const [a, b] = await startedMatch(relay);
    // At match start, the inputDelay pre-fill plus the lead allowance is fine...
    const lead = DEFAULT_INPUT_DELAY_TICKS + MAX_INPUT_LEAD_TICKS;
    await say(relay, a, { type: 'inputs', startTick: 0, frames: neutral(lead) });
    // ...as is another second's worth once a second has passed...
    ms += 1000;
    await say(relay, a, {
      type: 'inputs',
      startTick: lead,
      frames: neutral(GC_STEPS_PER_SECOND),
    });
    expect(a.closed).toBe(false);
    b.clear();
    // ...but a single frame beyond that is not.
    await say(relay, a, { type: 'inputs', startTick: lead + GC_STEPS_PER_SECOND, frames: [0] });
    expect(a.lastOf('error').code).toBe('bad_message');
    expect(a.closed).toBe(true);
    expect(b.allOf('peer_inputs')).toHaveLength(0);
  });

  it('accepts real-time pacing across a drop and resume, and in vs-AI rooms', async () => {
    let ms = 0;
    const relay = new RelayServer({ now: () => ms, graceMs: 60_000 });
    const a = await client(relay, 'alice');
    const tokenA = a.lastOf('welcome').token;
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });

    // Like a client: inputDelay neutral frames up front, then one batch per
    // render frame at 50 Hz (5 ticks per 100 ms here).
    const frontier = new Map<FakeConn, number>();
    const send = async (conn: FakeConn, n: number): Promise<void> => {
      const t = frontier.get(conn) ?? 0;
      await say(relay, conn, { type: 'inputs', startTick: t, frames: neutral(n) });
      frontier.set(conn, t + n);
    };
    /** `seconds` of real-time play by `players`, sharing one clock. */
    const play = async (seconds: number, ...players: FakeConn[]): Promise<void> => {
      for (let i = 0; i < seconds * 10; i++) {
        ms += 100;
        for (const p of players) await send(p, 5);
      }
    };
    await send(a, DEFAULT_INPUT_DELAY_TICKS);
    await send(b, DEFAULT_INPUT_DELAY_TICKS);
    await play(10, a, b);

    // Alice drops for 20 s (bob stalls in lockstep), then rejoins: the server
    // checks its own ledger frontier, so her live input continues unhindered.
    relay.disconnect(a);
    ms += 20_000;
    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.lastOf('match_resume').frames[0]).toHaveLength(frontier.get(a)!);
    frontier.set(a2, frontier.get(a)!);
    await play(10, a2, b);
    for (const conn of [a2, b]) {
      expect(conn.allOf('error')).toEqual([]);
      expect(conn.closed).toBe(false);
    }

    // vs-AI: the bot's stream never crosses the wire; the human's is paced alone.
    const c = await client(relay, 'carol');
    await say(relay, c, { type: 'create_room', aiOpponent: { difficulty: 'easy' } });
    await say(relay, c, { type: 'ready' });
    await send(c, DEFAULT_INPUT_DELAY_TICKS);
    await play(10, c);
    expect(c.allOf('error')).toEqual([]);
    expect(c.closed).toBe(false);
    relay.shutdown();
  });
});

describe('digest comparison', () => {
  it('broadcasts desync and voids the match on mismatch', async () => {
    const relay = new RelayServer({ log: () => {} });
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
      { name: 'alice', record: { wins: 1, losses: 0 }, rating: null },
      { name: 'bob', record: { wins: 0, losses: 1 }, rating: null },
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
    const relay = new RelayServer({ log: () => {} });
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 1 });
    expect(a.lastOf('match_end').reason).toBe('desync');
  });

  it('records a concession as a decisive result', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, b, { type: 'concede' });
    expect(b.lastOf('error')).toMatchObject({
      code: 'bad_message',
      message: "the game hasn't started",
    });
    await beginPlay(relay, a, b);
    await say(relay, b, { type: 'concede' });
    expect(a.lastOf('match_end')).toEqual({
      type: 'match_end',
      reason: 'concession',
      winner: 0,
    });
    expect(a.lastOf('room_list').rooms[0]!.players).toEqual([
      { name: 'alice', record: { wins: 1, losses: 0 }, rating: null },
      { name: 'bob', record: { wins: 0, losses: 1 }, rating: null },
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
    await beginPlay(relay, a, b);
    await say(relay, b, { type: 'concede' });
    relay.disconnect(a);

    // A later session with alice's token sees the recorded win.
    const a2 = await client(relay, 'alice', tokenA);
    expect(a2.lastOf('welcome').record).toEqual({ wins: 1, losses: 0 });
  });
});

describe('background store failures', () => {
  it('logs (not swallows) a failed forfeit write on a mid-match leave', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const relay = new RelayServer({ store: new FailingRecordStore() });
      const [a, b] = await startedMatch(relay);
      await say(relay, a, { type: 'leave_room' });
      expect(b.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'disconnect', winner: 1 });
      await relay.idle(); // the forfeit is settled by replay, then written
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('failed to settle a game'),
        expect.any(Error),
      );
    } finally {
      errors.mockRestore();
    }
  });
});

/**
 * A real game: seat 0 idles while seat 1 raises its stack every tick, so
 * seat 1 tops out first. Returns both ledgers, to the losing tick, and the
 * tick. Any prefix of it is a game still in play.
 */
function decidedGame(seed: number): { ledgers: [number[], number[]]; tick: number } {
  const match = new NetMatch(seed);
  let ended = null;
  while (!ended) ended = match.step(0, CC_ADVANCE);
  expect(ended.winner).toBe(0);
  return {
    ledgers: [neutral(ended.tick), new Array<number>(ended.tick).fill(CC_ADVANCE)],
    tick: ended.tick,
  };
}

/** Both digests after playing `ticks` ticks of `ledgers`. */
function digestsAt(seed: number, ledgers: [number[], number[]], ticks: number): [number, number] {
  const match = new NetMatch(seed);
  for (let t = 0; t < ticks; t++) match.step(ledgers[0][t]!, ledgers[1][t]!);
  return [match.sims[0].digest(), match.sims[1].digest()];
}

/** Send each seat's ledger through the relay, in protocol-sized batches. */
async function sendLedgers(
  relay: RelayServer,
  conns: [FakeConn, FakeConn],
  ledgers: [number[], number[]],
): Promise<void> {
  for (let i = 0; i < 2; i++) {
    const frames = ledgers[i]!;
    for (let t = 0; t < frames.length; t += MAX_INPUT_FRAMES_PER_MESSAGE) {
      const batch = frames.slice(t, t + MAX_INPUT_FRAMES_PER_MESSAGE);
      await say(relay, conns[i]!, { type: 'inputs', startTick: t, frames: batch });
    }
  }
}

describe('disputes', () => {
  /**
   * A started match whose players are alice (seat 0) and bob (seat 1), with a
   * clock far enough ahead that a whole game's input is within pacing.
   */
  async function setup() {
    let ms = 0;
    const store = new MemoryStore();
    const verifier = new Verifier();
    const log: string[] = [];
    const relay = new RelayServer({
      store,
      verifier,
      now: () => ms,
      log: (line) => log.push(line),
      entropy: fixedEntropy(0.25, 0.5, 0.75),
    });
    const a = await client(relay, 'alice');
    const b = await client(relay, 'bob');
    const tokens = [a.lastOf('welcome').token, b.lastOf('welcome').token] as const;
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    const seed = a.lastOf('match_start').seed;
    ms = 1e9;
    /** Alice's and bob's W-L records, from the store. */
    const records = async () => [
      (await store.getPlayer(tokens[0], 'alice'))!.record,
      (await store.getPlayer(tokens[1], 'bob'))!.record,
    ];
    return { relay, verifier, log, a, b, seed, records };
  }

  it('records the real result when the loser reports a win', async () => {
    const { relay, verifier, log, a, b, seed, records } = await setup();
    const game = decidedGame(seed);
    await sendLedgers(relay, [a, b], game.ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 1 });
    expect(a.lastOf('match_end').reason).toBe('desync');
    a.clear();

    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(/disputed results 0\/1 .*winner 0; seat 0 wins/);
    expect(await records()).toEqual([
      { wins: 1, losses: 0 },
      { wins: 0, losses: 1 },
    ]);
    // The lobby sees the new records.
    expect(a.lastOf('room_list').rooms[0]!.players).toEqual([
      { name: 'alice', record: { wins: 1, losses: 0 }, rating: null },
      { name: 'bob', record: { wins: 0, losses: 1 }, rating: null },
    ]);
  });

  it('records nothing when the ledgers stop before the game ends', async () => {
    const { relay, verifier, log, a, b, seed, records } = await setup();
    const game = decidedGame(seed);
    const short: [number[], number[]] = [
      game.ledgers[0].slice(0, 100),
      game.ledgers[1].slice(0, 100),
    ];
    await sendLedgers(relay, [a, b], short);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 1 });
    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(/in play at tick 100; not recorded/);
    expect(await records()).toEqual([
      { wins: 0, losses: 0 },
      { wins: 0, losses: 0 },
    ]);
  });

  it('records nothing when the replay agrees with neither report', async () => {
    const { relay, verifier, log, a, b, seed, records } = await setup();
    await sendLedgers(relay, [a, b], decidedGame(seed).ledgers);
    await say(relay, a, { type: 'result', winner: 1 });
    await say(relay, b, { type: 'result', winner: null });
    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(/winner 0; not recorded/);
    expect((await records())[0]).toEqual({ wins: 0, losses: 0 });
  });

  it.each([
    ['bob', 1, 0],
    ['alice', 0, 1],
  ])('gives the loss to a seat whose digests are false (%s)', async (_name, liar, honest) => {
    const { relay, verifier, log, a, b, seed, records } = await setup();
    const game = decidedGame(seed);
    const ledgers: [number[], number[]] = [
      game.ledgers[0].slice(0, 96),
      game.ledgers[1].slice(0, 96),
    ];
    await sendLedgers(relay, [a, b], ledgers);
    const truth = digestsAt(seed, ledgers, 64);
    const conns = [a, b];
    await say(relay, conns[honest]!, { type: 'digest', tick: 64, digests: truth });
    await say(relay, conns[liar]!, { type: 'digest', tick: 64, digests: [truth[0], truth[1] ^ 1] });
    expect(a.lastOf('desync').tick).toBe(64);

    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(
      new RegExp(`digests at tick 64 .*in play at tick 64; seat ${honest} wins`),
    );
    const recs = await records();
    expect(recs[honest]).toEqual({ wins: 1, losses: 0 });
    expect(recs[liar]).toEqual({ wins: 0, losses: 1 });
  });

  it("records nothing when neither seat's digests are true", async () => {
    const { relay, verifier, log, a, b, records } = await setup();
    const ledgers: [number[], number[]] = [neutral(96), neutral(96)];
    await sendLedgers(relay, [a, b], ledgers);
    await say(relay, a, { type: 'digest', tick: 64, digests: [1, 2] });
    await say(relay, b, { type: 'digest', tick: 64, digests: [3, 4] });
    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(/not recorded/);
    expect(await records()).toEqual([
      { wins: 0, losses: 0 },
      { wins: 0, losses: 0 },
    ]);
  });

  it('records the result of a game that ended before a disputed digest', async () => {
    const { relay, verifier, log, a, b, seed, records } = await setup();
    const game = decidedGame(seed);
    await sendLedgers(relay, [a, b], game.ledgers);
    const tick = Math.ceil(game.tick / 32) * 32;
    await say(relay, a, { type: 'digest', tick, digests: [1, 2] });
    await say(relay, b, { type: 'digest', tick, digests: [3, 4] });
    await verifier.idle();
    await vi.waitFor(() => expect(log).toHaveLength(1));
    expect(log[0]).toMatch(new RegExp(`ended on tick ${game.tick}, winner 0; seat 0 wins`));
    expect((await records())[0]).toEqual({ wins: 1, losses: 0 });
  });
});

describe('rated games', () => {
  const T0 = Date.UTC(2026, 8, 27, 12);
  const DAY = 24 * 60 * 60 * 1000;

  /**
   * A relay with accounts: Alice (id 1) and Bob (id 2) logged in by session,
   * plus a guest, Carol. `start` seats Alice and Bob in a rated room and starts
   * a match; `play` sends a whole game's inputs.
   */
  async function setup(options: { stallMs?: number } = {}) {
    let ms = 0;
    let wall = T0;
    const store = new MemoryAccountStore();
    const log: string[] = [];
    const relay = new RelayServer({
      store,
      accounts: store,
      now: () => ms,
      wallClock: () => wall,
      log: (line) => log.push(line),
      ...options,
    });
    const login = async (n: number, handle: string): Promise<FakeConn> => {
      const session = n.toString(16).padStart(32, '0');
      await store.createAccount({
        handle,
        handleFolded: handle.toLowerCase(),
        keyHash: `key${n}`,
        sessionHash: secretHash(session),
        createdAt: T0,
      });
      return client(relay, 'ignored', session);
    };
    const a = await login(1, 'Alice');
    const b = await login(2, 'Bob');
    const guest = await client(relay, 'carol');
    let code = '';
    /** Seat Alice and Bob in a rated room (the first time) and start a match; returns its seed. */
    const start = async (): Promise<number> => {
      if (code === '') {
        await say(relay, a, { type: 'create_room', rated: true });
        code = a.lastOf('room_created').code;
        await say(relay, b, { type: 'join_room', code });
      }
      await say(relay, a, { type: 'ready' });
      await say(relay, b, { type: 'ready' });
      ms += 1e9; // a whole game's input is within pacing
      return a.lastOf('match_start').seed;
    };
    const play = (ledgers: [number[], number[]]) => sendLedgers(relay, [a, b], ledgers);
    const nextDay = () => (wall += DAY);
    /** Let the relay's clock run on by `by` ms. */
    const later = (by: number) => (ms += by);
    return { relay, store, log, a, b, guest, start, play, nextDay, later, code: () => code };
  }

  it('lets an account play under its handle and rating', async () => {
    const { a, relay } = await setup();
    expect(a.lastOf('welcome')).toMatchObject({
      name: 'Alice',
      record: { wins: 0, losses: 0 },
      rating: { rating: 1500, provisional: true },
    });
    await say(relay, a, { type: 'rename', name: 'Alicia' });
    expect(a.lastOf('error').code).toBe('bad_message');
  });

  it('seats only accounts in a rated room, never twice the same, never with a bot', async () => {
    const { relay, a, b, guest } = await setup();
    await say(relay, guest, { type: 'create_room', rated: true });
    expect(guest.lastOf('error').code).toBe('account_required');
    await say(relay, a, { type: 'create_room', rated: true, aiOpponent: { difficulty: 'easy' } });
    expect(a.lastOf('error').code).toBe('bad_message');

    await say(relay, a, { type: 'create_room', rated: true });
    const room = a.lastOf('room_created').code;
    await say(relay, guest, { type: 'join_room', code: room });
    expect(guest.lastOf('error').code).toBe('account_required');
    const aliceAgain = await client(relay, 'x', (1).toString(16).padStart(32, '0'));
    await say(relay, aliceAgain, { type: 'join_room', code: room });
    expect(aliceAgain.lastOf('error').code).toBe('bad_message');
    // Anyone may watch.
    await say(relay, guest, { type: 'spectate', code: room });
    expect(guest.lastOf('spectate_joined').code).toBe(room);

    await say(relay, b, { type: 'join_room', code: room });
    expect(guest.lastOf('room_list').rooms[0]).toMatchObject({
      rated: true,
      players: [
        { name: 'Alice', rating: { rating: 1500, provisional: true } },
        { name: 'Bob', rating: { rating: 1500, provisional: true } },
      ],
    });
  });

  it('rates a played-out game once the replay confirms the result', async () => {
    const { relay, store, a, b, guest, start, play, code } = await setup();
    const seed = await start();
    expect(a.lastOf('match_start').rated).toBe(true);
    await say(relay, guest, { type: 'spectate', code: code() });
    expect(guest.lastOf('spectate_start').rated).toBe(true);
    const game = decidedGame(seed);
    await play(game.ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 0 });
    expect(a.lastOf('match_end')).toMatchObject({ reason: 'result', winner: 0 });

    await relay.idle();
    const update = a.lastOf('rating_update');
    expect(update.players).toEqual(['Alice', 'Bob']);
    expect(update.ratings[0].before).toEqual({ rating: 1500, provisional: true });
    expect(update.ratings[0].after.rating).toBeGreaterThan(1500);
    expect(update.ratings[1].after.rating).toBeLessThan(1500);
    expect(b.lastOf('rating_update')).toEqual(update);
    expect(guest.lastOf('rating_update')).toEqual(update);

    expect(await store.accountById(1)).toMatchObject({ wins: 1, losses: 0, ratedAt: T0 });
    expect(await store.accountById(2)).toMatchObject({ wins: 0, losses: 1 });
    const [logged] = await store.ratedGames(1, 1);
    expect(logged).toMatchObject({ result: 'a', end: 'result', ticks: game.tick });
    expect(JSON.parse(store.gameInputs(logged!.id)!)).toMatchObject({
      version: 1,
      ticks: [game.tick, game.tick],
      inputs: [[], [[1, CC_ADVANCE]]],
    });
    expect(a.lastOf('room_list').rooms[0]!.players).toEqual([
      { name: 'Alice', record: { wins: 1, losses: 0 }, rating: update.ratings[0].after },
      { name: 'Bob', record: { wins: 0, losses: 1 }, rating: update.ratings[1].after },
    ]);
  });

  it("doesn't rate a game the replay contradicts", async () => {
    const { relay, store, log, a, b, start, play } = await setup();
    await play(decidedGame(await start()).ledgers);
    await say(relay, a, { type: 'result', winner: 1 });
    await say(relay, b, { type: 'result', winner: 1 });
    await relay.idle();
    expect(a.allOf('rating_update')).toEqual([]);
    expect(log).toEqual([expect.stringMatching(/unsettled results 1\/1 .*winner 0; not rated/)]);
    expect(await store.ratedGames(1, 10)).toEqual([]);
  });

  it('rates the real result of a disputed game', async () => {
    const { relay, store, a, b, start, play } = await setup();
    await play(decidedGame(await start()).ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 1 });
    expect(a.lastOf('match_end').reason).toBe('desync');
    await relay.idle();
    expect(a.lastOf('rating_update').ratings[0].after.rating).toBeGreaterThan(1500);
    expect(await store.accountById(2)).toMatchObject({ losses: 1 });
  });

  it.each([
    ['a concession', 'concede', 'concession'],
    ['leaving mid-match', 'leave_room', 'disconnect'],
  ] as const)('rates %s as a loss at once', async (_what, type, end) => {
    const { relay, store, a, b, start, play } = await setup();
    const game = decidedGame(await start());
    await play([game.ledgers[0].slice(0, 100), game.ledgers[1].slice(0, 100)]);
    await say(relay, b, { type });
    await relay.idle();
    expect(a.lastOf('rating_update').ratings[1].after.rating).toBeLessThan(1500);
    expect((await store.ratedGames(2, 1))[0]).toMatchObject({ result: 'a', end, ticks: 100 });
  });

  it('rates a same-tick double loss as a draw', async () => {
    const { relay, store, a, b, start, play } = await setup();
    const seed = await start();
    const match = new NetMatch(seed);
    let ended = null;
    while (!ended) ended = match.step(CC_ADVANCE, CC_ADVANCE);
    expect(ended.winner).toBeNull();
    const frames = new Array<number>(ended.tick).fill(CC_ADVANCE);
    await play([frames, frames]);
    await say(relay, a, { type: 'result', winner: null });
    await say(relay, b, { type: 'result', winner: null });
    await relay.idle();
    const update = a.lastOf('rating_update');
    expect(update.ratings.map((r) => r.after.rating)).toEqual([1500, 1500]);
    expect(await store.accountById(1)).toMatchObject({ wins: 0, losses: 0, draws: 1 });
  });

  it('rates a game a rematch cut short, as far as it went', async () => {
    const { relay, store, a, b, start, play } = await setup();
    await play(decidedGame(await start()).ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    await start(); // both ready again, Bob's result never sent
    await relay.idle();
    expect((await store.ratedGames(1, 10)).map((g) => g.result)).toEqual(['a']);
    expect(b.lastOf('rating_update').ratings[1].after.rating).toBeLessThan(1500);
  });

  it('plays casual once a pair has had its rated games for the day', async () => {
    const { relay, store, a, start, nextDay } = await setup();
    const played: NewRatedGame = {
      accountA: 2,
      accountB: 1,
      result: 'draw',
      end: 'result',
      ticks: 1,
      seed: 1,
      simVersion: 1,
      aBefore: { rating: 1500, rd: 350 },
      bBefore: { rating: 1500, rd: 350 },
      aAfter: { rating: 1500, rd: 300, volatility: 0.06 },
      bAfter: { rating: 1500, rd: 300, volatility: 0.06 },
      createdAt: T0,
      inputs: null,
    };
    for (let i = 0; i < 10; i++) await store.recordRatedGame(played);
    await start();
    expect(a.lastOf('match_start').rated).toBe(false);
    expect(a.lastOf('room_list').rooms[0]!.rated).toBe(true);
    await beginPlay(relay, a);
    await say(relay, a, { type: 'concede' });
    await relay.idle();
    expect(a.allOf('rating_update')).toEqual([]);
    // Casual: the record counts, the rating doesn't.
    expect(await store.accountById(2)).toMatchObject({ wins: 1, draws: 10 });

    nextDay();
    await start();
    expect(a.lastOf('match_start').rated).toBe(true);
  });

  it('gives the game to its winner when the winner leaves before the loser reports', async () => {
    const { relay, store, a, b, start, play } = await setup();
    await play(decidedGame(await start()).ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    // Bob never reports; Alice, stuck on the result screen, leaves.
    await say(relay, a, { type: 'leave_room' });
    await relay.idle();
    expect((await store.ratedGames(1, 1))[0]).toMatchObject({ result: 'a', end: 'result' });
    expect(b.lastOf('rating_update').ratings[1].after.rating).toBeLessThan(1500);
  });

  describe('watchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('settles a game whose loser never reports the result', async () => {
      const { relay, store, a, b, start, play, later } = await setup({ stallMs: 30_000 });
      await play(decidedGame(await start()).ledgers);
      await say(relay, a, { type: 'result', winner: 0 });
      later(29_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(a.allOf('match_end')).toEqual([]);
      later(2_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(b.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'result', winner: 0 });
      await relay.idle();
      expect((await store.ratedGames(1, 1))[0]).toMatchObject({ result: 'a', end: 'result' });
    });

    it('forfeits a seat that stops sending inputs mid-game', async () => {
      const { relay, store, a, start, play, later } = await setup({ stallMs: 30_000 });
      const game = decidedGame(await start());
      // Bob stops 200 ticks in; Alice runs on to the few ticks lockstep allows.
      await play([game.ledgers[0].slice(0, 203), game.ledgers[1].slice(0, 200)]);
      later(31_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(a.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'disconnect', winner: 0 });
      await relay.idle();
      expect((await store.ratedGames(1, 1))[0]).toMatchObject({ result: 'a', end: 'disconnect' });
    });

    it('leaves a game alone while inputs flow, or when the frontiers are level', async () => {
      const { relay, a, b, start, later } = await setup({ stallMs: 30_000 });
      await start();
      await say(relay, a, { type: 'inputs', startTick: 0, frames: neutral(10) });
      await say(relay, b, { type: 'inputs', startTick: 0, frames: neutral(10) });
      later(31_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(a.allOf('match_end')).toEqual([]);
    });
  });

  it('seats an account once, whichever connection it asks from', async () => {
    const { relay, start } = await setup();
    await start();
    const aliceAgain = await client(relay, 'x', (1).toString(16).padStart(32, '0'));
    await say(relay, aliceAgain, { type: 'create_room', rated: true });
    expect(aliceAgain.lastOf('error').message).toMatch(/already in a room/);
  });

  it('counts a rated game still being settled toward the day', async () => {
    const { relay, store, a, b, start, play } = await setup();
    for (let i = 0; i < 9; i++) {
      await store.recordRatedGame({
        accountA: 1,
        accountB: 2,
        result: 'draw',
        end: 'result',
        ticks: 1,
        seed: 1,
        simVersion: 1,
        aBefore: { rating: 1500, rd: 350 },
        bBefore: { rating: 1500, rd: 350 },
        aAfter: { rating: 1500, rd: 300, volatility: 0.06 },
        bAfter: { rating: 1500, rd: 300, volatility: 0.06 },
        createdAt: T0,
        inputs: null,
      });
    }
    await play(decidedGame(await start()).ledgers);
    expect(a.lastOf('match_start').rated).toBe(true); // the tenth
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, b, { type: 'result', winner: 0 });
    // A rematch before the tenth game's replay is done: it's the eleventh.
    await start();
    expect(a.lastOf('match_start').rated).toBe(false);
    await relay.idle();
    expect(await store.countRatedGames(1, 2, 0)).toBe(10);
  });

  it("doesn't start a rematch with a seat that has dropped", async () => {
    const { relay, a, b, start, play } = await setup();
    await play(decidedGame(await start()).ledgers);
    await say(relay, a, { type: 'result', winner: 0 });
    await say(relay, a, { type: 'ready' });
    relay.disconnect(a); // grace running; Bob never reported
    const starts = b.allOf('match_start').length;
    await say(relay, b, { type: 'ready' });
    expect(b.allOf('match_start')).toHaveLength(starts);
    relay.shutdown();
  });

  it("closes an account's connections when its sessions end", async () => {
    const { relay, a, b, guest } = await setup();
    relay.sessionsEnded({ kind: 'account', accountId: 1, except: null });
    expect(a.closed).toBe(true);
    expect(a.lastOf('error').message).toMatch(/session has ended/);
    expect(b.closed).toBe(false);
    expect(guest.closed).toBe(false);
    relay.sessionsEnded({
      kind: 'session',
      sessionHash: secretHash((2).toString(16).padStart(32, '0')),
    });
    expect(b.closed).toBe(true);
  });

  it("counts casual games toward an account's record", async () => {
    const { relay, store, a, guest } = await setup();
    const code = await createRoom(relay, a);
    await say(relay, guest, { type: 'join_room', code });
    await say(relay, a, { type: 'ready' });
    await say(relay, guest, { type: 'ready' });
    expect(a.lastOf('match_start').rated).toBe(false);
    await beginPlay(relay, guest);
    await say(relay, guest, { type: 'concede' });
    expect(await store.accountById(1)).toMatchObject({ wins: 1, losses: 0 });
    expect(a.lastOf('room_list').rooms[0]!.players[0]).toMatchObject({
      name: 'Alice',
      record: { wins: 1, losses: 0 },
    });
  });
});

describe('rename', () => {
  it('takes effect live: rosters, room list, seat, and persistence', async () => {
    const store = new MemoryStore();
    const relay = new RelayServer({ store });
    const a = await client(relay, 'alice');
    const tokenA = a.lastOf('welcome').token;
    const b = await client(relay, 'bob');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });
    const carol = await client(relay, 'carol');
    await say(relay, carol, { type: 'spectate', code });

    await say(relay, a, { type: 'rename', name: 'alicia' });
    // Everyone's lobby list shows the new name immediately...
    expect(b.lastOf('room_list').rooms[0]!.players[0]!.name).toBe('alicia');
    expect(carol.lastOf('room_list').rooms[0]!.players[0]!.name).toBe('alicia');

    // ...spectator renames update the roster pushes...
    await say(relay, carol, { type: 'rename', name: 'carlotta' });
    expect(a.lastOf('spectators').names).toEqual(['carlotta']);
    expect(b.lastOf('room_list').rooms[0]!.spectators).toEqual(['carlotta']);

    // ...and the change persists in the store across sessions.
    relay.disconnect(a);
    const a2 = await client(relay, 'alicia', tokenA);
    expect(a2.lastOf('welcome').name).toBe('alicia');
  });

  it('a renamed seat carries into the next match_start', async () => {
    const relay = new RelayServer();
    const [a, b] = await startedMatch(relay);
    await say(relay, a, { type: 'rename', name: 'alicia' });
    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    expect(a.lastOf('match_start').players).toEqual(['alicia', 'bob']);
  });
});

describe('spectators', () => {
  it('attaches to a waiting room and gets spectate_start at match start', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    const b = await client(relay, 'bob');
    const carol = await client(relay, 'carol');
    const code = await createRoom(relay, a);
    await say(relay, b, { type: 'join_room', code });

    await say(relay, carol, { type: 'spectate', code });
    expect(carol.lastOf('spectate_joined')).toEqual({
      type: 'spectate_joined',
      code,
      players: ['alice', 'bob'],
      spectators: ['carol'],
    });
    expect(a.lastOf('spectators').names).toEqual(['carol']);
    expect(carol.allOf('spectate_start')).toHaveLength(0); // nothing playing yet
    expect(a.lastOf('room_list').rooms[0]!.spectators).toEqual(['carol']);

    await say(relay, a, { type: 'ready' });
    await say(relay, b, { type: 'ready' });
    const start = carol.lastOf('spectate_start');
    expect(start.players).toEqual(['alice', 'bob']);
    expect(start.frames).toEqual([[], []]);
    expect(start.seed).toBe(a.lastOf('match_start').seed);
  });

  it('joins mid-match with both ledgers and receives both live streams', async () => {
    const relay = new RelayServer();
    const [a, b, code] = await startedMatch(relay);
    await say(relay, a, { type: 'inputs', startTick: 0, frames: [0, 16] });
    await say(relay, b, { type: 'inputs', startTick: 0, frames: [4] });

    const carol = await client(relay, 'carol');
    await say(relay, carol, { type: 'spectate', code });
    const start = carol.lastOf('spectate_start');
    expect(start.frames).toEqual([[0, 16], [4]]);

    await say(relay, a, { type: 'inputs', startTick: 2, frames: [2] });
    await say(relay, b, { type: 'inputs', startTick: 1, frames: [1] });
    const relayed = carol.allOf('peer_inputs');
    expect(relayed).toEqual([
      { type: 'peer_inputs', playerIndex: 0, startTick: 2, frames: [2] },
      { type: 'peer_inputs', playerIndex: 1, startTick: 1, frames: [1] },
    ]);
    // Players still get each other's stream, not their own echoed back.
    expect(b.lastOf('peer_inputs').playerIndex).toBe(0);
  });

  it('cannot spectate and sit at once, and leave_room detaches the watch', async () => {
    const relay = new RelayServer();
    const [, , code] = await startedMatch(relay);
    const carol = await client(relay, 'carol');
    await say(relay, carol, { type: 'spectate', code });
    await say(relay, carol, { type: 'create_room' });
    expect(carol.lastOf('error').code).toBe('bad_message');

    await say(relay, carol, { type: 'leave_room' });
    expect(relay.roomCount).toBe(1);
    await say(relay, carol, { type: 'create_room' });
    expect(carol.lastOf('room_created')).toBeTruthy();
  });

  it('spectators get match lifecycle and room_closed when players leave', async () => {
    const relay = new RelayServer();
    const [a, b, code] = await startedMatch(relay);
    const carol = await client(relay, 'carol');
    await say(relay, carol, { type: 'spectate', code });

    await beginPlay(relay, b);
    await say(relay, b, { type: 'concede' });
    expect(carol.lastOf('match_end')).toEqual({
      type: 'match_end',
      reason: 'concession',
      winner: 0,
    });

    await say(relay, a, { type: 'leave_room' });
    expect(carol.lastOf('peer_left').name).toBe('alice');
    await say(relay, b, { type: 'leave_room' });
    expect(carol.lastOf('room_closed')).toEqual({ type: 'room_closed' });
    expect(relay.roomCount).toBe(0);
    // Detached: carol can host her own room now.
    await say(relay, carol, { type: 'create_room' });
    expect(carol.lastOf('room_created')).toBeTruthy();
  });

  it('a disconnecting spectator leaves the roster', async () => {
    const relay = new RelayServer();
    const [a, , code] = await startedMatch(relay);
    const carol = await client(relay, 'carol');
    await say(relay, carol, { type: 'spectate', code });
    expect(a.lastOf('spectators').names).toEqual(['carol']);
    relay.disconnect(carol);
    expect(a.lastOf('spectators').names).toEqual([]);
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
    const relay = new RelayServer({ log: () => {} });
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
      { name: 'bob', record: { wins: 1, losses: 0 }, rating: null },
    ]);
  });

  it('ending the match during grace cancels the timer and evicts the dropped seat', async () => {
    // Regression: a concede while the opponent was in grace left the timer
    // armed; it later fired against the already-ended match and recorded the
    // forfeit a second time.
    const relay = new RelayServer();
    const { b, tokenA } = await droppedMidMatch(relay);
    await say(relay, b, { type: 'inputs', startTick: 2, frames: [0, 0] });
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

  it('logs a failed forfeit write at grace expiry and keeps serving', async () => {
    // Regression: the timer callback discarded the expiry promise, so a store
    // rejection became an unhandled rejection (which exits Node by default).
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const relay = new RelayServer({ store: new FailingRecordStore() });
      const { b, code } = await droppedMidMatch(relay);
      await vi.advanceTimersByTimeAsync(DEFAULT_RECONNECT_GRACE_MS + 1);
      await relay.idle();
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining('failed to settle a game'),
        expect.any(Error),
      );
      // The survivor still gets the forfeit; only the record update is lost.
      expect(b.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'disconnect', winner: 1 });
      expect(b.lastOf('room_list').rooms[0]!.players).toEqual([
        { name: 'bob', record: { wins: 0, losses: 0 }, rating: null },
      ]);
      // The relay keeps working: a new opponent joins and a match starts.
      const c = await client(relay, 'carol');
      await say(relay, c, { type: 'join_room', code });
      await say(relay, b, { type: 'ready' });
      await say(relay, c, { type: 'ready' });
      expect(c.lastOf('match_start').players).toEqual(['bob', 'carol']);
    } finally {
      errors.mockRestore();
    }
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

describe('vs-AI rooms', () => {
  it('creates a full room with a bot seat and starts on a single ready', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    await say(relay, a, { type: 'create_room', aiOpponent: { difficulty: 'medium' } });
    const code = a.lastOf('room_created').code;

    // The lobby shows a full room: alice + the bot.
    const rooms = a.lastOf('room_list').rooms;
    const room = rooms.find((r) => r.code === code)!;
    expect(room.players.map((p) => p.name)).toEqual(['alice', 'CPU (medium)']);

    // A single ready starts the match; match_start carries the bot descriptor.
    await say(relay, a, { type: 'ready' });
    const start = a.lastOf('match_start');
    expect(start.playerIndex).toBe(0);
    expect(start.aiOpponent).toEqual({ difficulty: 'medium', index: 1 });
  });

  it('rejects a human joining a full AI room but allows spectating it', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    await say(relay, a, { type: 'create_room', aiOpponent: { difficulty: 'hard' } });
    const code = a.lastOf('room_created').code;

    const b = await client(relay, 'bob');
    await say(relay, b, { type: 'join_room', code });
    expect(b.lastOf('error').code).toBe('room_full');

    await say(relay, a, { type: 'ready' }); // match under way
    await say(relay, b, { type: 'spectate', code });
    const spec = b.lastOf('spectate_start');
    expect(spec.aiOpponent).toEqual({ difficulty: 'hard', index: 1 });
    expect(spec.frames).toEqual([[], []]); // bot stream never on the wire
  });

  it("accepts the human's result directly and returns to waiting for a rematch", async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    await say(relay, a, { type: 'create_room', aiOpponent: { difficulty: 'easy' } });
    const code = a.lastOf('room_created').code;
    await say(relay, a, { type: 'ready' });
    a.clear();

    // Human reports a win over the bot (index 0); no peer report is awaited.
    await say(relay, a, { type: 'result', winner: 0 });
    expect(a.lastOf('match_end')).toEqual({ type: 'match_end', reason: 'result', winner: 0 });
    // vs-AI is not persisted to W-L.
    expect(a.lastOf('room_list').rooms.find((r) => r.code === code)!.state).toBe('waiting');

    // Re-ready starts a rematch (the bot seat persisted).
    await say(relay, a, { type: 'ready' });
    expect(a.lastOf('match_start').aiOpponent).toEqual({ difficulty: 'easy', index: 1 });
  });

  it('closes the AI room when the human disconnects mid-match', async () => {
    const relay = new RelayServer();
    const a = await client(relay, 'alice');
    await say(relay, a, { type: 'create_room', aiOpponent: { difficulty: 'medium' } });
    await say(relay, a, { type: 'ready' });
    expect(relay.roomCount).toBe(1);

    relay.disconnect(a);
    expect(relay.roomCount).toBe(0); // torn down, no reconnect grace
  });
});
