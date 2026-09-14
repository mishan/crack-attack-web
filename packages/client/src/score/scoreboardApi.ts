/**
 * scoreboardApi.ts — the client side of the solo scoreboard's HTTP API
 * (protocol `scoreboard.ts`), which the relay serves beside its WebSocket (see
 * docs/SCOREBOARD_PLAN.md). Responses are shape-checked: a proxy's error page
 * or a stale server must not reach the game as a malformed object.
 */

import {
  SCOREBOARD_ERROR_CODES,
  SCORE_BOARDS,
  SCORE_PERIODS,
  SOLO_API_PREFIX,
  isRunId,
  type ScoreBoard,
  type ScoreboardErrorCode,
  type ScorePeriod,
  type SoloScoresResponse,
  type SoloStanding,
  type SoloSubmitRequest,
  type SoloSubmitResponse,
  type SoloTicketResponse,
} from '@crack-attack/protocol';

/** A request slower than this counts as a network failure. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The scoreboard API's base URL for a relay WebSocket URL: the same host, over
 * http(s), under `/api/solo` — e.g. `wss://example.com/ws` →
 * `https://example.com/api/solo`. Null if the relay URL is unusable.
 */
export function scoreboardUrlFor(relayUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return `${url.origin}${SOLO_API_PREFIX}`;
}

/** Why a request failed: the server's error code, or a client-side failure. */
export type ScoreboardFailure = ScoreboardErrorCode | 'network' | 'bad_response';

/** Failures that may pass: the server was unreachable, busy, or broken. */
const RETRYABLE: ReadonlySet<ScoreboardFailure> = new Set([
  'network',
  'bad_response',
  'rate_limited',
  'busy',
  'internal',
]);

export class ScoreboardError extends Error {
  constructor(
    readonly code: ScoreboardFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ScoreboardError';
  }

  /** Whether trying again later might work. */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

export interface ScoresQuery {
  board?: ScoreBoard;
  period?: ScorePeriod;
  /** `YYYY-MM`. */
  month?: string;
  limit?: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ScoreboardClient {
  constructor(
    readonly baseUrl: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
  ) {}

  /** A run ticket for the next ranked run. */
  ticket(): Promise<SoloTicketResponse> {
    return this.request('/ticket', { method: 'POST' }, isTicket);
  }

  /** Submit a finished run; resolves to its verified score and standing. */
  submit(request: SoloSubmitRequest): Promise<SoloSubmitResponse> {
    return this.request(
      '/submit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      },
      isSubmitResponse,
    );
  }

  /** A board. */
  scores(query: ScoresQuery = {}): Promise<SoloScoresResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    const search = params.toString();
    return this.request(`/scores${search ? `?${search}` : ''}`, {}, isScoresResponse);
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    valid: (body: unknown) => body is T,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ScoreboardError('network', `can't reach the scoreboard: ${String(err)}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const code = errorCode(body) ?? (res.status >= 500 ? 'internal' : 'bad_response');
      throw new ScoreboardError(code, errorMessage(body) ?? `HTTP ${res.status}`);
    }
    if (!valid(body)) throw new ScoreboardError('bad_response', 'unexpected scoreboard response');
    return body;
  }
}

// --- response shapes -----------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);

function errorCode(body: unknown): ScoreboardErrorCode | null {
  if (!isObject(body)) return null;
  const code = body['error'];
  return (SCOREBOARD_ERROR_CODES as readonly unknown[]).includes(code)
    ? (code as ScoreboardErrorCode)
    : null;
}

function errorMessage(body: unknown): string | null {
  return isObject(body) && typeof body['message'] === 'string' ? body['message'] : null;
}

/** The largest epoch-ms time a `Date` can hold; beyond it, formatting throws. */
const MAX_DATE_MS = 8.64e15;
const isTime = (v: unknown): v is number => isInt(v) && Math.abs(v) <= MAX_DATE_MS;
const isOneOf = (v: unknown, allowed: readonly string[]): boolean =>
  typeof v === 'string' && allowed.includes(v);

function isTicket(v: unknown): v is SoloTicketResponse {
  return (
    isObject(v) &&
    typeof v['runId'] === 'string' &&
    isRunId(v['runId']) &&
    isInt(v['seed']) &&
    isInt(v['simVersion']) &&
    isTime(v['expiresAt'])
  );
}

function isStanding(v: unknown): v is SoloStanding | null {
  return v === null || (isObject(v) && isInt(v['rank']) && isInt(v['total']));
}

function isSubmitResponse(v: unknown): v is SoloSubmitResponse {
  if (!isObject(v) || !isObject(v['standing'])) return false;
  const { standing } = v;
  return (
    isInt(v['id']) &&
    typeof v['name'] === 'string' &&
    isInt(v['score']) &&
    isInt(v['topMultiplier']) &&
    isInt(v['ticks']) &&
    isStanding(standing['all']) &&
    isStanding(standing['month'])
  );
}

function isEntry(v: unknown): boolean {
  return (
    isObject(v) &&
    isInt(v['rank']) &&
    isInt(v['id']) &&
    typeof v['name'] === 'string' &&
    isInt(v['score']) &&
    isInt(v['topMultiplier']) &&
    isInt(v['ticks']) &&
    isTime(v['createdAt'])
  );
}

function isScoresResponse(v: unknown): v is SoloScoresResponse {
  return (
    isObject(v) &&
    isOneOf(v['board'], SCORE_BOARDS) &&
    isOneOf(v['period'], SCORE_PERIODS) &&
    // A monthly board names its month; an all-time one has none.
    (v['period'] === 'month' ? typeof v['month'] === 'string' : v['month'] === null) &&
    isInt(v['total']) &&
    Array.isArray(v['entries']) &&
    v['entries'].every(isEntry)
  );
}
