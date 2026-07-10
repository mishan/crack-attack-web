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
 *
 * v2: Phase 5 lobby — session tokens + W-L records on `hello`/`welcome`,
 * `room_list` pushes, client-reported `result`, and the reconnect flow
 * (`peer_dropped`/`peer_rejoined`/`match_resume`).
 *
 * v3: spectators — `spectate`, `spectate_joined`/`spectate_start` (the
 * ledger mechanism from `match_resume` doubles as mid-match late-join),
 * `spectators` roster pushes, `room_closed`, and watcher names in
 * `RoomSummary`. A spectator is a third sim pair fed both players' input
 * streams; nothing new crosses the wire per tick.
 */
export const PROTOCOL_VERSION = 3;

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

/** Session tokens: lowercase hex, fixed length (128 bits). */
export const SESSION_TOKEN_LENGTH = 32;

/**
 * How long a dropped player may reconnect to an in-progress match before it
 * forfeits. 30 s, a nod to the original's server timeout (CO_SERVER_TIME_OUT,
 * Communicator.h:38). The server is authoritative; this is the default.
 */
export const DEFAULT_RECONNECT_GRACE_MS = 30_000;

/**
 * Upper bound on a `match_resume` input history (per player). 1M ticks is
 * ~5.5 h of play at 50 Hz — far beyond any real match; purely a codec sanity
 * bound so a hostile server can't feed the client an unbounded array.
 */
export const MAX_MATCH_FRAMES = 1_000_000;

/** A player's persistent win/loss record. */
export interface PlayerRecord {
  wins: number;
  losses: number;
}

/** One lobby room as shown in the room list. */
export interface RoomSummary {
  code: string;
  state: 'waiting' | 'playing';
  players: { name: string; record: PlayerRecord }[];
  /** Names of everyone watching (spectators are visible by design). */
  spectators: string[];
}

// --- Client → Server --------------------------------------------------------

/** First message on a connection; the server replies `welcome` or `error`. */
export interface HelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** Display name, 1..{@link MAX_PLAYER_NAME_LENGTH} chars. Updates the stored name. */
  name: string;
  /**
   * Session token from a previous `welcome`, to reclaim identity (records,
   * and any in-progress match within the reconnect grace). Omitted on first
   * connect; an unknown token just mints a fresh identity.
   */
  token?: string;
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

/**
 * Watch a room by code (waiting or playing); the server replies
 * `spectate_joined` (plus `spectate_start` if a game is in progress).
 * Spectators leave with `leave_room`.
 */
export interface SpectateMessage {
  type: 'spectate';
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

/**
 * Report the deterministic outcome of the current game (both clients compute
 * it from both sims). The server cross-checks the two reports; agreement
 * records the W-L result, disagreement is treated like a desync. `winner` is
 * a player index, or null for a same-tick draw.
 */
export interface ResultMessage {
  type: 'result';
  winner: number | null;
}

/**
 * Change display name mid-session. Takes effect immediately: the stored
 * identity, any seat, and the lobby/room rosters update, visible to everyone
 * via the ensuing `room_list`/`spectators` pushes. Names inside a running
 * match (`match_start.players`) refresh at the next game.
 */
export interface RenameMessage {
  type: 'rename';
  /** New display name, 1..{@link MAX_PLAYER_NAME_LENGTH} chars. */
  name: string;
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
  | SpectateMessage
  | ReadyMessage
  | InputsMessage
  | DigestMessage
  | ResultMessage
  | RenameMessage
  | ConcedeMessage
  | LeaveRoomMessage;

// --- Server → Client --------------------------------------------------------

/** Successful `hello`: the player's (possibly fresh) identity and record. */
export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  /** Session token to present on future `hello`s (store client-side). */
  token: string;
  /** Canonical display name (the hello name, as stored). */
  name: string;
  record: PlayerRecord;
}

/**
 * Lobby snapshot: every open room. Pushed to all connected players after any
 * change (create/join/leave/start/end) and immediately after `welcome`.
 */
export interface RoomListMessage {
  type: 'room_list';
  rooms: RoomSummary[];
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

/** Confirmation of `spectate`: the watcher is attached to the room. */
export interface SpectateJoinedMessage {
  type: 'spectate_joined';
  code: string;
  /** Seated players' names (0..2, in seat order). */
  players: string[];
  /** Everyone watching, including the recipient. */
  spectators: string[];
}

/**
 * A game is watchable: sent to each spectator at `match_start` (empty
 * ledgers) and on mid-match join (both ledgers so far — the same late-join
 * mechanism as `match_resume`). The spectator runs a third sim pair and is
 * fed both players' `peer_inputs` streams from here on.
 */
export interface SpectateStartMessage {
  type: 'spectate_start';
  seed: number;
  inputDelay: number;
  players: [string, string];
  frames: [number[], number[]];
}

/** The room's watcher roster changed (sent to players and spectators). */
export interface SpectatorsMessage {
  type: 'spectators';
  names: string[];
}

/** The room evaporated under a spectator (all players left). */
export interface RoomClosedMessage {
  type: 'room_closed';
}

/** Digest comparison failed at `tick`: the sims have diverged. */
export interface DesyncMessage {
  type: 'desync';
  tick: number;
}

/**
 * The opponent's connection dropped mid-match. The match holds for up to
 * `graceMs` awaiting their reconnect; expiry forfeits it to the survivor.
 */
export interface PeerDroppedMessage {
  type: 'peer_dropped';
  name: string;
  graceMs: number;
}

/** The dropped opponent reconnected; the match resumes. */
export interface PeerRejoinedMessage {
  type: 'peer_rejoined';
  name: string;
}

/**
 * Sent to a player who reconnected (hello with a token that has an in-progress
 * match): everything needed to rebuild the lockstep session and catch up.
 * `frames` are both players' full input histories from tick 0, indexed by
 * player index — the server's ledgers are authoritative, including for the
 * rejoiner's own stream (anything it scheduled but never sent is gone).
 */
export interface MatchResumeMessage {
  type: 'match_resume';
  seed: number;
  playerIndex: number;
  inputDelay: number;
  players: [string, string];
  frames: [number[], number[]];
}

/**
 * Why a match ended: `result` confirms an agreed client-reported gameplay
 * outcome (v2); the others are events the deterministic sims cannot decide.
 */
export type MatchEndReason = 'result' | 'concession' | 'disconnect' | 'desync';

/**
 * The match is over and the room is back to waiting (re-ready for a rematch).
 * `winner` is a player index, or null if void (desync) or a draw (`result`
 * with a same-tick double loss).
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
  | RoomListMessage
  | PeerDroppedMessage
  | PeerRejoinedMessage
  | MatchResumeMessage
  | SpectateJoinedMessage
  | SpectateStartMessage
  | SpectatorsMessage
  | RoomClosedMessage
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
