/**
 * @crack-attack/protocol — wire message types and codec shared by client and
 * server. Input-relay lockstep: see messages.ts for the model and its
 * departures from the C++ Communicator.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 */

export * from './messages.js';
export * from './codec.js';
