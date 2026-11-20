import { Bot, InputFile, type Api } from 'grammy';
import type { AppContext } from '../services/context.js';
import { RateLimiter } from '../security/rate-limit.js';
import { RefStore, SessionStore } from './refs.js';
import type { Notifier, SendOptions } from '../services/notifier.js';
import { errorText } from './format.js';
import { escapeHtml } from '../security/sanitize.js';
import { errorMessage } from '../utils/errors.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PairingIssuer {
  issuePairingCode(createdBy: number, mode: 'server-exchange' | 'local-exchange'): Promise<{ code: string; expiresAt: number }>;
}

export interface BotEnv {
  ctx: AppContext;
  api: Api;
  refs: RefStore;
  sessions: SessionStore;
  sign: (payload: string) => string;
  verify: (token: string) => string | null;
  deniedReply: (chatId: number) => Promise<void>;
  /** per-chat selection basket for bulk operations (archive, bulk move) */
  basket: Map<number, Set<string>>;
  /** pagination cursors for search results: `${chatId}:${page}` */
  pages: Map<string, { token: string; query: string }>;
  pairing: PairingIssuer | null;
}

export function createGrammyNotifier(api: Api): Notifier {
  return {
    async send(chatId: number, text: string, opts?: SendOptions): Promise<number | null> {
      try {
        const msg = await api.sendMessage(chatId, text, {
          parse_mode: opts?.parseMode ?? 'HTML',
          link_preview_options: { is_disabled: opts?.disablePreview ?? true },
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup as never } : {}),
        });
        return msg.message_id;
      } catch (err) {
        // 400 from Telegram usually means malformed HTML; retry as plain text.
        try {
          const msg = await api.sendMessage(chatId, text.replace(/<[^>]+>/g, ''), {
            link_preview_options: { is_disabled: true },
          });
          return msg.message_id;
        } catch {
          throw err;
        }
      }
    },
    async edit(chatId: number, messageId: number, text: string, opts?: SendOptions): Promise<boolean> {
      try {
        await api.editMessageText(chatId, messageId, text, {
          parse_mode: opts?.parseMode ?? 'HTML',
          link_preview_options: { is_disabled: opts?.disablePreview ?? true },
          ...(opts?.replyMarkup ? { reply_markup: opts.replyMarkup as never } : {}),
        });
        return true;
      } catch (err) {
        const msg = errorMessage(err);
        if (/message is not modified/i.test(msg)) return true;
        return false;
      }
    },
    async sendDocument(chatId: number, filePath: string, caption?: string): Promise<boolean> {
      try {
        await api.sendDocument(chatId, new InputFile(filePath, path.basename(filePath)), {
          ...(caption ? { caption } : {}),
        });
        return true;
      } finally {
        await fs.unlink(filePath).catch(() => undefined);
      }
    },
  };
}

export interface CreateBotOptions {
  /** skip long polling; used by tests */
  polling?: boolean;
}

export function createBot(
  appCtx: AppContext,
  opts: { pairing?: PairingIssuer | null } = {}
): { bot: Bot; env: BotEnv; notifier: Notifier } {
  const { config, logger } = appCtx;
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN, {
    client: { apiRoot: config.TELEGRAM_API_ROOT },
  });

  const refs = new RefStore();
  const sessions = new SessionStore();
  const limiter = new RateLimiter({ perMinute: config.RATE_LIMIT_PER_MINUTE, burst: config.RATE_LIMIT_BURST });

  const adminSet = new Set(config.ADMIN_USER_IDS);
  const deniedReply = async (chatId: number) => {
    try {
      await bot.api.sendMessage(chatId, '⛔️ دسترسی ندارید. این ربات خصوصی است.');
    } catch {
      /* user blocked the bot */
    }
  };

  const env: BotEnv = {
    ctx: appCtx,
    api: bot.api,
    refs,
    sessions,
    sign: (payload) => appCtx.signer.sign(payload, config.CALLBACK_TTL_SECONDS),
    verify: (token) => {
      const res = appCtx.signer.verify(token);
      return res.ok ? res.payload : null;
    },
    deniedReply,
    basket: new Map(),
    pages: new Map(),
    pairing: opts.pairing ?? null,
  };

  // ---------------- middleware ----------------
  bot.use(async (ctx, next) => {
    const started = Date.now();
    try {
      await next();
    } catch (err) {
      const message = errorMessage(err);
      logger.error('unhandled bot error', { err: message, updateId: ctx.update.update_id });
      try {
        if (ctx.chat) await ctx.reply(errorText(message), { parse_mode: 'HTML' });
      } catch {
        /* nothing else we can do */
      }
    } finally {
      logger.debug('update handled', { ms: Date.now() - started });
    }
  });

  // Strict single-operator allowlist. Everything the bot owns belongs to one
  // person; anyone else must learn nothing at all.
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !adminSet.has(userId)) {
      if (ctx.chat) await deniedReply(ctx.chat.id);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '⛔️ دسترسی ندارید', show_alert: true }).catch(() => undefined);
      logger.warn('rejected unauthorized user', { userId: userId ?? null });
      return;
    }
    await next();
  });

  bot.use(async (ctx, next) => {
    const userId = ctx.from!.id;
    const cost = ctx.callbackQuery ? 1 : 2;
    const { allowed, retryAfterMs } = limiter.consume(String(userId), cost);
    if (!allowed) {
      const wait = Math.ceil(retryAfterMs / 1000);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: `⏳ کمی صبر کنید (${wait}s)`, show_alert: false }).catch(() => undefined);
      else if (ctx.chat) await ctx.reply(`⏳ تعداد درخواست‌ها زیاد است. ${wait} ثانیه دیگر تلاش کنید.`).catch(() => undefined);
      return;
    }
    await next();
  });

  bot.catch((err) => {
    logger.error('bot polling error', { err: errorMessage(err.error) });
  });

  appCtx.setNotifier(createGrammyNotifier(bot.api));
  return { bot, env, notifier: createGrammyNotifier(bot.api) };
}

export function adminGuard(config: AppContext['config']) {
  const set = new Set(config.ADMIN_USER_IDS);
  return (userId: number | undefined): boolean => Boolean(userId && set.has(userId));
}

export { escapeHtml };
