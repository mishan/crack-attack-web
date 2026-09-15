/**
 * spectator.ts — a watcher bot: `spectate`, then read both players' streams,
 * checking each for contiguity the way the client's `SpectatorSession` does,
 * without simulating. When the game it watches runs in the same worker, each
 * batch is timed from its sender (spectator latency). `pause` stops reading
 * from the socket, to make a slow reader.
 */

import type { ServerMessage } from '@crack-attack/protocol';
import type { Game } from './bots.js';
import { BotClient, type BotEnv } from './client.js';
import { absNow } from './time.js';

export class SpectatorBot extends BotClient {
  watching = false;
  paused = false;
  private lens: [number, number] = [0, 0];
  private spectateAt: number | null = null;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    env: BotEnv,
    name: string,
    readonly code: string,
    /** The game behind `code`, if it runs in this worker. */
    private readonly localGame: (code: string) => Game | undefined,
  ) {
    super(env, name);
  }

  async start(): Promise<void> {
    await this.join();
    this.spectateAt = absNow();
    await this.request({ type: 'spectate', code: this.code }, 'spectate_joined');
    this.watching = true;
  }

  /** Stop reading for `ms` (forever if negative or infinite). */
  slow(ms: number): void {
    this.pause();
    this.paused = true;
    if (ms >= 0 && Number.isFinite(ms)) {
      this.resumeTimer = setTimeout(() => {
        this.resume();
        this.paused = false;
      }, ms);
    }
  }

  override close(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    super.close();
  }

  protected override onMessage(msg: ServerMessage): void {
    const metrics = this.env.metrics;
    if (msg.type === 'peer_inputs') {
      const i = msg.playerIndex;
      if (msg.startTick !== this.lens[i]) metrics.count('contiguityErrors');
      this.lens[i] = msg.startTick + msg.frames.length;
      const sender = this.localGame(this.code)?.players.find((p) => p.index === i);
      const sent = sender?.sentAt(msg.startTick);
      if (sent !== undefined) metrics.hist.spectator.record(this.receivedAt - sent);
    } else if (msg.type === 'spectate_start') {
      const [a, b] = msg.frames;
      // Joining a match in progress (ledgers attached) is the late join; a
      // start with empty ledgers is just the next game beginning.
      if (this.spectateAt !== null && a.length + b.length > 0) {
        metrics.hist.lateJoin.record(this.receivedAt - this.spectateAt);
      }
      this.spectateAt = null;
      this.lens = [a.length, b.length];
    } else if (msg.type === 'room_closed') {
      // Nothing left to watch: hang up, so the harness puts a new watcher on a live game.
      this.watching = false;
      this.close();
    }
  }

  protected override onClose(): void {
    this.watching = false;
  }
}
