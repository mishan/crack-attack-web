import { describe, expect, it } from 'vitest';
import { CC_LEFT, CC_SWAP, CC_ADVANCE } from '@crack-attack/core';
import {
  ACTION_MASK,
  MAX_INPUT_FRAMES_PER_MESSAGE,
  MAX_PLAYER_NAME_LENGTH,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ProtocolError,
  decodeClientMessage,
  decodeServerMessage,
  encodeMessage,
  isRoomCode,
  type ClientMessage,
  type ServerMessage,
} from './index.js';

const CODE = 'ABC23';

const clientMessages: ClientMessage[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha' },
  { type: 'create_room' },
  { type: 'join_room', code: CODE },
  { type: 'ready' },
  { type: 'inputs', startTick: 96, frames: [0, CC_LEFT, CC_LEFT | CC_SWAP, CC_ADVANCE] },
  { type: 'digest', tick: 32, digests: [0xdeadbeef, 0] },
  { type: 'concede' },
  { type: 'leave_room' },
];

const serverMessages: ServerMessage[] = [
  { type: 'welcome', protocolVersion: PROTOCOL_VERSION },
  { type: 'room_created', code: CODE },
  { type: 'room_joined', code: CODE, players: ['misha', 'opponent'] },
  { type: 'peer_joined', name: 'opponent' },
  { type: 'peer_left', name: 'opponent' },
  {
    type: 'match_start',
    seed: 0x12345678,
    playerIndex: 1,
    inputDelay: 3,
    players: ['misha', 'opponent'],
  },
  { type: 'peer_inputs', playerIndex: 0, startTick: 0, frames: [CC_SWAP] },
  { type: 'desync', tick: 64 },
  { type: 'match_end', reason: 'concession', winner: 0 },
  { type: 'match_end', reason: 'desync', winner: null },
  { type: 'error', code: 'room_not_found', message: 'no such room' },
];

describe('round-trip', () => {
  it.each(clientMessages.map((m) => [m.type, m] as const))('client %s', (_t, msg) => {
    expect(decodeClientMessage(encodeMessage(msg))).toEqual(msg);
  });

  it.each(serverMessages.map((m) => [m.type, m] as const))('server %s', (_t, msg) => {
    expect(decodeServerMessage(encodeMessage(msg))).toEqual(msg);
  });
});

describe('direction enforcement', () => {
  it('rejects server messages on the client decoder and vice versa', () => {
    expect(() =>
      decodeClientMessage(encodeMessage({ type: 'welcome', protocolVersion: 1 })),
    ).toThrow(ProtocolError);
    expect(() => decodeServerMessage(encodeMessage({ type: 'ready' }))).toThrow(ProtocolError);
  });
});

describe('malformed input', () => {
  const bad: [string, string][] = [
    ['not JSON', 'garbage{'],
    ['non-object', '42'],
    ['array', '[]'],
    ['missing type', '{}'],
    ['unknown type', '{"type":"warp_core_breach"}'],
    ['hello without name', '{"type":"hello","protocolVersion":1}'],
    ['hello empty name', '{"type":"hello","protocolVersion":1,"name":""}'],
    [
      'hello name too long',
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        name: 'x'.repeat(MAX_PLAYER_NAME_LENGTH + 1),
      }),
    ],
    ['hello fractional version', '{"type":"hello","protocolVersion":1.5,"name":"m"}'],
    ['join_room bad code (lookalike char)', '{"type":"join_room","code":"ABC10"}'],
    ['join_room lowercase code', '{"type":"join_room","code":"abc23"}'],
    ['join_room short code', '{"type":"join_room","code":"AB2"}'],
    ['inputs negative tick', '{"type":"inputs","startTick":-1,"frames":[0]}'],
    ['inputs empty frames', '{"type":"inputs","startTick":0,"frames":[]}'],
    ['inputs frame out of mask', `{"type":"inputs","startTick":0,"frames":[${ACTION_MASK + 1}]}`],
    ['inputs fractional frame', '{"type":"inputs","startTick":0,"frames":[0.5]}'],
    ['inputs frames not array', '{"type":"inputs","startTick":0,"frames":"lol"}'],
    [
      'inputs too many frames',
      JSON.stringify({
        type: 'inputs',
        startTick: 0,
        frames: Array(MAX_INPUT_FRAMES_PER_MESSAGE + 1).fill(0),
      }),
    ],
    ['digest wrong arity', '{"type":"digest","tick":32,"digests":[1]}'],
    ['digest overflows uint32', '{"type":"digest","tick":32,"digests":[4294967296,0]}'],
    ['digest negative', '{"type":"digest","tick":32,"digests":[-1,0]}'],
  ];

  it.each(bad)('client rejects %s', (_name, text) => {
    expect(() => decodeClientMessage(text)).toThrow(ProtocolError);
  });

  const badServer: [string, string][] = [
    [
      'match_start playerIndex out of range',
      JSON.stringify({
        type: 'match_start',
        seed: 1,
        playerIndex: 2,
        inputDelay: 3,
        players: ['a', 'b'],
      }),
    ],
    [
      'match_start players wrong arity',
      JSON.stringify({
        type: 'match_start',
        seed: 1,
        playerIndex: 0,
        inputDelay: 3,
        players: ['a'],
      }),
    ],
    [
      'match_start seed overflows uint32',
      JSON.stringify({
        type: 'match_start',
        seed: 2 ** 32,
        playerIndex: 0,
        inputDelay: 3,
        players: ['a', 'b'],
      }),
    ],
    [
      'room_joined too many players',
      JSON.stringify({ type: 'room_joined', code: CODE, players: ['a', 'b', 'c'] }),
    ],
    ['room_joined empty players', JSON.stringify({ type: 'room_joined', code: CODE, players: [] })],
    ['match_end unknown reason', '{"type":"match_end","reason":"rage_quit","winner":0}'],
    ['match_end winner out of range', '{"type":"match_end","reason":"concession","winner":2}'],
    ['match_end missing winner', '{"type":"match_end","reason":"concession"}'],
    ['error unknown code', '{"type":"error","code":"whoops","message":"m"}'],
    ['peer_inputs missing playerIndex', '{"type":"peer_inputs","startTick":0,"frames":[0]}'],
  ];

  it.each(badServer)('server rejects %s', (_name, text) => {
    expect(() => decodeServerMessage(text)).toThrow(ProtocolError);
  });
});

describe('room codes', () => {
  it('accepts every alphabet character', () => {
    for (const ch of ROOM_CODE_ALPHABET) {
      expect(isRoomCode(ch.repeat(ROOM_CODE_LENGTH))).toBe(true);
    }
  });

  it('excludes lookalike characters from the alphabet', () => {
    for (const ch of 'IO01') expect(ROOM_CODE_ALPHABET).not.toContain(ch);
  });
});

describe('constants', () => {
  it('ACTION_MASK covers exactly the six CC_* bits', () => {
    expect(ACTION_MASK).toBe(0b111111);
  });
});
