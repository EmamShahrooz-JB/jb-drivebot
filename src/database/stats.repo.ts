import type { Db } from './types.js';

export interface DailyRow {
  day: string;
  uploads: number;
  bytes_uploaded: number;
  downloads: number;
  bytes_downloaded: number;
  successes: number;
  failures: number;
}

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

async function bump(
  db: Db,
  day: string,
  field: 'uploads' | 'bytes_uploaded' | 'downloads' | 'bytes_downloaded' | 'successes' | 'failures',
  by: number
): Promise<void> {
  // Portable upsert without dialect specific syntax: try update, then insert.
  const upd = await db.execute(`UPDATE stats_daily SET ${field} = ${field} + ? WHERE day = ?`, [by, day]);
  if (upd.changes === 0) {
    const row: Record<string, number | string> = {
      day,
      uploads: 0,
      bytes_uploaded: 0,
      downloads: 0,
      bytes_downloaded: 0,
      successes: 0,
      failures: 0,
    };
    row[field] = by;
    try {
      await db.execute(
        'INSERT INTO stats_daily (day, uploads, bytes_uploaded, downloads, bytes_downloaded, successes, failures) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [day, row.uploads as number, row.bytes_uploaded as number, row.downloads as number, row.bytes_downloaded as number, row.successes as number, row.failures as number]
      );
    } catch {
      // lost a race with another writer: apply the update again
      await db.execute(`UPDATE stats_daily SET ${field} = ${field} + ? WHERE day = ?`, [by, day]);
    }
  }
}

export class StatsRepo {
  constructor(private readonly db: Db) {}

  recordUpload(bytes: number): Promise<void> {
    return bump(this.db, dayKey(), 'uploads', 1).then(() => bump(this.db, dayKey(), 'bytes_uploaded', bytes));
  }

  recordDownload(bytes: number): Promise<void> {
    return bump(this.db, dayKey(), 'downloads', 1).then(() => bump(this.db, dayKey(), 'bytes_downloaded', bytes));
  }

  recordJobOutcome(ok: boolean): Promise<void> {
    return bump(this.db, dayKey(), ok ? 'successes' : 'failures', 1);
  }

  async getDay(day = dayKey()): Promise<DailyRow> {
    const rows = await this.db.query('SELECT * FROM stats_daily WHERE day = ?', [day]);
    const row = rows[0];
    if (!row) {
      return { day, uploads: 0, bytes_uploaded: 0, downloads: 0, bytes_downloaded: 0, successes: 0, failures: 0 };
    }
    return {
      day: String(row.day),
      uploads: Number(row.uploads),
      bytes_uploaded: Number(row.bytes_uploaded),
      downloads: Number(row.downloads),
      bytes_downloaded: Number(row.bytes_downloaded),
      successes: Number(row.successes),
      failures: Number(row.failures),
    };
  }

  async range(days: number): Promise<DailyRow[]> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db.query('SELECT * FROM stats_daily WHERE day >= ? ORDER BY day ASC', [since]);
    return rows.map((row) => ({
      day: String(row.day),
      uploads: Number(row.uploads),
      bytes_uploaded: Number(row.bytes_uploaded),
      downloads: Number(row.downloads),
      bytes_downloaded: Number(row.bytes_downloaded),
      successes: Number(row.successes),
      failures: Number(row.failures),
    }));
  }

  async totals(): Promise<{ uploads: number; bytesUploaded: number; downloads: number; bytesDownloaded: number; successes: number; failures: number }> {
    const rows = await this.db.query(
      'SELECT COALESCE(SUM(uploads),0) u, COALESCE(SUM(bytes_uploaded),0) bu, COALESCE(SUM(downloads),0) d, COALESCE(SUM(bytes_downloaded),0) bd, COALESCE(SUM(successes),0) s, COALESCE(SUM(failures),0) f FROM stats_daily'
    );
    const r = rows[0] ?? {};
    return {
      uploads: Number(r.u ?? 0),
      bytesUploaded: Number(r.bu ?? 0),
      downloads: Number(r.d ?? 0),
      bytesDownloaded: Number(r.bd ?? 0),
      successes: Number(r.s ?? 0),
      failures: Number(r.f ?? 0),
    };
  }

  async monthBytes(): Promise<number> {
    const now = new Date();
    const start = `${now.toISOString().slice(0, 7)}-01`;
    const rows = await this.db.query<{ s: number | string | null }>(
      'SELECT COALESCE(SUM(bytes_uploaded),0) AS s FROM stats_daily WHERE day >= ?',
      [start]
    );
    return Number(rows[0]?.s ?? 0);
  }
}
