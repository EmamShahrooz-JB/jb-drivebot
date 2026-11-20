import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { validateTarget, guardedLookup, SsrfError, type Resolver } from '../security/ssrf.js';
import { AppError } from '../utils/errors.js';
import { safeFileName } from '../security/sanitize.js';
import type { Logger } from '../utils/logger.js';

export interface ProbeResult {
  finalUrl: string;
  size: number | null;
  contentType: string | null;
  filename: string | null;
  supportsRange: boolean;
  status: number;
}

export interface DownloadResult {
  finalUrl: string;
  path: string;
  bytes: number;
  md5: string;
  contentType: string | null;
  filename: string;
}

export interface DownloadOptions {
  destDir: string;
  filenameHint?: string;
  maxBytes: number;
  maxRedirects?: number;
  timeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
  shouldAbort?: () => Promise<boolean> | boolean;
  userAgent?: string;
  resolver?: Resolver;
  /**
   * Test seam: allow a loopback target. Silently ignored unless NODE_ENV is
   * not "production", so a misconfiguration can never open SSRF in prod.
   */
  allowLoopback?: boolean;
}

const DEFAULT_UA = 'Mozilla/5.0 (compatible; JB-DriveBot/1.0; +https://altare.gg)';

interface RawResponse {
  res: http.IncomingMessage;
  finalUrl: string;
}

/**
 * Perform a GET/HEAD with manual redirect handling. Every hop is validated by
 * the SSRF guard and the socket-level `lookup` double checks the IP we actually
 * connect to (defeats DNS rebinding).
 */
async function requestFollow(
  startUrl: string,
  opts: {
    method: 'GET' | 'HEAD';
    maxRedirects: number;
    timeoutMs: number;
    userAgent: string;
    resolver?: Resolver;
    allowLoopback?: boolean;
  }
): Promise<RawResponse> {
  let current = startUrl;
  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const target = await validateTarget(current, {
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
      ...(opts.allowLoopback ? { allowLoopback: true } : {}),
    });
    const isHttps = target.url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.request(
        {
          protocol: target.url.protocol,
          hostname: target.url.hostname,
          port: target.url.port || (isHttps ? 443 : 80),
          path: target.url.pathname + target.url.search,
          method: opts.method,
          headers: {
            'user-agent': opts.userAgent,
            accept: '*/*',
            'accept-encoding': 'identity',
          },
          lookup: guardedLookup(target.addresses) as unknown as net.LookupFunction,
          timeout: opts.timeoutMs,
        },
        resolve
      );
      req.on('timeout', () => {
        req.destroy(new AppError('timeout', `request to ${target.hostname} timed out`));
      });
      req.on('error', (err) => {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ESSRFBLOCKED') reject(new SsrfError(e.message));
        else reject(new AppError('network', e.message, { retryable: true }));
      });
      req.end();
    });

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (hop === opts.maxRedirects) {
        throw new AppError('too_many_redirects', `more than ${opts.maxRedirects} redirects`);
      }
      // A redirect target is re-validated on the next loop iteration.
      current = new URL(location, target.url).toString();
      continue;
    }
    return { res, finalUrl: current };
  }
  throw new AppError('too_many_redirects', 'redirect loop');
}

function filenameFromDisposition(header: string | undefined): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star?.[1]) {
    const value = star[1].trim().replace(/^UTF-8''/i, '').replace(/^"|"$/g, '');
    try {
      return safeFileName(decodeURIComponent(value));
    } catch {
      return safeFileName(value);
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1] ? safeFileName(plain[1]) : null;
}

export class HttpDownloader {
  constructor(private readonly logger: Logger) {}

  /** Loopback downloads are only ever permitted outside production. */
  private static allowLoopback(requested: boolean | undefined): boolean {
    return requested === true && process.env.NODE_ENV !== 'production';
  }

  async probe(
    rawUrl: string,
    opts: { timeoutMs?: number; maxRedirects?: number; resolver?: Resolver; allowLoopback?: boolean } = {}
  ): Promise<ProbeResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxRedirects = opts.maxRedirects ?? 5;
    const allowLoopback = HttpDownloader.allowLoopback(opts.allowLoopback);
    try {
      const { res, finalUrl } = await requestFollow(rawUrl, {
        method: 'HEAD',
        maxRedirects,
        timeoutMs,
        userAgent: DEFAULT_UA,
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
        ...(allowLoopback ? { allowLoopback: true } : {}),
      });
      res.resume();
      const len = res.headers['content-length'];
      return {
        finalUrl,
        status: res.statusCode ?? 0,
        size: len ? Number(len) : null,
        contentType: (res.headers['content-type'] as string | undefined) ?? null,
        filename: filenameFromDisposition(res.headers['content-disposition'] as string | undefined),
        supportsRange: String(res.headers['accept-ranges'] ?? '').includes('bytes'),
      };
    } catch (err) {
      if (err instanceof SsrfError) throw err;
      // Some servers reject HEAD; fall back to a GET that we abort immediately.
      const { res, finalUrl } = await requestFollow(rawUrl, {
        method: 'GET',
        maxRedirects,
        timeoutMs,
        userAgent: DEFAULT_UA,
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
        ...(allowLoopback ? { allowLoopback: true } : {}),
      });
      res.destroy();
      const len = res.headers['content-length'];
      return {
        finalUrl,
        status: res.statusCode ?? 0,
        size: len ? Number(len) : null,
        contentType: (res.headers['content-type'] as string | undefined) ?? null,
        filename: filenameFromDisposition(res.headers['content-disposition'] as string | undefined),
        supportsRange: String(res.headers['accept-ranges'] ?? '').includes('bytes'),
      };
    }
  }

  async download(rawUrl: string, opts: DownloadOptions): Promise<DownloadResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const maxRedirects = opts.maxRedirects ?? 5;
    const loopback = HttpDownloader.allowLoopback(opts.allowLoopback);
    const { res, finalUrl } = await requestFollow(rawUrl, {
      method: 'GET',
      maxRedirects,
      timeoutMs,
      userAgent: opts.userAgent ?? DEFAULT_UA,
      ...(opts.resolver ? { resolver: opts.resolver } : {}),
      ...(loopback ? { allowLoopback: true } : {}),
    });

    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.resume();
      throw new AppError('http_error', `server responded ${status}`, { retryable: status >= 500 || status === 429 });
    }
    const contentType = (res.headers['content-type'] as string | undefined) ?? null;
    if (contentType && /^text\/html/i.test(contentType) && !/\.html?$/i.test(opts.filenameHint ?? '')) {
      res.resume();
      throw new AppError(
        'not_a_file',
        'سرور به‌جای فایل، یک صفحه HTML برگرداند (معمولاً صفحه ورود یا تأیید گوگل). لینک دانلود مستقیم لازم است.'
      );
    }

    const total = res.headers['content-length'] ? Number(res.headers['content-length']) : 0;
    if (total > opts.maxBytes) {
      res.destroy();
      throw new AppError('too_large', `file is ${total} bytes, above the ${opts.maxBytes} byte limit`);
    }

    const hinted =
      filenameFromDisposition(res.headers['content-disposition'] as string | undefined) ??
      opts.filenameHint ??
      (() => {
        try {
          const p = new URL(finalUrl).pathname.split('/').filter(Boolean).pop();
          return p ? safeFileName(decodeURIComponent(p)) : null;
        } catch {
          return null;
        }
      })() ??
      'download.bin';

    const filename = safeFileName(hinted, { fallback: 'download.bin' });
    await fsp.mkdir(opts.destDir, { recursive: true });
    const destPath = `${opts.destDir}/${Date.now()}-${Math.random().toString(16).slice(2, 10)}-${filename}`;

    const hash = createHash('md5');
    let received = 0;
    let last = 0;
    const meter = new Transform({
      async transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > opts.maxBytes) {
          cb(new AppError('too_large', `download exceeded ${opts.maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        const now = Date.now();
        if (opts.onProgress && now - last > 700) {
          last = now;
          opts.onProgress(received, total || received);
        }
        if (opts.shouldAbort && (await opts.shouldAbort())) {
          cb(new AppError('canceled', 'download canceled by user'));
          return;
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(res, meter, fs.createWriteStream(destPath));
    } catch (err) {
      await fsp.unlink(destPath).catch(() => undefined);
      throw err;
    }
    opts.onProgress?.(received, total || received);
    this.logger.debug('link download finished', { finalUrl, bytes: received });

    return { finalUrl, path: destPath, bytes: received, md5: hash.digest('hex'), contentType, filename };
  }
}

// minimal structural type so we do not have to import node:net just for the cast
declare namespace net {
  type LookupFunction = (...args: unknown[]) => void;
}
