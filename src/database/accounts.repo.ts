import type { Db, AccountRow } from './types.js';

const INT_COLS = ['access_token_expires_at', 'connected_at', 'updated_at'];

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  private norm(row: Record<string, unknown>): AccountRow {
    const r = { ...row };
    for (const k of INT_COLS) if (typeof r[k] === 'string' && /^-?\d+$/.test(r[k] as string)) r[k] = Number(r[k]);
    return r as unknown as AccountRow;
  }

  /** There is exactly one managed Google account; the row id is stable. */
  async get(): Promise<AccountRow | null> {
    const rows = await this.db.query('SELECT * FROM accounts ORDER BY updated_at DESC LIMIT 1');
    return rows[0] ? this.norm(rows[0]) : null;
  }

  async isConnected(): Promise<boolean> {
    const acc = await this.get();
    return Boolean(acc && acc.status === 'connected' && acc.refresh_token_enc);
  }

  async saveConnection(input: {
    googleSub?: string | null;
    email?: string | null;
    scopes: string[];
    refreshTokenEnc: string;
    rootFolderId?: string | null;
  }): Promise<void> {
    const now = Date.now();
    const existing = await this.get();
    if (existing) {
      await this.db.execute(
        `UPDATE accounts SET google_sub = ?, email = ?, scopes = ?, refresh_token_enc = ?,
           access_token_enc = NULL, access_token_expires_at = NULL,
           root_folder_id = COALESCE(?, root_folder_id), status = 'connected', connected_at = ?, updated_at = ?
         WHERE id = ?`,
        [
          input.googleSub ?? null,
          input.email ?? null,
          input.scopes.join(' '),
          input.refreshTokenEnc,
          input.rootFolderId ?? null,
          now,
          now,
          existing.id,
        ]
      );
      return;
    }
    await this.db.execute(
      `INSERT INTO accounts (id, google_sub, email, scopes, refresh_token_enc, access_token_enc,
         access_token_expires_at, root_folder_id, status, connected_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, 'connected', ?, ?)`,
      [
        'primary',
        input.googleSub ?? null,
        input.email ?? null,
        input.scopes.join(' '),
        input.refreshTokenEnc,
        input.rootFolderId ?? null,
        now,
        now,
      ]
    );
  }

  /** Persist a rotated refresh token without touching the cached access token. */
  async setRefreshToken(enc: string, scopes?: string[]): Promise<void> {
    const acc = await this.get();
    if (!acc) throw new Error('no google account connected');
    if (scopes) {
      await this.db.execute('UPDATE accounts SET refresh_token_enc = ?, scopes = ?, updated_at = ? WHERE id = ?', [
        enc, scopes.join(' '), Date.now(), acc.id,
      ]);
      return;
    }
    await this.db.execute('UPDATE accounts SET refresh_token_enc = ?, updated_at = ? WHERE id = ?', [enc, Date.now(), acc.id]);
  }

  async setAccessToken(enc: string, expiresAtMs: number): Promise<void> {
    const acc = await this.get();
    if (!acc) throw new Error('no google account connected');
    await this.db.execute('UPDATE accounts SET access_token_enc = ?, access_token_expires_at = ?, updated_at = ? WHERE id = ?', [
      enc,
      expiresAtMs,
      Date.now(),
      acc.id,
    ]);
  }

  async setRootFolder(id: string): Promise<void> {
    const acc = await this.get();
    if (!acc) return;
    await this.db.execute('UPDATE accounts SET root_folder_id = ?, updated_at = ? WHERE id = ?', [id, Date.now(), acc.id]);
  }

  async disconnect(): Promise<void> {
    const acc = await this.get();
    if (!acc) return;
    await this.db.execute(
      `UPDATE accounts SET refresh_token_enc = NULL, access_token_enc = NULL, access_token_expires_at = NULL,
         status = 'disconnected', updated_at = ? WHERE id = ?`,
      [Date.now(), acc.id]
    );
  }
}
