/**
 * lobby.ts — bots that load the lobby rather than play: idlers (hello and
 * nothing else; they exist to receive `room_list` pushes, and time them),
 * room sitters (an open room each, which makes every push bigger), and
 * churners (a lobby event per step, each one a push to every session).
 */

import type { ServerMessage } from '@crack-attack/protocol';
import { BotClient } from './client.js';
import { absNow } from './time.js';

export class Idler extends BotClient {
  /** Lobby events already covered by a push; null until the hello's own list. */
  private seenLobby: number | null = null;

  protected override onRoomList(): void {
    const metrics = this.env.metrics;
    // The first list answers this idler's hello, not a lobby event.
    this.seenLobby =
      this.seenLobby === null
        ? metrics.lobbySeq
        : metrics.pushReceived(this.seenLobby, this.receivedAt);
  }
}

export class RoomSitter extends BotClient {
  async start(): Promise<void> {
    await this.join();
    const created = this.request({ type: 'create_room' }, 'room_created');
    this.env.metrics.lobbyEvent(absNow());
    await created;
  }
}

export type ChurnMode = 'rooms' | 'spectate';

export class Churner extends BotClient {
  private inRoom = false;

  /**
   * One lobby event: `rooms` mode creates a room or leaves the one it made;
   * `spectate` mode watches one of `codes` or stops watching.
   */
  step(mode: ChurnMode, codes: readonly string[]): void {
    if (this.inRoom) {
      this.send({ type: 'leave_room' });
      this.inRoom = false;
    } else if (mode === 'rooms') {
      this.send({ type: 'create_room' });
      this.inRoom = true;
    } else {
      const code = codes[Math.floor(Math.random() * codes.length)];
      if (code === undefined) return;
      this.send({ type: 'spectate', code });
      this.inRoom = true;
    }
    this.env.metrics.lobbyEvent(absNow());
  }

  protected override onMessage(msg: ServerMessage): void {
    // A watched room that closed leaves the churner outside it.
    if (msg.type === 'room_closed') this.inRoom = false;
  }
}
