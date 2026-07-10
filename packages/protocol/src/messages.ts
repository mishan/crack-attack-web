/**
 * messages.ts — the lockstep wire surface.
 *
 * The port's netcode model is **input-relay lockstep**, a deliberate departure
 * from the original's event exchange (Communicator.h:54-84). Both clients run
 * *both* sims (`GameSim` is instanced precisely to allow this) from a shared
 * seed, advancing a tick only when both players' inputs for that tick are
 * known; local input is scheduled `inputDelay` ticks ahead to hide latency.
 * Consequences, relative to the C++ `Communicator`:
 *
 * - Garbage events ({time_stamp, height, width, flavor}, Communicator.h:70-77)
 *   never cross the wire: each client cross-wires the two sims' garbage-out
 *   ports locally, so insertion happens at the same tick on both machines.
 * - The status word ({level_lights, game_state, loss_time_stamp, sync},
 *   Communicator.h:79-84) disappears: level lights and losses are computed
 *   deterministically from the opponent's sim. Loss ties resolve by a fixed
 *   deterministic rule, retiring the hidden server-wins-ties quirk
 *   (Communicator.cxx:423-425).
 * - What remains on the wire is only: handshake/room flow, per-tick input
 *   frames, periodic state digests (desync detection — an improvement over
 *   the original, which let boards silently diverge), and match lifecycle
 *   events the sims cannot decide (concession, disconnect).
 *
 * Messages are a discriminated union on `type`, encoded as compact JSON
 * (codec.ts); a binary codec can replace it later without touching call sites.
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { CC_MOVE_MASK, CC_SWAP, CC_ADVANCE } from '@crack-attack/core';

// --- Protocol constants -----------------------------------------------------

/**
 * Bumped whenever the wire format changes incompatibly. Exchanged in
 * `hello`/`welcome` and checked by the server, mirroring the original's
 * version-string check (CO_VERSION, Communicator.h:47; Communicator.cxx:192).
 */
export const PROTOCOL_VERSION = 1;

/**
 * How often (in ticks) each client submits state digests. 32 is a nod to the
 * original's exchange cadence (CO_COMMUNICATION_PERIOD, Communicator.h:41),
 * though here the cadence is advisory — only digests ride it.
 */
export const DIGEST_PERIOD = 32;

/**
 * Default local-input scheduling delay in ticks (60 ms at 50 Hz). The server
 * sets the authoritative value per match in `match_start`.
 */
export const DEFAULT_INPUT_DELAY_TICKS = 3;

/** Every valid action bit an input frame may carry (the `CC_*` mask). */
export const ACTION_MASK = CC_MOVE_MASK | CC_SWAP | CC_ADVANCE;

/** Upper bound on frames per `inputs`/`peer_inputs` message (5 s at 50 Hz). */
export const MAX_INPUT_FRAMES_PER_MESSAGE = 250;

/** Player display names: 1..32 chars. (The C++ allowed 256; 32 is plenty.) */
export const MAX_PLAYER_NAME_LENGTH = 32;

/** Room codes: 5 chars from an alphabet without lookalikes (no I/O/0/1). */
export const ROOM_CODE_LENGTH = 5;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// --- Client → Server --------------------------------------------------------

/** First message on a connection; the server replies `welcome` or `error`. */
export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** Display name, 1..{@link MAX_PLAYER_NAME_LENGTH} chars. */
  name: string;
}

/** Ask the server to create a room; it replies `room_created`. */
export interface CreateRoomMessage {
  type: 'create_room';
}

/** Join an existing room by code; the server replies `room_joined` or `error`. */
export interface JoinRoomMessage {
  type: 'join_room';
  code: string;
}

/** Declare readiness. When every player in the room is ready, `match_start`. */
export interface ReadyMessage {
  type: 'ready';
}

/**
 * A contiguous batch of the sender's input frames. `frames[i]` is the `CC_*`
 * action bitmask ({@link ACTION_MASK}) for tick `startTick + i`. Batches must
 * be contiguous and non-overlapping in tick order; the server relays them
 * verbatim as `peer_inputs`.
 */
export interface InputsMessage {
  type: 'inputs';
  startTick: number;
  frames: number[];
}

/**
 * Periodic desync check: the sender's digest of *each* sim at `tick` (indexed
 * by player index), submitted every {@link DIGEST_PERIOD} ticks. The server
 * compares submissions from both clients and broadcasts `desync` on mismatch.
 */
export interface DigestMessage {
  type: 'digest';
  tick: number;
  digests: [number, number];
}

/** Concede the current match. The server broadcasts `match_end`. */
export interface ConcedeMessage {
  type: 'concede';
}

/** Leave the current room (pre-match). Peers receive `peer_left`. */
export interface LeaveRoomMessage {
  type: 'leave_room';
}

export type ClientMessage =
  | HelloMessage
  | CreateRoomMessage
  | JoinRoomMessage
  | ReadyMessage
  | InputsMessage
  | DigestMessage
  | ConcedeMessage
  | LeaveRoomMessage;

// --- Server → Client --------------------------------------------------------

/** Successful `hello`. */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
}

/** The room was created; share `code` with the opponent. */
export interface RoomCreatedMessage {
  type: 'room_created';
  code: string;
}

/** Joined a room. `players` lists display names in player-index order. */
export interface RoomJoinedMessage {
  type: 'room_joined';
  code: string;
  players: string[];
}

/** Another player joined the room. */
export interface PeerJoinedMessage {
  type: 'peer_joined';
  name: string;
}

/** A player left the room (pre-match). */
export interface PeerLeftMessage {
  type: 'peer_left';
  name: string;
}

/**
 * The match begins. Replaces the original's server-generated seed exchange
 * (Communicator.cxx:283-296): the relay generates `seed`, and both clients
 * derive each player's sim RNG from it identically. `playerIndex` is the
 * recipient's own index into `players`/digests/input streams.
 */
export interface MatchStartMessage {
  type: 'match_start';
  seed: number;
  playerIndex: number;
  /** Authoritative local-input scheduling delay for this match, in ticks. */
  inputDelay: number;
  players: [string, string];
}

/** A relayed `inputs` batch from the peer at `playerIndex`. */
export interface PeerInputsMessage {
  type: 'peer_inputs';
  playerIndex: number;
  startTick: number;
  frames: number[];
}

/** Digest comparison failed at `tick`: the sims have diverged. */
export interface DesyncMessage {
  type: 'desync';
  tick: number;
}

/** Reasons a match can end that the deterministic sims cannot decide. */
export type MatchEndReason = 'concession' | 'disconnect' | 'desync';

/**
 * The match ended for a non-gameplay reason (gameplay losses are computed
 * deterministically client-side and need no server message). `winner` is a
 * player index, or null if the match is void (e.g. desync).
 */
export interface MatchEndMessage {
  type: 'match_end';
  reason: MatchEndReason;
  winner: number | null;
}

/** Machine-readable request failures. */
export type ErrorCode =
  'version_mismatch' | 'bad_name' | 'room_not_found' | 'room_full' | 'not_in_room' | 'bad_message';

export interface ErrorMessage {
  type: 'error';
  code: ErrorCode;
  message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | RoomCreatedMessage
  | RoomJoinedMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | MatchStartMessage
  | PeerInputsMessage
  | DesyncMessage
  | MatchEndMessage
  | ErrorMessage;

export type Message = ClientMessage | ServerMessage;
