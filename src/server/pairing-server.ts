import http from 'node:http';
import { createCipheriv, createDecipheriv, randomBytes, hkdfSync } from 'node:crypto';
import type { AppContext } from '../services/context.js';
import { AppError, errorMessage } from '../utils/errors.js';
import { sha256Hex, pairingCode } from '../utils/id.js';
import { scopesFor } from '../oauth/scopes.js';
import { safeEqual } from '../security/crypto.js';
import type { Logger } from '../utils/logger.js';

export const TRANSFER_KEY_INFO = 'jb-drivebot/pairing-transfer/v1';

/**
 * In `local-exchange` mode the authenticator performs the code exchange on the
 * user's machine and then has to hand the refresh token to the server. Rather
 * than posting it in clear text inside JSON (where it would show up in any proxy
 * log), it is sealed with AES-256-GCM under a key both sides derive from the
 * one-time pairing code. TLS remains the primary control; this is defence in
 * depth, and the key only ever exists for the lifetime of one code.
 */
export function deriveTransferKey(code: string): Buffer {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(normalized, 'utf8'), Buffer.from('jb-drivebot-pairing'), Buffer.from(TRANSFER_KEY_INFO), 32)
  );
}

export function sealWithTransferKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openWithTransferKey(key: Buffer, sealedB64: string): string {
  const raw = Buffer.from(sealedB64, 'base64url');
  if (raw.length < 12 + 16 + 1) throw new AppError('bad_payload', 'sealed payload is too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

const MAX_BODY = 64 * 1024;
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:\d{2,5}\/oauth2callback$/;

export interface PairCompleteBody {
  code?: string;
  mode?: 'server-exchange' | 'local-exchange';
  authorizationCode?: string;
  codeVerifier?: string;
  redirectUri?: string;
  sealedPayload?: string;
  clientVersion?: string;
}

export interface ExtraRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
}

export interface PairingServerOptions {
  port: number;
  host: string;
  logger?: Logger;
  /** additional routes (used to mount the Telegram webhook on the same port) */
  extraRoutes?: ExtraRoute[];
}

export interface PairingServer {
  server: http.Server;
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
  issuePairingCode(createdBy: number, mode: 'server-exchange' | 'local-exchange'): Promise<{ code: string; expiresAt: number }>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new AppError('payload_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
  });
  res.end(JSON.stringify(body));
}

export function createPairingServer(ctx: AppContext, opts: PairingServerOptions): PairingServer {
  const logger = opts.logger ?? ctx.logger.child({ mod: 'pairing' });
  const windows = new Map<string, { count: number; resetAt: number }>();

  const withinRateLimit = (ip: string): boolean => {
    const now = Date.now();
    const entry = windows.get(ip) ?? { count: 0, resetAt: now + 60_000 };
    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + 60_000;
    }
    entry.count += 1;
    windows.set(ip, entry);
    return entry.count <= 10;
  };

  const issuePairingCode = async (createdBy: number, mode: 'server-exchange' | 'local-exchange') => {
    const code = pairingCode(8);
    const expiresAt = Date.now() + ctx.config.PAIRING_TTL_SECONDS * 1000;
    const transferKey = deriveTransferKey(code);
    const transferKeyEnc = ctx.box.seal(transferKey.toString('base64'), 'pairing-transfer-key');
    transferKey.fill(0);
    await ctx.repos.pairing.create({ codeHash: sha256Hex(code), createdBy, expiresAt, mode, transferKeyEnc });
    logger.info('pairing code issued', { createdBy, mode, expiresAt });
    return { code, expiresAt };
  };

  /**
   * The authenticator calls this first to learn which scopes this deployment
   * expects and which OAuth client to use. No secret is returned: an OAuth
   * desktop client_id is public by design.
   */
  const handlePrepare = async (code: string, res: http.ServerResponse): Promise<void> => {
    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'code is required' });
      return;
    }
    const row = await ctx.repos.pairing.findByHash(sha256Hex(normalized));
    if (!row) {
      json(res, 401, { ok: false, error: 'invalid_code', message: 'کد جفت‌سازی نامعتبر است' });
      return;
    }
    if (Number(row.used_at ?? 0) > 0) {
      json(res, 409, { ok: false, error: 'code_used', message: 'این کد قبلاً استفاده شده است' });
      return;
    }
    if (Number(row.expires_at) < Date.now()) {
      json(res, 410, { ok: false, error: 'code_expired', message: 'کد منقضی شده است؛ دوباره /connect بزنید' });
      return;
    }
    json(res, 200, {
      ok: true,
      clientId: ctx.config.GOOGLE_CLIENT_ID,
      scopes: scopesFor(ctx.config.GOOGLE_SCOPES_MODE),
      mode: row.mode,
      expiresAt: Number(row.expires_at),
      ...(ctx.config.GOOGLE_EXPECTED_EMAIL ? { expectedEmail: ctx.config.GOOGLE_EXPECTED_EMAIL } : {}),
    });
  };

  const handleComplete = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!withinRateLimit(ip)) {
      json(res, 429, { ok: false, error: 'rate_limited', message: 'too many attempts' });
      return;
    }

    let body: PairCompleteBody;
    try {
      body = JSON.parse(await readBody(req)) as PairCompleteBody;
    } catch {
      json(res, 400, { ok: false, error: 'bad_request', message: 'invalid JSON body' });
      return;
    }

    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!code) {
      json(res, 400, { ok: false, error: 'bad_request', message: 'pairing code is required' });
      return;
    }

    const row = await ctx.repos.pairing.findByHash(sha256Hex(code));
    if (!row) {
      json(res, 401, { ok: false, error: 'invalid_code', message: 'کد جفت‌سازی نامعتبر است' });
      return;
    }

    const attempts = await ctx.repos.pairing.bumpAttempts(row.id);
    if (attempts > ctx.config.PAIRING_MAX_ATTEMPTS) {
      json(res, 429, { ok: false, error: 'too_many_attempts', message: 'این کد قفل شده است؛ /connect را دوباره اجرا کنید' });
      return;
    }
    if (Number(row.used_at ?? 0) > 0) {
      json(res, 409, { ok: false, error: 'code_used', message: 'این کد قبلاً استفاده شده است' });
      return;
    }
    if (Number(row.expires_at) < Date.now()) {
      json(res, 410, { ok: false, error: 'code_expired', message: 'کد منقضی شده است؛ دوباره /connect بزنید' });
      return;
    }

    const mode = (body.mode ?? row.mode ?? 'server-exchange') as 'server-exchange' | 'local-exchange';

    try {
      let refreshToken: string;
      let grantedScopes: string[];
      let email: string | null = null;
      let sub: string | null = null;

      if (mode === 'server-exchange') {
        const authCode = typeof body.authorizationCode === 'string' ? body.authorizationCode : '';
        const verifier = typeof body.codeVerifier === 'string' ? body.codeVerifier : '';
        const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri : '';
        if (!authCode || !verifier || !redirectUri) {
          json(res, 400, { ok: false, error: 'bad_request', message: 'authorizationCode, codeVerifier and redirectUri are required' });
          return;
        }
        if (!LOOPBACK_REDIRECT.test(redirectUri)) {
          json(res, 400, { ok: false, error: 'bad_redirect_uri', message: 'redirect URI must be http://127.0.0.1:<port>/oauth2callback' });
          return;
        }
        const token = await ctx.oauth.exchangeCode({ code: authCode, codeVerifier: verifier, redirectUri });
        if (!token.refresh_token) {
          json(res, 400, {
            ok: false,
            error: 'no_refresh_token',
            message:
              'گوگل refresh token برنگرداند. دسترسی ربات را در myaccount.google.com/permissions حذف کنید و دوباره /connect بزنید.',
          });
          return;
        }
        refreshToken = token.refresh_token;
        grantedScopes = token.scope ? token.scope.split(' ').filter(Boolean) : scopesFor(ctx.config.GOOGLE_SCOPES_MODE);
        const info = await ctx.oauth.userInfo(token.access_token).catch(() => ({}) as { email?: string; sub?: string });
        email = info.email ?? null;
        sub = info.sub ?? null;
      } else {
        if (!row.transfer_key_enc) {
          json(res, 500, { ok: false, error: 'server_state', message: 'pairing record is incomplete' });
          return;
        }
        if (typeof body.sealedPayload !== 'string') {
          json(res, 400, { ok: false, error: 'bad_request', message: 'sealedPayload is required in local-exchange mode' });
          return;
        }
        const transferKey = Buffer.from(ctx.box.open(row.transfer_key_enc, 'pairing-transfer-key'), 'base64');
        let parsed: { refreshToken?: string; scopes?: string[]; email?: string; sub?: string };
        try {
          parsed = JSON.parse(openWithTransferKey(transferKey, body.sealedPayload)) as typeof parsed;
        } finally {
          transferKey.fill(0);
        }
        if (!parsed.refreshToken) {
          json(res, 400, { ok: false, error: 'bad_request', message: 'payload has no refreshToken' });
          return;
        }
        refreshToken = parsed.refreshToken;
        grantedScopes = parsed.scopes ?? scopesFor(ctx.config.GOOGLE_SCOPES_MODE);
        email = parsed.email ?? null;
        sub = parsed.sub ?? null;
      }

      if (ctx.config.GOOGLE_EXPECTED_EMAIL && email && !safeEqual(email.toLowerCase(), ctx.config.GOOGLE_EXPECTED_EMAIL.toLowerCase())) {
        json(res, 403, {
          ok: false,
          error: 'wrong_account',
          message: `این حساب (${email}) مجاز نیست. حساب ${ctx.config.GOOGLE_EXPECTED_EMAIL} را انتخاب کنید.`,
        });
        return;
      }

      await ctx.repos.accounts.saveConnection({
        googleSub: sub,
        email,
        scopes: grantedScopes,
        refreshTokenEnc: ctx.tokens.sealRefreshToken(refreshToken),
      });
      await ctx.repos.pairing.markUsed(row.id);
      await ctx.repos.audit.log({ actor: Number(row.created_by), action: 'oauth.connect', meta: { email, scopes: grantedScopes.length, mode } });

      let rootName: string | null = null;
      try {
        const { getRootFolder } = await import('../services/folders.js');
        rootName = (await getRootFolder(ctx)).name;
      } catch (err) {
        logger.warn('connected, but the root folder could not be created yet', { err: errorMessage(err) });
      }

      await ctx.notifier
        .send(
          ctx.config.OWNER_ID,
          `🔗 <b>Google Drive متصل شد</b>\n📧 حساب: <code>${email ?? 'ناشناس'}</code>\n🔐 دسترسی‌ها: ${grantedScopes.length} scope\n📁 پوشه ربات: <code>${rootName ?? '—'}</code>`,
          { parseMode: 'HTML' }
        )
        .catch(() => undefined);

      logger.info('pairing completed', { email, scopes: grantedScopes.length, mode });
      json(res, 200, { ok: true, email, scopes: grantedScopes, rootFolder: rootName, message: 'اتصال با موفقیت برقرار شد' });
    } catch (err) {
      const message = errorMessage(err);
      logger.warn('pairing failed', { err: message });
      json(res, 502, { ok: false, error: 'connect_failed', message });
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    for (const route of opts.extraRoutes ?? []) {
      if (req.method === route.method && url.pathname === route.path) {
        void route.handler(req, res);
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { ok: true, service: 'jb-drivebot', uptime: Math.round(process.uptime()) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/pair/prepare') {
      void handlePrepare(url.searchParams.get('code') ?? '', res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/pair/complete') {
      void handleComplete(req, res);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/api')) {
      json(res, 200, {
        ok: true,
        service: 'jb-drivebot',
        endpoints: ['GET /health', 'POST /api/pair/complete'],
        note: 'این سرویس فقط برای جفت‌سازی ابزار محلی JB-Drive Authenticator است.',
      });
      return;
    }
    json(res, 404, { ok: false, error: 'not_found' });
  });

  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;

  return {
    server,
    issuePairingCode,
    listen: () =>
      new Promise<{ port: number; host: string }>((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          const addr = server.address();
          const port = typeof addr === 'object' && addr ? addr.port : opts.port;
          resolve({ port, host: opts.host });
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
