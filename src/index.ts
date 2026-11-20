import { loadConfig } from './config/index.js';
import { createLogger } from './utils/logger.js';
import { createContext } from './services/context.js';
import { registerJobHandlers } from './queue/handlers.js';
import { createPairingServer, type PairingServer } from './server/pairing-server.js';
import { createBot } from './bot/bot.js';
import { registerCommands } from './commands/index.js';
import { registerMessageHandlers } from './handlers/messages.js';
import { webhookCallback } from 'grammy';
import { errorMessage } from './utils/errors.js';
import { formatBytes } from './utils/bytes.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  logger.info('starting JB-DriveBot', {
    env: config.NODE_ENV,
    transport: config.TELEGRAM_TRANSPORT,
    db: config.DB_DRIVER,
    scopesMode: config.GOOGLE_SCOPES_MODE,
    maxTelegramDownload: formatBytes(config.MAX_TELEGRAM_DOWNLOAD_BYTES),
  });

  if (!config.googleConfigured) {
    logger.warn(
      'GOOGLE_CLIENT_ID/SECRET are not set: the bot will run, but Google Drive features stay disabled until they are configured'
    );
  }

  const app = await createContext(config);
  registerJobHandlers(app);

  const recovery = await app.queue.start();
  if (recovery.requeued + recovery.canceled > 0) {
    logger.info('recovered jobs from previous run', recovery);
  }

  let pairing: PairingServer | null = null;
  let webhookHandler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | null = null;

  const { bot, env } = createBot(app, { pairing: null });

  if (config.TELEGRAM_TRANSPORT === 'webhook') {
    if (!config.WEBHOOK_PUBLIC_URL || !config.WEBHOOK_SECRET) {
      throw new Error('WEBHOOK_PUBLIC_URL and WEBHOOK_SECRET are required when TELEGRAM_TRANSPORT=webhook');
    }
    const handler = webhookCallback(bot, 'http', { secretToken: config.WEBHOOK_SECRET });
    webhookHandler = async (req, res) => {
      await handler(req, res);
    };
  }

  if (config.ENABLE_PAIRING_SERVER) {
    pairing = createPairingServer(app, {
      port: config.PORT,
      host: config.HOST,
      extraRoutes:
        webhookHandler && config.WEBHOOK_SECRET
          ? [
              {
                method: 'POST' as const,
                path: `/telegram/webhook/${config.WEBHOOK_SECRET}`,
                handler: webhookHandler,
              },
            ]
          : [],
    });
    env.pairing = pairing;
    const bound = await pairing.listen();
    logger.info('http server listening', { host: bound.host, port: bound.port, pairing: true, webhook: Boolean(webhookHandler) });
  } else if (webhookHandler) {
    throw new Error('webhook transport requires ENABLE_PAIRING_SERVER=true (it hosts the webhook route)');
  }

  registerCommands(env, bot);
  registerMessageHandlers(env, bot);

  await bot.api
    .setMyCommands([
      { command: 'start', description: 'منوی اصلی' },
      { command: 'connect', description: 'اتصال Google Drive' },
      { command: 'status', description: 'وضعیت اتصال و صف' },
      { command: 'folders', description: 'مدیریت پوشه‌ها' },
      { command: 'search', description: 'جستجوی فایل' },
      { command: 'recent', description: 'آخرین فایل‌ها' },
      { command: 'storage', description: 'وضعیت فضا' },
      { command: 'stats', description: 'آمار' },
      { command: 'queue', description: 'صف عملیات' },
      { command: 'settings', description: 'تنظیمات' },
      { command: 'help', description: 'راهنما' },
    ])
    .catch((err) => logger.warn('setMyCommands failed', { err: errorMessage(err) }));

  // periodic maintenance: temp purge + old job pruning
  const maintenance = setInterval(
    () => {
      void app.repos.jobs
        .create({ type: 'cleanup', priority: 10, payload: { chatId: config.OWNER_ID, userId: config.OWNER_ID } })
        .catch((err) => logger.warn('could not enqueue maintenance job', { err: errorMessage(err) }));
    },
    6 * 3600_000
  );
  maintenance.unref?.();

  const shutdown = async (signal: string) => {
    logger.info('shutting down', { signal });
    clearInterval(maintenance);
    try {
      await bot.stop();
    } catch {
      /* not started */
    }
    await app.queue.stop();
    await pairing?.close();
    await app.db.close();
    logger.info('shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { err: errorMessage(reason) }));
  process.on('uncaughtException', (err) => logger.error('uncaught exception', { err: errorMessage(err) }));

  if (config.TELEGRAM_TRANSPORT === 'webhook') {
    const url = `${config.WEBHOOK_PUBLIC_URL!.replace(/\/$/, '')}/telegram/webhook/${config.WEBHOOK_SECRET!}`;
    await bot.api.setWebhook(url, { secret_token: config.WEBHOOK_SECRET!, drop_pending_updates: false });
    logger.info('webhook registered', { url: url.replace(config.WEBHOOK_SECRET!, '[REDACTED]') });
  } else {
    await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    logger.info('started long polling');
    // bot.start() resolves only when the bot stops
    await bot.start({ drop_pending_updates: false });
  }
}

main().catch((err) => {
  console.error('fatal startup error:', errorMessage(err));
  process.exit(1);
});
