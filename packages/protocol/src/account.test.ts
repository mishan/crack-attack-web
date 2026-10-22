import { describe, expect, it } from 'vitest';
import {
  decodeAccountHandleRequest,
  decodeAccountKeyRequest,
  decodeAccountRegisterRequest,
  foldHandle,
  normalizeAccountKey,
  normalizeHandle,
} from './account.js';
import { ProtocolError } from './codec.js';

const KEY = 'abacus-zoom-acorn-yodel-crane-mango-otter-wafer';

describe('normalizeAccountKey', () => {
  it('keeps a canonical key as it is', () => {
    expect(normalizeAccountKey(KEY)).toBe(KEY);
  });

  it('accepts spaces, capitals and stray separators, as typed on a phone', () => {
    expect(normalizeAccountKey('  Abacus zoom ACORN  yodel-crane mango - otter wafer\n')).toBe(KEY);
  });

  it.each([
    ['too few words', 'abacus-zoom-acorn'],
    ['too many words', `${KEY}-extra`],
    ['a digit', KEY.replace('zoom', 'zo0m')],
    ['a non-ASCII letter', KEY.replace('zoom', 'zööm')],
    ['nothing', ''],
    ['too long', `${'a'.repeat(200)} b c d e f g h`],
  ])('refuses %s', (_what, raw) => {
    expect(normalizeAccountKey(raw)).toBeNull();
  });
});

describe('handles', () => {
  it('clean up as scoreboard names do', () => {
    expect(normalizeHandle('  misha\u202e ')).toBe('misha');
    expect(normalizeHandle('\u200b')).toBeNull();
  });

  it('fold case and compatibility forms, so lookalikes clash', () => {
    expect(foldHandle('Misha')).toBe(foldHandle('mISHA'));
    expect(foldHandle('Ｍｉｓｈａ')).toBe(foldHandle('misha'));
    expect(foldHandle('ﬁsh')).toBe('fish');
    expect(foldHandle('straße')).toBe(foldHandle('STRASSE'));
    expect(foldHandle('İstanbul')).toBe(foldHandle('istanbul'));
    expect(foldHandle('ΣΑΣ')).toBe(foldHandle('σας'));
    expect(foldHandle('misha')).not.toBe(foldHandle('mishа')); // Cyrillic а: not caught
  });
});

describe('decoders', () => {
  it('validate a registration, with or without a guest token', () => {
    expect(decodeAccountRegisterRequest({ handle: 'misha' })).toEqual({ handle: 'misha' });
    const guestToken = '0123456789abcdef0123456789abcdef';
    expect(decodeAccountRegisterRequest({ handle: 'misha', guestToken, extra: 1 })).toEqual({
      handle: 'misha',
      guestToken,
    });
    expect(() => decodeAccountRegisterRequest({ handle: 'misha', guestToken: 'x' })).toThrow(
      ProtocolError,
    );
    expect(() => decodeAccountRegisterRequest({ handle: 7 })).toThrow(ProtocolError);
    expect(() => decodeAccountRegisterRequest([])).toThrow(ProtocolError);
  });

  it('validate key and rename requests', () => {
    expect(decodeAccountKeyRequest({ key: KEY })).toEqual({ key: KEY });
    expect(() => decodeAccountKeyRequest({})).toThrow(ProtocolError);
    expect(decodeAccountHandleRequest({ handle: 'x' })).toEqual({ handle: 'x' });
    expect(() => decodeAccountHandleRequest(null)).toThrow(ProtocolError);
  });
});
