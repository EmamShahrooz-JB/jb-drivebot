import http from 'node:http';
import { createPkce, createState, deriveTransferKey, sealWithTransferKey, timingSafeEqualStr } from './pkce.js';
import { openBrowser } from './browser.js';

export interface FlowOptions {
  serverUrl: string;
  pairingCode: string;
  port: number;
  mode: 'server-exchange' | 'local-exchange';
  clientId?: string;
  clientSecret?: string;
  allowInsecure: boolean;
  openBrowser: boolean;
  timeoutMs?: number;
  onStatus: (message: string) => void;
}

export interface PrepareInfo {
  clientId: string;
  scopes: string[];
  expectedEmail?: string;
  mode: string;
}

export interface FlowResult {
  email: string | null;
  scopes: string[];
  rootFolder: string | null;
}

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function assertHttps(url: string, allowInsecure: boolean): void {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return;
  if (!allowInsecure || !/^(127\.0\.0\.1|localhost)$/.test(parsed.hostname)) {
    throw new Error(
      `${url} is not HTTPS. Refusing to send a pairing code over plain HTTP (use --allow-insecure only for a local test server).`
    );
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { message: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

export async function fetchPrepare(opts: Pick<FlowOptions, 'serverUrl' | 'pairingCode' | 'allowInsecure' | 'clientId'>): Promise<PrepareInfo> {
  assertHttps(opts.serverUrl, opts.allowInsecure);
  const url = new URL('/api/pair/prepare', opts.serverUrl);
  url.searchParams.set('code', opts.pairingCode);
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) {
    let message = `server responded ${res.status}`;
    try {
      message = String((JSON.parse(text) as { message?: string }).message ?? message);
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const json = JSON.parse(text) as { clientId?: string; scopes?: string[]; expectedEmail?: string; mode?: string };
  if (!json.clientId) throw new Error('server did not return a clientId');
  return {
    clientId: opts.clientId ?? json.clientId,
    scopes: json.scopes ?? [],
    ...(json.expectedEmail ? { expectedEmail: json.expectedEmail } : {}),
    mode: json.mode ?? 'server-exchange',
  };
}

/** Run the whole loopback OAuth dance and hand the result to the server. */
export async function runFlow(opts: FlowOptions): Promise<FlowResult> {
  assertHttps(opts.serverUrl, opts.allowInsecure);
  const prepare = await fetchPrepare(opts);
  const redirectUri = `http://127.0.0.1:${opts.port}/oauth2callback`;
  const pkce = createPkce();
  const state = createState();

  const authUrl = new URL(GOOGLE_AUTH);
  authUrl.searchParams.set('client_id', prepare.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', prepare.scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', pkce.challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('include_granted_scopes', 'true');
  if (prepare.expectedEmail) authUrl.searchParams.set('login_hint', prepare.expectedEmail);

  const { code, server } = await waitForCallback(opts, state, authUrl.toString());

  let response: { status: number; json: Record<string, unknown> };
  if (opts.mode === 'server-exchange') {
    opts.onStatus('Authorization code دریافت شد؛ تبادل توکن روی سرور انجام می‌شود…');
    response = await postJson(new URL('/api/pair/complete', opts.serverUrl).toString(), {
      code: opts.pairingCode,
      mode: 'server-exchange',
      authorizationCode: code,
      codeVerifier: pkce.verifier,
      redirectUri,
      clientVersion: '1.0.0',
    });
  } else {
    const clientSecret = opts.clientSecret ?? process.env.JBD_CLIENT_SECRET;
    if (!clientSecret) throw new Error('local-exchange mode needs --client-secret (or JBD_CLIENT_SECRET)');
    opts.onStatus('تبادل توکن روی همین دستگاه انجام می‌شود…');
    const tokenRes = await fetch(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: pkce.verifier,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        client_id: prepare.clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) throw new Error(`google token exchange failed (${tokenRes.status})`);
    const token = JSON.parse(tokenText) as { refresh_token?: string; scope?: string; id_token?: string };
    if (!token.refresh_token) {
      throw new Error(
        'گوگل refresh token نداد. دسترسی ربات را در myaccount.google.com/permissions حذف کنید و دوباره تلاش کنید.'
      );
    }
    const email = decodeEmail(token.id_token) ?? null;
    const key = deriveTransferKey(opts.pairingCode);
    const sealed = sealWithTransferKey(
      key,
      JSON.stringify({
        refreshToken: token.refresh_token,
        scopes: (token.scope ?? prepare.scopes.join(' ')).split(' ').filter(Boolean),
        email,
      })
    );
    key.fill(0);
    opts.onStatus('توکن رمزنگاری‌شده به سرور ارسال می‌شود…');
    response = await postJson(new URL('/api/pair/complete', opts.serverUrl).toString(), {
      code: opts.pairingCode,
      mode: 'local-exchange',
      sealedPayload: sealed,
      clientVersion: '1.0.0',
    });
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (response.status !== 200 || response.json.ok !== true) {
    throw new Error(String(response.json.message ?? `server responded ${response.status}`));
  }
  return {
    email: (response.json.email as string | undefined) ?? null,
    scopes: (response.json.scopes as string[] | undefined) ?? [],
    rootFolder: (response.json.rootFolder as string | null | undefined) ?? null,
  };
}

function decodeEmail(idToken?: string): string | undefined {
  if (!idToken) return undefined;
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { email?: string };
    return payload.email;
  } catch {
    return undefined;
  }
}

function waitForCallback(
  opts: FlowOptions,
  expectedState: string,
  authUrl: string
): Promise<{ code: string; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('زمان انتظار برای تأیید گوگل تمام شد (۵ دقیقه). دوباره تلاش کنید.'));
    }, opts.timeoutMs ?? 5 * 60_000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const err = url.searchParams.get('error');
      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';

      const page = (title: string, body: string, ok: boolean) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(
          `<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8"><title>${title}</title>
           <body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0">
           <div style="text-align:center;max-width:32rem;padding:2rem;border-radius:1rem;background:#1e293b">
           <h1 style="font-size:1.25rem">${title}</h1><p style="line-height:1.8">${body}</p></div></body></html>`
        );
      };

      if (err) {
        clearTimeout(timeout);
        page('اتصال لغو شد', `گوگل خطای <code>${err}</code> برگرداند. می‌توانید این پنجره را ببندید.`, false);
        server.close();
        reject(new Error(`google returned error: ${err}`));
        return;
      }
      if (!timingSafeEqualStr(state, expectedState)) {
        page('درخواست نامعتبر', 'مقدار state با مقدار انتظاری مطابقت ندارد. عملیات متوقف شد.', false);
        server.close();
        clearTimeout(timeout);
        reject(new Error('state mismatch — possible CSRF, aborted'));
        return;
      }
      if (!code) {
        page('درخواست نامعتبر', 'کد مجوز دریافت نشد.', false);
        server.close();
        clearTimeout(timeout);
        reject(new Error('no authorization code in callback'));
        return;
      }
      clearTimeout(timeout);
      page('تأیید شد', 'می‌توانید این پنجره را ببندید و به ترمینال برگردید.', true);
      resolve({ code, server });
    });

    server.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    server.listen(opts.port, '127.0.0.1', () => {
      opts.onStatus(`در حال اجرای سرور محلی روی ${`http://127.0.0.1:${opts.port}`}`);
      opts.onStatus('مرورگر باز می‌شود؛ حساب Google خود را انتخاب و دسترسی را تأیید کنید.');
      if (opts.openBrowser) openBrowser(authUrl);
      else opts.onStatus(`لینک را دستی باز کنید:\n${authUrl}`);
    });
  });
}
