/**
 * lobby.ts — bots that load the lobby rather than play: idlers (hello and
 * nothing else; they exist to receive `room_list` pushes), room sitters (an
 * open room each, which makes every push bigger), and churners (a lobby
 * event per step, each one a push to every session).
 */

import type { ServerMessage } from '@crack-attack/protocol';
import { BotClient } from './client.js';

export class Idler extends BotClient {
  /** When the latest `room_list` arrived (absolute time). */
  lastListAt = 0;

  protected override onRoomList(): void {
    this.lastListAt = this.receivedAt;
  }
}

export class RoomSitter extends BotClient {
  async start(): Promise<void> {
    await this.join();
    await this.request({ type: 'create_room' }, 'room_created');
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
    this.env.metrics.count('lobbyEvents');
  }

  protected override onMessage(msg: ServerMessage): void {
    // A watched room that closed leaves the churner outside it.
    if (msg.type === 'room_closed') this.inRoom = false;
  }
}
