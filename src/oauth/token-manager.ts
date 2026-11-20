import type { AppConfig } from '../config/index.js';
import type { AccountsRepo } from '../database/accounts.repo.js';
import type { SecretBox } from '../security/crypto.js';
import { GoogleOAuthClient } from './google-oauth.js';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

const EXPIRY_SKEW_MS = 90_000;

export interface AccessTokenResult {
  accessToken: string;
  expiresAt: number;
  scopes: string[];
}

/**
 * Owns the Google access token lifecycle.
 *
 * - the refresh token is only ever stored sealed (AES-256-GCM, purpose bound)
 * - access tokens are cached in the DB and refreshed transparently
 * - concurrent callers share a single in-flight refresh
 */
export class TokenManager {
  private inflight: Promise<AccessTokenResult> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly accounts: AccountsRepo,
    private readonly box: SecretBox,
    private readonly oauth: GoogleOAuthClient,
    private readonly logger: Logger
  ) {}

  /** For the local authenticator / pairing endpoint: seal a fresh refresh token. */
  sealRefreshToken(token: string): string {
    return this.box.seal(token, 'google-refresh-token', 'jb-drivebot:primary');
  }

  async hasConnection(): Promise<boolean> {
    return this.accounts.isConnected();
  }

  async grantedScopes(): Promise<string[]> {
    const acc = await this.accounts.get();
    if (!acc?.scopes) return [];
    return acc.scopes.split(' ').filter(Boolean);
  }

  async getAccessToken(force = false): Promise<AccessTokenResult> {
    const acc = await this.accounts.get();
    if (!acc || acc.status !== 'connected' || !acc.refresh_token_enc) {
      throw new AppError('not_connected', 'Google Drive حساب متصل نشده است. /connect را اجرا کنید.');
    }
    const now = Date.now();
    if (!force && acc.access_token_enc && acc.access_token_expires_at && acc.access_token_expires_at - EXPIRY_SKEW_MS > now) {
      try {
        const accessToken = this.box.open(acc.access_token_enc, 'google-access-token', 'jb-drivebot:primary');
        return { accessToken, expiresAt: Number(acc.access_token_expires_at), scopes: acc.scopes.split(' ').filter(Boolean) };
      } catch (err) {
        this.logger.warn('stored access token could not be decrypted, forcing refresh', { err: String(err) });
      }
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(): Promise<AccessTokenResult> {
    const acc = await this.accounts.get();
    if (!acc?.refresh_token_enc) throw new AppError('not_connected', 'no refresh token stored');
    const refreshToken = this.box.open(acc.refresh_token_enc, 'google-refresh-token', 'jb-drivebot:primary');
    let res;
    try {
      res = await this.oauth.refresh(refreshToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant/i.test(msg)) {
        await this.accounts.disconnect();
        throw new AppError('reauth_required', 'اتصال Google منقضی شده است. لطفاً با /connect دوباره وصل کنید.', { details: msg });
      }
      throw err;
    }
    const expiresAt = Date.now() + res.expires_in * 1000;
    const accessEnc = this.box.seal(res.access_token, 'google-access-token', 'jb-drivebot:primary');
    await this.accounts.setAccessToken(accessEnc, expiresAt);
    if (res.refresh_token) {
      // Google rarely rotates refresh tokens, but when it does the new value
      // must be persisted — without discarding the access token we just cached.
      await this.accounts.setRefreshToken(
        this.sealRefreshToken(res.refresh_token),
        res.scope ? res.scope.split(' ').filter(Boolean) : undefined
      );
    }
    this.logger.info('google access token refreshed', { expiresAt });
    return {
      accessToken: res.access_token,
      expiresAt,
      scopes: (res.scope || acc.scopes || '').split(' ').filter(Boolean),
    };
  }

  async disconnect(revoke = true): Promise<void> {
    const acc = await this.accounts.get();
    if (acc?.refresh_token_enc) {
      try {
        const refreshToken = this.box.open(acc.refresh_token_enc, 'google-refresh-token', 'jb-drivebot:primary');
        if (revoke) await this.oauth.revoke(refreshToken);
      } catch (err) {
        this.logger.warn('could not revoke google token (continuing with local disconnect)', { err: String(err) });
      }
    }
    await this.accounts.disconnect();
  }
}
