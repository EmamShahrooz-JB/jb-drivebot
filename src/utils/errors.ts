export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  constructor(code: string, message: string, opts: { retryable?: boolean; details?: unknown } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
}

export const isRetryable = (err: unknown): boolean => {
  if (err instanceof AppError) return err.retryable;
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|timeout|429|5\d\d/i.test(msg);
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
