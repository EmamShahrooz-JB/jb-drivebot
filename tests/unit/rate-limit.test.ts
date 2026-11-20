import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../../src/security/rate-limit.js';
import { backoffDelay } from '../../src/utils/backoff.js';

describe('RateLimiter', () => {
  it('allows a burst then blocks', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ perMinute: 60, burst: 3, now: () => now });
    expect(limiter.consume('u1').allowed).toBe(true);
    expect(limiter.consume('u1').allowed).toBe(true);
    expect(limiter.consume('u1').allowed).toBe(true);
    const blocked = limiter.consume('u1');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ perMinute: 60, burst: 1, now: () => now });
    expect(limiter.consume('u1').allowed).toBe(true);
    expect(limiter.consume('u1').allowed).toBe(false);
    now += 1_100; // ~1 token per second at 60/min
    expect(limiter.consume('u1').allowed).toBe(true);
  });

  it('isolates users from each other', () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 });
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('b').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
  });

  it('supports weighted costs', () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 5 });
    expect(limiter.consume('a', 5).allowed).toBe(true);
    expect(limiter.consume('a', 1).allowed).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('grows and stays under the cap', () => {
    const values = [0, 1, 2, 3, 4, 10].map((a) => backoffDelay(a, { baseMs: 100, maxMs: 2000, jitter: 0 }));
    expect(values[0]).toBe(100);
    expect(values[1]).toBe(200);
    expect(values[2]).toBe(400);
    expect(values[5]).toBe(2000);
  });

  it('adds bounded jitter', () => {
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(3, { baseMs: 100, maxMs: 5000, jitter: 0.25 });
      expect(d).toBeGreaterThanOrEqual(600);
      expect(d).toBeLessThanOrEqual(1000);
    }
  });
});
