import { describe, expect, it } from 'vitest';
import { RateLimiter, clientKey } from './rateLimit.js';

describe('RateLimiter', () => {
  it('allows a burst, then one request per refill period', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 3, refillMs: 1000 }, () => now);
    const burst = [1, 2, 3, 4].map(() => limiter.take('a'));
    expect(burst).toEqual([true, true, true, false]);
    expect(limiter.take('b')).toBe(true); // clients are independent
    now += 999;
    expect(limiter.take('a')).toBe(false);
    now += 1;
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    now += 60_000; // refills to capacity, no further
    expect([1, 2, 3, 4].map(() => limiter.take('a'))).toEqual([true, true, true, false]);
  });

  it('survives the clock stepping backwards', () => {
    let now = 10_000;
    const limiter = new RateLimiter({ capacity: 1, refillMs: 1000 }, () => now);
    expect(limiter.take('a')).toBe(true);
    now = 0;
    expect(limiter.take('a')).toBe(false);
    now = 1000;
    expect(limiter.take('a')).toBe(true);
  });
});

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::198.51.100.1', '64:ff9b:0:0::/64'],
  ])('keys %s as %s', (address, key) => {
    expect(clientKey(address)).toBe(key);
  });

  it('gives every address in a /64 the same key', () => {
    expect(clientKey('2001:db8:1:2::9')).toBe(clientKey('2001:db8:1:2:ffff:ffff:ffff:1'));
    expect(clientKey('2001:db8:1:2::9')).not.toBe(clientKey('2001:db8:1:3::9'));
  });
});
