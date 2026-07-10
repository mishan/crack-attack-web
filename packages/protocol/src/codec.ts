/**
 * codec.ts — JSON encoding with validating decode.
 *
 * Compact JSON per the port plan; a binary codec can replace this later
 * without touching call sites. Decoding is strict: every field of every
 * message is shape- and range-checked (a relay must never trust a socket),
 * and unknown or malformed messages throw {@link ProtocolError} with a
 * machine-readable reason. Validation here is *shape only* — semantic rules
 * (version match, tick contiguity of input batches, room membership) belong
 * to the server/client logic, not the codec.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 *
 * Original work Copyright (C) 2000 Daniel Nelson. GPL-2.0-or-later.
 */

import type {
  ClientMessage,
  Message,
  ServerMessage,
  ErrorCode,
  MatchEndReason,
} from './messages.js';
import {
  ACTION_MASK,
  MAX_INPUT_FRAMES_PER_MESSAGE,
  MAX_MATCH_FRAMES,
  MAX_PLAYER_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  SESSION_TOKEN_LENGTH,
} from './messages.js';
import type { PlayerRecord, RoomSummary } from './messages.js';

/** Thrown by the decode functions on any malformed or unknown message. */
export class ProtocolError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProtocolError';
  }
}

/** Encode any protocol message for the wire. */
export function encodeMessage(msg: Message): string {
  return JSON.stringify(msg);
}

/** Decode + validate a message that must come from a client. */
export function decodeClientMessage(text: string): ClientMessage {
  const raw = parse(text);
  const msg = decodeAny(raw);
  if (!CLIENT_TYPES.has(msg.type)) throw new ProtocolError(`not a client message: ${msg.type}`);
  return msg as ClientMessage;
}

/** Decode + validate a message that must come from the server. */
export function decodeServerMessage(text: string): ServerMessage {
  const raw = parse(text);
  const msg = decodeAny(raw);
  if (!SERVER_TYPES.has(msg.type)) throw new ProtocolError(`not a server message: ${msg.type}`);
  return msg as ServerMessage;
}

// --- Field validators ---------------------------------------------------------

function parse(text: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ProtocolError('message must be a JSON object');
  return raw as Record<string, unknown>;
}

function uint32(m: Record<string, unknown>, field: string): number {
  const v = m[field];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffffffff)
    throw new ProtocolError(`${field} must be a uint32`);
  return v;
}

function str(m: Record<string, unknown>, field: string): string {
  const v = m[field];
  if (typeof v !== 'string') throw new ProtocolError(`${field} must be a string`);
  return v;
}

function playerName(m: Record<string, unknown>, field: string): string {
  const v = str(m, field);
  if (v.length < 1 || v.length > MAX_PLAYER_NAME_LENGTH)
    throw new ProtocolError(`${field} must be 1..${MAX_PLAYER_NAME_LENGTH} chars`);
  return v;
}

/** Whether `code` is a well-formed room code (shape check only). */
export function isRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

function roomCode(m: Record<string, unknown>, field: string): string {
  const v = str(m, field);
  if (!isRoomCode(v)) throw new ProtocolError(`${field} is not a valid room code`);
  return v;
}

/** Player index in a two-player match. */
function playerIndex(m: Record<string, unknown>, field: string): number {
  const v = uint32(m, field);
  if (v > 1) throw new ProtocolError(`${field} must be 0 or 1`);
  return v;
}

function inputFrames(m: Record<string, unknown>, field: string): number[] {
  const v = m[field];
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_INPUT_FRAMES_PER_MESSAGE)
    throw new ProtocolError(`${field} must be an array of 1..${MAX_INPUT_FRAMES_PER_MESSAGE}`);
  // Range check, not a bitwise one: JS bitwise ops truncate to int32, so
  // `(f & ~ACTION_MASK) !== 0` would let values like 2**33 + 1 slip through.
  for (const f of v)
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > ACTION_MASK)
      throw new ProtocolError(`${field} entries must be CC_* action bitmasks`);
  return v as number[];
}

function digestPair(m: Record<string, unknown>, field: string): [number, number] {
  const v = m[field];
  if (!Array.isArray(v) || v.length !== 2) throw new ProtocolError(`${field} must be a pair`);
  for (const d of v)
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 0xffffffff)
      throw new ProtocolError(`${field} entries must be uint32 digests`);
  return v as [number, number];
}

function isName(n: unknown): n is string {
  return typeof n === 'string' && n.length >= 1 && n.length <= MAX_PLAYER_NAME_LENGTH;
}

/** Whether `token` is a well-formed session token (shape check only). */
export function isSessionToken(token: string): boolean {
  if (token.length !== SESSION_TOKEN_LENGTH) return false;
  for (const ch of token) if (!'0123456789abcdef'.includes(ch)) return false;
  return true;
}

function sessionToken(m: Record<string, unknown>, field: string): string {
  const v = str(m, field);
  if (!isSessionToken(v)) throw new ProtocolError(`${field} is not a valid session token`);
  return v;
}

function playerRecord(m: Record<string, unknown>, field: string): PlayerRecord {
  const v = m[field];
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new ProtocolError(`${field} must be a record object`);
  const r = v as Record<string, unknown>;
  return { wins: uint32(r, 'wins'), losses: uint32(r, 'losses') };
}

/** A full-match input history: like inputFrames but may be empty and far longer. */
function matchFrames(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.length > MAX_MATCH_FRAMES)
    throw new ProtocolError(`${field} must be an array of 0..${MAX_MATCH_FRAMES}`);
  for (const f of v)
    if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > ACTION_MASK)
      throw new ProtocolError(`${field} entries must be CC_* action bitmasks`);
  return v as number[];
}

function roomSummaries(m: Record<string, unknown>, field: string): RoomSummary[] {
  const v = m[field];
  if (!Array.isArray(v)) throw new ProtocolError(`${field} must be an array`);
  return v.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
      throw new ProtocolError(`${field}[${i}] must be a room object`);
    const r = entry as Record<string, unknown>;
    const state = str(r, 'state');
    if (state !== 'waiting' && state !== 'playing')
      throw new ProtocolError(`${field}[${i}].state must be waiting|playing`);
    const players = r['players'];
    if (!Array.isArray(players) || players.length > 2)
      throw new ProtocolError(`${field}[${i}].players must be an array of 0..2`);
    return {
      code: roomCode(r, 'code'),
      state,
      players: players.map((p, j) => {
        if (typeof p !== 'object' || p === null || Array.isArray(p))
          throw new ProtocolError(`${field}[${i}].players[${j}] must be an object`);
        const pr = p as Record<string, unknown>;
        return { name: playerName(pr, 'name'), record: playerRecord(pr, 'record') };
      }),
    };
  });
}

function namePair(m: Record<string, unknown>, field: string): [string, string] {
  const v = m[field];
  if (!Array.isArray(v) || v.length !== 2 || !v.every(isName))
    throw new ProtocolError(`${field} must be a pair of names`);
  return v as [string, string];
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  'version_mismatch',
  'bad_name',
  'room_not_found',
  'room_full',
  'not_in_room',
  'bad_message',
] satisfies ErrorCode[]);

const MATCH_END_REASONS: ReadonlySet<string> = new Set([
  'concession',
  'disconnect',
  'desync',
] satisfies MatchEndReason[]);

// --- Per-message decoders -------------------------------------------------------

const CLIENT_TYPES: ReadonlySet<string> = new Set([
  'hello',
  'create_room',
  'join_room',
  'ready',
  'inputs',
  'digest',
  'result',
  'concede',
  'leave_room',
]);

const SERVER_TYPES: ReadonlySet<string> = new Set([
  'welcome',
  'room_list',
  'room_created',
  'room_joined',
  'peer_joined',
  'peer_left',
  'peer_dropped',
  'peer_rejoined',
  'match_start',
  'match_resume',
  'peer_inputs',
  'desync',
  'match_end',
  'error',
]);

function decodeAny(m: Record<string, unknown>): Message {
  const type = m['type'];
  if (typeof type !== 'string') throw new ProtocolError('missing message type');
  switch (type) {
    // client → server
    case 'hello': {
      const base = {
        type,
        protocolVersion: uint32(m, 'protocolVersion'),
        name: playerName(m, 'name'),
      } as const;
      return m['token'] === undefined ? base : { ...base, token: sessionToken(m, 'token') };
    }
    case 'create_room':
    case 'ready':
    case 'concede':
    case 'leave_room':
      return { type };
    case 'join_room':
      return { type, code: roomCode(m, 'code') };
    case 'inputs':
      return { type, startTick: uint32(m, 'startTick'), frames: inputFrames(m, 'frames') };
    case 'digest':
      return { type, tick: uint32(m, 'tick'), digests: digestPair(m, 'digests') };
    case 'result': {
      const w = m['winner'];
      if (w !== null && (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 1))
        throw new ProtocolError('winner must be a player index or null');
      return { type, winner: w };
    }
    // server → client
    case 'welcome':
      return {
        type,
        protocolVersion: uint32(m, 'protocolVersion'),
        token: sessionToken(m, 'token'),
        name: playerName(m, 'name'),
        record: playerRecord(m, 'record'),
      };
    case 'room_list':
      return { type, rooms: roomSummaries(m, 'rooms') };
    case 'peer_dropped':
      return { type, name: playerName(m, 'name'), graceMs: uint32(m, 'graceMs') };
    case 'peer_rejoined':
      return { type, name: playerName(m, 'name') };
    case 'match_resume': {
      const frames = m['frames'];
      if (!Array.isArray(frames) || frames.length !== 2)
        throw new ProtocolError('frames must be a pair of histories');
      return {
        type,
        seed: uint32(m, 'seed'),
        playerIndex: playerIndex(m, 'playerIndex'),
        inputDelay: uint32(m, 'inputDelay'),
        players: namePair(m, 'players'),
        frames: [matchFrames(frames[0], 'frames[0]'), matchFrames(frames[1], 'frames[1]')],
      };
    }
    case 'room_created':
      return { type, code: roomCode(m, 'code') };
    case 'room_joined': {
      const players = m['players'];
      if (
        !Array.isArray(players) ||
        players.length < 1 ||
        players.length > 2 ||
        !players.every(isName)
      )
        throw new ProtocolError('players must be an array of 1..2 names');
      return { type, code: roomCode(m, 'code'), players: players as string[] };
    }
    case 'peer_joined':
    case 'peer_left':
      return { type, name: playerName(m, 'name') };
    case 'match_start':
      return {
        type,
        seed: uint32(m, 'seed'),
        playerIndex: playerIndex(m, 'playerIndex'),
        inputDelay: uint32(m, 'inputDelay'),
        players: namePair(m, 'players'),
      };
    case 'peer_inputs':
      return {
        type,
        playerIndex: playerIndex(m, 'playerIndex'),
        startTick: uint32(m, 'startTick'),
        frames: inputFrames(m, 'frames'),
      };
    case 'desync':
      return { type, tick: uint32(m, 'tick') };
    case 'match_end': {
      const reason = str(m, 'reason');
      if (!MATCH_END_REASONS.has(reason)) throw new ProtocolError('unknown match_end reason');
      const w = m['winner'];
      if (w !== null && (typeof w !== 'number' || !Number.isInteger(w) || w < 0 || w > 1))
        throw new ProtocolError('winner must be a player index or null');
      return { type, reason: reason as MatchEndReason, winner: w };
    }
    case 'error': {
      const code = str(m, 'code');
      if (!ERROR_CODES.has(code)) throw new ProtocolError('unknown error code');
      return { type, code: code as ErrorCode, message: str(m, 'message') };
    }
    default:
      throw new ProtocolError(`unknown message type: ${type}`);
  }
}
