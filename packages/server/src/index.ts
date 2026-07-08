/**
 * @crack-attack/server — lobby + lockstep relay (Node).
 *
 * Placeholder. Phase 4 adds the WebSocket relay (server-relayed lockstep) and
 * Phase 5 the lobby (rooms, seeds, match lifecycle, records). Kept as a valid
 * workspace package so the monorepo builds end-to-end from day one.
 */

import { PROTOCOL_VERSION } from '@crack-attack/protocol';

export function serverInfo(): { protocol: string; status: 'not-implemented' } {
  return { protocol: PROTOCOL_VERSION, status: 'not-implemented' };
}
