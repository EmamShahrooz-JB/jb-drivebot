export type Dialect = 'sqlite' | 'postgres';

export interface Queryable {
  /** SQL uses `?` placeholders; the driver rewrites them for Postgres. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface Db extends Queryable {
  readonly dialect: Dialect;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Run raw multi-statement DDL. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobRow {
  id: string;
  type: string;
  priority: number;
  status: JobStatus;
  payload: string;
  idempotency_key: string | null;
  attempts: number;
  max_attempts: number;
  run_at: number;
  started_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  progress: number;
  message: string | null;
  cancel_requested: number;
  result: string | null;
  session_uri: string | null;
  resume_offset: number | null;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface AccountRow {
  id: string;
  google_sub: string | null;
  email: string | null;
  scopes: string;
  refresh_token_enc: string | null;
  access_token_enc: string | null;
  access_token_expires_at: number | null;
  root_folder_id: string | null;
  status: string;
  connected_at: number | null;
  updated_at: number;
}

export interface UploadRow {
  id: string;
  drive_file_id: string;
  name: string;
  size: number;
  mime: string | null;
  extension: string | null;
  folder_id: string | null;
  folder_path: string | null;
  sha256: string | null;
  source: string;
  source_ref: string | null;
  web_link: string | null;
  status: string;
  uploaded_at: number;
  duration_ms: number | null;
  created_by: number | null;
  budget_bytes: number | null;
  seq: number;
}
