import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { loadConfig, type AppConfig } from '../../src/config/index.js';

export function tempDir(prefix = 'jbd-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A valid config backed by a throwaway SQLite file. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  const dir = tempDir();
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    TELEGRAM_BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly1234567890',
    ADMIN_USER_IDS: '111111',
    GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-test-secret',
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(dir, 'test.sqlite'),
    DATA_DIR: dir,
    TMP_DIR: path.join(dir, 'tmp'),
    BACKUP_DIR: path.join(dir, 'backups'),
    ENABLE_PAIRING_SERVER: 'false',
    ...overrides,
  });
}
