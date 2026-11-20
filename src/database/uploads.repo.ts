import type { Db, UploadRow } from './types.js';
import { uuid } from '../utils/id.js';

const INT_COLS = ['size', 'uploaded_at', 'duration_ms', 'created_by', 'budget_bytes', 'seq'];

function norm(row: Record<string, unknown>): UploadRow {
  const r = { ...row };
  for (const k of INT_COLS) {
    if (typeof r[k] === 'string' && /^-?\d+$/.test(r[k] as string)) r[k] = Number(r[k]);
  }
  return r as unknown as UploadRow;
}

export interface RecordUploadInput {
  driveFileId: string;
  name: string;
  size: number;
  mime?: string | null;
  extension?: string | null;
  folderId?: string | null;
  folderPath?: string | null;
  sha256?: string | null;
  source: string;
  sourceRef?: string | null;
  webLink?: string | null;
  status?: string;
  durationMs?: number | null;
  createdBy?: number | null;
  /** Google Drive quota this file consumes (native Google Docs cost 0). */
  budgetBytes?: number | null;
}

/**
 * Monotonic insertion counter. `uploaded_at` only has millisecond resolution, so
 * two uploads in the same tick would otherwise have no stable order; the UI and
 * the duplicate detection both need "most recent first" to be deterministic.
 */
let seqCounter = 0;
export function nextSeq(now = Date.now()): number {
  seqCounter = (seqCounter + 1) % 1000;
  return now * 1000 + seqCounter;
}

export class UploadsRepo {
  constructor(private readonly db: Db) {}

  async record(input: RecordUploadInput): Promise<UploadRow> {
    const id = uuid();
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO uploads (id, drive_file_id, name, size, mime, extension, folder_id, folder_path, sha256,
         source, source_ref, web_link, status, uploaded_at, duration_ms, created_by, budget_bytes, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.driveFileId,
        input.name,
        input.size,
        input.mime ?? null,
        input.extension ?? null,
        input.folderId ?? null,
        input.folderPath ?? null,
        input.sha256 ?? null,
        input.source,
        input.sourceRef ?? null,
        input.webLink ?? null,
        input.status ?? 'ok',
        now,
        input.durationMs ?? null,
        input.createdBy ?? null,
        input.budgetBytes ?? input.size,
        nextSeq(now),
      ]
    );
    const rows = await this.db.query('SELECT * FROM uploads WHERE id = ?', [id]);
    return norm(rows[0]!);
  }

  async findByHash(sha256: string): Promise<UploadRow[]> {
    const rows = await this.db.query('SELECT * FROM uploads WHERE sha256 = ? ORDER BY seq DESC LIMIT 10', [sha256]);
    return rows.map(norm);
  }

  async recent(limit = 10): Promise<UploadRow[]> {
    const rows = await this.db.query('SELECT * FROM uploads ORDER BY seq DESC LIMIT ' + Math.min(50, Math.max(1, limit)));
    return rows.map(norm);
  }

  async byName(name: string): Promise<UploadRow[]> {
    const rows = await this.db.query('SELECT * FROM uploads WHERE name = ? LIMIT 10', [name]);
    return rows.map(norm);
  }

  async totalCount(): Promise<number> {
    const rows = await this.db.query<{ n: number | string }>('SELECT COUNT(*) AS n FROM uploads');
    return Number(rows[0]?.n ?? 0);
  }

  async totalBytes(): Promise<number> {
    const rows = await this.db.query<{ s: number | string | null }>('SELECT COALESCE(SUM(budget_bytes),0) AS s FROM uploads');
    return Number(rows[0]?.s ?? 0);
  }

  async bytesSince(sinceMs: number): Promise<number> {
    const rows = await this.db.query<{ s: number | string | null }>(
      'SELECT COALESCE(SUM(budget_bytes),0) AS s FROM uploads WHERE uploaded_at >= ?',
      [sinceMs]
    );
    return Number(rows[0]?.s ?? 0);
  }

  /** Prefer the Drive file id in the most recent upload event for this hash. */
  async knownDriveFile(sha256: string): Promise<string | null> {
    const rows = await this.findByHash(sha256);
    return rows[0]?.drive_file_id ?? null;
  }
}
