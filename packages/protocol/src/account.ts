/**
 * account.ts — the account API: request/response shapes, limits, and the
 * validation both ends share (see docs/RATING_PLAN.md).
 *
 * An account is a handle, a key and a rating; no email, password or real
 * name. The server makes the key (eight words) and stores only its hash, so
 * the key _is_ the account: lose it and the account is gone. Logging in trades
 * the key for a session token, the same token the lobby's `hello` carries.
 *
 * Plain JSON over HTTP, served by the relay beside the scoreboard:
 *
 *   POST /api/account/register (AccountRegisterRequest)            → AccountRegisterResponse
 *   POST /api/account/login    (AccountLoginRequest)               → AccountSessionResponse
 *   GET  /api/account/me                          (session)        → AccountResponse
 *   POST /api/account/handle   (AccountHandleRequest, session)     → AccountResponse
 *   POST /api/account/key      (AccountKeyRequest, session)        → AccountKeyResponse
 *   POST /api/account/logout                      (session)        → {}
 *   POST /api/account/delete   (AccountDeleteRequest, session?)    → {}
 *
 * Anything that could lose the owner the account takes the key itself, not
 * just a session, so a borrowed or stolen logged-in browser can't: a new key
 * needs the current one, and so does deleting. (A lost key therefore can't be
 * replaced; a browser still logged in keeps playing, but nowhere new can log
 * in.) Deleting with a session too checks the key is that session's account's.
 *
 * "(session)" routes take `Authorization: Bearer <session>`, never a cookie,
 * so there's no cross-site request to forge. Keys and sessions travel only in
 * bodies and headers, never in URLs. Failures come back as an
 * {@link ApiErrorBody}.
 *
 * This package must remain platform-agnostic (no DOM, no Node builtins).
 */

import { ProtocolError, isSessionToken } from './codec.js';
import { MAX_PLAYER_NAME_LENGTH } from './messages.js';
import { SCOREBOARD_ERROR_CODES, normalizeScoreName } from './scoreboard.js';

/** Path prefix of every account route. */
export const ACCOUNT_API_PREFIX = '/api/account';

/** Words in an account key. */
export const ACCOUNT_KEY_WORDS = 8;

/** Longest key a request may carry, in UTF-16 units: eight long words and their separators, with room to spare. */
export const ACCOUNT_KEY_MAX_INPUT = 200;

/** Largest account request body the server reads. */
export const ACCOUNT_MAX_BODY_BYTES = 1024;

/** A rating is provisional (shown as `1580?`) while its deviation is above this. */
export const PROVISIONAL_RD = 110;

/** How long after a rename the next one is allowed, in ms. */
export const HANDLE_RENAME_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a session lasts after its last use, in ms. */
export const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/** An account, as its owner sees it. */
export interface AccountInfo {
  handle: string;
  /** Rounded to a whole number. */
  rating: number;
  /** The rating's deviation is above {@link PROVISIONAL_RD}. */
  provisional: boolean;
  wins: number;
  losses: number;
  draws: number;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms from which the handle may be changed; at or before now, it may be now. */
  renameAt: number;
}

export interface AccountRegisterRequest {
  handle: string;
  /** The browser's guest token: its W-L record moves to the new account. */
  guestToken?: string;
}

export interface AccountRegisterResponse {
  /** The account key. Shown once: the server keeps only its hash. */
  key: string;
  session: string;
  account: AccountInfo;
}

export interface AccountLoginRequest {
  key: string;
}

export interface AccountSessionResponse {
  session: string;
  account: AccountInfo;
}

export interface AccountResponse {
  account: AccountInfo;
}

export interface AccountHandleRequest {
  handle: string;
}

/** Replacing the key: the current one. */
export interface AccountKeyRequest {
  key: string;
}

export interface AccountKeyResponse {
  /** The new key; the old one no longer works. */
  key: string;
}

export interface AccountDeleteRequest {
  key: string;
}

export const ACCOUNT_ERROR_CODES = [
  /** No session, or one that's unknown or expired. */
  'unauthorized',
  /** No account has that key. */
  'bad_key',
  'bad_handle',
  'handle_taken',
  'rename_too_soon',
] as const;
export type AccountErrorCode = (typeof ACCOUNT_ERROR_CODES)[number];

/** Every error code the relay's HTTP API returns. */
export type ApiErrorCode = (typeof SCOREBOARD_ERROR_CODES)[number] | AccountErrorCode;

export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
}

/**
 * A handle cleaned up as for the scoreboard (see `normalizeScoreName`), or
 * null if nothing usable is left, or if it's longer than a lobby name may be
 * ({@link MAX_PLAYER_NAME_LENGTH} UTF-16 units: an account plays under its
 * handle, and sixteen characters of long emoji sequences can run past that).
 */
export function normalizeHandle(raw: string): string | null {
  const handle = normalizeScoreName(raw);
  return handle !== null && handle.length <= MAX_PLAYER_NAME_LENGTH ? handle : null;
}

/**
 * The form of a normalized handle that uniqueness is checked on: two handles
 * clash if they fold alike. Compatibility forms (full-width letters,
 * ligatures) fold to their plain letters, and case doesn't count. Upper-casing
 * first catches the pairs lower-casing alone misses (`ß` and `SS`), and the dot
 * `İ` leaves behind on its `i` is dropped, so `İstanbul` clashes with
 * `istanbul`.
 */
export function foldHandle(handle: string): string {
  return handle
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()
    .replace(/i\u0307/g, 'i')
    .normalize('NFC');
}

/**
 * A key as typed or pasted, in its canonical form: lowercase words joined by
 * hyphens, whatever separated them (spaces from a phone keyboard, say). Null
 * if it isn't {@link ACCOUNT_KEY_WORDS} words of letters.
 */
export function normalizeAccountKey(raw: string): string | null {
  if (raw.length > ACCOUNT_KEY_MAX_INPUT) return null;
  const words = raw
    .toLowerCase()
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length !== ACCOUNT_KEY_WORDS) return null;
  return words.every((w) => /^[a-z]+$/.test(w)) ? words.join('-') : null;
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ProtocolError(`${field} must be a string`);
  return value;
}

/** Validate a registration's envelope; throws {@link ProtocolError}. */
export function decodeAccountRegisterRequest(value: unknown): AccountRegisterRequest {
  const { handle, guestToken } = object(value, 'registration');
  const request: AccountRegisterRequest = { handle: string(handle, 'handle') };
  if (guestToken !== undefined) {
    const token = string(guestToken, 'guestToken');
    if (!isSessionToken(token)) throw new ProtocolError('guestToken is not a token');
    request.guestToken = token;
  }
  return request;
}

/** Validate a request carrying just a key (log in, a new key, delete); throws {@link ProtocolError}. */
export function decodeAccountKeyRequest(value: unknown): AccountLoginRequest {
  return { key: string(object(value, 'request').key, 'key') };
}

/** Validate a rename's envelope; throws {@link ProtocolError}. */
export function decodeAccountHandleRequest(value: unknown): AccountHandleRequest {
  return { handle: string(object(value, 'request').handle, 'handle') };
}
