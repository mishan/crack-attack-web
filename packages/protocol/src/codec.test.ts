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
const TOKEN = 'a'.repeat(32);
const RECORD = { wins: 3, losses: 1 };

const clientMessages: ClientMessage[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha' },
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, name: 'misha', token: TOKEN },
  { type: 'create_room' },
  { type: 'join_room', code: CODE },
  { type: 'ready' },
  { type: 'inputs', startTick: 96, frames: [0, CC_LEFT, CC_LEFT | CC_SWAP, CC_ADVANCE] },
  { type: 'digest', tick: 32, digests: [0xdeadbeef, 0] },
  { type: 'result', winner: 1 },
  { type: 'result', winner: null },
  { type: 'concede' },
  { type: 'leave_room' },
  { type: 'spectate', code: CODE },
  { type: 'rename', name: 'misha2' },
];

const serverMessages: ServerMessage[] = [
  {
    type: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    token: TOKEN,
    name: 'misha',
    record: RECORD,
  },
  { type: 'room_list', rooms: [] },
  {
    type: 'room_list',
    rooms: [
      {
        code: CODE,
        state: 'waiting',
        players: [{ name: 'misha', record: RECORD }],
        spectators: [],
      },
      {
        code: 'XYZ99',
        state: 'playing',
        players: [
          { name: 'a', record: { wins: 0, losses: 0 } },
          { name: 'b', record: { wins: 9, losses: 2 } },
        ],
        spectators: ['carol', 'dave'],
      },
    ],
  },
  { type: 'spectate_joined', code: CODE, players: ['a', 'b'], spectators: ['carol'] },
  { type: 'spectate_joined', code: CODE, players: [], spectators: ['carol'] },
  {
    type: 'spectate_start',
    seed: 0x12345678,
    inputDelay: 3,
    players: ['a', 'b'],
    frames: [[0, CC_LEFT], []],
  },
  { type: 'spectators', names: ['carol', 'dave'] },
  { type: 'spectators', names: [] },
  { type: 'room_closed' },
  { type: 'room_created', code: CODE },
  { type: 'room_joined', code: CODE, players: ['misha', 'opponent'] },
  { type: 'peer_joined', name: 'opponent' },
  { type: 'peer_left', name: 'opponent' },
  { type: 'peer_dropped', name: 'opponent', graceMs: 30000 },
  { type: 'peer_rejoined', name: 'opponent' },
  {
    type: 'match_start',
    seed: 0x12345678,
    playerIndex: 1,
    inputDelay: 3,
    players: ['misha', 'opponent'],
  },
  {
    type: 'match_resume',
    seed: 0x12345678,
    playerIndex: 0,
    inputDelay: 3,
    players: ['misha', 'opponent'],
    frames: [
      [0, CC_LEFT, CC_SWAP],
      [0, 0, CC_ADVANCE],
    ],
  },
  {
    type: 'match_resume',
    seed: 1,
    playerIndex: 1,
    inputDelay: 3,
    players: ['a', 'b'],
    frames: [[], []],
  },
  { type: 'peer_inputs', playerIndex: 0, startTick: 0, frames: [CC_SWAP] },
  { type: 'desync', tick: 64 },
  { type: 'match_end', reason: 'concession', winner: 0 },
  { type: 'match_end', reason: 'result', winner: 1 },
  { type: 'match_end', reason: 'result', winner: null },
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
    // Regression: values beyond 2^32 truncate under JS bitwise ops, so a pure
    // `(f & ~ACTION_MASK)` check would wrongly accept 2**33 + 1 (int32-truncates
    // to 1). The validator must bound the range explicitly.
    [
      'inputs frame beyond int32 range',
      `{"type":"inputs","startTick":0,"frames":[${2 ** 33 + 1}]}`,
    ],
    ['inputs frame at 2**32', `{"type":"inputs","startTick":0,"frames":[${2 ** 32}]}`],
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
    ['hello short token', '{"type":"hello","protocolVersion":2,"name":"m","token":"abc"}'],
    [
      'hello non-hex token',
      `{"type":"hello","protocolVersion":2,"name":"m","token":"${'Z'.repeat(32)}"}`,
    ],
    ['result winner out of range', '{"type":"result","winner":2}'],
    ['result missing winner', '{"type":"result"}'],
    ['rename empty name', '{"type":"rename","name":""}'],
    [
      'rename name too long',
      JSON.stringify({ type: 'rename', name: 'x'.repeat(MAX_PLAYER_NAME_LENGTH + 1) }),
    ],
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
    [
      'welcome missing record',
      `{"type":"welcome","protocolVersion":2,"token":"${'a'.repeat(32)}","name":"m"}`,
    ],
    [
      'welcome record with negative wins',
      `{"type":"welcome","protocolVersion":2,"token":"${'a'.repeat(32)}","name":"m","record":{"wins":-1,"losses":0}}`,
    ],
    ['room_list rooms not array', '{"type":"room_list","rooms":"nope"}'],
    [
      'room_list bad room state',
      `{"type":"room_list","rooms":[{"code":"ABC23","state":"exploded","players":[]}]}`,
    ],
    [
      'room_list player missing record',
      `{"type":"room_list","rooms":[{"code":"ABC23","state":"waiting","players":[{"name":"m"}]}]}`,
    ],
    [
      'match_resume frames wrong arity',
      '{"type":"match_resume","seed":1,"playerIndex":0,"inputDelay":3,"players":["a","b"],"frames":[[]]}',
    ],
    [
      'match_resume frame out of mask',
      '{"type":"match_resume","seed":1,"playerIndex":0,"inputDelay":3,"players":["a","b"],"frames":[[999],[]]}',
    ],
    ['peer_dropped missing grace', '{"type":"peer_dropped","name":"m"}'],
    [
      'room_list room missing spectators',
      `{"type":"room_list","rooms":[{"code":"ABC23","state":"waiting","players":[]}]}`,
    ],
    [
      'spectate_joined too many players',
      `{"type":"spectate_joined","code":"ABC23","players":["a","b","c"],"spectators":[]}`,
    ],
    [
      'spectate_start frames wrong arity',
      '{"type":"spectate_start","seed":1,"inputDelay":3,"players":["a","b"],"frames":[[]]}',
    ],
    ['spectators names not array', '{"type":"spectators","names":"carol"}'],
    ['spectators empty name', '{"type":"spectators","names":[""]}'],
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
