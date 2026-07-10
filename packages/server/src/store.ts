/**
 * store.ts — the abstract persistence layer for player identity and records.
 *
 * The relay only ever talks to this interface, so the backing store is
 * swappable: `MemoryStore` (tests, ephemeral servers), `SqliteStore`
 * (production), and later Redis or anything else. The interface is async for
 * exactly that reason — SQLite is synchronous under the hood, but a network
 * store won't be.
 *
 * Identity model: a player is a server-minted 128-bit hex session token
 * (SESSION_TOKEN_LENGTH). Display names are stored but not unique — the token
 * is the key. This is the plan's "lightweight auth": good enough for lobby
 * records, replaced wholesale if real accounts ever matter.
 */

import type { PlayerRecord } from '@crack-attack/protocol';

/** A stored player: identity + display name + W-L record. */
export interface StoredPlayer {
  token: string;
  name: string;
  record: PlayerRecord;
}

export interface LobbyStore {
  /**
   * Look up a player by token, updating the stored display name to `name`.
   * Returns null for an unknown token (the caller then mints a new player).
   */
  getPlayer(token: string, name: string): Promise<StoredPlayer | null>;

  /** Create a fresh player with a zero record. `token` is caller-generated. */
  createPlayer(token: string, name: string): Promise<StoredPlayer>;

  /** Record a decisive game: +1 win / +1 loss. Draws are simply not recorded. */
  recordResult(winnerToken: string, loserToken: string): Promise<void>;

  /** Release any resources (file handles, connections). */
  close(): Promise<void>;
}

/** In-memory store: tests and zero-persistence deployments. */
export class MemoryStore implements LobbyStore {
  private readonly players = new Map<string, StoredPlayer>();

  getPlayer(token: string, name: string): Promise<StoredPlayer | null> {
    const p = this.players.get(token);
    if (!p) return Promise.resolve(null);
    p.name = name;
    return Promise.resolve({ ...p, record: { ...p.record } });
  }

  createPlayer(token: string, name: string): Promise<StoredPlayer> {
    const p: StoredPlayer = { token, name, record: { wins: 0, losses: 0 } };
    this.players.set(token, p);
    return Promise.resolve({ ...p, record: { ...p.record } });
  }

  recordResult(winnerToken: string, loserToken: string): Promise<void> {
    const w = this.players.get(winnerToken);
    const l = this.players.get(loserToken);
    if (w) w.record.wins++;
    if (l) l.record.losses++;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
