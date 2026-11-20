import type { Db, JobRow, JobStatus, Queryable } from './types.js';
import { uuid } from '../utils/id.js';

const INT_COLS = [
  'priority', 'attempts', 'max_attempts', 'run_at', 'started_at', 'finished_at',
  'progress', 'cancel_requested', 'resume_offset', 'created_by', 'created_at', 'updated_at',
];

export interface NewJobInput {
  type: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  runAt?: number;
  idempotencyKey?: string;
  createdBy?: number | null;
}

export function normalizeJob(row: Record<string, unknown>): JobRow {
  const r = { ...row };
  for (const k of INT_COLS) {
    if (typeof r[k] === 'string' && /^-?\d+$/.test(r[k] as string)) r[k] = Number(r[k]);
    if (r[k] === null && ['priority', 'attempts', 'max_attempts', 'progress', 'cancel_requested', 'created_at', 'updated_at'].includes(k)) {
      r[k] = 0;
    }
  }
  return r as unknown as JobRow;
}

export class JobsRepo {
  constructor(private readonly db: Db) {}

  async create(input: NewJobInput): Promise<JobRow> {
    const now = Date.now();
    const id = uuid();
    await this.db.execute(
      `INSERT INTO jobs (id, type, priority, status, payload, idempotency_key, attempts, max_attempts,
         run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)`,
      [
        id,
        input.type,
        input.priority ?? 100,
        JSON.stringify(input.payload),
        input.idempotencyKey ?? null,
        input.maxAttempts ?? 4,
        input.runAt ?? now,
        input.createdBy ?? null,
        now,
        now,
      ]
    );
    const rows = await this.db.query('SELECT * FROM jobs WHERE id = ?', [id]);
    return normalizeJob(rows[0]!);
  }

  async get(id: string): Promise<JobRow | null> {
    const rows = await this.db.query('SELECT * FROM jobs WHERE id = ?', [id]);
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<JobRow | null> {
    const rows = await this.db.query('SELECT * FROM jobs WHERE idempotency_key = ?', [key]);
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  async findBySessionUri(uri: string): Promise<JobRow | null> {
    const rows = await this.db.query('SELECT * FROM jobs WHERE session_uri = ?', [uri]);
    return rows[0] ? normalizeJob(rows[0]) : null;
  }

  /**
   * Atomically claim the next runnable job. Highest priority first, then FIFO.
   * The UPDATE ... WHERE status='queued' guard makes double-claiming impossible
   * even if two workers race.
   */
  async claimNext(now = Date.now(), types?: string[]): Promise<JobRow | null> {
    const typeFilter = types && types.length > 0 ? ` AND type IN (${types.map(() => '?').join(',')})` : '';
    const baseParams: unknown[] = types && types.length > 0 ? [...types] : [];
    return this.db.transaction(async (tx: Queryable) => {
      const rows = await tx.query(
        `SELECT * FROM jobs WHERE status = ? AND run_at <= ?${typeFilter} ORDER BY priority DESC, created_at ASC LIMIT 1`,
        ['queued', now, ...baseParams]
      );
      const candidate = rows[0];
      if (!candidate) return null;
      const id = candidate.id as string;
      const res = await tx.execute(
        'UPDATE jobs SET status = ?, started_at = ?, updated_at = ?, attempts = attempts + 1 WHERE id = ? AND status = ?',
        ['running', now, now, id, 'queued']
      );
      if (res.changes === 0) return null;
      const fresh = await tx.query('SELECT * FROM jobs WHERE id = ?', [id]);
      return normalizeJob(fresh[0]!);
    });
  }

  async setProgress(id: string, progress: number, message?: string): Promise<void> {
    await this.db.execute('UPDATE jobs SET progress = ?, message = COALESCE(?, message), updated_at = ? WHERE id = ?', [
      Math.max(0, Math.min(100, Math.round(progress))),
      message ?? null,
      Date.now(),
      id,
    ]);
  }

  async setSession(id: string, sessionUri: string | null, resumeOffset: number | null): Promise<void> {
    await this.db.execute('UPDATE jobs SET session_uri = ?, resume_offset = ?, updated_at = ? WHERE id = ?', [
      sessionUri,
      resumeOffset,
      Date.now(),
      id,
    ]);
  }

  async setMessage(id: string, message: string): Promise<void> {
    await this.db.execute('UPDATE jobs SET message = ?, updated_at = ? WHERE id = ?', [message, Date.now(), id]);
  }

  async complete(id: string, result: Record<string, unknown>, status: JobStatus = 'succeeded'): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      'UPDATE jobs SET status = ?, finished_at = ?, updated_at = ?, progress = 100, result = ?, session_uri = NULL WHERE id = ?',
      [status, now, now, JSON.stringify(result), id]
    );
  }

  async fail(id: string, error: string, opts: { retryAt?: number | null } = {}): Promise<JobStatus> {
    const job = await this.get(id);
    if (!job) return 'failed';
    const now = Date.now();
    if (job.cancel_requested) {
      await this.db.execute('UPDATE jobs SET status = ?, finished_at = ?, updated_at = ?, last_error = ? WHERE id = ?', [
        'canceled',
        now,
        now,
        error.slice(0, 2000),
        id,
      ]);
      return 'canceled';
    }
    if (opts.retryAt !== null && job.attempts < job.max_attempts) {
      await this.db.execute(
        'UPDATE jobs SET status = ?, run_at = ?, updated_at = ?, last_error = ? WHERE id = ?',
        ['queued', opts.retryAt ?? now, now, error.slice(0, 2000), id]
      );
      return 'queued';
    }
    await this.db.execute('UPDATE jobs SET status = ?, finished_at = ?, updated_at = ?, last_error = ? WHERE id = ?', [
      'failed',
      now,
      now,
      error.slice(0, 2000),
      id,
    ]);
    return 'failed';
  }

  async requestCancel(id: string): Promise<boolean> {
    const res = await this.db.execute(
      `UPDATE jobs SET cancel_requested = 1, updated_at = ?,
         status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
         finished_at = CASE WHEN status = 'queued' THEN ? ELSE finished_at END
       WHERE id = ? AND status IN ('queued','running')`,
      [Date.now(), Date.now(), id]
    );
    return res.changes > 0;
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const rows = await this.db.query<{ cancel_requested: number | boolean }>('SELECT cancel_requested FROM jobs WHERE id = ?', [id]);
    const v = rows[0]?.cancel_requested;
    return v === 1 || v === true;
  }

  /**
   * Startup recovery: any job left in `running` state belongs to a previous
   * process that died. Put it back in the queue so it resumes.
   */
  async recoverOrphans(now = Date.now()): Promise<{ requeued: number; canceled: number }> {
    const running = await this.db.query<{ id: string; cancel_requested: number }>(
      "SELECT id, cancel_requested FROM jobs WHERE status = 'running'"
    );
    let requeued = 0;
    let canceled = 0;
    for (const row of running) {
      if (Number(row.cancel_requested) === 1) {
        await this.db.execute("UPDATE jobs SET status = 'canceled', finished_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]);
        canceled++;
      } else {
        await this.db.execute("UPDATE jobs SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ?", [now, now, row.id]);
        requeued++;
      }
    }
    return { requeued, canceled };
  }

  async list(opts: { status?: JobStatus; limit?: number } = {}): Promise<JobRow[]> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
    const rows = opts.status
      ? await this.db.query('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ' + limit, [opts.status])
      : await this.db.query('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ' + limit);
    return rows.map(normalizeJob);
  }

  async activeForUser(userId: number): Promise<JobRow[]> {
    const rows = await this.db.query(
      "SELECT * FROM jobs WHERE created_by = ? AND status IN ('queued','running') ORDER BY created_at ASC",
      [userId]
    );
    return rows.map(normalizeJob);
  }

  async counts(): Promise<Record<JobStatus, number>> {
    const rows = await this.db.query<{ status: string; n: number | string }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status');
    const out: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
    for (const r of rows) out[r.status as JobStatus] = Number(r.n);
    return out;
  }

  async prune(olderThanMs: number, keepStatuses: JobStatus[] = ['succeeded', 'canceled']): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let total = 0;
    for (const st of keepStatuses) {
      const res = await this.db.execute('DELETE FROM jobs WHERE status = ? AND updated_at < ?', [st, cutoff]);
      total += res.changes;
    }
    return total;
  }
}
