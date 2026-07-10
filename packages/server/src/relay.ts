/**
 * relay.ts — the lockstep relay, transport-free.
 *
 * All room/match logic lives here against a tiny {@link ClientConnection}
 * abstraction, so it unit-tests without sockets; `wsServer.ts` is the thin
 * WebSocket wrapper. The relay never runs a simulation — it forwards input
 * frames verbatim, generates seeds/room codes, compares digests, and settles
 * the few lifecycle events the deterministic sims can't (concession,
 * disconnection, desync). See packages/protocol/src/messages.ts for the model.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import {
  DEFAULT_INPUT_DELAY_TICKS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ProtocolError,
  decodeClientMessage,
  encodeMessage,
  type ClientMessage,
  type ErrorCode,
  type MatchEndReason,
  type ServerMessage,
} from '@crack-attack/protocol';

/** Transport surface the relay needs from a connection. */
export interface ClientConnection {
  /** Send one encoded protocol message. Must not throw on a closed socket. */
  send(text: string): void;
  /** Close the connection (the transport must then call `disconnect`). */
  close(): void;
}

/**
 * Digest submissions retained per client while waiting for the peer's
 * submission for the same tick. In lockstep the sims stay within one relay
 * round-trip of each other, so a healthy match needs only a handful; a client
 * exceeding this is violating the protocol.
 */
const MAX_PENDING_DIGESTS = 128;

interface Player {
  conn: ClientConnection;
  name: string;
  room: Room | null;
  ready: boolean;
  /**
   * This player's index in the current match (0 or 1), fixed at `match_start`.
   * Kept on the player rather than derived from array position so a mid-match
   * departure can't renumber the survivor.
   */
  match_index: number;
  /** First tick of the next expected `inputs` batch (contiguity check). */
  next_input_tick: number;
  /** Pending digest submissions by tick, awaiting the peer's. */
  digests: Map<number, [number, number]>;
}

interface Room {
  code: string;
  players: Player[];
  state: 'waiting' | 'playing';
}

/** Uniform uint32 from an injectable float source (defaults to Math.random). */
function randomUint32(entropy: () => number): number {
  return (entropy() * 0x100000000) >>> 0;
}

export class RelayServer {
  private readonly rooms = new Map<string, Room>();
  private readonly players = new Map<ClientConnection, Player | null>();
  private readonly entropy: () => number;
  private readonly inputDelay: number;

  constructor(
    options: { entropy?: (() => number) | undefined; inputDelay?: number | undefined } = {},
  ) {
    this.entropy = options.entropy ?? Math.random;
    this.inputDelay = options.inputDelay ?? DEFAULT_INPUT_DELAY_TICKS;
  }

  /** Number of open rooms (inspection/test helper). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** The transport reports a new connection. */
  connect(conn: ClientConnection): void {
    // null = connected but not helloed yet.
    this.players.set(conn, null);
  }

  /** The transport reports a closed connection. */
  disconnect(conn: ClientConnection): void {
    const player = this.players.get(conn);
    if (player) this.leaveRoom(player, 'disconnect');
    this.players.delete(conn);
  }

  /** The transport delivers one raw message from `conn`. */
  message(conn: ClientConnection, text: string): void {
    if (!this.players.has(conn)) return; // already disconnected
    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(text);
    } catch (e) {
      this.error(conn, 'bad_message', e instanceof ProtocolError ? e.message : 'malformed');
      return;
    }

    const player = this.players.get(conn) ?? null;
    if (!player) {
      this.handlePreHello(conn, msg);
      return;
    }

    switch (msg.type) {
      case 'hello':
        this.error(conn, 'bad_message', 'already helloed');
        return;
      case 'create_room':
        this.handleCreateRoom(player);
        return;
      case 'join_room':
        this.handleJoinRoom(player, msg.code);
        return;
      case 'ready':
        this.handleReady(player);
        return;
      case 'inputs':
        this.handleInputs(player, msg.startTick, msg.frames);
        return;
      case 'digest':
        this.handleDigest(player, msg.tick, msg.digests);
        return;
      case 'concede':
        this.handleConcede(player);
        return;
      case 'leave_room':
        this.leaveRoom(player, 'leave');
        return;
    }
  }

  // --- Handshake --------------------------------------------------------------

  private handlePreHello(conn: ClientConnection, msg: ClientMessage): void {
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
    this.players.set(conn, {
      conn,
      name: msg.name,
      room: null,
      ready: false,
      match_index: 0,
      next_input_tick: 0,
      digests: new Map(),
    });
    this.send(conn, { type: 'welcome', protocolVersion: PROTOCOL_VERSION });
  }

  // --- Room flow ---------------------------------------------------------------

  private handleCreateRoom(player: Player): void {
    if (player.room) {
      this.error(player.conn, 'bad_message', 'already in a room');
      return;
    }
    const code = this.generateRoomCode();
    const room: Room = { code, players: [player], state: 'waiting' };
    this.rooms.set(code, room);
    player.room = room;
    player.ready = false;
    this.send(player.conn, { type: 'room_created', code });
  }

  private handleJoinRoom(player: Player, code: string): void {
    if (player.room) {
      this.error(player.conn, 'bad_message', 'already in a room');
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.error(player.conn, 'room_not_found', `no room ${code}`);
      return;
    }
    if (room.players.length >= 2 || room.state !== 'waiting') {
      this.error(player.conn, 'room_full', `room ${code} is full`);
      return;
    }
    room.players.push(player);
    player.room = room;
    player.ready = false;
    this.send(player.conn, {
      type: 'room_joined',
      code,
      players: room.players.map((p) => p.name),
    });
    this.send(room.players[0]!.conn, { type: 'peer_joined', name: player.name });
  }

  /**
   * Readiness. In a waiting room this arms the match start; sent while a match
   * is `playing` it means "this game is over on my screen, ready for a rematch"
   * — gameplay losses are computed client-side (deterministically, from both
   * sims), so the relay never learns game outcomes and needs no message for
   * them. When both players are ready, a fresh seed starts the next game.
   */
  private handleReady(player: Player): void {
    const room = player.room;
    if (!room) {
      this.error(player.conn, 'not_in_room', 'ready outside a room');
      return;
    }
    player.ready = true;
    if (room.players.length === 2 && room.players.every((p) => p.ready)) {
      this.startMatch(room);
    }
  }

  private startMatch(room: Room): void {
    room.state = 'playing';
    // Server-generated seed, replacing the original's seed exchange
    // (Communicator.cxx:283-296). Both clients derive both sims from it.
    const seed = randomUint32(this.entropy);
    const names = [room.players[0]!.name, room.players[1]!.name] as [string, string];
    for (let i = 0; i < 2; i++) {
      const p = room.players[i]!;
      p.ready = false;
      p.match_index = i;
      p.next_input_tick = 0;
      p.digests.clear();
      this.send(p.conn, {
        type: 'match_start',
        seed,
        playerIndex: i,
        inputDelay: this.inputDelay,
        players: names,
      });
    }
  }

  // --- In-match traffic ---------------------------------------------------------

  private handleInputs(player: Player, startTick: number, frames: number[]): void {
    const room = player.room;
    if (!room || room.state !== 'playing') {
      this.error(player.conn, 'not_in_room', 'inputs outside a match');
      return;
    }
    // Contiguity: batches must tile the tick line exactly. The transport is
    // ordered and reliable, so a gap or overlap is a client bug that would
    // silently corrupt lockstep — treat it as fatal.
    if (startTick !== player.next_input_tick) {
      this.error(
        player.conn,
        'bad_message',
        `inputs batch starts at ${startTick}, expected ${player.next_input_tick}`,
      );
      player.conn.close();
      return;
    }
    player.next_input_tick += frames.length;
    const peer = room.players.find((p) => p !== player);
    if (peer) {
      this.send(peer.conn, {
        type: 'peer_inputs',
        playerIndex: player.match_index,
        startTick,
        frames,
      });
    }
  }

  private handleDigest(player: Player, tick: number, digests: [number, number]): void {
    const room = player.room;
    if (!room || room.state !== 'playing') {
      this.error(player.conn, 'not_in_room', 'digest outside a match');
      return;
    }
    const peer = room.players.find((p) => p !== player);
    if (!peer) return; // opponent already gone; match_end is on its way

    const peerDigests = peer.digests.get(tick);
    if (peerDigests === undefined) {
      player.digests.set(tick, digests);
      if (player.digests.size > MAX_PENDING_DIGESTS) {
        this.error(player.conn, 'bad_message', 'too many unmatched digests');
        player.conn.close();
      }
      return;
    }

    peer.digests.delete(tick);
    if (peerDigests[0] !== digests[0] || peerDigests[1] !== digests[1]) {
      // The sims have diverged: void the match. This is the improvement over
      // the original, which had no detection and let boards silently drift.
      for (const p of room.players) this.send(p.conn, { type: 'desync', tick });
      this.endMatch(room, 'desync', null);
    }
  }

  private handleConcede(player: Player): void {
    const room = player.room;
    if (!room || room.state !== 'playing') {
      this.error(player.conn, 'not_in_room', 'concede outside a match');
      return;
    }
    this.endMatch(room, 'concession', 1 - player.match_index);
  }

  // --- Lifecycle ---------------------------------------------------------------

  /** End the current match and return the room to the waiting state. */
  private endMatch(room: Room, reason: MatchEndReason, winner: number | null): void {
    room.state = 'waiting';
    for (const p of room.players) {
      p.ready = false;
      p.digests.clear();
      this.send(p.conn, { type: 'match_end', reason, winner });
    }
  }

  /** Remove a player from their room (leave_room message or disconnection). */
  private leaveRoom(player: Player, _cause: 'leave' | 'disconnect'): void {
    const room = player.room;
    if (!room) return;
    room.players.splice(room.players.indexOf(player), 1);
    player.room = null;
    player.ready = false;
    player.digests.clear();

    const peer = room.players[0];
    if (!peer) {
      this.rooms.delete(room.code);
      return;
    }
    if (room.state === 'playing') {
      // Leaving mid-match forfeits it, whatever the cause.
      this.endMatch(room, 'disconnect', peer.match_index);
    }
    this.send(peer.conn, { type: 'peer_left', name: player.name });
  }

  // --- Helpers -------------------------------------------------------------------

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

  private send(conn: ClientConnection, msg: ServerMessage): void {
    conn.send(encodeMessage(msg));
  }

  private error(conn: ClientConnection, code: ErrorCode, message: string): void {
    this.send(conn, { type: 'error', code, message });
  }
}
