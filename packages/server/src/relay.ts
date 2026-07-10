/**
 * relay.ts — the lockstep relay + lobby, transport-free.
 *
 * All room/match logic lives here against a tiny {@link ClientConnection}
 * abstraction, so it unit-tests without sockets; `wsServer.ts` is the thin
 * WebSocket wrapper. The relay never runs a simulation — it forwards input
 * frames verbatim, generates seeds/room codes, compares digests, and settles
 * the few lifecycle events the deterministic sims can't (concession,
 * disconnection, desync). See packages/protocol/src/messages.ts for the model.
 *
 * Phase 5 adds the lobby: token identity + W-L records (via the abstract
 * {@link LobbyStore}), room-list pushes, client-reported (cross-checked) game
 * results, and reconnect grace — a dropped player's *seat* survives their
 * connection, holding the full per-match input ledger so a rejoining client
 * can rebuild its session from tick 0 (`match_resume`).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  DEFAULT_INPUT_DELAY_TICKS,
  DEFAULT_RECONNECT_GRACE_MS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SESSION_TOKEN_LENGTH,
  ProtocolError,
  decodeClientMessage,
  encodeMessage,
  type ClientMessage,
  type ErrorCode,
  type HelloMessage,
  type MatchEndReason,
  type RoomSummary,
  type ServerMessage,
} from '@crack-attack/protocol';
import { MemoryStore, type LobbyStore, type StoredPlayer } from './store.js';

/** Transport surface the relay needs from a connection. */
export interface ClientConnection {
  /** Send one encoded protocol message. Must not throw on a closed socket. */
  send(text: string): void;
  /** Close the connection (the transport must then call `disconnect`). */
  close(): void;
}

/**
 * Digest submissions retained per seat while waiting for the peer's
 * submission for the same tick. In lockstep the sims stay within one relay
 * round-trip of each other, so a healthy match needs only a handful; a client
 * exceeding this is violating the protocol.
 */
const MAX_PENDING_DIGESTS = 128;

/**
 * A player's place in a room. Unlike a connection, a seat survives a
 * mid-match disconnect (reconnect grace): it keeps the identity, the full
 * input ledger for the current game, and the pending digests.
 */
interface Seat {
  /** Live connection, or null while the player is dropped (grace running). */
  conn: ClientConnection | null;
  token: string;
  name: string;
  record: { wins: number; losses: number };
  ready: boolean;
  /** Index in the current match (0/1), pinned at match_start. */
  match_index: number;
  /**
   * Every input frame this seat has sent for the current game, from tick 0.
   * Doubles as the contiguity ledger (next expected startTick = length) and
   * the `match_resume` history.
   */
  frames: number[];
  /** Pending digest submissions by tick, awaiting the peer's. */
  digests: Map<number, [number, number]>;
  /** Reported game result (player index or null = draw), awaiting the peer's. */
  reported_result: number | null | undefined;
}

interface Room {
  code: string;
  seats: Seat[];
  state: 'waiting' | 'playing';
  /** Seed of the current match (kept for `match_resume`). */
  seed: number;
  /**
   * Digests at or below this tick are ignored: set on resume to the ledger
   * frontier, since the rejoining client replays from tick 0 and resubmits
   * digests its peer already had matched and discarded.
   */
  digest_floor: number;
  /** Pending grace expiry, when a seat is dropped. */
  grace_timer: ReturnType<typeof setTimeout> | null;
}

/** A live, helloed connection: identity plus (optionally) a seat. */
interface Session {
  conn: ClientConnection;
  identity: StoredPlayer;
  room: Room | null;
  seat: Seat | null;
}

/** Uniform uint32 from an injectable float source (defaults to Math.random). */
function randomUint32(entropy: () => number): number {
  return (entropy() * 0x100000000) >>> 0;
}

export interface RelayServerOptions {
  entropy?: (() => number) | undefined;
  inputDelay?: number | undefined;
  /** Persistence backend; defaults to an in-memory store. */
  store?: LobbyStore | undefined;
  /** Reconnect grace in ms; DEFAULT_RECONNECT_GRACE_MS unless overridden. */
  graceMs?: number | undefined;
}

export class RelayServer {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<ClientConnection, Session | null>();
  /** Dropped mid-match, grace pending: token → their room. */
  private readonly dropped = new Map<string, Room>();
  private readonly entropy: () => number;
  private readonly inputDelay: number;
  private readonly store: LobbyStore;
  private readonly graceMs: number;

  constructor(options: RelayServerOptions = {}) {
    this.entropy = options.entropy ?? Math.random;
    this.inputDelay = options.inputDelay ?? DEFAULT_INPUT_DELAY_TICKS;
    this.store = options.store ?? new MemoryStore();
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
  }

  /** Number of open rooms (inspection/test helper). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Cancel outstanding timers (transport shutdown). */
  shutdown(): void {
    for (const room of this.rooms.values()) {
      if (room.grace_timer !== null) clearTimeout(room.grace_timer);
      room.grace_timer = null;
    }
  }

  /** The transport reports a new connection. */
  connect(conn: ClientConnection): void {
    // null = connected but not helloed yet.
    this.sessions.set(conn, null);
  }

  /** The transport reports a closed connection. */
  disconnect(conn: ClientConnection): void {
    const session = this.sessions.get(conn);
    this.sessions.delete(conn);
    if (!session?.room || !session.seat) return;

    if (session.room.state === 'playing') {
      this.dropSeat(session.room, session.seat);
    } else {
      this.leaveRoom(session);
      this.broadcastRoomList();
    }
  }

  /**
   * The transport delivers one raw message from `conn`. Async because hello
   * and result reporting touch the store; the transport must serialize
   * messages per connection (await each before processing the next).
   */
  async message(conn: ClientConnection, text: string): Promise<void> {
    if (!this.sessions.has(conn)) return; // already disconnected
    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(text);
    } catch (e) {
      this.error(conn, 'bad_message', e instanceof ProtocolError ? e.message : 'malformed');
      return;
    }

    const session = this.sessions.get(conn) ?? null;
    if (!session) {
      await this.handlePreHello(conn, msg);
      return;
    }

    switch (msg.type) {
      case 'hello':
        this.error(conn, 'bad_message', 'already helloed');
        return;
      case 'create_room':
        this.handleCreateRoom(session);
        return;
      case 'join_room':
        this.handleJoinRoom(session, msg.code);
        return;
      case 'ready':
        this.handleReady(session);
        return;
      case 'inputs':
        this.handleInputs(session, msg.startTick, msg.frames);
        return;
      case 'digest':
        this.handleDigest(session, msg.tick, msg.digests);
        return;
      case 'result':
        await this.handleResult(session, msg.winner);
        return;
      case 'concede':
        await this.handleConcede(session);
        return;
      case 'leave_room':
        this.handleLeave(session);
        return;
    }
  }

  // --- Handshake --------------------------------------------------------------

  private async handlePreHello(conn: ClientConnection, msg: ClientMessage): Promise<void> {
    if (msg.type !== 'hello') {
      this.error(conn, 'bad_message', 'hello must be the first message');
      return;
    }
    // Version check, mirroring the original's version-string gate
    // (Communicator.cxx:192): mismatched peers are turned away at the door.
    if (msg.protocolVersion !== PROTOCOL_VERSION) {
      this.error(conn, 'version_mismatch', `server speaks protocol ${PROTOCOL_VERSION}`);
      conn.close();
      return;
    }

    const identity = await this.resolveIdentity(msg);
    const session: Session = { conn, identity, room: null, seat: null };
    this.sessions.set(conn, session);
    this.send(conn, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      token: identity.token,
      name: identity.name,
      record: identity.record,
    });
    this.send(conn, { type: 'room_list', rooms: this.roomSummaries() });

    // Reconnect: this token has a seat in a playing room within grace.
    const room = this.dropped.get(identity.token);
    if (room) this.resumeSeat(session, room);
  }

  /** Token lookup with fallback to a freshly minted identity. */
  private async resolveIdentity(msg: HelloMessage): Promise<StoredPlayer> {
    if (msg.token !== undefined) {
      const existing = await this.store.getPlayer(msg.token, msg.name);
      if (existing) return existing;
      // Unknown token (expired store, other server): mint fresh below.
    }
    return this.store.createPlayer(this.generateToken(), msg.name);
  }

  // --- Reconnect grace -----------------------------------------------------------

  /** A playing seat lost its connection: hold the match and start the clock. */
  private dropSeat(room: Room, seat: Seat): void {
    seat.conn = null;
    this.dropped.set(seat.token, room);
    const peer = room.seats.find((s) => s !== seat);
    if (peer?.conn) {
      this.send(peer.conn, { type: 'peer_dropped', name: seat.name, graceMs: this.graceMs });
    }
    if (room.grace_timer !== null) clearTimeout(room.grace_timer);
    room.grace_timer = setTimeout(() => {
      room.grace_timer = null;
      void this.expireGrace(room, seat);
    }, this.graceMs);
  }

  /** Grace ran out: the dropped seat forfeits and leaves the room. */
  private async expireGrace(room: Room, seat: Seat): Promise<void> {
    this.dropped.delete(seat.token);
    room.seats.splice(room.seats.indexOf(seat), 1);

    const peer = room.seats[0];
    if (!peer) {
      this.rooms.delete(room.code);
      this.broadcastRoomList();
      return;
    }
    await this.recordDecisive(peer, seat);
    this.endMatch(room, 'disconnect', peer.match_index);
    if (peer.conn) this.send(peer.conn, { type: 'peer_left', name: seat.name });
    this.broadcastRoomList();
  }

  /** A dropped player reconnected: reattach the seat and replay the match. */
  private resumeSeat(session: Session, room: Room): void {
    const seat = room.seats.find((s) => s.token === session.identity.token);
    if (!seat) return; // raced with expiry; lobby it is
    this.dropped.delete(seat.token);
    if (room.grace_timer !== null) {
      clearTimeout(room.grace_timer);
      room.grace_timer = null;
    }

    seat.conn = session.conn;
    seat.name = session.identity.name;
    session.room = room;
    session.seat = seat;

    // The rejoining client replays from tick 0 and will resubmit digests its
    // peer already had matched and discarded; ignore everything at or below
    // the current ledger frontier, and clear both pending maps (that window
    // simply goes unverified).
    const frontier = Math.min(...room.seats.map((s) => s.frames.length));
    room.digest_floor = frontier;
    for (const s of room.seats) s.digests.clear();

    const histories = this.ledgers(room);
    this.send(session.conn, {
      type: 'match_resume',
      seed: room.seed,
      playerIndex: seat.match_index,
      inputDelay: this.inputDelay,
      players: this.matchNames(room),
      frames: histories,
    });
    const peer = room.seats.find((s) => s !== seat);
    if (peer?.conn) this.send(peer.conn, { type: 'peer_rejoined', name: seat.name });
  }

  // --- Room flow ---------------------------------------------------------------

  private newSeat(session: Session): Seat {
    return {
      conn: session.conn,
      token: session.identity.token,
      name: session.identity.name,
      record: { ...session.identity.record },
      ready: false,
      match_index: 0,
      frames: [],
      digests: new Map(),
      reported_result: undefined,
    };
  }

  private handleCreateRoom(session: Session): void {
    if (session.room) {
      this.error(session.conn, 'bad_message', 'already in a room');
      return;
    }
    const code = this.generateRoomCode();
    const seat = this.newSeat(session);
    const room: Room = {
      code,
      seats: [seat],
      state: 'waiting',
      seed: 0,
      digest_floor: -1,
      grace_timer: null,
    };
    this.rooms.set(code, room);
    session.room = room;
    session.seat = seat;
    this.send(session.conn, { type: 'room_created', code });
    this.broadcastRoomList();
  }

  private handleJoinRoom(session: Session, code: string): void {
    if (session.room) {
      this.error(session.conn, 'bad_message', 'already in a room');
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.error(session.conn, 'room_not_found', `no room ${code}`);
      return;
    }
    if (room.seats.length >= 2 || room.state !== 'waiting') {
      this.error(session.conn, 'room_full', `room ${code} is full`);
      return;
    }
    const seat = this.newSeat(session);
    room.seats.push(seat);
    session.room = room;
    session.seat = seat;
    this.send(session.conn, {
      type: 'room_joined',
      code,
      players: room.seats.map((s) => s.name),
    });
    const host = room.seats[0]!;
    if (host.conn) this.send(host.conn, { type: 'peer_joined', name: seat.name });
    this.broadcastRoomList();
  }

  /**
   * Readiness. In a waiting room this arms the match start; sent while a match
   * is `playing` it means "this game is over on my screen, ready for a rematch".
   * When both players are ready, a fresh seed starts the next game.
   */
  private handleReady(session: Session): void {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat) {
      this.error(session.conn, 'not_in_room', 'ready outside a room');
      return;
    }
    seat.ready = true;
    if (room.seats.length === 2 && room.seats.every((s) => s.ready)) {
      this.startMatch(room);
    }
  }

  private startMatch(room: Room): void {
    room.state = 'playing';
    // Server-generated seed, replacing the original's seed exchange
    // (Communicator.cxx:283-296). Both clients derive both sims from it.
    room.seed = randomUint32(this.entropy);
    room.digest_floor = -1;
    // Pin indices from the current seat order before deriving names.
    for (let i = 0; i < 2; i++) room.seats[i]!.match_index = i;
    const names = this.matchNames(room);
    for (let i = 0; i < 2; i++) {
      const s = room.seats[i]!;
      s.ready = false;
      s.frames = [];
      s.digests.clear();
      s.reported_result = undefined;
      if (s.conn) {
        this.send(s.conn, {
          type: 'match_start',
          seed: room.seed,
          playerIndex: i,
          inputDelay: this.inputDelay,
          players: names,
        });
      }
    }
    this.broadcastRoomList();
  }

  // --- In-match traffic ---------------------------------------------------------

  private handleInputs(session: Session, startTick: number, frames: number[]): void {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat || room.state !== 'playing') {
      this.error(session.conn, 'not_in_room', 'inputs outside a match');
      return;
    }
    // Contiguity: batches must tile the tick line exactly. The transport is
    // ordered and reliable, so a gap or overlap is a client bug that would
    // silently corrupt lockstep — treat it as fatal.
    if (startTick !== seat.frames.length) {
      this.error(
        session.conn,
        'bad_message',
        `inputs batch starts at ${startTick}, expected ${seat.frames.length}`,
      );
      session.conn.close();
      return;
    }
    for (const f of frames) seat.frames.push(f);
    const peer = room.seats.find((s) => s !== seat);
    if (peer?.conn) {
      this.send(peer.conn, {
        type: 'peer_inputs',
        playerIndex: seat.match_index,
        startTick,
        frames,
      });
    }
  }

  private handleDigest(session: Session, tick: number, digests: [number, number]): void {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat || room.state !== 'playing') {
      this.error(session.conn, 'not_in_room', 'digest outside a match');
      return;
    }
    // Replayed digests from a resumed client (or stragglers from before the
    // resume) fall at or below the floor; that window goes unverified.
    if (tick <= room.digest_floor) return;
    const peer = room.seats.find((s) => s !== seat);
    if (!peer) return;

    const peerDigests = peer.digests.get(tick);
    if (peerDigests === undefined) {
      seat.digests.set(tick, digests);
      if (seat.digests.size > MAX_PENDING_DIGESTS) {
        this.error(session.conn, 'bad_message', 'too many unmatched digests');
        session.conn.close();
      }
      return;
    }

    peer.digests.delete(tick);
    if (peerDigests[0] !== digests[0] || peerDigests[1] !== digests[1]) {
      // The sims have diverged: void the match. This is the improvement over
      // the original, which had no detection and let boards silently drift.
      for (const s of room.seats) if (s.conn) this.send(s.conn, { type: 'desync', tick });
      this.endMatch(room, 'desync', null);
      this.broadcastRoomList();
    }
  }

  /**
   * A client reports the game's deterministic outcome. Both must agree (they
   * compute it from identical sims); agreement records the W-L result and
   * returns the room to waiting, disagreement is treated as a desync.
   */
  private async handleResult(session: Session, winner: number | null): Promise<void> {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat || room.state !== 'playing') {
      this.error(session.conn, 'not_in_room', 'result outside a match');
      return;
    }
    seat.reported_result = winner;
    const peer = room.seats.find((s) => s !== seat);
    if (!peer || peer.reported_result === undefined) return;

    if (peer.reported_result !== winner) {
      for (const s of room.seats) if (s.conn) this.send(s.conn, { type: 'desync', tick: 0 });
      this.endMatch(room, 'desync', null);
      this.broadcastRoomList();
      return;
    }

    if (winner !== null) {
      const winnerSeat = room.seats.find((s) => s.match_index === winner);
      const loserSeat = room.seats.find((s) => s.match_index !== winner);
      if (winnerSeat && loserSeat) await this.recordDecisive(winnerSeat, loserSeat);
    }
    this.endMatch(room, 'result', winner);
    this.broadcastRoomList();
  }

  private async handleConcede(session: Session): Promise<void> {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat || room.state !== 'playing') {
      this.error(session.conn, 'not_in_room', 'concede outside a match');
      return;
    }
    const peer = room.seats.find((s) => s !== seat);
    if (peer) await this.recordDecisive(peer, seat);
    this.endMatch(room, 'concession', peer ? peer.match_index : 1 - seat.match_index);
    this.broadcastRoomList();
  }

  private handleLeave(session: Session): void {
    if (!session.room) {
      this.error(session.conn, 'not_in_room', 'leave_room outside a room');
      return;
    }
    this.leaveRoom(session);
    this.broadcastRoomList();
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** Persist a decisive game and update the seats' cached records. */
  private async recordDecisive(winner: Seat, loser: Seat): Promise<void> {
    await this.store.recordResult(winner.token, loser.token);
    winner.record.wins++;
    loser.record.losses++;
    // Keep any live sessions' cached identity records fresh too.
    for (const s of this.sessions.values()) {
      if (s?.identity.token === winner.token) s.identity.record = { ...winner.record };
      if (s?.identity.token === loser.token) s.identity.record = { ...loser.record };
    }
  }

  /** End the current match and return the room to the waiting state. */
  private endMatch(room: Room, reason: MatchEndReason, winner: number | null): void {
    room.state = 'waiting';
    room.digest_floor = -1;
    for (const s of room.seats) {
      s.ready = false;
      s.frames = [];
      s.digests.clear();
      s.reported_result = undefined;
      if (s.conn) this.send(s.conn, { type: 'match_end', reason, winner });
    }
  }

  /**
   * Remove a session's seat from its room (explicit leave, or disconnect from
   * a waiting room). Mid-match leaves forfeit the match first.
   */
  private leaveRoom(session: Session): void {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat) return;
    room.seats.splice(room.seats.indexOf(seat), 1);
    session.room = null;
    session.seat = null;

    const peer = room.seats[0];
    if (!peer) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.state === 'playing') {
      // Leaving mid-match forfeits it. Recording is fire-and-forget here (the
      // handler path is sync); failures only cost a stats update.
      void this.recordDecisive(peer, seat).catch(() => undefined);
      this.endMatch(room, 'disconnect', peer.match_index);
    }
    if (peer.conn) this.send(peer.conn, { type: 'peer_left', name: seat.name });
  }

  // --- Room list -------------------------------------------------------------------

  private roomSummaries(): RoomSummary[] {
    const rooms: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      rooms.push({
        code: room.code,
        state: room.state,
        players: room.seats.map((s) => ({ name: s.name, record: { ...s.record } })),
      });
    }
    return rooms;
  }

  /** Push the lobby snapshot to every helloed connection. */
  private broadcastRoomList(): void {
    const msg: ServerMessage = { type: 'room_list', rooms: this.roomSummaries() };
    const text = encodeMessage(msg);
    for (const session of this.sessions.values()) {
      session?.conn.send(text);
    }
  }

  // --- Helpers -------------------------------------------------------------------

  private matchNames(room: Room): [string, string] {
    const byIndex = [...room.seats].sort((a, b) => a.match_index - b.match_index);
    return [byIndex[0]?.name ?? '?', byIndex[1]?.name ?? '?'];
  }

  private ledgers(room: Room): [number[], number[]] {
    const result: [number[], number[]] = [[], []];
    for (const s of room.seats) result[s.match_index] = [...s.frames];
    return result;
  }

  private generateRoomCode(): string {
    // Rejection-free uniform draw per character; retry on (unlikely) collision.
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[randomUint32(this.entropy) % ROOM_CODE_ALPHABET.length]!;
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  private generateToken(): string {
    let token = '';
    for (let i = 0; i < SESSION_TOKEN_LENGTH / 8; i++) {
      token += randomUint32(this.entropy).toString(16).padStart(8, '0');
    }
    return token;
  }

  private send(conn: ClientConnection, msg: ServerMessage): void {
    conn.send(encodeMessage(msg));
  }

  private error(conn: ClientConnection, code: ErrorCode, message: string): void {
    this.send(conn, { type: 'error', code, message });
  }
}
