import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createContext, type AppContext } from '../../src/services/context.js';
import { createPairingServer, type PairingServer } from '../../src/server/pairing-server.js';
import { createSqliteDb } from '../../src/database/sqlite.js';
import { createLogger } from '../../src/utils/logger.js';
import { NullNotifier } from '../../src/services/notifier.js';
import { runFlow } from '../../auth-local/src/flow.js';
import { testConfig, tempDir } from '../helpers/config.js';

/**
 * End-to-end authentication test.
 *
 * It runs the REAL local authenticator (auth-local) against the REAL pairing
 * server, with a stub in place of Google's token endpoint. Everything else —
 * PKCE, state validation, the loopback callback, the pairing code lifecycle and
 * the encryption of the refresh token at rest — is production code.
 */
const REFRESH = '1//0gStubRefreshTokenDoNotLog-abcdefghijklmnop';
const AUTH_CODE = 'stub-auth-code-123';

let google: http.Server;
let googleBase: string;
let app: AppContext;
let pairing: PairingServer;
let serverUrl: string;
let callbackPort: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

beforeAll(async () => {
  // ---- stub Google ----
  google = http.createServer((req, res) => {
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'ya29.stub-access-token-value',
          expires_in: 3600,
          refresh_token: REFRESH,
          scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file',
          token_type: 'Bearer',
          id_token: `x.${Buffer.from(JSON.stringify({ email: 'owner@example.com', sub: 'sub-123' })).toString('base64url')}.y`,
        })
      );
      return;
    }
    if (req.url === '/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ email: 'owner@example.com', sub: 'sub-123' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => google.listen(0, '127.0.0.1', r));
  const addr = google.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  googleBase = `http://127.0.0.1:${addr.port}`;

  // ---- application ----
  const dir = tempDir('jbd-oauth-');
  const config = testConfig({ DATA_DIR: dir, SQLITE_PATH: `${dir}/oauth.sqlite`, TMP_DIR: `${dir}/tmp` });
  const db = createSqliteDb(config.SQLITE_PATH!);
  app = await createContext(config, {
    db,
    logger: createLogger('error'),
    notifier: new NullNotifier(),
    tokenEndpoint: `${googleBase}/token`,
    userInfoEndpoint: `${googleBase}/userinfo`,
  });
  pairing = createPairingServer(app, { port: 0, host: '127.0.0.1', logger: createLogger('error') });
  const bound = await pairing.listen();
  serverUrl = `http://127.0.0.1:${bound.port}`;
  callbackPort = await freePort();
});

afterAll(async () => {
  await pairing?.close();
  await app?.db.close();
  await new Promise<void>((r) => google.close(() => r()));
});

describe('local authenticator -> pairing server', () => {
  it('completes the whole flow and stores only an encrypted refresh token', async () => {
    const { code } = await pairing.issuePairingCode(111111, 'server-exchange');

    let authUrlResolved: (url: string) => void;
    const authUrlPromise = new Promise<string>((resolve) => {
      authUrlResolved = resolve;
    });

    const flowPromise = runFlow({
      serverUrl,
      pairingCode: code,
      port: callbackPort,
      mode: 'server-exchange',
      allowInsecure: true,
      openBrowser: false,
      onStatus: (message) => {
        const match = /https:\/\/accounts\.google\.com\/[^\s]+/.exec(message);
        if (match) authUrlResolved(match[0]);
      },
    });

    const authUrl = await authUrlPromise;
    const parsed = new URL(authUrl);
    // the authenticator must use PKCE + state + offline access
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${callbackPort}/oauth2callback`);
    expect(parsed.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
    const state = parsed.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(20);

    // ---- play the role of the browser + Google ----
    const callback = await fetch(
      `http://127.0.0.1:${callbackPort}/oauth2callback?code=${AUTH_CODE}&state=${encodeURIComponent(state)}`
    );
    expect(callback.status).toBe(200);

    const result = await flowPromise;
    expect(result.email).toBe('owner@example.com');
    expect(result.scopes.length).toBeGreaterThan(0);

    // ---- what got persisted ----
    const account = await app.repos.accounts.get();
    expect(account?.status).toBe('connected');
    expect(account?.email).toBe('owner@example.com');
    expect(account?.refresh_token_enc).toBeTruthy();
    // never plaintext at rest
    expect(account!.refresh_token_enc).not.toContain(REFRESH);
    expect(account!.refresh_token_enc!.startsWith('v1:')).toBe(true);
    // and it decrypts back to the original token
    expect(app.box.open(account!.refresh_token_enc!, 'google-refresh-token', 'jb-drivebot:primary')).toBe(REFRESH);
    expect(account?.scopes).toContain('drive.file');

    // the pairing code is single use
    const replay = await fetch(`${serverUrl}/api/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        mode: 'server-exchange',
        authorizationCode: AUTH_CODE,
        codeVerifier: 'x'.repeat(43),
        redirectUri: `http://127.0.0.1:${callbackPort}/oauth2callback`,
      }),
    });
    expect(replay.status).toBe(409);
    const body = (await replay.json()) as { error?: string };
    expect(body.error).toBe('code_used');
  });

  it('rejects an invalid pairing code at the prepare step', async () => {
    const res = await fetch(`${serverUrl}/api/pair/prepare?code=ZZZZ-9999`);
    expect(res.status).toBe(401);
  });

  it('rejects a callback whose state does not match (CSRF)', async () => {
    const { code } = await pairing.issuePairingCode(111111, 'server-exchange');
    let resolveUrl: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => (resolveUrl = resolve));

    // attach a handler straight away so an early rejection is never "unhandled"
    const flowPromise = runFlow({
      serverUrl,
      pairingCode: code,
      port: callbackPort,
      mode: 'server-exchange',
      allowInsecure: true,
      openBrowser: false,
      onStatus: (message) => {
        const match = /https:\/\/accounts\.google\.com\/[^\s]+/.exec(message);
        if (match) resolveUrl(match[0]);
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: Error) => ({ ok: false as const, error })
    );
    await urlPromise;

    const bad = await fetch(`http://127.0.0.1:${callbackPort}/oauth2callback?code=${AUTH_CODE}&state=attacker-state`);
    expect(bad.status).toBe(400);
    const outcome = await flowPromise;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.message).toMatch(/state mismatch/);
  });

  it('rejects a redirect URI that is not loopback', async () => {
    const { code } = await pairing.issuePairingCode(111111, 'server-exchange');
    const res = await fetch(`${serverUrl}/api/pair/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        mode: 'server-exchange',
        authorizationCode: AUTH_CODE,
        codeVerifier: 'y'.repeat(43),
        redirectUri: 'https://attacker.example.com/oauth2callback',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('bad_redirect_uri');
  });

  it('exposes a health endpoint for --check', async () => {
    const res = await fetch(`${serverUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('jb-drivebot');
  });

  it('delivers the pairing code only through the prepare endpoint, never the token', async () => {
    const { code } = await pairing.issuePairingCode(111111, 'server-exchange');
    const res = await fetch(`${serverUrl}/api/pair/prepare?code=${code}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.clientId).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(REFRESH);
    expect(body).not.toHaveProperty('refreshToken');
  });
});

describe('token manager', () => {
  it('refreshes and caches an access token', async () => {
    const first = await app.tokens.getAccessToken();
    expect(first.accessToken).toBe('ya29.stub-access-token-value');
    const second = await app.tokens.getAccessToken();
    expect(second.accessToken).toBe(first.accessToken);
    // cached in the DB, sealed
    const account = await app.repos.accounts.get();
    expect(account?.access_token_enc).not.toContain('ya29.');
    expect(account?.access_token_expires_at).toBeGreaterThan(Date.now());

    const forced = await app.tokens.getAccessToken(true);
    expect(forced.accessToken).toBe('ya29.stub-access-token-value');
  });

  it('reports capabilities consistent with the granted scopes', async () => {
    const { capabilitiesForScopes } = await import('../../src/oauth/scopes.js');
    const caps = capabilitiesForScopes(await app.tokens.grantedScopes());
    expect(caps.mode).toBe('file');
    expect(caps.browseWholeDrive).toBe(false);
    expect(caps.storageQuota).toBe(false);
  });

  it('disconnects and clears the stored token', async () => {
    await app.tokens.disconnect(false);
    expect(await app.tokens.hasConnection()).toBe(false);
    await expect(app.tokens.getAccessToken()).rejects.toThrow(/حساب متصل نشده|not connected/);
    void fs;
  });
});
