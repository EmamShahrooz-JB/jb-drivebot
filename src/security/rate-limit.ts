/**
 * Token bucket rate limiter keyed by Telegram user id.
 * In-memory on purpose: the bot runs as a single process and a restart
 * loosening the bucket is not a security problem.
 */
export interface BucketOptions {
  perMinute: number;
  burst: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly now: () => number;
  constructor(private readonly opts: BucketOptions) {
    this.now = opts.now ?? Date.now;
  }

  private refill(key: string) {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.opts.burst, updated: t };
    const elapsed = Math.max(0, t - b.updated);
    const refillRate = this.opts.perMinute / 60_000;
    b.tokens = Math.min(this.opts.burst, b.tokens + elapsed * refillRate);
    b.updated = t;
    this.buckets.set(key, b);
    return b;
  }

  /** Returns { allowed, retryAfterMs } and consumes one token when allowed. */
  consume(key: string, cost = 1): { allowed: boolean; retryAfterMs: number } {
    const b = this.refill(key);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { allowed: true, retryAfterMs: 0 };
    }
    const need = cost - b.tokens;
    const retryAfterMs = Math.ceil((need / this.opts.perMinute) * 60_000);
    return { allowed: false, retryAfterMs };
  }

  reset(key: string) {
    this.buckets.delete(key);
  }
}
