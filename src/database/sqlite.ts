import Database from 'better-sqlite3';
import type { Db, Queryable } from './types.js';

/** Rewrite `?` placeholders into PostgreSQL style. Skipped for sqlite. */
export function toPgPlaceholders(sql: string): string {
  let i = 0;
  let out = '';
  let inSingle = false;
  for (const ch of sql) {
    if (ch === "'") inSingle = !inSingle;
    if (ch === '?' && !inSingle) {
      i += 1;
      out += `$${i}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function bindAll(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p as unknown;
  });
}

class SqliteQueryable implements Queryable {
  constructor(private readonly db: Database.Database) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...bindAll(params)) as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const r = this.db.prepare(sql).run(...bindAll(params));
    return { changes: r.changes };
  }
}

export function createSqliteDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const base = new SqliteQueryable(db);
  let depth = 0;

  return {
    dialect: 'sqlite',
    query: (sql, params) => base.query(sql, params),
    execute: (sql, params) => base.execute(sql, params),
    async exec(sql: string) {
      db.exec(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      if (depth > 0) return fn(base); // already inside a transaction
      depth++;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(base);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        depth--;
      }
    },
    async close() {
      db.close();
    },
  };
}
