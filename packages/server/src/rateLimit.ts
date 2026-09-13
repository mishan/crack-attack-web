/**
 * rateLimit.ts — per-client token buckets for the scoreboard API, and the key
 * a client is limited by.
 */

/** A token bucket: a burst of `capacity` requests, earning one back every `refillMs`. */
export interface RateLimit {
  capacity: number;
  refillMs: number;
}

/** Past this many tracked clients, refilled buckets are dropped before adding another. */
const SWEEP_AT = 10_000;

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly limit: RateLimit,
    private readonly now: () => number,
  ) {}

  /** Spend one request for `key`; false if it has none left. */
  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      bucket.tokens = this.refilled(bucket, now);
      bucket.at = now;
    } else {
      if (this.buckets.size >= SWEEP_AT) this.sweep(now);
      bucket = { tokens: this.limit.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  private refilled(bucket: { tokens: number; at: number }, now: number): number {
    // max(0, …): a wall clock stepped backwards mustn't drain the bucket.
    const earned = Math.max(0, now - bucket.at) / this.limit.refillMs;
    return Math.min(this.limit.capacity, bucket.tokens + earned);
  }

  /** Forget clients whose buckets are full again; they'd start full anyway. */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (this.refilled(bucket, now) >= this.limit.capacity) this.buckets.delete(key);
    }
  }
}

/**
 * The rate-limit key for a client address. IPv4 (including IPv4-mapped IPv6)
 * is limited per address. IPv6 is limited per /64, since a single host
 * usually holds a whole /64 and can hop between its addresses at will.
 */
export function clientKey(address: string): string {
  let a = address.trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith('::ffff:') && a.includes('.')) return a.slice('::ffff:'.length);
  if (!a.includes(':')) return a;

  // An embedded IPv4 tail stands for two groups; it's past the /64 anyway.
  const groups = (part: string): string[] =>
    part === '' ? [] : part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const gap = a.indexOf('::');
  let all: string[];
  if (gap < 0) {
    all = groups(a);
  } else {
    const head = groups(a.slice(0, gap));
    const tail = groups(a.slice(gap + 2));
    all = [
      ...head,
      ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'),
      ...tail,
    ];
  }
  const prefix = all.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}
