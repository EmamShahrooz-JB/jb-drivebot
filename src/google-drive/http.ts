import { AppError } from '../utils/errors.js';
import { backoffDelay, sleep } from '../utils/backoff.js';
import type { Logger } from '../utils/logger.js';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveErrorBody {
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string; domain?: string }>;
    status?: string;
  };
}

export function driveErrorFrom(status: number, body: string): AppError {
  let reason = '';
  let message = body.slice(0, 300);
  try {
    const json = JSON.parse(body) as DriveErrorBody;
    reason = json.error?.errors?.[0]?.reason ?? json.error?.status ?? '';
    message = json.error?.message ?? message;
  } catch {
    /* keep raw text */
  }
  const retryable = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  const map: Record<number, string> = {
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    429: 'rate_limited',
  };
  const code = map[status] ?? (status >= 500 ? 'drive_unavailable' : 'drive_error');
  return new AppError(code, `Drive API ${status}${reason ? ` (${reason})` : ''}: ${message}`, {
    retryable,
    details: { status, reason },
  });
}

export interface TokenProvider {
  (): Promise<string>;
}

export interface DriveHttpOptions {
  tokenProvider: TokenProvider;
  logger: Logger;
  fetchImpl?: typeof fetch;
  /** retries for transient Drive failures */
  maxRetries?: number;
  /** overridable so the services can be exercised against a local stub */
  apiBase?: string;
  uploadApiBase?: string;
}

export class DriveHttp {
  readonly apiBase: string;
  readonly uploadApiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  constructor(private readonly opts: DriveHttpOptions) {
    this.apiBase = opts.apiBase ?? DRIVE_API;
    this.uploadApiBase = opts.uploadApiBase ?? DRIVE_UPLOAD_API;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  async authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await this.opts.tokenProvider();
    return { authorization: `Bearer ${token}`, ...extra };
  }

  /** JSON request with exponential backoff on 429/5xx. */
  async json<T>(url: string, init: RequestInit = {}): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const headers = await this.authHeaders({
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...((init.headers as Record<string, string>) ?? {}),
        });
        const res = await this.fetchImpl(url, { ...init, headers });
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          const text = await res.text();
          return (text ? JSON.parse(text) : undefined) as T;
        }
        const body = await res.text();
        const err = driveErrorFrom(res.status, body);
        if (!err.retryable || attempt === this.maxRetries) throw err;
        lastErr = err;
        this.opts.logger.debug('drive request failed, retrying', { url: url.split('?')[0], attempt, status: res.status });
      } catch (err) {
        if (err instanceof AppError && !err.retryable) throw err;
        if (attempt === this.maxRetries) throw err;
        lastErr = err;
      }
      await sleep(backoffDelay(attempt, { baseMs: 800, maxMs: 30_000 }));
    }
    throw lastErr instanceof Error ? lastErr : new AppError('drive_error', 'drive request failed');
  }

  /** Unauthorized streaming request (used for file content downloads). */
  async stream(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = await this.authHeaders({ ...((init.headers as Record<string, string>) ?? {}) });
    const res = await this.fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      const body = await res.text();
      throw driveErrorFrom(res.status, body);
    }
    return res;
  }
}

/** Escape a value for use inside a Drive `q` string literal. */
export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
