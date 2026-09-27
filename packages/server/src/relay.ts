/**
 * relay.ts — the lockstep relay + lobby, transport-free.
 *
 * All room/match logic lives here against a tiny {@link ClientConnection}
 * abstraction, so it unit-tests without sockets; `wsServer.ts` is the thin
 * WebSocket wrapper. The relay runs no simulation during play — it forwards input
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
 * The relay does run a simulation in one place: a disputed game. When the
 * players' results disagree, or their digests do, it re-simulates the match
 * from the seed and both ledgers on the {@link Verifier}'s queue and records
 * what actually happened, so a loser can't erase a loss by reporting a win or
 * forging a digest (see {@link RelayServer.settle}).
 *
 * Rated rooms (protocol v5) are for accounts: a `hello` may carry an
 * account's session. A rated game is rated only once the relay has decided
 * it: by re-simulating it when it's played out (whatever the reports say), or
 * directly for a concession or a forfeit. Ratings are Glicko-2
 * (`glicko.ts`), and every rated game is logged with both players' inputs.
 *
 * Accounts may also queue for a rated game (protocol v6): the relay pairs the
 * two closest ratings inside both players' windows (`matchmaker.ts`), asks
 * both to accept, and seats them in a new rated room. The queue lives in
 * memory, like rooms: a restart or a disconnect empties it.
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import { GC_STEPS_PER_SECOND, SIM_VERSION } from '@crack-attack/core';
import {
  DEFAULT_INPUT_DELAY_TICKS,
  DEFAULT_RECONNECT_GRACE_MS,
  MAX_MATCH_FRAMES,
  PROTOCOL_VERSION,
  QUEUE_ACCEPT_MS,
  RATED_GAMES_PER_PAIR_PER_DAY,
  SESSION_TTL_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SESSION_TOKEN_LENGTH,
  ProtocolError,
  decodeClientMessage,
  encodeMessage,
  type AiDifficulty,
  type AiOpponentInfo,
  type ClientMessage,
  type ErrorCode,
  type HelloMessage,
  type MatchEndReason,
  type PlayerRating,
  type PlayerRecord,
  type RatedGameEnd,
  type RatingChange,
  type RoomSummary,
  type ServerMessage,
} from '@crack-attack/protocol';
import { randomBytes } from 'node:crypto';
import { accountKey, type AccountStore, type StoredAccount } from './accountStore.js';
import { secretHash, shownRating, type SessionsEnded } from './accounts.js';
import { rateGame } from './glicko.js';
import { bestPair, queueWindow, type QueueEntry } from './matchmaker.js';
import { MemoryStore, type LobbyStore } from './store.js';
import { Verifier } from './verifier.js';

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
 * How far (in ticks) a seat's input frontier may run ahead of real time since
 * `match_start`, on top of the match's `inputDelay` pre-fill. An honest client
 * samples one frame per stepped tick and its fixed timestep never steps faster
 * than wall-clock 50 Hz (catch-up bursts only replay already-buffered *remote*
 * frames; the countdown gate makes it lag), and it receives `match_start` after
 * the server stamped it — so it only ever trails this bound. The 2 s allowance
 * is generous slack for clock-rate skew and batching. A client beyond it is
 * flooding the ledger faster than the game can be played: fatal.
 */
export const MAX_INPUT_LEAD_TICKS = 2 * GC_STEPS_PER_SECOND;

/** How often a playing room is checked for a stalled game or a withheld result. */
const WATCHDOG_EVERY_MS = 5000;

/** How long a rated game keeps its inputs in the log. */
export const RATED_INPUTS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;
/** Old rated games' inputs are dropped at most this often (after a rated game). */
const INPUT_SWEEP_EVERY_MS = 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Who a connection plays as: a guest (keyed by its token) or an account
 * (keyed by {@link accountKey}, whatever session it logged in with).
 */
interface Identity {
  /** The token `hello` carried (or was given): a guest's, or an account's session. */
  token: string;
  /** Whose record a game counts for. */
  key: string;
  name: string;
  record: PlayerRecord;
  account: { id: number; rating: PlayerRating } | null;
}

/**
 * A player's place in a room. Unlike a connection, a seat survives a
 * mid-match disconnect (reconnect grace): it keeps the identity, the full
 * input ledger for the current game, and the pending digests.
 */
interface Seat {
  /** Live connection, or null while the player is dropped (grace running). */
  conn: ClientConnection | null;
  token: string;
  /** The identity's record key (see {@link Identity}). */
  key: string;
  name: string;
  record: { wins: number; losses: number };
  /** The account's rating, shown in the room list; null for a guest or bot. */
  rating: PlayerRating | null;
  account_id: number | null;
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
  /** `now()` when the result was reported, or when the seat last sent inputs. */
  reported_at: number;
  progress_at: number;
  /**
   * Set iff this is a bot seat (no connection, no token). The bot plays a
   * deterministic sim every client computes locally, so the relay only records
   * its presence — it never sends match_start/inputs/digests, and its stream
   * never crosses the wire.
   */
  ai?: AiDifficulty;
}

interface Room {
  code: string;
  seats: Seat[];
  /**
   * Watchers: live sessions running a third sim pair off both players' input
   * streams. Connection-bound (no reconnect grace — re-spectating is cheap).
   */
  spectators: Session[];
  state: 'waiting' | 'playing';
  /** Created rated: only accounts may sit. */
  rated: boolean;
  /** Whether the current (or last) match counts: a rated room, under the pair's daily cap. */
  match_rated: boolean;
  /** A rated start is checking the pair's cap: don't start twice. */
  starting: boolean;
  /** Seed of the current match (kept for `match_resume`). */
  seed: number;
  /** `now()` at the current match's start: the input-pacing baseline. */
  started_at: number;
  /**
   * Digests at or below this tick are ignored: set on resume to the ledger
   * frontier, since the rejoining client replays from tick 0 and resubmits
   * digests its peer already had matched and discarded.
   */
  digest_floor: number;
  /** Pending grace expiry, when a seat is dropped. */
  grace_timer: ReturnType<typeof setTimeout> | null;
  /** While playing: the check for a stalled game or a withheld result. */
  watchdog: ReturnType<typeof setTimeout> | null;
}

/**
 * A game to settle, copied out of its room before the match ends: enough to
 * re-simulate it and to credit the result to the players, wherever they are by
 * the time the verdict lands. Arrays are by match index.
 */
interface Settlement {
  code: string;
  seed: number;
  ledgers: [number[], number[]];
  keys: [string, string];
  names: [string, string];
  /** Set iff the game is rated: both seats' accounts. */
  accounts: [number, number] | null;
  /**
   * What each seat claimed: the winner each reported (undefined if it
   * reported none), or the digests each submitted for `tick`.
   */
  claim:
    | { kind: 'result'; winners: [number | null | undefined, number | null | undefined] }
    | { kind: 'digest'; tick: number; digests: [[number, number], [number, number]] }
    /** A seat left, ran out its grace, or stalled: it loses unless the game had ended. */
    | { kind: 'forfeit'; leaver: number };
  /**
   * For a rated game: frees its place in the pair's count of rated games in
   * progress, once it's been rated or found unratable. Called once.
   */
  release: (() => void) | null;
}

/** An account waiting in the rated queue. */
interface Queued {
  session: Session;
  accountId: number;
  /** On the relay's clock; kept if a found match falls through. */
  joinedAt: number;
  /** The window last reported in `queue_status`, to tell it when it widens. */
  lastWindow: number;
}

/** A pairing the queue found, waiting for both sides to accept. */
interface Proposal {
  sides: [Queued, Queued];
  accepted: [boolean, boolean];
  timer: ReturnType<typeof setTimeout>;
}

/** How often the queue re-pairs, as windows widen. */
const QUEUE_TICK_MS = 1000;

/** A live, helloed connection: identity plus (optionally) a seat or a watch. */
interface Session {
  conn: ClientConnection;
  identity: Identity;
  room: Room | null;
  seat: Seat | null;
  /** Room this session is spectating (mutually exclusive with a seat). */
  watching: Room | null;
}

/**
 * CSPRNG-backed float source, the default entropy. Session tokens are the
 * identity key (they reclaim records and in-progress matches), so guessable
 * tokens are an account-takeover primitive — the default must be secure even
 * when RelayServer is constructed directly. Tests inject deterministic
 * entropy via {@link RelayServerOptions.entropy}.
 */
export function cryptoEntropy(): number {
  return randomBytes(4).readUInt32BE(0) / 0x100000000;
}

/** Uniform uint32 from an injectable float source. */
function randomUint32(entropy: () => number): number {
  return (entropy() * 0x100000000) >>> 0;
}

/**
 * Remove `item` from `arr` if present. Never `splice(indexOf(...), 1)`
 * directly: indexOf's -1 on a missing item would silently remove the *last*
 * element (e.g. corrupting a roster on a double-detach).
 */
function removeItem<T>(arr: T[], item: T): void {
  const i = arr.indexOf(item);
  if (i >= 0) arr.splice(i, 1);
}

export interface RelayServerOptions {
  /** Float source in [0, 1); defaults to a CSPRNG. Inject only for tests. */
  entropy?: (() => number) | undefined;
  inputDelay?: number | undefined;
  /** Persistence backend; defaults to an in-memory store. */
  store?: LobbyStore | undefined;
  /** Reconnect grace in ms; DEFAULT_RECONNECT_GRACE_MS unless overridden. */
  graceMs?: number | undefined;
  /**
   * Monotonic clock in ms for input pacing; defaults to `performance.now()`
   * (unlike `Date.now()`, it can't jump backwards on an NTP/clock adjustment
   * and wrongly disconnect honest players). Inject for tests.
   */
  now?: (() => number) | undefined;
  /** Re-simulates disputed games; share the scoreboard's. Defaults to a private one. */
  verifier?: Verifier | undefined;
  /** Where dispute verdicts are logged; defaults to `console.warn`. */
  log?: ((line: string) => void) | undefined;
  /** Accounts and the rated-game log; without it, `hello` knows guests only and nothing is rated. */
  accounts?: AccountStore | undefined;
  /** Wall clock in epoch ms (sessions, ratings, the pair cap's day). Inject for tests. */
  wallClock?: (() => number) | undefined;
  /**
   * How long a game may go without progress (no inputs from either seat) or
   * with one seat's result unanswered before the relay settles it itself.
   * Defaults to the reconnect grace.
   */
  stallMs?: number | undefined;
}

/** Point-in-time counts for the relay's STATS probe (`stats.ts`). */
export interface RelayStats {
  /** Open connections, helloed or not. */
  connections: number;
  /** Helloed connections. */
  sessions: number;
  rooms: number;
  /** Rooms with a match in progress. */
  playing: number;
  /** Spectators across all rooms. */
  spectators: number;
  /** Seats dropped mid-match, their reconnect grace running. */
  dropped: number;
  /** Longest input ledger of any seat, in frames. */
  maxLedger: number;
}

export class RelayServer {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<ClientConnection, Session | null>();
  /** Dropped mid-match, grace pending: token → their room. */
  private readonly dropped = new Map<string, Room>();
  /** The rated queue, oldest first. */
  private readonly queue = new Map<Session, Queued>();
  /** Found matches awaiting acceptance, by each side's session. */
  private readonly proposals = new Map<Session, Proposal>();
  /** Whom the queue last paired each player with, by record key. */
  private readonly lastQueueOpponent = new Map<string, string>();
  /** Account pairs known to be at today's rated cap: pair → the UTC day's start. */
  private readonly cappedPairs = new Map<string, number>();
  private queueTimer: ReturnType<typeof setTimeout> | null = null;
  /** A pairing pass is running (it awaits the store, so passes mustn't overlap). */
  private matching = false;
  private readonly entropy: () => number;
  private readonly inputDelay: number;
  private readonly store: LobbyStore;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly verifier: Verifier;
  private readonly log: (line: string) => void;
  private readonly accounts: AccountStore | null;
  private readonly wallClock: () => number;
  private readonly stallMs: number;
  /** Rated matches started but not yet written, by account pair: they count toward the cap. */
  private readonly ratedInFlight = new Map<string, number>();
  /** Rated games apply one at a time: each reads both ratings, then writes them. */
  private ratingChain: Promise<void> = Promise.resolve();
  /** Settlements waiting on a replay. */
  private readonly settling = new Set<Promise<void>>();
  private lastInputSweep = -Infinity;

  constructor(options: RelayServerOptions = {}) {
    this.entropy = options.entropy ?? cryptoEntropy;
    this.inputDelay = options.inputDelay ?? DEFAULT_INPUT_DELAY_TICKS;
    this.store = options.store ?? new MemoryStore();
    this.graceMs = options.graceMs ?? DEFAULT_RECONNECT_GRACE_MS;
    this.now = options.now ?? (() => performance.now());
    this.verifier = options.verifier ?? new Verifier();
    this.log = options.log ?? ((line) => console.warn(line));
    this.accounts = options.accounts ?? null;
    this.wallClock = options.wallClock ?? Date.now;
    this.stallMs = options.stallMs ?? this.graceMs;
  }

  /** Resolves once every game settled so far has been recorded (for tests). */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.ratingChain;
      await Promise.all([...this.settling, chain]);
      if (this.settling.size === 0 && chain === this.ratingChain) return;
    }
  }

  /** Number of open rooms (inspection/test helper). */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Session and room counts. Walks every room, so call it now and then, not per message. */
  stats(): RelayStats {
    let sessions = 0;
    for (const session of this.sessions.values()) if (session) sessions++;
    let playing = 0;
    let spectators = 0;
    let maxLedger = 0;
    for (const room of this.rooms.values()) {
      if (room.state === 'playing') playing++;
      spectators += room.spectators.length;
      for (const seat of room.seats) maxLedger = Math.max(maxLedger, seat.frames.length);
    }
    return {
      connections: this.sessions.size,
      sessions,
      rooms: this.rooms.size,
      playing,
      spectators,
      dropped: this.dropped.size,
      maxLedger,
    };
  }

  /** Cancel outstanding timers (transport shutdown). */
  shutdown(): void {
    for (const room of this.rooms.values()) {
      if (room.grace_timer !== null) clearTimeout(room.grace_timer);
      room.grace_timer = null;
      this.stopWatchdog(room);
    }
  }

  /**
   * Account sessions have ended (a log out, a new key, a deleted account):
   * close their lobby connections, which were let in on them. A reconnect
   * then comes back as a guest, or not at all.
   */
  sessionsEnded(ended: SessionsEnded): void {
    for (const session of this.sessions.values()) {
      const account = session?.identity.account;
      if (!session || !account) continue;
      const hash = secretHash(session.identity.token);
      const gone =
        ended.kind === 'session'
          ? hash === ended.sessionHash
          : account.id === ended.accountId && hash !== ended.except;
      if (!gone) continue;
      this.error(session.conn, 'bad_message', 'your session has ended; log in again');
      session.conn.close();
    }
    if (this.queueTimer !== null) clearTimeout(this.queueTimer);
    this.queueTimer = null;
    for (const p of this.proposals.values()) clearTimeout(p.timer);
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
    if (!session) return;
    // No grace for the queue: a disconnect leaves it (and declines a found match).
    this.leaveQueue(session, false);
    // Whom the queue last paired it with only matters while it's connected.
    const key = session.identity.key;
    if (![...this.sessions.values()].some((s) => s?.identity.key === key)) {
      this.lastQueueOpponent.delete(key);
    }

    if (session.watching) {
      this.stopSpectating(session);
      return;
    }
    if (!session.room || !session.seat) return;

    // Reconnect grace applies only to human-vs-human matches. In a vs-AI room
    // the bot can't play on alone, so a human drop just tears the room down
    // (handled by leaveRoom, whose sole-bot-remaining case closes the room).
    if (session.room.state === 'playing' && this.aiSeatOf(session.room) === undefined) {
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
        this.handleCreateRoom(session, msg.aiOpponent, msg.rated === true);
        return;
      case 'join_room':
        this.handleJoinRoom(session, msg.code);
        return;
      case 'spectate':
        this.handleSpectate(session, msg.code);
        return;
      case 'ready':
        await this.handleReady(session);
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
      case 'rename':
        await this.handleRename(session, msg.name);
        return;
      case 'concede':
        await this.handleConcede(session);
        return;
      case 'leave_room':
        this.handleLeave(session);
        return;
      case 'queue_join':
        this.handleQueueJoin(session);
        return;
      case 'queue_leave':
        if (!this.leaveQueue(session, true)) this.sendQueueStatus(session, null);
        return;
      case 'queue_accept':
        this.handleQueueAccept(session);
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
    const session: Session = { conn, identity, room: null, seat: null, watching: null };
    this.sessions.set(conn, session);
    this.send(conn, {
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      token: identity.token,
      name: identity.name,
      record: identity.record,
      rating: identity.account?.rating ?? null,
    });
    this.send(conn, { type: 'room_list', rooms: this.roomSummaries(), queued: this.queue.size });

    // Reconnect: this token has a seat in a playing room within grace.
    const room = this.dropped.get(identity.token);
    if (room) this.resumeSeat(session, room);
  }

  /**
   * Token lookup: a guest's token, then an account's session, with fallback to
   * a freshly minted guest.
   */
  private async resolveIdentity(msg: HelloMessage): Promise<Identity> {
    if (msg.token !== undefined) {
      const guest = await this.store.getPlayer(msg.token, msg.name);
      if (guest) return { ...guest, key: guest.token, account: null };
      if (this.accounts) {
        const now = this.wallClock();
        const account = await this.accounts.useSession(
          secretHash(msg.token),
          now,
          now - SESSION_TTL_MS,
        );
        if (account) return accountIdentity(msg.token, account);
      }
      // Unknown token (expired store, other server): mint fresh below.
    }
    const guest = await this.store.createPlayer(this.generateToken(), msg.name);
    return { ...guest, key: guest.token, account: null };
  }

  // --- Reconnect grace -----------------------------------------------------------

  /** A playing seat lost its connection: hold the match and start the clock. */
  private dropSeat(room: Room, seat: Seat): void {
    seat.conn = null;
    this.dropped.set(seat.token, room);
    const dropped: ServerMessage = {
      type: 'peer_dropped',
      name: seat.name,
      graceMs: this.graceMs,
    };
    const peer = room.seats.find((s) => s !== seat);
    if (peer?.conn) this.send(peer.conn, dropped);
    for (const w of room.spectators) this.send(w.conn, dropped);
    if (room.grace_timer !== null) clearTimeout(room.grace_timer);
    room.grace_timer = setTimeout(() => {
      room.grace_timer = null;
      this.expireGrace(room, seat);
    }, this.graceMs);
  }

  /** Grace ran out: the dropped seat forfeits and leaves the room. */
  private expireGrace(room: Room, seat: Seat): void {
    this.dropped.delete(seat.token);
    removeItem(room.seats, seat);

    const peer = room.seats[0];
    if (!peer) {
      this.closeRoom(room);
      this.broadcastRoomList();
      return;
    }
    // The dropped seat forfeits, unless the replay shows the game had already
    // ended: then that result stands (a loser can't win by leaving the winner
    // waiting for a result that never comes).
    this.settle(
      this.settlement(room, [seat, peer], { kind: 'forfeit', leaver: seat.match_index }),
      'disconnect',
    );
    this.endMatch(room, 'disconnect', peer.match_index);
    if (peer.conn) this.send(peer.conn, { type: 'peer_left', name: seat.name });
    for (const w of room.spectators) this.send(w.conn, { type: 'peer_left', name: seat.name });
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
      rated: room.match_rated,
    });
    const peer = room.seats.find((s) => s !== seat);
    if (peer?.conn) this.send(peer.conn, { type: 'peer_rejoined', name: seat.name });
    for (const w of room.spectators) this.send(w.conn, { type: 'peer_rejoined', name: seat.name });
  }

  // --- Room flow ---------------------------------------------------------------

  private newSeat(session: Session): Seat {
    const { identity } = session;
    return {
      conn: session.conn,
      token: identity.token,
      key: identity.key,
      name: identity.name,
      record: { ...identity.record },
      rating: identity.account ? { ...identity.account.rating } : null,
      account_id: identity.account?.id ?? null,
      ready: false,
      match_index: 0,
      frames: [],
      digests: new Map(),
      reported_result: undefined,
      reported_at: 0,
      progress_at: 0,
    };
  }

  /** A bot seat: no connection or token; every client plays it deterministically. */
  private newAiSeat(difficulty: AiDifficulty): Seat {
    return {
      conn: null,
      token: '',
      key: '',
      name: `CPU (${difficulty})`,
      record: { wins: 0, losses: 0 },
      rating: null,
      account_id: null,
      ready: false,
      match_index: 1,
      frames: [],
      digests: new Map(),
      reported_result: undefined,
      reported_at: 0,
      progress_at: 0,
      ai: difficulty,
    };
  }

  /** The room's bot seat, if any. */
  private aiSeatOf(room: Room): Seat | undefined {
    return room.seats.find((s) => s.ai !== undefined);
  }

  private handleCreateRoom(
    session: Session,
    aiOpponent: { difficulty: AiDifficulty } | undefined,
    rated: boolean,
  ): void {
    this.leaveQueue(session, true);
    if (session.room || session.watching) {
      this.error(session.conn, 'bad_message', 'already in a room');
      return;
    }
    if (rated && !session.identity.account) {
      this.error(session.conn, 'account_required', 'log in to an account to play rated');
      return;
    }
    if (rated && aiOpponent) {
      this.error(session.conn, 'bad_message', 'a game against a bot is never rated');
      return;
    }
    if (this.busyElsewhere(session)) return;
    const code = this.generateRoomCode();
    const seat = this.newSeat(session);
    // A vs-AI room is created full: the human plus a bot seat, so a single
    // ready starts the match (no second human awaited).
    const seats = aiOpponent ? [seat, this.newAiSeat(aiOpponent.difficulty)] : [seat];
    const room: Room = {
      code,
      seats,
      spectators: [],
      state: 'waiting',
      rated,
      match_rated: false,
      starting: false,
      seed: 0,
      started_at: 0,
      digest_floor: -1,
      grace_timer: null,
      watchdog: null,
    };
    this.rooms.set(code, room);
    session.room = room;
    session.seat = seat;
    this.send(session.conn, { type: 'room_created', code });
    this.broadcastRoomList();
  }

  private handleJoinRoom(session: Session, code: string): void {
    this.leaveQueue(session, true);
    if (session.room || session.watching) {
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
    if (room.rated && !session.identity.account) {
      this.error(session.conn, 'account_required', 'log in to an account to play rated');
      return;
    }
    if (room.rated && room.seats.some((s) => s.key === session.identity.key)) {
      this.error(session.conn, 'bad_message', "a rated game can't be against yourself");
      return;
    }
    if (this.busyElsewhere(session)) return;
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

  /** Attach a watcher to a room; a playing room also ships the ledgers. */
  private handleSpectate(session: Session, code: string): void {
    this.leaveQueue(session, true);
    if (session.room || session.watching) {
      this.error(session.conn, 'bad_message', 'already in a room');
      return;
    }
    const room = this.rooms.get(code);
    if (!room) {
      this.error(session.conn, 'room_not_found', `no room ${code}`);
      return;
    }
    room.spectators.push(session);
    session.watching = room;
    this.send(session.conn, {
      type: 'spectate_joined',
      code,
      players: room.seats.map((s) => s.name),
      spectators: room.spectators.map((s) => s.identity.name),
    });
    if (room.state === 'playing') {
      // Mid-match late-join: the same ledger mechanism as match_resume.
      const ai = this.aiSeatOf(room);
      this.send(session.conn, {
        type: 'spectate_start',
        seed: room.seed,
        inputDelay: this.inputDelay,
        players: this.matchNames(room),
        frames: this.ledgers(room),
        ...(ai ? { aiOpponent: { difficulty: ai.ai!, index: ai.match_index } } : {}),
        rated: room.match_rated,
      });
    }
    this.broadcastSpectators(room);
    this.broadcastRoomList();
  }

  /** A spectator detaches (leave_room or disconnect). */
  private stopSpectating(session: Session): void {
    const room = session.watching;
    if (!room) return;
    removeItem(room.spectators, session);
    session.watching = null;
    this.broadcastSpectators(room);
    this.broadcastRoomList();
  }

  /** Push the watcher roster to everyone in the room (players + watchers). */
  private broadcastSpectators(room: Room): void {
    const msg: ServerMessage = {
      type: 'spectators',
      names: room.spectators.map((s) => s.identity.name),
    };
    const text = encodeMessage(msg);
    for (const s of room.seats) s.conn?.send(text);
    for (const w of room.spectators) w.conn.send(text);
  }

  /** Delete a room, telling any watchers it evaporated. */
  /**
   * An account may hold one seat at a time, whichever browsers it's logged in
   * on: otherwise two accounts could play any number of rated games at once,
   * each started under the day's cap. Says so, and true, if it already has one.
   */
  private busyElsewhere(session: Session): boolean {
    if (!session.identity.account) return false;
    const key = session.identity.key;
    const mine = (other: Session): boolean => other !== session && other.identity.key === key;
    for (const room of this.rooms.values()) {
      if (room.seats.some((s) => s.key === key)) {
        this.error(session.conn, 'bad_message', "you're already in a room on another connection");
        return true;
      }
    }
    // The queue too: two connections each queued could be paired at once.
    if ([...this.queue.keys(), ...this.proposals.keys()].some(mine)) {
      this.error(session.conn, 'bad_message', "you're already in the queue on another connection");
      return true;
    }
    return false;
  }

  private closeRoom(room: Room): void {
    this.stopWatchdog(room);
    for (const w of room.spectators) {
      w.watching = null;
      this.send(w.conn, { type: 'room_closed' });
    }
    room.spectators.length = 0;
    this.rooms.delete(room.code);
  }

  /**
   * Readiness. In a waiting room this arms the match start; sent while a match
   * is `playing` it means "this game is over on my screen, ready for a rematch".
   * When both players are ready, a fresh seed starts the next game.
   */
  private async handleReady(session: Session): Promise<void> {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat) {
      this.error(session.conn, 'not_in_room', 'ready outside a room');
      return;
    }
    seat.ready = true;
    // A bot seat is always ready; the match starts once every human is.
    // A dropped seat (its grace running) isn't ready for anything: a game
    // started without it would be forfeited by its old grace timer.
    const allReady = (): boolean =>
      room.seats.length === 2 &&
      room.seats.every((s) => s.ai !== undefined || (s.ready && s.conn !== null));
    if (!allReady() || room.starting) return;
    let rated = false;
    if (room.rated) {
      const [a, b] = room.seats as [Seat, Seat];
      room.starting = true;
      try {
        rated = await this.underPairCap(a, b);
      } finally {
        room.starting = false;
      }
      // The room may have changed while the store was asked; the answer is
      // only good for the pair it was about.
      const same = room.seats[0] === a && room.seats[1] === b;
      if (this.rooms.get(room.code) !== room || !same || !allReady()) return;
    }
    this.startMatch(room, rated);
  }

  /** Whether two accounts have rated games left today (UTC). A store failure plays it casual. */
  private async underPairCap(a: Seat, b: Seat): Promise<boolean> {
    if (a.account_id === null || b.account_id === null) return false;
    const played = await this.ratedGamesToday(a.account_id, b.account_id);
    return played !== null && played < RATED_GAMES_PER_PAIR_PER_DAY;
  }

  /** Rated games two accounts have played today (UTC); null if the store can't say. */
  private async ratedGamesToday(a: number, b: number): Promise<number | null> {
    if (!this.accounts) return null;
    try {
      const played = await this.accounts.countRatedGames(a, b, this.utcDayStart());
      // Rated games under way count too: they'll be written once settled.
      return played + (this.ratedInFlight.get(pairKey(a, b)) ?? 0);
    } catch (err) {
      console.error('relay: failed to count rated games:', err);
      return null;
    }
  }

  private utcDayStart(): number {
    const now = this.wallClock();
    return now - (now % MS_PER_DAY);
  }

  // --- The rated queue ------------------------------------------------------------------

  private handleQueueJoin(session: Session): void {
    const account = session.identity.account;
    if (!account || !this.accounts) {
      this.error(session.conn, 'account_required', 'log in to an account to play rated');
      return;
    }
    if (session.room || session.watching) {
      this.error(session.conn, 'bad_message', 'leave the room first');
      return;
    }
    if (this.queue.has(session) || this.proposals.has(session)) {
      this.sendQueueStatus(session, this.queue.get(session) ?? null);
      return;
    }
    if (this.busyElsewhere(session)) return;
    const now = this.now();
    this.queue.set(session, {
      session,
      accountId: account.id,
      joinedAt: now,
      lastWindow: 0,
    });
    this.queueChanged();
  }

  /**
   * Take `session` out of the queue, or decline its found match (the other
   * side goes back in). With `notify`, it's told it's out. False if it wasn't
   * queued at all.
   */
  private leaveQueue(session: Session, notify: boolean): boolean {
    if (this.queue.delete(session)) {
      if (notify) this.sendQueueStatus(session, null);
      this.queueChanged();
      return true;
    }
    const proposal = this.proposals.get(session);
    if (!proposal) return false;
    this.endProposal(proposal, (side) => side.session !== session);
    return true;
  }

  private handleQueueAccept(session: Session): void {
    const proposal = this.proposals.get(session);
    if (!proposal) {
      this.error(session.conn, 'bad_message', 'no match to accept');
      return;
    }
    proposal.accepted[proposal.sides[0].session === session ? 0 : 1] = true;
    if (!proposal.accepted[0] || !proposal.accepted[1]) return;
    clearTimeout(proposal.timer);
    for (const side of proposal.sides) this.proposals.delete(side.session);
    void this.seatQueuedPair(proposal.sides[0].session, proposal.sides[1].session);
  }

  /**
   * A found match is off: sides `keep` says so go back in the queue with the
   * time they'd waited, the rest are out.
   */
  private endProposal(proposal: Proposal, keep: (side: Queued) => boolean): void {
    clearTimeout(proposal.timer);
    for (const side of proposal.sides) {
      this.proposals.delete(side.session);
      if (keep(side) && this.sessions.has(side.session.conn)) {
        side.lastWindow = 0; // report the window afresh
        this.queue.set(side.session, side);
      } else {
        this.sendQueueStatus(side.session, null);
      }
    }
    this.queueChanged();
  }

  /** The queue changed: tell those in it where they stand, the lobby its size, and pair. */
  private queueChanged(): void {
    const now = this.now();
    for (const queued of this.queue.values()) this.sendQueueStatus(queued.session, queued, now);
    this.broadcastRoomList();
    this.scheduleQueueTick();
    void this.matchmake();
  }

  /** While anyone's queued, re-pair every second as windows widen. */
  private scheduleQueueTick(): void {
    if (this.queue.size === 0 || this.queueTimer !== null) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      const now = this.now();
      for (const queued of this.queue.values()) {
        if (this.windowOf(queued, now) !== queued.lastWindow) {
          this.sendQueueStatus(queued.session, queued, now);
        }
      }
      this.scheduleQueueTick();
      void this.matchmake();
    }, QUEUE_TICK_MS);
  }

  private windowOf(queued: Queued, now: number): number {
    return queueWindow(this.entryOf(queued), now);
  }

  private entryOf(queued: Queued): QueueEntry {
    const { identity } = queued.session;
    return {
      key: identity.key,
      rating: identity.account?.rating.rating ?? 0,
      joinedAt: queued.joinedAt,
      lastOpponent: this.lastQueueOpponent.get(identity.key) ?? null,
    };
  }

  private sendQueueStatus(session: Session, queued: Queued | null, now = this.now()): void {
    const window = queued ? this.windowOf(queued, now) : 0;
    if (queued) queued.lastWindow = window;
    this.send(session.conn, {
      type: 'queue_status',
      inQueue: queued !== null,
      queued: this.queue.size,
      waitedMs: queued ? Math.max(0, Math.round(now - queued.joinedAt)) : 0,
      window,
    });
  }

  /**
   * Pair whoever can be paired. Each candidate pair is checked against today's
   * cap in the store; one that's reached it is remembered for the day and
   * skipped.
   */
  private async matchmake(): Promise<void> {
    if (this.matching) return;
    this.matching = true;
    try {
      for (;;) {
        const day = this.utcDayStart();
        const queued = [...this.queue.values()];
        const entries = queued.map((q) => this.entryOf(q));
        const byEntry = new Map(entries.map((e, i) => [e, queued[i]!]));
        const pair = bestPair(entries, this.now(), (a, b) => {
          const key = pairKey(byEntry.get(a)!.accountId, byEntry.get(b)!.accountId);
          return this.cappedPairs.get(key) === day;
        });
        if (!pair) return;
        const [a, b] = [byEntry.get(pair[0])!, byEntry.get(pair[1])!];
        const played = await this.ratedGamesToday(a.accountId, b.accountId);
        if (played === null) return; // try again on the next tick
        if (played >= RATED_GAMES_PER_PAIR_PER_DAY) {
          // Only today's entries matter: drop older days' as a new one comes.
          for (const [pair, at] of this.cappedPairs) if (at !== day) this.cappedPairs.delete(pair);
          this.cappedPairs.set(pairKey(a.accountId, b.accountId), day);
          continue;
        }
        // Either may have left while the store was asked.
        if (this.queue.get(a.session) !== a || this.queue.get(b.session) !== b) continue;
        this.propose(a, b);
      }
    } finally {
      this.matching = false;
    }
  }

  private propose(a: Queued, b: Queued): void {
    this.queue.delete(a.session);
    this.queue.delete(b.session);
    const proposal: Proposal = {
      sides: [a, b],
      accepted: [false, false],
      timer: setTimeout(() => {
        // Whoever didn't accept in time leaves the queue.
        this.endProposal(proposal, (side) => proposal.accepted[proposal.sides.indexOf(side)]!);
      }, QUEUE_ACCEPT_MS),
    };
    for (const [me, them] of [
      [a, b],
      [b, a],
    ] as const) {
      this.proposals.set(me.session, proposal);
      this.lastQueueOpponent.set(me.session.identity.key, them.session.identity.key);
      this.send(me.session.conn, {
        type: 'match_found',
        opponent: them.session.identity.name,
        rating: { ...them.session.identity.account!.rating },
        acceptMs: QUEUE_ACCEPT_MS,
      });
    }
    this.queueChanged();
  }

  /** Both accepted: a new rated room, both seated, and the match under way. */
  private async seatQueuedPair(a: Session, b: Session): Promise<void> {
    const code = this.generateRoomCode();
    const seats = [this.newSeat(a), this.newSeat(b)];
    const room: Room = {
      code,
      seats,
      spectators: [],
      state: 'waiting',
      rated: true,
      match_rated: false,
      starting: true,
      seed: 0,
      started_at: 0,
      digest_floor: -1,
      grace_timer: null,
      watchdog: null,
    };
    this.rooms.set(code, room);
    for (const [session, seat] of [
      [a, seats[0]!],
      [b, seats[1]!],
    ] as const) {
      session.room = room;
      session.seat = seat;
      this.send(session.conn, { type: 'room_joined', code, players: seats.map((s) => s.name) });
    }
    this.broadcastRoomList();
    let rated = false;
    try {
      rated = await this.underPairCap(seats[0]!, seats[1]!);
    } finally {
      room.starting = false;
    }
    // Either may have left (or dropped) while the store was asked.
    if (this.rooms.get(code) !== room || room.seats.length !== 2 || room.state !== 'waiting') {
      return;
    }
    this.startMatch(room, rated);
  }

  private startMatch(room: Room, rated: boolean): void {
    // A rematch while a rated game is still in play (both readied without its
    // result settling it): the game still counts, as far as it went.
    if (room.state === 'playing' && room.match_rated) {
      const winners: [number | null | undefined, number | null | undefined] = [
        undefined,
        undefined,
      ];
      for (const s of room.seats) winners[s.match_index] = s.reported_result;
      this.settle(this.settlement(room, room.seats, { kind: 'result', winners }), 'result');
    }
    room.state = 'playing';
    room.match_rated = rated;
    if (rated) {
      // Held until the game is written (see Settlement.release), so a rematch
      // started before the last game's verdict lands still counts it.
      const pair = pairKey(room.seats[0]!.account_id!, room.seats[1]!.account_id!);
      this.ratedInFlight.set(pair, (this.ratedInFlight.get(pair) ?? 0) + 1);
    }
    // Server-generated seed, replacing the original's seed exchange
    // (Communicator.cxx:283-296). Both clients derive both sims from it.
    room.seed = randomUint32(this.entropy);
    room.started_at = this.now();
    room.digest_floor = -1;
    // Pin indices from the current seat order before deriving names.
    for (let i = 0; i < 2; i++) room.seats[i]!.match_index = i;
    const names = this.matchNames(room);
    const ai = this.aiSeatOf(room);
    // The bot descriptor everyone needs to reproduce its moves locally.
    const aiInfo: AiOpponentInfo | undefined = ai
      ? { difficulty: ai.ai!, index: ai.match_index }
      : undefined;
    for (let i = 0; i < 2; i++) {
      const s = room.seats[i]!;
      s.ready = false;
      s.frames = [];
      s.digests.clear();
      s.reported_result = undefined;
      s.progress_at = room.started_at;
      if (s.conn) {
        this.send(s.conn, {
          type: 'match_start',
          seed: room.seed,
          playerIndex: i,
          inputDelay: this.inputDelay,
          players: names,
          ...(aiInfo ? { aiOpponent: aiInfo } : {}),
          rated,
        });
      }
    }
    // Watchers start their third sim pair alongside (empty ledgers).
    for (const w of room.spectators) {
      this.send(w.conn, {
        type: 'spectate_start',
        seed: room.seed,
        inputDelay: this.inputDelay,
        players: names,
        frames: [[], []],
        ...(aiInfo ? { aiOpponent: aiInfo } : {}),
        rated,
      });
    }
    if (!ai) this.startWatchdog(room);
    this.broadcastRoomList();
  }

  /**
   * Check a playing room every few seconds for a game going nowhere, which a
   * player could otherwise use to turn a loss into a win (the opponent's only
   * ways out, leaving or conceding, would each be a loss):
   *
   * - **One seat's result unanswered** for {@link stallMs}: the game is over
   *   on that screen; settle it by replay, as if both had reported.
   * - **No inputs from either seat** for {@link stallMs}, with both connected:
   *   lockstep has stalled on whoever sent the fewest frames (the other can
   *   only run {@link inputDelay} ticks past it), so that seat forfeits,
   *   unless the replay shows the game had already ended.
   *
   * A dropped seat has its reconnect grace instead.
   */
  private startWatchdog(room: Room): void {
    this.stopWatchdog(room);
    const check = (): void => {
      room.watchdog = null;
      if (room.state !== 'playing' || this.rooms.get(room.code) !== room) return;
      if (room.seats.length === 2 && room.seats.every((s) => s.conn !== null)) {
        if (this.settleStalled(room)) return;
      }
      room.watchdog = setTimeout(check, WATCHDOG_EVERY_MS);
    };
    room.watchdog = setTimeout(check, WATCHDOG_EVERY_MS);
  }

  private stopWatchdog(room: Room): void {
    if (room.watchdog !== null) clearTimeout(room.watchdog);
    room.watchdog = null;
  }

  /** The watchdog's verdict (see {@link startWatchdog}); true if it ended the match. */
  private settleStalled(room: Room): boolean {
    const now = this.now();
    const [a, b] = room.seats as [Seat, Seat];
    const reported = room.seats.filter((s) => s.reported_result !== undefined);
    if (reported.length === 1) {
      const [only] = reported as [Seat];
      if (now - only.reported_at < this.stallMs) return false;
      const winners: [number | null | undefined, number | null | undefined] = [
        undefined,
        undefined,
      ];
      winners[only.match_index] = only.reported_result;
      this.settle(this.settlement(room, room.seats, { kind: 'result', winners }), 'result');
      this.endMatch(room, 'result', only.reported_result ?? null);
      this.broadcastRoomList();
      return true;
    }
    if (reported.length > 0) return false;
    if (now - Math.max(a.progress_at, b.progress_at) < this.stallMs) return false;
    if (a.frames.length === b.frames.length) return false;
    const staller = a.frames.length < b.frames.length ? a : b;
    const peer = staller === a ? b : a;
    this.settle(
      this.settlement(room, room.seats, { kind: 'forfeit', leaver: staller.match_index }),
      'disconnect',
    );
    this.endMatch(room, 'disconnect', peer.match_index);
    this.broadcastRoomList();
    return true;
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
      this.fatal(
        session.conn,
        `inputs batch starts at ${startTick}, expected ${seat.frames.length}`,
      );
      return;
    }
    const frontier = seat.frames.length + frames.length;
    // Ledger cap: the codec rejects longer match_resume/spectate_start
    // histories, so a seat past it could no longer be resumed or watched —
    // and the ledger lives in server memory. Fatal, like a contiguity break.
    if (frontier > MAX_MATCH_FRAMES) {
      this.fatal(session.conn, `inputs ledger would exceed ${MAX_MATCH_FRAMES} frames`);
      return;
    }
    // Pacing: the frontier may not outrun real time (see MAX_INPUT_LEAD_TICKS).
    // Checked against the server-side ledger, so a resumed client — which
    // replays from the ledger and only then sends live input — is unaffected;
    // a bot seat's stream never reaches the relay at all.
    // Clamped at 0 so even an injected clock that steps back can't shrink the allowance.
    const elapsed = Math.max(
      0,
      Math.floor(((this.now() - room.started_at) * GC_STEPS_PER_SECOND) / 1000),
    );
    const allowed = elapsed + this.inputDelay + MAX_INPUT_LEAD_TICKS;
    if (frontier > allowed) {
      this.fatal(session.conn, `inputs frontier ${frontier} runs ahead of the clock (${allowed})`);
      return;
    }
    for (const f of frames) seat.frames.push(f);
    seat.progress_at = this.now();
    const relayed: ServerMessage = {
      type: 'peer_inputs',
      playerIndex: seat.match_index,
      startTick,
      frames,
    };
    const text = encodeMessage(relayed);
    const peer = room.seats.find((s) => s !== seat);
    peer?.conn?.send(text);
    // Spectators consume both players' streams.
    for (const w of room.spectators) w.conn.send(text);
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
    // A bot peer never submits digests, so there is nothing to compare against.
    if (!peer || peer.ai !== undefined) return;

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
      // Then find out which seat's digests were true.
      const claimed: [[number, number], [number, number]] = [digests, digests];
      claimed[peer.match_index] = peerDigests;
      const dispute = this.settlement(room, room.seats, {
        kind: 'digest',
        tick,
        digests: claimed,
      });
      for (const s of room.seats) if (s.conn) this.send(s.conn, { type: 'desync', tick });
      for (const w of room.spectators) this.send(w.conn, { type: 'desync', tick });
      this.endMatch(room, 'desync', null);
      this.broadcastRoomList();
      this.settle(dispute, 'desync');
    }
  }

  /**
   * A client reports the game's deterministic outcome. Both must agree (they
   * compute it from identical sims); agreement records the W-L result and
   * returns the room to waiting. Disagreement ends the match as a desync, and
   * the relay then re-simulates it to find the real result.
   */
  private async handleResult(session: Session, winner: number | null): Promise<void> {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat || room.state !== 'playing') {
      this.error(session.conn, 'not_in_room', 'result outside a match');
      return;
    }
    seat.reported_result = winner;
    seat.reported_at = this.now();
    const peer = room.seats.find((s) => s !== seat);

    // Bot opponent: there is no second client to cross-check, and the outcome
    // is deterministic, so accept the human's report directly. Vs-AI games are
    // not persisted to W-L (the bot has no record). The room returns to waiting
    // for a rematch.
    if (peer && peer.ai !== undefined) {
      this.endMatch(room, 'result', winner);
      this.broadcastRoomList();
      return;
    }

    if (!peer || peer.reported_result === undefined) return;

    const winners: [number | null, number | null] = [winner, winner];
    winners[peer.match_index] = peer.reported_result;
    if (peer.reported_result !== winner) {
      const dispute = this.settlement(room, room.seats, { kind: 'result', winners });
      for (const s of room.seats) if (s.conn) this.send(s.conn, { type: 'desync', tick: 0 });
      this.endMatch(room, 'desync', null);
      this.broadcastRoomList();
      this.settle(dispute, 'result');
      return;
    }

    if (room.match_rated) {
      // Rated: the reports agree, but the relay decides. The result screen
      // doesn't wait; `rating_update` follows once the replay is done.
      this.settle(this.settlement(room, room.seats, { kind: 'result', winners }), 'result');
    } else if (winner !== null) {
      const winnerSeat = room.seats.find((s) => s.match_index === winner);
      const loserSeat = room.seats.find((s) => s.match_index !== winner);
      if (winnerSeat && loserSeat) await this.recordDecisive(winnerSeat.key, loserSeat.key);
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
    // Not before the game has begun (the client holds concession through the
    // countdown too, sending nothing, not even its pre-filled frames, until
    // it's over): a concession that early is only good for trading wins.
    const played = Math.max(...room.seats.map((s) => s.frames.length));
    if (played <= this.inputDelay) {
      this.error(session.conn, 'bad_message', "the game hasn't started");
      return;
    }
    const peer = room.seats.find((s) => s !== seat);
    if (peer && room.match_rated) {
      this.rateNow(this.settlement(room, room.seats), peer.match_index, 'concession');
    } else if (peer && peer.ai === undefined) {
      // A bot peer keeps no record; only persist against a real opponent.
      await this.recordDecisive(peer.key, seat.key);
    }
    this.endMatch(room, 'concession', peer ? peer.match_index : 1 - seat.match_index);
    this.broadcastRoomList();
  }

  /**
   * Live display-name change. The store's lookup-updates-name contract does
   * the persistence; the session, any seat, and every roster follow. Names
   * baked into a running match (`match_start.players`) refresh next game.
   */
  private async handleRename(session: Session, name: string): Promise<void> {
    if (session.identity.account) {
      this.error(session.conn, 'bad_message', "an account's handle changes on the account screen");
      return;
    }
    // Persist (getPlayer updates the stored name as a side effect of lookup).
    await this.store.getPlayer(session.identity.token, name);
    session.identity.name = name;
    if (session.seat) session.seat.name = name;

    // Everyone sees names through the lobby list; rooms with watchers also
    // carry names in the spectator roster.
    const room = session.room ?? session.watching;
    if (room && (room.spectators.length > 0 || session.watching)) {
      this.broadcastSpectators(room);
    }
    this.broadcastRoomList();
  }

  private handleLeave(session: Session): void {
    if (session.watching) {
      this.stopSpectating(session);
      return;
    }
    if (!session.room) {
      this.error(session.conn, 'not_in_room', 'leave_room outside a room');
      return;
    }
    this.leaveRoom(session);
    this.broadcastRoomList();
  }

  // --- Lifecycle ---------------------------------------------------------------

  /**
   * Persist a decisive casual game and update the cached records: every seat
   * and live session with either key, since a disputed game's verdict can land
   * after its players have moved on.
   */
  private async recordDecisive(winnerKey: string, loserKey: string): Promise<void> {
    await this.store.recordResult(winnerKey, loserKey);
    this.forEachIdentity((record, key) => {
      if (key === winnerKey) record.wins++;
      else if (key === loserKey) record.losses++;
    });
  }

  /** Visit every cached record: each seat's and each live session's. */
  private forEachIdentity(
    visit: (record: PlayerRecord, key: string, holder: Seat | Identity) => void,
  ): void {
    for (const room of this.rooms.values()) {
      for (const seat of room.seats) if (seat.key !== '') visit(seat.record, seat.key, seat);
    }
    for (const s of this.sessions.values())
      if (s) visit(s.identity.record, s.identity.key, s.identity);
  }

  /**
   * Copy what settling a game needs out of the room, before `endMatch` clears
   * it. `seats` are the match's two seats (one may already have left the room).
   */
  private settlement(
    room: Room,
    seats: readonly Seat[],
    claim: Settlement['claim'] = { kind: 'result', winners: [undefined, undefined] },
  ): Settlement {
    const ledgers: [number[], number[]] = [[], []];
    const keys: [string, string] = ['', ''];
    const names: [string, string] = ['?', '?'];
    const accounts: [number | null, number | null] = [null, null];
    for (const s of seats) {
      ledgers[s.match_index] = [...s.frames];
      keys[s.match_index] = s.key;
      names[s.match_index] = s.name;
      accounts[s.match_index] = s.account_id;
    }
    const [a, b] = accounts;
    const rated = room.match_rated && a !== null && b !== null;
    let release: (() => void) | null = null;
    if (rated) {
      const pair = pairKey(a, b);
      release = () => {
        release = null;
        const left = (this.ratedInFlight.get(pair) ?? 1) - 1;
        if (left > 0) this.ratedInFlight.set(pair, left);
        else this.ratedInFlight.delete(pair);
      };
    }
    return {
      code: room.code,
      seed: room.seed,
      ledgers,
      keys,
      names,
      accounts: rated ? [a, b] : null,
      claim,
      release: () => release?.(),
    };
  }

  /**
   * Re-simulate a game in the background and record what it finds. Casual
   * games come here only when disputed; a rated game always does, unless it
   * ended by a concession or a forfeit (see {@link rateNow}).
   *
   * - **Results:** the match is played out from the ledgers. If it ends, and
   *   one seat reported that ending (or neither reported one: a rated game a
   *   rematch cut short), that's the result.
   * - **Digests disagree:** the match is played to the digest's tick. If it
   *   ended by then, that's the result. Otherwise, if exactly one seat's
   *   digests are the true ones, the other seat's sims left the game both
   *   players were sent, so it takes the loss, as for a concession.
   * - **A forfeit** (a seat left, ran out its grace, or stalled): if the
   *   replay shows the game had ended, that's the result; otherwise the seat
   *   that went loses.
   *
   * Anything else (the ledgers stop before the game ends, the replay agrees
   * with neither seat) records nothing. Disputes and failures are logged.
   */
  private settle(settlement: Settlement, end: RatedGameEnd): void {
    const { claim } = settlement;
    const endTick = claim.kind === 'digest' ? claim.tick : undefined;
    const settled = this.verifier
      .verifyMatch({ seed: settlement.seed, ledgers: settlement.ledgers, endTick })
      .then(async (found) => {
        const reported =
          claim.kind === 'result' ? claim.winners.filter((w) => w !== undefined) : [];
        let winner: number | null | undefined;
        if (found.outcome) {
          winner = found.outcome.winner;
          if (reported.length > 0 && !reported.includes(winner)) winner = undefined;
        } else if (claim.kind === 'forfeit') {
          winner = 1 - claim.leaver;
        } else if (claim.kind === 'digest' && found.tick === claim.tick) {
          const honest = [0, 1].filter((i) => {
            const d = claim.digests[i]!;
            return d[0] === found.digests[0] && d[1] === found.digests[1];
          });
          if (honest.length === 1) winner = honest[0]!;
        }

        const overturned =
          claim.kind === 'forfeit' && found.outcome !== null && winner !== 1 - claim.leaver;
        const disputed =
          claim.kind === 'digest' ||
          overturned ||
          (reported.length === 2 && reported[0] !== reported[1]);
        if (disputed || winner === undefined) {
          const what =
            claim.kind === 'result'
              ? `results ${String(claim.winners[0])}/${String(claim.winners[1])}`
              : claim.kind === 'forfeit'
                ? `forfeit by seat ${claim.leaver}`
                : `digests at tick ${claim.tick}`;
          const replayed = found.outcome
            ? `ended on tick ${found.outcome.tick}, winner ${String(found.outcome.winner)}`
            : `in play at tick ${found.tick}`;
          const counted = settlement.accounts ? 'rated' : 'recorded';
          const verdict =
            winner === undefined
              ? `not ${counted}`
              : winner === null
                ? settlement.accounts
                  ? 'a draw, rated'
                  : 'a draw, not recorded'
                : `seat ${winner} wins`;
          this.log(
            `relay: ${disputed ? 'disputed' : 'unsettled'} ${what} ` +
              `(room ${settlement.code}, seed ${settlement.seed}): replay ${replayed}; ${verdict}`,
          );
        }

        if (winner === undefined) return;
        const reason =
          claim.kind === 'forfeit'
            ? found.outcome
              ? 'result'
              : end
            : found.outcome
              ? end
              : 'desync';
        if (settlement.accounts) {
          await this.rate(settlement, winner, reason, found.tick);
        } else if (winner !== null) {
          await this.recordDecisive(settlement.keys[winner]!, settlement.keys[1 - winner]!);
          this.broadcastRoomList();
        }
      })
      .catch((err: unknown) => {
        console.error(`relay: failed to settle a game (room ${settlement.code}):`, err);
      })
      .finally(() => settlement.release?.());
    this.settling.add(settled);
    void settled.finally(() => this.settling.delete(settled));
  }

  /** Rate a game the relay decided without a replay: a concession. */
  private rateNow(settlement: Settlement, winner: number, end: RatedGameEnd): void {
    const ticks = Math.min(settlement.ledgers[0].length, settlement.ledgers[1].length);
    this.rate(settlement, winner, end, ticks)
      .catch((err: unknown) => {
        console.error(`relay: failed to rate a game (room ${settlement.code}):`, err);
      })
      .finally(() => settlement.release?.());
  }

  /**
   * Apply a rated game: both ratings (Glicko-2, each grown for its idle time
   * first), W-L-D, and the game log, then tell the players and the room's
   * spectators. Games apply one at a time, since each reads both ratings
   * before writing them.
   */
  private rate(
    settlement: Settlement,
    winner: number | null,
    end: RatedGameEnd,
    ticks: number,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const store = this.accounts;
      if (!store || !settlement.accounts) return;
      const [idA, idB] = settlement.accounts;
      const [a, b] = await Promise.all([store.accountById(idA), store.accountById(idB)]);
      if (!a || !b) {
        this.log(`relay: a rated game's account is gone (room ${settlement.code}); not rated`);
        return;
      }
      const now = this.wallClock();
      const score = winner === null ? 0.5 : winner === 0 ? 1 : 0;
      const rated = rateGame(a, b, score, now);
      await store.recordRatedGame({
        accountA: idA,
        accountB: idB,
        result: winner === null ? 'draw' : winner === 0 ? 'a' : 'b',
        end,
        ticks,
        seed: settlement.seed,
        simVersion: SIM_VERSION,
        aBefore: snapshot(rated.aBefore),
        bBefore: snapshot(rated.bBefore),
        aAfter: rated.a,
        bAfter: rated.b,
        createdAt: now,
        inputs: ratedGameInputs(settlement.ledgers),
      });
      await this.sweepGameInputs(store, now);

      const after: [PlayerRating, PlayerRating] = [shownRating(rated.a), shownRating(rated.b)];
      this.forEachIdentity((record, key, holder) => {
        const i = settlement.keys.indexOf(key);
        if (i < 0) return;
        if (winner === i) record.wins++;
        else if (winner === 1 - i) record.losses++;
        if ('account_id' in holder) holder.rating = { ...after[i]! };
        else if (holder.account) holder.account.rating = { ...after[i]! };
      });
      const ratings: [RatingChange, RatingChange] = [
        { before: shownRating(rated.aBefore), after: after[0] },
        { before: shownRating(rated.bBefore), after: after[1] },
      ];
      const text = encodeMessage({ type: 'rating_update', players: settlement.names, ratings });
      for (const session of this.sessions.values()) {
        if (session && settlement.keys.includes(session.identity.key)) session.conn.send(text);
      }
      for (const w of this.rooms.get(settlement.code)?.spectators ?? []) w.conn.send(text);
      this.broadcastRoomList();
    };
    const next = this.ratingChain.then(run);
    this.ratingChain = next.catch(() => undefined);
    return next;
  }

  /** Drop old rated games' inputs, at most every {@link INPUT_SWEEP_EVERY_MS}. */
  private async sweepGameInputs(store: AccountStore, now: number): Promise<void> {
    if (now - this.lastInputSweep < INPUT_SWEEP_EVERY_MS) return;
    this.lastInputSweep = now;
    await store.dropGameInputs(now - RATED_INPUTS_KEPT_MS);
  }

  /** End the current match and return the room to the waiting state. */
  private endMatch(room: Room, reason: MatchEndReason, winner: number | null): void {
    room.state = 'waiting';
    room.digest_floor = -1;
    this.stopWatchdog(room);

    // The match is settled: a pending grace timer must not fire against it
    // later (it would double-record and re-end the room), and a dropped seat
    // has nothing left to rejoin — remove it.
    if (room.grace_timer !== null) {
      clearTimeout(room.grace_timer);
      room.grace_timer = null;
    }
    // A bot seat also has no connection but is not an orphan — it persists
    // across games so the human can rematch; only dropped humans are removed.
    const orphaned = room.seats.filter((s) => s.conn === null && s.ai === undefined);
    for (const s of orphaned) {
      this.dropped.delete(s.token);
      removeItem(room.seats, s);
    }

    for (const s of room.seats) {
      s.ready = false;
      s.frames = [];
      s.digests.clear();
      s.reported_result = undefined;
      const conn = s.conn;
      if (!conn) continue; // (unreachable: orphans were removed above)
      this.send(conn, { type: 'match_end', reason, winner });
      for (const gone of orphaned) this.send(conn, { type: 'peer_left', name: gone.name });
    }
    for (const w of room.spectators) {
      this.send(w.conn, { type: 'match_end', reason, winner });
      for (const gone of orphaned) this.send(w.conn, { type: 'peer_left', name: gone.name });
    }
    if (room.seats.length === 0) this.closeRoom(room);
  }

  /**
   * Remove a session's seat from its room (explicit leave, or disconnect from
   * a waiting room). Mid-match leaves forfeit the match first.
   */
  private leaveRoom(session: Session): void {
    const room = session.room;
    const seat = session.seat;
    if (!room || !seat) return;
    removeItem(room.seats, seat);
    session.room = null;
    session.seat = null;

    // The remaining *human* opponent, if any. A lone bot seat left behind is
    // not a survivor: the room closes (a bot can't hold a room open).
    const peer = room.seats.find((s) => s.ai === undefined);
    if (!peer) {
      this.closeRoom(room);
      return;
    }
    if (room.state === 'playing') {
      // Leaving mid-match forfeits it, unless the replay shows the game had
      // already ended (see expireGrace).
      this.settle(
        this.settlement(room, [seat, peer], { kind: 'forfeit', leaver: seat.match_index }),
        'disconnect',
      );
      this.endMatch(room, 'disconnect', peer.match_index);
    }
    if (peer.conn) this.send(peer.conn, { type: 'peer_left', name: seat.name });
    for (const w of room.spectators) this.send(w.conn, { type: 'peer_left', name: seat.name });
  }

  // --- Room list -------------------------------------------------------------------

  private roomSummaries(): RoomSummary[] {
    const rooms: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      rooms.push({
        code: room.code,
        state: room.state,
        rated: room.rated,
        players: room.seats.map((s) => ({
          name: s.name,
          record: { ...s.record },
          rating: s.rating ? { ...s.rating } : null,
        })),
        spectators: room.spectators.map((w) => w.identity.name),
      });
    }
    return rooms;
  }

  /** Push the lobby snapshot to every helloed connection. */
  private broadcastRoomList(): void {
    const msg: ServerMessage = {
      type: 'room_list',
      rooms: this.roomSummaries(),
      queued: this.queue.size,
    };
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

  /**
   * A protocol violation that would corrupt lockstep or exhaust the relay:
   * report it and close. A mid-match close then takes the ordinary disconnect
   * path (reconnect grace, then forfeit).
   */
  private fatal(conn: ClientConnection, message: string): void {
    this.error(conn, 'bad_message', message);
    conn.close();
  }
}

/** The identity of an account logged in with session `token`. */
function accountIdentity(token: string, account: StoredAccount): Identity {
  return {
    token,
    key: accountKey(account.id),
    name: account.handle,
    record: { wins: account.wins, losses: account.losses },
    account: { id: account.id, rating: shownRating(account) },
  };
}

const snapshot = ({ rating, rd }: { rating: number; rd: number }) => ({ rating, rd });

/**
 * A rated game's inputs for the log: each seat's ledger as `[tickDelta,
 * command]` changes, as in a solo replay, so a long game is a few KB.
 */
export function ratedGameInputs(ledgers: readonly [readonly number[], readonly number[]]): string {
  const encode = (frames: readonly number[]): [number, number][] => {
    const changes: [number, number][] = [];
    let held = 0;
    let last = 0;
    frames.forEach((command, i) => {
      if (command === held) return;
      changes.push([i + 1 - last, command]);
      last = i + 1;
      held = command;
    });
    return changes;
  };
  return JSON.stringify({
    version: 1,
    ticks: [ledgers[0].length, ledgers[1].length],
    inputs: [encode(ledgers[0]), encode(ledgers[1])],
  });
}

/** A pair of accounts as one key, whichever way round. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}
