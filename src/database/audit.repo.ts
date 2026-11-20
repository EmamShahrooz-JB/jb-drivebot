import type { Db } from './types.js';
import { uuid } from '../utils/id.js';
import { nextSeq } from './uploads.repo.js';

export interface AuditRow {
  id: string;
  actor: number | null;
  action: string;
  target: string | null;
  meta: string | null;
  created_at: number;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async log(input: { actor?: number | null; action: string; target?: string | null; meta?: Record<string, unknown> }): Promise<void> {
    await this.db.execute('INSERT INTO audit_log (id, actor, action, target, meta, created_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      uuid(),
      input.actor ?? null,
      input.action,
      input.target ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      Date.now(),
      nextSeq(),
    ]);
  }

  async recent(limit = 15): Promise<AuditRow[]> {
    const rows = await this.db.query('SELECT * FROM audit_log ORDER BY seq DESC LIMIT ' + Math.min(100, Math.max(1, limit)));
    return rows.map((r) => ({ ...(r as unknown as AuditRow), created_at: Number(r.created_at) }));
  }
}
