import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createSqliteDb } from '../../src/database/sqlite.js';
import { migrate } from '../../src/database/index.js';
import { toPgPlaceholders } from '../../src/database/sqlite.js';
import { AccountsRepo } from '../../src/database/accounts.repo.js';
import { JobsRepo } from '../../src/database/jobs.repo.js';
import { UploadsRepo } from '../../src/database/uploads.repo.js';
import { SettingsRepo, DEFAULT_SETTINGS } from '../../src/database/settings.repo.js';
import { StatsRepo, dayKey } from '../../src/database/stats.repo.js';
import { PairingRepo } from '../../src/database/pairing.repo.js';
import { AuditRepo } from '../../src/database/audit.repo.js';
import { SCHEMA_SQL } from '../../src/database/schema.js';
import { tempDir } from '../helpers/config.js';
import type { Db } from '../../src/database/types.js';

describe('database', () => {
  let db: Db;
  let dir: string;

  beforeEach(async () => {
    dir = tempDir('jbd-db-');
    db = createSqliteDb(path.join(dir, 'test.sqlite'));
    await migrate(db);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates every table', async () => {
    const rows = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    const names = rows.map((r) => r.name);
    for (const table of ['accounts', 'uploads', 'jobs', 'settings', 'pairing_codes', 'audit_log', 'stats_daily', 'schema_migrations']) {
      expect(names, table).toContain(table);
    }
  });

  it('is idempotent (migrate twice)', async () => {
    const applied = await migrate(db);
    expect(applied).toEqual([]);
  });

  it('keeps migrations/*.sql in sync with schema.ts', () => {
    for (const dialect of ['sqlite', 'postgres'] as const) {
      const file = path.resolve(process.cwd(), 'migrations', dialect, '001_init.sql');
      expect(fs.existsSync(file), file).toBe(true);
      const onDisk = fs.readFileSync(file, 'utf8');
      expect(onDisk.trim()).toBe(SCHEMA_SQL[dialect].trim());
    }
  });

  it('translates ? placeholders for postgres without touching string literals', () => {
    expect(toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?')).toBe('SELECT * FROM t WHERE a = $1 AND b = $2');
    expect(toPgPlaceholders("SELECT * FROM t WHERE a = 'what?' AND b = ?")).toBe("SELECT * FROM t WHERE a = 'what?' AND b = $1");
  });

  describe('accounts', () => {
    it('starts disconnected and round-trips a connection', async () => {
      const repo = new AccountsRepo(db);
      expect(await repo.isConnected()).toBe(false);
      await repo.saveConnection({ email: 'me@example.com', scopes: ['a', 'b'], refreshTokenEnc: 'sealed' });
      const acc = await repo.get();
      expect(acc?.status).toBe('connected');
      expect(acc?.email).toBe('me@example.com');
      expect(await repo.isConnected()).toBe(true);
      await repo.setAccessToken('at', Date.now() + 1000);
      expect((await repo.get())?.access_token_enc).toBe('at');
      await repo.disconnect();
      expect(await repo.isConnected()).toBe(false);
      expect((await repo.get())?.refresh_token_enc).toBeNull();
    });

    it('replaces the token on reconnect instead of duplicating rows', async () => {
      const repo = new AccountsRepo(db);
      await repo.saveConnection({ email: 'a@example.com', scopes: [], refreshTokenEnc: 'one' });
      await repo.saveConnection({ email: 'b@example.com', scopes: [], refreshTokenEnc: 'two' });
      const rows = await db.query('SELECT * FROM accounts');
      expect(rows).toHaveLength(1);
      expect((await repo.get())?.refresh_token_enc).toBe('two');
    });
  });

  describe('uploads + stats', () => {
    it('records uploads, dedupes by hash and aggregates bytes', async () => {
      const uploads = new UploadsRepo(db);
      const stats = new StatsRepo(db);
      await uploads.record({ driveFileId: 'f1', name: 'a.pdf', size: 100, sha256: 'hash1', source: 'telegram' });
      await stats.recordUpload(100);
      await uploads.record({ driveFileId: 'f2', name: 'a.pdf', size: 100, sha256: 'hash1', source: 'link' });
      await stats.recordUpload(100);

      expect(await uploads.totalCount()).toBe(2);
      expect(await uploads.totalBytes()).toBe(200);
      expect(await uploads.findByHash('hash1')).toHaveLength(2);
      expect(await uploads.knownDriveFile('hash1')).toBe('f2'); // most recent wins

      const day = await stats.getDay();
      expect(day.uploads).toBe(2);
      expect(day.bytes_uploaded).toBe(200);
    });

    it('buckets stats per day and month', async () => {
      const stats = new StatsRepo(db);
      await stats.recordUpload(50);
      await stats.recordDownload(25);
      await stats.recordJobOutcome(true);
      await stats.recordJobOutcome(false);
      const today = await stats.getDay(dayKey());
      expect(today.downloads).toBe(1);
      expect(today.bytes_downloaded).toBe(25);
      expect(today.successes).toBe(1);
      expect(today.failures).toBe(1);
      expect(await stats.monthBytes()).toBe(50);
    });
  });

  describe('settings', () => {
    it('returns defaults then persists overrides', async () => {
      const repo = new SettingsRepo(db);
      expect((await repo.all()).autoOrganize).toBe(DEFAULT_SETTINGS.autoOrganize);
      await repo.set('autoOrganize', false);
      await repo.set('organizeMode', 'date');
      const all = await repo.all();
      expect(all.autoOrganize).toBe(false);
      expect(all.organizeMode).toBe('date');
    });

    it('ignores corrupt stored values', async () => {
      const repo = new SettingsRepo(db);
      await db.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', ['autoOrganize', '{not json', Date.now()]);
      expect((await repo.all()).autoOrganize).toBe(DEFAULT_SETTINGS.autoOrganize);
    });
  });

  describe('pairing codes', () => {
    it('invalidates the previous code when a new one is issued', async () => {
      const repo = new PairingRepo(db);
      const first = await repo.create({ codeHash: 'h1', createdBy: 1, expiresAt: Date.now() + 60_000, mode: 'server-exchange', transferKeyEnc: null });
      await repo.create({ codeHash: 'h2', createdBy: 1, expiresAt: Date.now() + 60_000, mode: 'server-exchange', transferKeyEnc: null });
      expect(await repo.findByHash('h1')).toBeNull();
      expect(await repo.findByHash('h2')).not.toBeNull();
      expect(first).toBeTruthy();
    });

    it('counts attempts and marks single use', async () => {
      const repo = new PairingRepo(db);
      await repo.create({ codeHash: 'h', createdBy: 1, expiresAt: Date.now() + 60_000, mode: 'server-exchange', transferKeyEnc: null });
      const row = (await repo.findByHash('h'))!;
      expect(await repo.bumpAttempts(row.id)).toBe(1);
      expect(await repo.bumpAttempts(row.id)).toBe(2);
      await repo.markUsed(row.id);
      expect((await repo.findByHash('h'))!.used_at).toBeGreaterThan(0);
    });

    it('purges expired codes', async () => {
      const repo = new PairingRepo(db);
      await repo.create({ codeHash: 'old', createdBy: 1, expiresAt: Date.now() - 1000, mode: 'server-exchange', transferKeyEnc: null });
      expect(await repo.purgeExpired()).toBe(1);
    });
  });

  describe('jobs repo', () => {
    it('claims jobs by priority then FIFO', async () => {
      const repo = new JobsRepo(db);
      await repo.create({ type: 'a', payload: {}, priority: 10 });
      await repo.create({ type: 'a', payload: {}, priority: 90 });
      const first = await repo.claimNext();
      expect(first?.priority).toBe(90);
      const second = await repo.claimNext();
      expect(second?.priority).toBe(10);
      expect(await repo.claimNext()).toBeNull();
    });

    it('does not claim a job scheduled in the future', async () => {
      const repo = new JobsRepo(db);
      await repo.create({ type: 'a', payload: {}, runAt: Date.now() + 60_000 });
      expect(await repo.claimNext()).toBeNull();
    });

    it('filters by type when asked', async () => {
      const repo = new JobsRepo(db);
      await repo.create({ type: 'upload', payload: {} });
      await repo.create({ type: 'download', payload: {} });
      const claimed = await repo.claimNext(Date.now(), ['download']);
      expect(claimed?.type).toBe('download');
    });

    it('enforces idempotency keys', async () => {
      const repo = new JobsRepo(db);
      await repo.create({ type: 'a', payload: {}, idempotencyKey: 'same' });
      await expect(repo.create({ type: 'a', payload: {}, idempotencyKey: 'same' })).rejects.toThrow();
      expect(await repo.findByIdempotencyKey('same')).not.toBeNull();
    });

    it('retries until max_attempts then fails', async () => {
      const repo = new JobsRepo(db);
      const job = await repo.create({ type: 'a', payload: {}, maxAttempts: 2 });
      // attempt 1 fails -> requeued
      const first = await repo.claimNext();
      expect(first?.attempts).toBe(1);
      expect(await repo.fail(job.id, 'boom', { retryAt: Date.now() })).toBe('queued');
      // attempt 2 fails -> out of attempts
      const second = await repo.claimNext();
      expect(second?.attempts).toBe(2);
      expect(await repo.fail(job.id, 'boom', { retryAt: Date.now() })).toBe('failed');
      expect((await repo.get(job.id))?.status).toBe('failed');
      expect(await repo.claimNext()).toBeNull();
    });

    it('recoverOrphans requeues jobs left running by a crashed process', async () => {
      const repo = new JobsRepo(db);
      const job = await repo.create({ type: 'a', payload: {} });
      await repo.claimNext();
      expect((await repo.get(job.id))?.status).toBe('running');
      const result = await repo.recoverOrphans();
      expect(result.requeued).toBe(1);
      expect((await repo.get(job.id))?.status).toBe('queued');
    });

    it('recoverOrphans cancels jobs whose cancellation was requested', async () => {
      const repo = new JobsRepo(db);
      const job = await repo.create({ type: 'a', payload: {} });
      await repo.claimNext();
      await repo.requestCancel(job.id);
      const result = await repo.recoverOrphans();
      expect(result.canceled).toBe(1);
      expect((await repo.get(job.id))?.status).toBe('canceled');
    });

    it('requestCancel cancels a queued job immediately', async () => {
      const repo = new JobsRepo(db);
      const job = await repo.create({ type: 'a', payload: {} });
      expect(await repo.requestCancel(job.id)).toBe(true);
      expect((await repo.get(job.id))?.status).toBe('canceled');
      expect(await repo.requestCancel(job.id)).toBe(false);
    });

    it('counts by status', async () => {
      const repo = new JobsRepo(db);
      await repo.create({ type: 'a', payload: {} });
      await repo.create({ type: 'b', payload: {} });
      await repo.claimNext();
      const counts = await repo.counts();
      expect(counts.queued + counts.running).toBe(2);
    });
  });

  describe('audit', () => {
    it('logs entries newest first', async () => {
      const repo = new AuditRepo(db);
      await repo.log({ actor: 1, action: 'one' });
      await repo.log({ actor: 1, action: 'two', meta: { a: 1 } });
      const rows = await repo.recent(10);
      expect(rows[0]?.action).toBe('two');
      expect(rows).toHaveLength(2);
    });
  });
});
