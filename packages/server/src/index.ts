/**
 * @crack-attack/server — lobby + lockstep relay (Node).
 *
 * `relay.ts` holds the transport-free room/match logic; `wsServer.ts` binds it
 * to WebSockets; `main.ts` is the CLI entry. Phase 5 grows the lobby (named
 * players, room lists, rankings) on the same surface.
 */

export * from './relay.js';
export * from './store.js';
export * from './sqliteStore.js';
export * from './wsServer.js';
