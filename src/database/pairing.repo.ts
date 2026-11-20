import type { Db } from './types.js';
import { uuid } from '../utils/id.js';

export interface PairingRow {
  id: string;
  code_hash: string;
  created_by: number;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  attempts: number;
  mode: string;
  transfer_key_enc: string | null;
}

export class PairingRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    codeHash: string;
    createdBy: number;
    expiresAt: number;
    mode: string;
    transferKeyEnc: string | null;
  }): Promise<string> {
    const id = uuid();
    // one active code per admin: creating a new one invalidates the old ones
    await this.db.execute('DELETE FROM pairing_codes WHERE used_at IS NULL', []);
    await this.db.execute(
      'INSERT INTO pairing_codes (id, code_hash, created_by, created_at, expires_at, used_at, attempts, mode, transfer_key_enc) VALUES (?, ?, ?, ?, ?, NULL, 0, ?, ?)',
      [id, input.codeHash, input.createdBy, Date.now(), input.expiresAt, input.mode, input.transferKeyEnc]
    );
    return id;
  }

  async findByHash(codeHash: string): Promise<PairingRow | null> {
    const rows = await this.db.query('SELECT * FROM pairing_codes WHERE code_hash = ? LIMIT 1', [codeHash]);
    const row = rows[0] as PairingRow | undefined;
    if (!row) return null;
    row.attempts = Number(row.attempts);
    row.expires_at = Number(row.expires_at);
    row.created_at = Number(row.created_at);
    return row;
  }

  async bumpAttempts(id: string): Promise<number> {
    await this.db.execute('UPDATE pairing_codes SET attempts = attempts + 1 WHERE id = ?', [id]);
    const rows = await this.db.query<{ attempts: number | string }>('SELECT attempts FROM pairing_codes WHERE id = ?', [id]);
    return Number(rows[0]?.attempts ?? 0);
  }

  async markUsed(id: string): Promise<void> {
    await this.db.execute('UPDATE pairing_codes SET used_at = ? WHERE id = ?', [Date.now(), id]);
  }

  async purgeExpired(before = Date.now()): Promise<number> {
    const res = await this.db.execute('DELETE FROM pairing_codes WHERE expires_at < ?', [before]);
    return res.changes;
  }
}
