/**
 * Minimal structured logger with hard redaction of anything that looks like a
 * credential. Google OAuth tokens, Telegram bot tokens and pairing codes must
 * never reach stdout, a log file or a Telegram message.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b\d{6,12}:AA[\w-]{30,}\b/g, // telegram bot token
  /\bya29\.[\w.-]{20,}/g, // google access token
  /\b1\/\/[\w.-]{20,}/g, // google refresh token
  /\bGOCSPX-[\w-]{10,}/g, // google client secret
  /("?(?:access_token|refresh_token|client_secret|id_token|code_verifier|password|authorization)"?\s*[:=]\s*"?)([^"'\s,&}]+)/gi,
  /([?&](?:code|access_token|refresh_token|state)=)[^&\s]+/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{10,}/g,
];

export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1?: string) => (typeof p1 === 'string' && /[:=?&]$|[:=]\s*$/.test(p1) ? `${p1}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|cookie|apikey|api_key/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: LogLevel = 'info', bindings: Record<string, unknown> = {}): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (ORDER[lvl] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(msg),
      ...(redactValue(bindings) as Record<string, unknown>),
      ...(meta ? (redactValue(meta) as Record<string, unknown>) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level: lvl, msg: record.msg });
    }
    const stream = ORDER[lvl] >= ORDER.error ? process.stderr : process.stdout;
    stream.write(line + '\n');
  };
  return {
    trace: (m, meta) => emit('trace', m, meta),
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (b) => createLogger(level, { ...bindings, ...b }),
  };
}
