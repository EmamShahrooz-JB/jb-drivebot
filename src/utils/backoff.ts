export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  factor?: number;
}

/** Exponential backoff with full jitter, capped. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 1000, maxMs = 5 * 60_000, jitter = 0.25, factor = 2 } = opts;
  const raw = Math.min(maxMs, baseMs * Math.pow(factor, Math.max(0, attempt)));
  const spread = raw * jitter;
  return Math.round(raw - spread + Math.random() * spread * 2);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
