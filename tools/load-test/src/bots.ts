/**
 * bots.ts — player bots. A {@link Game} is two players in one room, both in
 * this process, so each input batch is timed from the sender's clock to the
 * receiver's: the forward latency a player feels.
 *
 * A wire player speaks the protocol and keeps lockstep (it steps a tick only
 * once the peer's frame for it has arrived, and schedules its own frames
 * `inputDelay` ahead, as the client does) but runs no simulation, so one
 * process drives thousands. Its frames follow a fixed script and its digests
 * come from a table, identical for both seats, so the relay sees agreement.
 *
 * A sim player drives the real client `LockstepSession` with the hard
 * `AiController`: heavier, but it proves that games at scale still verify
 * (digests match, results agree, a resume replays to the same outcome).
 */

import { AiController, CC_ADVANCE, CC_LEFT, CC_RIGHT, CC_SWAP } from '@crack-attack/core';
import { GC_TIME_STEP_PERIOD, aiDecisionSeed } from '@crack-attack/core';
import {
  DIGEST_PERIOD,
  MAX_INPUT_FRAMES_PER_MESSAGE,
  type MatchEndMessage,
  type MatchResumeMessage,
  type MatchStartMessage,
  type PeerInputsMessage,
  type ServerMessage,
} from '@crack-attack/protocol';
import { LockstepSession } from '@crack-attack/client/dist/net/lockstep.js';
import { BotClient, type BotEnv } from './client.js';
import { absNow, sleep } from './time.js';

/** Most ticks a sim player steps in one pump while catching up (the client's chunk size). */
const CATCH_UP_TICKS = 500;
/** How long a reconnecting player waits for `match_resume` after its welcome. */
const RESUME_WAIT_MS = 5_000;
/** Send times remembered per player, by batch start tick. */
const RING = 1024;

function mix32(x: number): number {
  let h = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A wire player's input for `tick`: a move about one tick in five, a swap one
 * in four, a raise one in forty (the e2e test's mix), so batches look like play.
 */
export function scriptedFrame(seat: number, tick: number): number {
  const h = mix32(tick * 2 + seat + 1);
  let bits = 0;
  const roll = h % 10;
  if (roll === 0) bits |= CC_LEFT;
  else if (roll === 1) bits |= CC_RIGHT;
  if ((h >>> 8) % 4 === 0) bits |= CC_SWAP;
  if ((h >>> 16) % 40 === 0) bits |= CC_ADVANCE;
  return bits;
}

/** The digests both wire players submit for `tick`: equal, so the relay never calls a desync. */
export function tableDigests(tick: number): [number, number] {
  return [mix32(tick), mix32(tick ^ 0x5bd1e995)];
}

export type GameKind = 'wire' | 'sim';

/** Two players in one room. */
export class Game {
  code: string | null = null;
  readonly players: [Player, Player];
  /** False once the game can't go on (a forfeit, a socket the relay closed). */
  alive = true;
  /** When both players report a result (absolute time); null = the game ends by itself. */
  endAt: number | null = null;

  constructor(
    readonly env: BotEnv,
    readonly kind: GameKind,
    readonly id: number,
    /** Wire games: report a result this long after each start, then rematch (0 = never). */
    readonly rotateMs = 0,
  ) {
    const make = (seat: number): Player =>
      kind === 'sim' ? new SimPlayer(env, this, seat) : new WirePlayer(env, this, seat);
    this.players = [make(0), make(1)];
  }

  get playing(): boolean {
    return this.alive && this.players[0].playing;
  }

  /** Hello both, create and join a room, ready up; resolves at `match_start`. */
  async start(): Promise<void> {
    const [host, guest] = this.players;
    await Promise.all([host.join(), guest.join()]);
    const created = await host.request({ type: 'create_room' }, 'room_created');
    this.code = created.code;
    await guest.request({ type: 'join_room', code: created.code }, 'room_joined');
    const started = Promise.all([host.expect('match_start'), guest.expect('match_start')]);
    host.send({ type: 'ready' });
    guest.send({ type: 'ready' });
    await started;
  }

  pump(now: number): void {
    if (!this.alive) return;
    this.players[0].pump(now);
    this.players[1].pump(now);
  }

  /** A player saw `match_start` (both do). */
  matchStarted(now: number): void {
    if (this.kind === 'wire' && this.rotateMs > 0 && this.endAt === null) {
      this.endAt = now + this.rotateMs;
    }
  }

  /** The host saw `match_end`. */
  matchEnded(msg: MatchEndMessage, now: number): void {
    if (msg.reason === 'result' && this.endAt !== null) {
      this.env.metrics.hist.matchEnd.record(now - this.endAt);
    }
    this.endAt = null;
  }

  /** Whether the players ready up again after this `match_end`. */
  rematches(msg: MatchEndMessage): boolean {
    return msg.reason === 'result' && (this.kind === 'sim' || this.rotateMs > 0);
  }

  stop(): void {
    this.alive = false;
    for (const p of this.players) p.close();
  }
}

export abstract class Player extends BotClient {
  /** This player's index in the current match. */
  index = 0;
  inputDelay = 0;
  /** When the current match started here: the origin of its tick clock. */
  matchAt = 0;
  playing = false;
  protected resultSent = false;
  /** Set while a reconnect waits for its `match_resume`. */
  private reconnecting = false;
  private lastTarget = 0;
  private readonly sentTimes = new Float64Array(RING);
  private readonly sentTicks = new Int32Array(RING).fill(-1);
  private peerDroppedAt: number | null = null;
  private graceMs = 0;

  constructor(
    env: BotEnv,
    readonly game: Game,
    readonly seat: number,
  ) {
    super(env, `${env.tag}${game.kind[0]}${game.id}${seat === 0 ? 'a' : 'b'}`);
  }

  get peer(): Player {
    return this.game.players[1 - this.seat]!;
  }

  /** When this player sent the batch starting at `startTick`, if it still remembers. */
  sentAt(startTick: number): number | undefined {
    const i = startTick & (RING - 1);
    return this.sentTicks[i] === startTick ? this.sentTimes[i] : undefined;
  }

  abstract pump(now: number): void;
  protected abstract startMatch(msg: MatchStartMessage): void;
  protected abstract resumeMatch(msg: MatchResumeMessage): void;
  protected abstract peerInputs(msg: PeerInputsMessage): void;

  /**
   * Cut this player's socket, keeping its state, and reconnect by token after
   * `delayMs`: a reconnect storm's unit. Resolves with what the relay did.
   */
  async reconnectAfter(delayMs: number): Promise<'resumed' | 'forfeited' | 'failed'> {
    this.playing = false;
    this.terminate();
    await sleep(delayMs);
    this.reconnecting = true;
    const resumed = this.expect('match_resume', RESUME_WAIT_MS + 30_000).then(
      () => true,
      () => false,
    );
    try {
      await this.join();
    } catch {
      this.reconnecting = false;
      this.env.metrics.count('startFailures');
      this.game.alive = false;
      return 'failed';
    }
    // A resume arrives with the welcome; past the grace, none comes.
    const outcome = await Promise.race([resumed, sleep(RESUME_WAIT_MS).then(() => false)]);
    this.reconnecting = false;
    if (outcome) return 'resumed';
    this.env.metrics.count('lateForfeits');
    this.game.alive = false;
    return 'forfeited';
  }

  protected sendInputs(startTick: number, frames: number[], now: number): void {
    const i = startTick & (RING - 1);
    this.sentTicks[i] = startTick;
    this.sentTimes[i] = now;
    this.send({ type: 'inputs', startTick, frames });
  }

  /** The tick the clock says this player should have reached. */
  protected target(now: number): number {
    return Math.floor((now - this.matchAt) / GC_TIME_STEP_PERIOD);
  }

  /** Count the clock's ticks that pass while this player is stuck over `inputDelay` behind. */
  protected noteProgress(target: number, reached: number): void {
    if (target - reached > this.inputDelay) {
      this.env.metrics.counters.stallTicks += target - this.lastTarget;
    }
    this.lastTarget = target;
  }

  protected override onMessage(msg: ServerMessage): void {
    const now = this.receivedAt;
    const metrics = this.env.metrics;
    switch (msg.type) {
      case 'peer_inputs': {
        const sent = this.peer.sentAt(msg.startTick);
        if (sent !== undefined) metrics.hist.forward.record(now - sent);
        this.peerInputs(msg);
        return;
      }
      case 'match_start':
        this.sentTicks.fill(-1);
        this.resultSent = false;
        this.peerDroppedAt = null;
        this.matchAt = now;
        this.lastTarget = 0;
        this.index = msg.playerIndex;
        this.inputDelay = msg.inputDelay;
        this.playing = true;
        if (this.seat === 0) metrics.count('matchStarts');
        this.game.matchStarted(now);
        this.startMatch(msg);
        return;
      case 'match_resume':
        if (this.reconnecting) metrics.hist.reconnect.record(now - this.helloAt);
        metrics.count('resumed');
        this.sentTicks.fill(-1);
        this.index = msg.playerIndex;
        this.inputDelay = msg.inputDelay;
        this.lastTarget = this.target(absNow());
        this.playing = true;
        this.resumeMatch(msg);
        return;
      case 'peer_dropped':
        this.peerDroppedAt = now;
        this.graceMs = msg.graceMs;
        return;
      case 'peer_rejoined':
        this.peerDroppedAt = null;
        return;
      case 'desync':
        if (this.seat === 0) metrics.count('desyncs');
        return;
      case 'match_end':
        this.playing = false;
        if (this.seat === 0) {
          metrics.count('matchEnds');
          this.game.matchEnded(msg, now);
        }
        if (msg.reason === 'disconnect' && this.peerDroppedAt !== null) {
          metrics.count('forfeits');
          metrics.hist.graceError.record(now - this.peerDroppedAt - this.graceMs);
          this.game.alive = false;
        }
        if (this.game.alive && this.game.rematches(msg)) this.send({ type: 'ready' });
        return;
      default:
        return;
    }
  }

  protected override onClose(byRelay: boolean): void {
    this.playing = false;
    if (byRelay) this.game.alive = false;
  }
}

export class WirePlayer extends Player {
  /** Ticks stepped. */
  private t = 0;
  /** Own frames scheduled (and sent), and the peer's received. */
  private localLen = 0;
  private peerLen = 0;
  private digestFloor = -1;
  /** The first pump of a match sends the `inputDelay` neutral frames every client pre-fills. */
  private prefill = false;

  protected startMatch(): void {
    this.t = 0;
    this.localLen = 0;
    this.peerLen = 0;
    this.digestFloor = -1;
    this.prefill = true;
  }

  protected resumeMatch(msg: MatchResumeMessage): void {
    // The relay's ledgers are authoritative: carry on from their frontiers,
    // as a resumed client does once it has replayed them.
    this.localLen = msg.frames[this.index]!.length;
    this.peerLen = msg.frames[1 - this.index]!.length;
    this.t = Math.min(this.peerLen, Math.max(0, this.localLen - this.inputDelay));
    this.digestFloor = Math.min(this.localLen, this.peerLen);
    this.prefill = false;
  }

  protected peerInputs(msg: PeerInputsMessage): void {
    if (msg.startTick !== this.peerLen) this.env.metrics.count('contiguityErrors');
    this.peerLen = msg.startTick + msg.frames.length;
  }

  pump(now: number): void {
    if (!this.playing) return;
    const endAt = this.game.endAt;
    if (endAt !== null && now >= endAt) {
      if (!this.resultSent) {
        this.resultSent = true;
        this.playing = false;
        this.send({ type: 'result', winner: 0 });
      }
      return;
    }
    const target = this.target(now);
    const start = this.localLen;
    let frames: number[] | null = null;
    if (this.prefill) {
      frames = [];
      for (; this.localLen < this.inputDelay; this.localLen++) frames.push(0);
      this.prefill = false;
    }
    let digests: number[] | null = null;
    while (this.t < target && this.t < this.peerLen) {
      for (; this.localLen < this.t + this.inputDelay + 1; this.localLen++) {
        (frames ??= []).push(scriptedFrame(this.seat, this.localLen));
      }
      this.t++;
      if (this.t % DIGEST_PERIOD === 0 && this.t > this.digestFloor) (digests ??= []).push(this.t);
    }
    this.noteProgress(target, this.t);
    if (frames) {
      for (let i = 0; i < frames.length; i += MAX_INPUT_FRAMES_PER_MESSAGE) {
        this.sendInputs(start + i, frames.slice(i, i + MAX_INPUT_FRAMES_PER_MESSAGE), now);
      }
    }
    if (digests) {
      for (const tick of digests) this.send({ type: 'digest', tick, digests: tableDigests(tick) });
    }
  }
}

export class SimPlayer extends Player {
  private session: LockstepSession | null = null;
  private controller: AiController | null = null;
  private readonly sample = (): number =>
    this.controller!.decide(this.session!.sims[this.index]!).state;

  protected startMatch(msg: MatchStartMessage): void {
    this.session = new LockstepSession(msg.seed, msg.playerIndex, msg.inputDelay);
    this.controller = new AiController('hard', aiDecisionSeed(msg.seed, msg.playerIndex));
  }

  protected resumeMatch(msg: MatchResumeMessage): void {
    this.session = LockstepSession.resume(msg.seed, msg.playerIndex, msg.inputDelay, msg.frames);
    this.controller = new AiController('hard', aiDecisionSeed(msg.seed, msg.playerIndex));
  }

  protected peerInputs(msg: PeerInputsMessage): void {
    try {
      this.session?.addRemoteFrames(msg.startTick, msg.frames);
    } catch {
      this.env.metrics.count('contiguityErrors');
    }
  }

  pump(now: number): void {
    const s = this.session;
    if (!this.playing || !s) return;
    if (s.outcome === null) {
      const target = this.target(now);
      if (target > s.currentTick) {
        s.advance(Math.min(CATCH_UP_TICKS, target - s.currentTick), this.sample);
      }
      this.noteProgress(target, s.currentTick);
    }
    for (const b of s.takeOutgoing()) this.sendInputs(b.startTick, b.frames, now);
    for (const d of s.takeDigests())
      this.send({ type: 'digest', tick: d.tick, digests: d.digests });
    if (s.outcome !== null && !this.resultSent) {
      this.resultSent = true;
      this.send({ type: 'result', winner: s.outcome.winner });
    }
  }
}
