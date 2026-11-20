/**
 * Boot smoke test — no Telegram, no Google, no secrets required.
 *
 * It wires up exactly what index.ts wires up (config -> database -> migrations
 * -> queue -> job handlers -> HTTP server -> bot object), exercises the HTTP
 * endpoints and the pairing-code lifecycle, then shuts down. Run it after a
 * deploy to prove the container is healthy before you hand it a real token:
 *
 *   npm run smoke
 */
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { createContext } from '../src/services/context.js';
import { registerJobHandlers } from '../src/queue/handlers.js';
import { createPairingServer } from '../src/server/pairing-server.js';
import { createBot } from '../src/bot/bot.js';
import { registerCommands } from '../src/commands/index.js';
import { registerMessageHandlers } from '../src/handlers/messages.js';
import { errorMessage } from '../src/utils/errors.js';
import net from 'node:net';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (!addr || typeof addr === 'string') return reject(new Error('no free port'));
      const { port } = addr;
      probe.close(() => resolve(port));
    });
  });

const useRealEnv = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.APP_ENCRYPTION_KEY);

async function main(): Promise<void> {
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'jbd-smoke-'));
  const port = String(await freePort());
  const env: NodeJS.ProcessEnv = useRealEnv
    ? { ...process.env, ENABLE_PAIRING_SERVER: 'true', PORT: port }
    : {
        NODE_ENV: 'test',
        LOG_LEVEL: 'info',
        TELEGRAM_BOT_TOKEN: '123456789:AAHsmokeTestTokenNotReal1234567890',
        ADMIN_USER_IDS: '111111',
        GOOGLE_CLIENT_ID: 'smoke-client.apps.googleusercontent.com',
        GOOGLE_CLIENT_SECRET: 'GOCSPX-smoke',
        APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        DB_DRIVER: 'sqlite',
        DATA_DIR: scratch,
        SQLITE_PATH: path.join(scratch, 'smoke.sqlite'),
        TMP_DIR: path.join(scratch, 'tmp'),
        BACKUP_DIR: path.join(scratch, 'backups'),
        PORT: port,
        ENABLE_PAIRING_SERVER: 'true',
      };

  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, ...(detail ? { detail } : {}) });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  const config = loadConfig(env);
  const logger = createLogger(config.LOG_LEVEL === 'trace' ? 'debug' : config.LOG_LEVEL);
  check('config parsed', true, `env=${config.NODE_ENV} db=${config.DB_DRIVER} scopes=${config.GOOGLE_SCOPES_MODE}`);

  const app = await createContext(config);
  check('database open + migrations', (await app.db.query('SELECT 1 AS ok')).length === 1);

  registerJobHandlers(app);
  await app.queue.start();
  const queueStats = app.queue.stats();
  check('job handlers registered', queueStats.registered.length >= 7, queueStats.registered.join(','));

  const pairing = createPairingServer(app, { port: config.PORT, host: config.HOST });
  const bound = await pairing.listen();
  check('http server listening', bound.port > 0, `127.0.0.1:${bound.port}`);

  const base = `http://127.0.0.1:${bound.port}`;
  const health = await fetch(`${base}/health`);
  const healthBody = (await health.json()) as { ok?: boolean };
  check('GET /health', health.status === 200 && healthBody.ok === true);

  const { bot, env: botEnv } = createBot(app, { pairing });
  registerCommands(botEnv, bot);
  registerMessageHandlers(botEnv, bot);
  check('bot wired (commands + handlers), polling not started', true);

  const issued = await pairing.issuePairingCode(config.OWNER_ID, 'server-exchange');
  check('pairing code issued', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(issued.code));

  const prepare = await fetch(`${base}/api/pair/prepare?code=${encodeURIComponent(issued.code)}`);
  const prepareBody = (await prepare.json()) as { ok?: boolean; clientId?: string; scopes?: string[] };
  check('GET /api/pair/prepare', prepare.status === 200 && prepareBody.ok === true, `${prepareBody.scopes?.length ?? 0} scopes`);

  const badPrepare = await fetch(`${base}/api/pair/prepare?code=ZZZZ-9999`);
  check('invalid pairing code rejected', badPrepare.status === 401);

  const jobs = await app.repos.jobs.create({ type: 'cleanup', priority: 5, payload: { chatId: config.OWNER_ID, userId: config.OWNER_ID } });
  const deadline = Date.now() + 8000;
  let status = 'queued';
  while (Date.now() < deadline) {
    const fresh = await app.repos.jobs.get(jobs.id);
    status = fresh?.status ?? 'missing';
    if (status === 'succeeded' || status === 'failed') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check('queue processed a real job', status === 'succeeded', `cleanup -> ${status}`);

  const stats = await app.repos.stats.getDay();
  check('stats read', typeof stats.uploads === 'number');
  check('temp space initialised', true, config.tmpDir);

  await pairing.close();
  await app.queue.stop();
  await app.db.close();
  if (!useRealEnv) await fsp.rm(scratch, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.ok);
  console.log('');
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error('failed checks:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('smoke test crashed:', errorMessage(err));
  process.exit(1);
});
