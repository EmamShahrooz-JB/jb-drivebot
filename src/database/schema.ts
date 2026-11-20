import type { Dialect } from './types.js';

/**
 * Authoritative DDL. `migrations/sqlite/001_init.sql` and
 * `migrations/postgres/001_init.sql` are byte-identical copies of these
 * constants and a test asserts that, so the repo can never drift.
 */
const common = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT,
  email TEXT,
  scopes TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at BIGINT,
  root_folder_id TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  connected_at BIGINT,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  drive_file_id TEXT NOT NULL,
  name TEXT NOT NULL,
  size BIGINT NOT NULL,
  mime TEXT,
  extension TEXT,
  folder_id TEXT,
  folder_path TEXT,
  sha256 TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  web_link TEXT,
  status TEXT NOT NULL,
  uploaded_at BIGINT NOT NULL,
  duration_ms BIGINT,
  created_by BIGINT,
  budget_bytes BIGINT,
  seq BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_uploads_sha ON uploads(sha256);
CREATE INDEX IF NOT EXISTS idx_uploads_time ON uploads(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_seq ON uploads(seq DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_name ON uploads(name);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'queued',
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 4,
  run_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  last_error TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  session_uri TEXT,
  resume_offset BIGINT,
  created_by BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_idem ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, run_at, priority DESC, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  created_by BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  attempts INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'server-exchange',
  transfer_key_enc TEXT
);
CREATE INDEX IF NOT EXISTS idx_pairing_hash ON pairing_codes(code_hash);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor BIGINT,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT,
  created_at BIGINT NOT NULL,
  seq BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_log(seq DESC);

CREATE TABLE IF NOT EXISTS stats_daily (
  day TEXT PRIMARY KEY,
  uploads INTEGER NOT NULL DEFAULT 0,
  bytes_uploaded BIGINT NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0,
  bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
`;

export const SCHEMA_SQL: Record<Dialect, string> = {
  sqlite: common,
  postgres: common,
};
