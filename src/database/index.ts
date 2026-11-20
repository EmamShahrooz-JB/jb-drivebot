import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/index.js';
import type { Db } from './types.js';
import { createSqliteDb } from './sqlite.js';
import { createPostgresDb } from './postgres.js';
import { SCHEMA_SQL } from './schema.js';

export async function openDatabase(config: AppConfig): Promise<Db> {
  if (config.DB_DRIVER === 'postgres') {
    if (!config.DATABASE_URL) throw new Error('DATABASE_URL missing');
    return createPostgresDb(config.DATABASE_URL, config.DB_POOL_MAX);
  }
  const file = path.resolve(config.SQLITE_PATH ?? path.join(config.dataDir, 'jb-drivebot.sqlite'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return createSqliteDb(file);
}

export async function migrate(db: Db): Promise<string[]> {
  const applied: string[] = [];
  // The migrations table has to exist before we can read it.
  const bootstrap = SCHEMA_SQL[db.dialect]
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /CREATE TABLE IF NOT EXISTS schema_migrations/i.test(s));
  for (const stmt of bootstrap) await db.exec(stmt + ';');

  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name)
  );
  const steps: Array<{ name: string; sql: string }> = [{ name: '001_init', sql: SCHEMA_SQL[db.dialect] }];

  for (const step of steps) {
    if (done.has(step.name)) continue;
    await db.exec(step.sql);
    await db.execute('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [step.name, Date.now()]);
    applied.push(step.name);
  }
  return applied;
}

export * from './types.js';
export { coerceInts } from './postgres.js';
export { toPgPlaceholders } from './sqlite.js';
