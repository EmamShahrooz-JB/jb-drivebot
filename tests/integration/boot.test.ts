import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tempDir } from '../helpers/config.js';

/**
 * Boots the real production entrypoint (src/index.ts) against a stub Telegram
 * Bot API and checks that the HTTP service comes up, answers, and shuts down
 * cleanly on SIGTERM. This is the closest thing to a deployment test we can run
 * without a real bot token.
 */
const TOKEN = '999999999:AAHstubTokenForBootTest1234567890';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no port'));
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe('production entrypoint (src/index.ts)', () => {
  let telegram: http.Server;
  let telegramBase: string;
  let app: ChildProcess;
  let dir: string;
  let port: number;
  let output = '';
  let updatesRequested = 0;

  beforeAll(async () => {
    telegram = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = url.pathname.split('/').pop() ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      if (method === 'getMe') {
        res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'stub', username: 'stub_bot' } }));
        return;
      }
      if (method === 'getUpdates') {
        updatesRequested++;
        res.end(JSON.stringify({ ok: true, result: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true, result: true }));
    });
    await new Promise<void>((r) => telegram.listen(0, '127.0.0.1', r));
    const addr = telegram.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    telegramBase = `http://127.0.0.1:${addr.port}`;

    dir = tempDir('jbd-boot-');
    port = await freePort();
    app = spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'src/index.ts'], {
      env: {
        PATH: process.env.PATH ?? '',
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_API_ROOT: telegramBase,
        TELEGRAM_TRANSPORT: 'polling',
        ADMIN_USER_IDS: '111111',
        GOOGLE_CLIENT_ID: 'boot.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-boot',
        APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        DB_DRIVER: 'sqlite',
        SQLITE_PATH: path.join(dir, 'boot.sqlite'),
        DATA_DIR: dir,
        TMP_DIR: path.join(dir, 'tmp'),
        BACKUP_DIR: path.join(dir, 'backups'),
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_BASE_URL: 'https://boot.example.app',
        ENABLE_PAIRING_SERVER: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    app.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  });

  afterAll(async () => {
    app?.kill('SIGKILL');
    await new Promise<void>((r) => telegram.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts the HTTP service and long polling', async () => {
    const up = await waitForHttp(`http://127.0.0.1:${port}/health`);
    if (!up) throw new Error(`app did not start. output:\n${output}`);
    expect(output).toContain('database migrated');
    expect(output).toContain('job queue started');
    expect(output).toContain('http server listening');
    await new Promise((r) => setTimeout(r, 700));
    expect(updatesRequested).toBeGreaterThan(0);
  }, 40_000);

  it('answers /health and the service index', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; service: string };
    expect(body).toMatchObject({ ok: true, service: 'jb-drivebot' });

    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    const indexBody = (await index.json()) as { endpoints: string[] };
    expect(indexBody.endpoints).toContain('POST /api/pair/complete');
  });

  it('rejects unknown routes and bad pairing codes', async () => {
    const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(notFound.status).toBe(404);
    const bad = await fetch(`http://127.0.0.1:${port}/api/pair/prepare?code=AAAA-1111`);
    expect(bad.status).toBe(401);
  });

  it('never writes the bot token to the logs', () => {
    expect(output).not.toContain(TOKEN);
    expect(output).not.toContain('AAHstubTokenForBootTest');
  });

  it('shuts down cleanly on SIGTERM', async () => {
    const exited = new Promise<number | null>((resolve) => app.once('exit', (code) => resolve(code)));
    app.kill('SIGTERM');
    const code = await exited;
    expect(code).toBe(0);
    expect(output).toContain('shutdown complete');
  }, 30_000);
});
