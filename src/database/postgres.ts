import pg from 'pg';
import { toPgPlaceholders } from './sqlite.js';
import type { Db, Queryable } from './types.js';

const { Pool } = pg;

class PgQueryable implements Queryable {
  constructor(private readonly client: pg.Pool | pg.PoolClient) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const res = await this.client.query(toPgPlaceholders(sql), (params ?? []) as unknown[]);
    return res.rows as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    const res = await this.client.query(toPgPlaceholders(sql), (params ?? []) as unknown[]);
    return { changes: res.rowCount ?? 0 };
  }
}

/** Postgres normalises BIGINT to string; convert the columns we rely on. */
export function coerceInts<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v !== '' && /^-?\d+$/.test(v)) {
      (row as Record<string, unknown>)[k] = Number(v);
    }
  }
  return row;
}

export function createPostgresDb(connectionString: string, poolMax = 5): Db {
  const pool = new Pool({ connectionString, max: poolMax, ssl: /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined });
  const base = new PgQueryable(pool);

  return {
    dialect: 'postgres',
    query: (sql, params) => base.query(sql, params),
    execute: (sql, params) => base.execute(sql, params),
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = new PgQueryable(client);
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}
