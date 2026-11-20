import { randomBytes, createHash } from 'node:crypto';
import { AppError } from '../utils/errors.js';

export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 S256 challenge. */
export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within 43..128
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export const createState = (): string => randomBytes(24).toString('base64url');

export interface AuthUrlParams {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  loginHint?: string;
}

export function buildAuthUrl(p: AuthUrlParams): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', p.scopes.join(' '));
  url.searchParams.set('state', p.state);
  url.searchParams.set('code_challenge', p.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // offline + consent guarantees a refresh_token on every re-connect
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  if (p.loginHint) url.searchParams.set('login_hint', p.loginHint);
  return url.toString();
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

export type FetchFn = typeof fetch;

export interface OAuthClientOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: FetchFn;
  tokenEndpoint?: string;
  revokeEndpoint?: string;
  userInfoEndpoint?: string;
}

export class GoogleOAuthClient {
  private readonly fetchImpl: FetchFn;
  private readonly tokenEndpoint: string;
  private readonly revokeEndpoint: string;
  private readonly userInfoEndpoint: string;
  constructor(private readonly opts: OAuthClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.tokenEndpoint = opts.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT;
    this.revokeEndpoint = opts.revokeEndpoint ?? GOOGLE_REVOKE_ENDPOINT;
    this.userInfoEndpoint = opts.userInfoEndpoint ?? GOOGLE_USERINFO_ENDPOINT;
  }

  private async postForm(endpoint: string, body: Record<string, string>): Promise<Response> {
    return this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
    });
  }

  /** Exchange an authorization code (+ PKCE verifier) for tokens. */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenResponse> {
    const res = await this.postForm(this.tokenEndpoint, {
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    return this.parseTokenResponse(res, 'code_exchange_failed');
  }

  async refresh(refreshToken: string): Promise<TokenResponse> {
    const res = await this.postForm(this.tokenEndpoint, {
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    return this.parseTokenResponse(res, 'refresh_failed');
  }

  async revoke(token: string): Promise<void> {
    const res = await this.postForm(this.revokeEndpoint, { token });
    if (!res.ok && res.status !== 400) {
      throw new AppError('revoke_failed', `Google revoke failed with ${res.status}`);
    }
  }

  async userInfo(accessToken: string): Promise<{ email?: string; sub?: string }> {
    const res = await this.fetchImpl(this.userInfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new AppError('userinfo_failed', `userinfo failed (${res.status}): ${text.slice(0, 200)}`);
    }
    return (await res.json()) as { email?: string; sub?: string };
  }

  private async parseTokenResponse(res: Response, code: string): Promise<TokenResponse> {
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AppError(code, `non-JSON token response (${res.status})`);
    }
    if (!res.ok || typeof json.access_token !== 'string') {
      const errCode = String(json.error ?? res.status);
      const desc = String(json.error_description ?? '');
      throw new AppError(code, `google token endpoint error: ${errCode} ${desc}`.trim(), {
        details: { error: errCode },
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    return {
      access_token: json.access_token,
      expires_in: Number(json.expires_in ?? 3600),
      refresh_token: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
      scope: String(json.scope ?? ''),
      token_type: String(json.token_type ?? 'Bearer'),
      id_token: typeof json.id_token === 'string' ? json.id_token : undefined,
    };
  }
}

/** Read `email`/`sub` out of an id_token without verifying it (we just got it over TLS from Google). */
export function decodeIdToken(idToken?: string): { email?: string; sub?: string } {
  if (!idToken) return {};
  const parts = idToken.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    return {
      email: typeof payload.email === 'string' ? payload.email : undefined,
      sub: typeof payload.sub === 'string' ? payload.sub : undefined,
    };
  } catch {
    return {};
  }
}
