/**
 * apiError.ts — how the relay's HTTP services (the scoreboard, accounts)
 * refuse a request, and the rate limits they share.
 */

import type { ApiErrorBody, ApiErrorCode } from '@crack-attack/protocol';
import { RateLimiter, siteKey, type RateLimit } from './rateLimit.js';

/** A request a service refuses, with its HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
    /** Extra response headers, e.g. `Retry-After` or `Allow`. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body(): ApiErrorBody {
    return { error: this.code, message: this.message };
  }

  /** This refusal with more response headers. */
  withHeaders(extra: Readonly<Record<string, string>>): ApiError {
    return new ApiError(this.status, this.code, this.message, { ...this.headers, ...extra });
  }
}

/** The key of a bucket shared by all clients. */
const EVERYONE = '*';

/** The 429 for a request `key`'s bucket can't afford, saying when to try again. */
export function rateLimited(limiter: RateLimiter, key: string): ApiError {
  const seconds = Math.max(1, Math.ceil(limiter.waitMs(key) / 1000));
  return new ApiError(429, 'rate_limited', 'too many requests; slow down', {
    'Retry-After': String(seconds),
  });
}

/** Spend a request from `key`'s bucket, or refuse with a 429. */
export function take(limiter: RateLimiter, key: string): void {
  if (!limiter.take(key)) throw rateLimited(limiter, key);
}

/**
 * A request's rate limits, narrowest first: per client, per IPv6 /48 (none
 * for IPv4), and across all clients (unless that's null).
 */
export class TieredLimit {
  private readonly own: RateLimiter;
  private readonly site: RateLimiter;
  private readonly everyone: RateLimiter | null;

  constructor(
    limits: [own: RateLimit, site: RateLimit, everyone: RateLimit | null],
    now: () => number,
    /** Called when the bucket shared by all clients turns a request away. */
    private readonly onSharedRefusal: () => void,
  ) {
    this.own = new RateLimiter(limits[0], now);
    this.site = new RateLimiter(limits[1], now);
    this.everyone = limits[2] && new RateLimiter(limits[2], now, 1);
  }

  /**
   * Spend one request for `client`, or refuse with a 429. Narrowest first, so
   * a client already over its own limit spends nothing from the shared buckets.
   */
  take(client: string): void {
    for (const [limiter, key] of this.buckets(client)) {
      if (!limiter.take(key)) throw this.refusal(limiter, key);
    }
  }

  /** Clients tracked by the per-client bucket. */
  get clients(): number {
    return this.own.size;
  }

  private buckets(client: string): [RateLimiter, string][] {
    const site = siteKey(client);
    return [
      [this.own, client],
      ...(site === null ? [] : [[this.site, site] as [RateLimiter, string]]),
      ...(this.everyone ? [[this.everyone, EVERYONE] as [RateLimiter, string]] : []),
    ];
  }

  private refusal(limiter: RateLimiter, key: string): ApiError {
    if (key === EVERYONE) this.onSharedRefusal();
    return rateLimited(limiter, key);
  }
}
