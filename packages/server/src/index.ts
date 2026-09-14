/**
 * @crack-attack/server — lobby + lockstep relay (Node).
 *
 * `relay.ts` holds the transport-free room/match logic; `wsServer.ts` binds it
 * to WebSockets; `main.ts` is the CLI entry. Phase 5 grows the lobby (named
 * players, room lists, rankings) on the same surface. The solo scoreboard is
 * `scoreboard.ts` (transport-free) behind `httpApi.ts`, on the same port.
 */

export * from './relay.js';
export * from './store.js';
export * from './scoreStore.js';
export * from './sqliteStore.js';
export * from './rateLimit.js';
export * from './soloVerifier.js';
export * from './scoreboard.js';
export * from './httpApi.js';
export * from './admin.js';
export * from './wsServer.js';
