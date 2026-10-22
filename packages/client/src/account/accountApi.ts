/**
 * accountApi.ts — the client side of the relay's account API (protocol
 * `account.ts`) and the ladder's read-only API (protocol `rating.ts`). The
 * relay serves both beside its WebSocket, on the same host as the scoreboard.
 * Responses are shape-checked, as for the scoreboard: a proxy's error page or
 * a stale server must not reach the game as a malformed object.
 */

import {
  ACCOUNT_API_PREFIX,
  ACCOUNT_ERROR_CODES,
  RATING_API_PREFIX,
  SCOREBOARD_ERROR_CODES,
  type AccountInfo,
  type AccountKeyResponse,
  type AccountRegisterResponse,
  type AccountResponse,
  type AccountSessionResponse,
  type ApiErrorCode,
  type LeaderboardResponse,
  type RatingPlayerResponse,
} from '@crack-attack/protocol';

/** A request slower than this counts as a network failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The origin the relay's HTTP API is served from, for a relay WebSocket URL:
 * the same host over http(s) — `wss://example.com/ws` → `https://example.com`.
 * Null if the relay URL is unusable.
 */
export function apiOriginFor(relayUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.origin;
}

/** Why a request failed: the server's error code, or a client-side failure. */
export type AccountFailure = ApiErrorCode | 'network' | 'bad_response';

export class AccountError extends Error {
  constructor(
    readonly code: AccountFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** The account and ladder APIs on one relay. */
export class AccountClient {
  constructor(
    /** The relay's HTTP origin, e.g. `https://example.com`. */
    readonly origin: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  register(handle: string, guestToken?: string): Promise<AccountRegisterResponse> {
    return this.post(
      '/register',
      { handle, ...(guestToken ? { guestToken } : {}) },
      null,
      isRegisterResponse,
    );
  }

  login(key: string): Promise<AccountSessionResponse> {
    return this.post('/login', { key }, null, isSessionResponse);
  }

  me(session: string): Promise<AccountResponse> {
    return this.request(
      `${ACCOUNT_API_PREFIX}/me`,
      { headers: bearer(session) },
      isAccountResponse,
    );
  }

  rename(session: string, handle: string): Promise<AccountResponse> {
    return this.post('/handle', { handle }, session, isAccountResponse);
  }

  /** A new key, for the current one. */
  replaceKey(session: string, key: string): Promise<AccountKeyResponse> {
    return this.post('/key', { key }, session, isKeyResponse);
  }

  logout(session: string): Promise<unknown> {
    return this.post('/logout', undefined, session, isObject);
  }

  /** Delete the account; with a session, only if the key is that session's account's. */
  deleteAccount(key: string, session: string | null = null): Promise<unknown> {
    return this.post('/delete', { key }, session, isObject);
  }

  leaderboard(limit?: number): Promise<LeaderboardResponse> {
    const query = limit === undefined ? '' : `?limit=${limit}`;
    return this.request(`${RATING_API_PREFIX}/leaderboard${query}`, {}, isLeaderboard);
  }

  player(handle: string): Promise<RatingPlayerResponse> {
    return this.request(
      `${RATING_API_PREFIX}/player/${encodeURIComponent(handle)}`,
      {},
      isPlayerResponse,
    );
  }

  private post<T>(
    route: string,
    body: unknown,
    session: string | null,
    valid: (v: unknown) => v is T,
  ): Promise<T> {
    return this.request(
      `${ACCOUNT_API_PREFIX}${route}`,
      {
        method: 'POST',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(session === null ? {} : bearer(session)),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      valid,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    valid: (body: unknown) => body is T,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.origin + path, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AccountError('network', `can't reach the server: ${String(err)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const code = errorCode(body) ?? (res.status >= 500 ? 'internal' : 'bad_response');
      throw new AccountError(code, errorMessage(body) ?? `HTTP ${res.status}`);
    }
    if (!valid(body)) throw new AccountError('bad_response', 'unexpected server response');
    return body;
  }
}

const bearer = (session: string): Record<string, string> => ({
  Authorization: `Bearer ${session}`,
});

// --- response shapes -------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const MAX_DATE_MS = 8.64e15;
const isTime = (v: unknown): v is number => isInt(v) && Math.abs(v) <= MAX_DATE_MS;
const ERROR_CODES: readonly unknown[] = [...SCOREBOARD_ERROR_CODES, ...ACCOUNT_ERROR_CODES];

function errorCode(body: unknown): ApiErrorCode | null {
  if (!isObject(body)) return null;
  const code = body['error'];
  return ERROR_CODES.includes(code) ? (code as ApiErrorCode) : null;
}

function errorMessage(body: unknown): string | null {
  return isObject(body) && isString(body['message']) ? body['message'] : null;
}

function isAccountInfo(v: unknown): v is AccountInfo {
  return (
    isObject(v) &&
    isString(v['handle']) &&
    isInt(v['rating']) &&
    typeof v['provisional'] === 'boolean' &&
    isInt(v['wins']) &&
    isInt(v['losses']) &&
    isInt(v['draws']) &&
    isTime(v['createdAt']) &&
    isTime(v['renameAt'])
  );
}

function isAccountResponse(v: unknown): v is AccountResponse {
  return isObject(v) && isAccountInfo(v['account']);
}

function isSessionResponse(v: unknown): v is AccountSessionResponse {
  return isObject(v) && isAccountInfo(v['account']) && isString(v['session']);
}

function isRegisterResponse(v: unknown): v is AccountRegisterResponse {
  return isObject(v) && isSessionResponse(v) && isString(v['key']);
}

function isKeyResponse(v: unknown): v is AccountKeyResponse {
  return isObject(v) && isString(v['key']);
}

function isLeaderboard(v: unknown): v is LeaderboardResponse {
  return (
    isObject(v) &&
    Array.isArray(v['entries']) &&
    v['entries'].every(
      (e) =>
        isObject(e) &&
        isInt(e['rank']) &&
        isString(e['handle']) &&
        isInt(e['rating']) &&
        isInt(e['wins']) &&
        isInt(e['losses']) &&
        isInt(e['draws']),
    )
  );
}

const RESULTS: readonly unknown[] = ['win', 'loss', 'draw'];
const ENDS: readonly unknown[] = ['result', 'concession', 'disconnect', 'desync'];

function isPlayerResponse(v: unknown): v is RatingPlayerResponse {
  return (
    isObject(v) &&
    isString(v['handle']) &&
    isInt(v['rating']) &&
    typeof v['provisional'] === 'boolean' &&
    isInt(v['wins']) &&
    isInt(v['losses']) &&
    isInt(v['draws']) &&
    Array.isArray(v['games']) &&
    v['games'].every(
      (g) =>
        isObject(g) &&
        isInt(g['id']) &&
        (g['opponent'] === null || isString(g['opponent'])) &&
        RESULTS.includes(g['result']) &&
        ENDS.includes(g['end']) &&
        isInt(g['ratingBefore']) &&
        isInt(g['ratingAfter']) &&
        isTime(g['createdAt']),
    )
  );
}
