import { InlineKeyboard, type Bot, type Context } from 'grammy';
import type { BotEnv } from '../bot/bot.js';
import {
  mainView,
  driveView,
  foldersView,
  statsView,
  settingsView,
  queueView,
  historyView,
  helpView,
  connectView,
} from '../bot/views.js';
import { backToMain, confirmKeyboard, fileListKeyboard, mainMenu } from '../keyboards/index.js';
import { ICONS, errorText, successText, fmtDate, fileLine } from '../bot/format.js';
import { formatBytes } from '../utils/bytes.js';
import { escapeHtml, safeFileName, truncate } from '../security/sanitize.js';
import { AppError, errorMessage } from '../utils/errors.js';
import { getRootFolder, resolveDestination } from '../services/folders.js';
import { capabilitiesForScopes } from '../oauth/scopes.js';
import { searchDrive, parseQuery } from '../services/search.js';
import type { DriveFile } from '../google-drive/types.js';

const HTML = { parse_mode: 'HTML' as const };

function argText(text: string | undefined): string {
  if (!text) return '';
  const parts = text.split(' ');
  return parts.slice(1).join(' ').trim();
}

async function send(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.reply(text, { ...HTML, link_preview_options: { is_disabled: true }, ...extra });
}

/** Resolve a user supplied name or Drive id to a file. */
export async function resolveFileArg(env: BotEnv, arg: string): Promise<DriveFile | null> {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
    try {
      return await env.ctx.drive.files.get(trimmed);
    } catch {
      /* fall through to a name search */
    }
  }
  const res = await env.ctx.drive.files.list({
    q: `name contains '${trimmed.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: 5,
    orderBy: 'modifiedTime desc',
  });
  return res.files[0] ?? null;
}

export function registerCommands(env: BotEnv, bot: Bot): void {
  const { ctx: app } = env;

  const guard = async (fn: () => Promise<void>, reply: (text: string) => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_connected') {
        await reply(`${ICONS.warn} Google Drive متصل نیست.\nابتدا /connect را اجرا کنید.`);
        return;
      }
      await reply(errorText(errorMessage(err)));
    }
  };

  bot.command(['start', 'menu'], async (ctx) => {
    const view = await mainView(env);
    await send(ctx, view.text, { reply_markup: view.keyboard });
  });

  bot.command('help', async (ctx) => {
    const view = helpView(env);
    await send(ctx, view.text, { reply_markup: view.keyboard });
  });

  bot.command('id', async (ctx) => {
    await send(ctx, `🆔 آیدی تلگرام شما: <code>${ctx.from?.id ?? 0}</code>\nچت: <code>${ctx.chat?.id ?? 0}</code>`);
  });

  bot.command('status', async (ctx) => {
    await guard(async () => {
      const account = await app.repos.accounts.get();
      const connected = Boolean(account?.status === 'connected' && account.refresh_token_enc);
      const jobCounts = await app.repos.jobs.counts();
      const caps = capabilitiesForScopes(await app.tokens.grantedScopes());
      const queueStats = app.queue.stats();
      const lines = [
        `${ICONS.info} <b>وضعیت سیستم</b>`,
        '',
        `${connected ? ICONS.ok : ICONS.warn} Google Drive: ${connected ? `متصل (<code>${escapeHtml(account?.email ?? '—')}</code>)` : 'متصل نیست'}`,
        `🔐 سطح دسترسی: <code>${caps.mode}</code>`,
        `🕒 آخرین بروزرسانی توکن: ${fmtDate(account?.updated_at ?? null)}`,
        '',
        `⏳ صف: ${jobCounts.queued} · ▶️ در حال اجرا: ${jobCounts.running}`,
        `✅ موفق: ${jobCounts.succeeded} · ❌ ناموفق: ${jobCounts.failed} · 🚫 لغو: ${jobCounts.canceled}`,
        `🧵 ورکر فعال: ${queueStats.running} · نوع عملیات: ${queueStats.registered.length}`,
        '',
        `<i>سرویس جفت‌سازی: ${app.config.ENABLE_PAIRING_SERVER ? 'فعال' : 'غیرفعال'}</i>`,
      ];
      await send(ctx, lines.join('\n'));
    }, (text) => send(ctx, text));
  });

  bot.command('connect', async (ctx) => {
    await guard(async () => {
      if (!env.pairing || !app.config.ENABLE_PAIRING_SERVER) {
        await send(ctx, `${ICONS.err} سرویس جفت‌سازی روی این استقرار فعال نیست.`);
        return;
      }
      const account = await app.repos.accounts.get();
      if (account?.status === 'connected' && account.refresh_token_enc) {
        await send(
          ctx,
          `${ICONS.ok} از قبل به <code>${escapeHtml(account.email ?? '—')}</code> متصل هستید.\nبرای اتصال مجدد ابتدا /disconnect را بزنید.`
        );
        return;
      }
      const { code, expiresAt } = await env.pairing.issuePairingCode(ctx.from!.id, 'server-exchange');
      const base = app.config.PUBLIC_BASE_URL ?? `http://127.0.0.1:${app.config.PORT}`;
      await send(
        ctx,
        [
          `${ICONS.link} <b>کد اتصال یک‌بارمصرف</b>`,
          '',
          `<code>${code}</code>`,
          '',
          `⏱ اعتبار: تا ${fmtDate(expiresAt)}`,
          '',
          '<b>روی کامپیوتر خود اجرا کنید:</b>',
          `<pre>npx tsx auth-local/src/cli.ts --server ${escapeHtml(base)} --code ${code}</pre>`,
          '<i>مرورگر باز می‌شود، حساب Google را انتخاب و تأیید کنید. توکن روی سیستم شما ذخیره نمی‌شود.</i>',
          '',
          '⚠️ این کد فقط یک‌بار کار می‌کند و به‌صورت هش‌شده ذخیره می‌شود.',
        ].join('\n')
      );
      await app.repos.audit.log({ actor: ctx.from!.id, action: 'oauth.pairing_code', meta: { mode: 'server-exchange' } });
    }, (text) => send(ctx, text));
  });

  bot.command('disconnect', async (ctx) => {
    await guard(async () => {
      const account = await app.repos.accounts.get();
      if (!account?.refresh_token_enc) {
        await send(ctx, `${ICONS.info} هیچ حسابی متصل نیست.`);
        return;
      }
      const kb = new InlineKeyboardBuilder()
        .text('✅ بله، قطع کن', env.sign('y:disconnect:x'))
        .text('❌ لغو', env.sign('m:main'));
      await send(ctx, `${ICONS.warn} <b>قطع اتصال Google Drive</b>\n\nتوکن دسترسی روی سرور حذف و از سمت گوگل هم باطل می‌شود. فایل‌های موجود در Drive دست‌نخورده می‌مانند.\n\nمطمئن هستید؟`, {
        reply_markup: kb,
      });
    }, (text) => send(ctx, text));
  });

  bot.command('folders', async (ctx) => {
    await guard(async () => {
      const view = await foldersView(env);
      await send(ctx, view.text, { reply_markup: view.keyboard });
    }, (text) => send(ctx, text));
  });

  bot.command('mkdir', async (ctx) => {
    await guard(async () => {
      const raw = argText(ctx.message?.text);
      if (!raw) {
        await send(ctx, 'استفاده: <code>/mkdir نام پوشه</code> یا <code>/mkdir والد/فرزند</code>');
        return;
      }
      const root = await getRootFolder(app);
      const segments = raw.split('/').map((s) => safeFileName(s)).filter(Boolean);
      const created = await app.drive.files.ensurePath(root.id, segments);
      await app.repos.settings.set('defaultFolderPath', [root.name, ...segments].join('/'));
      await app.repos.audit.log({ actor: ctx.from!.id, action: 'folder.create', target: created.id });
      await send(ctx, successText('پوشه ساخته/پیدا شد', [`📁 مسیر: <code>${escapeHtml([root.name, ...segments].join('/'))}</code>`, `🆔 <code>${created.id}</code>`]));
    }, (text) => send(ctx, text));
  });

  bot.command('search', async (ctx) => {
    await guard(async () => {
      const q = argText(ctx.message?.text);
      if (!q) {
        await send(
          ctx,
          [
            `${ICONS.search} <b>جستجو</b>`,
            '',
            'استفاده: <code>/search عبارت</code>',
            '',
            'فیلترهای پیشرفته:',
            '<code>ext:pdf</code> · <code>type:image</code> · <code>size:&gt;10mb</code> · <code>after:2026-01-01</code>',
            'مثال: <code>/search invoice ext:pdf after:2026-01-01</code>',
          ].join('\n')
        );
        return;
      }
      await performSearch(ctx, env, q, 0);
    }, (text) => send(ctx, text));
  });

  bot.command('recent', async (ctx) => {
    await guard(async () => {
      const res = await app.drive.files.list({ pageSize: 10, orderBy: 'modifiedTime desc' });
      if (res.files.length === 0) {
        await send(ctx, `${ICONS.info} هیچ فایلی یافت نشد.`);
        return;
      }
      const refs = env.refs.putMany(res.files.map(toRef));
      await send(ctx, [`${ICONS.clock} <b>آخرین فایل‌ها</b>`, '', res.files.map((f, i) => fileLine(f, i)).join('\n')].join('\n'), {
        reply_markup: fileListKeyboard(res.files, refs, env.sign, { page: 0, back: 'recent' }),
      });
    }, (text) => send(ctx, text));
  });

  bot.command('storage', async (ctx) => {
    await guard(async () => {
      const caps = capabilitiesForScopes(await app.tokens.grantedScopes());
      const lines: string[] = [`${ICONS.drive} <b>مدیریت فضای ذخیره‌سازی</b>`, ''];
      if (caps.storageQuota) {
        const about = await app.drive.files.about();
        const limit = Number(about.storageQuota?.limit ?? 0);
        const usage = Number(about.storageQuota?.usage ?? 0);
        lines.push(`حساب: <b>${formatBytes(usage)}</b> از ${limit ? formatBytes(limit) : 'نامحدود'}`);
        if (limit && usage / limit > 0.9) lines.push(`${ICONS.warn} کمتر از ۱۰٪ فضا باقی مانده است!`);
        lines.push('');
      } else {
        lines.push('<i>برای مشاهده فضای حساب به دسترسی drive.readonly یا drive نیاز است.</i>', '');
      }

      const search = await app.drive.files.list({ pageSize: 40, orderBy: 'quotaBytesUsed desc' });
      const largest = search.files.slice(0, 5);
      lines.push('<b>بزرگ‌ترین فایل‌ها</b>');
      lines.push(largest.length ? largest.map((f) => `• <code>${escapeHtml(truncate(f.name, 40))}</code> — ${formatBytes(Number(f.size ?? 0))}`).join('\n') : '<i>—</i>');

      const old = await app.drive.files.list({ pageSize: 5, orderBy: 'modifiedTime asc' });
      lines.push('', '<b>قدیمی‌ترین فایل‌ها</b>');
      lines.push(old.files.map((f) => `• <code>${escapeHtml(truncate(f.name, 40))}</code> — ${fmtDate(f.modifiedTime ?? null)}`).join('\n') || '<i>—</i>');

      const dupes = await app.db.query<{ sha256: string; n: number; total: number }>(
        'SELECT sha256, COUNT(*) AS n, SUM(size) AS total FROM uploads WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 5'
      );
      lines.push('', '<b>تکراری‌ها (بر اساس هش)</b>');
      lines.push(dupes.length ? dupes.map((d) => `• <code>${d.sha256.slice(0, 12)}…</code> — ${d.n} نسخه، ${formatBytes(Number(d.total))}`).join('\n') : '<i>تکراری یافت نشد</i>');

      lines.push('', `<i>مجموع مدیریت‌شده توسط ربات: ${formatBytes(await app.repos.uploads.totalBytes())}</i>`);
      lines.push('<i>هیچ فایلی بدون تأیید شما حذف نمی‌شود.</i>');
      await send(ctx, lines.join('\n'), { reply_markup: backToMain(env.sign) });
    }, (text) => send(ctx, text));
  });

  bot.command('stats', async (ctx) => {
    await guard(async () => {
      const view = await statsView(env);
      await send(ctx, view.text, { reply_markup: view.keyboard });
    }, (text) => send(ctx, text));
  });

  bot.command('history', async (ctx) => {
    await guard(async () => {
      const view = await historyView(env);
      await send(ctx, view.text, { reply_markup: view.keyboard });
    }, (text) => send(ctx, text));
  });

  bot.command('queue', async (ctx) => {
    await guard(async () => {
      const view = await queueView(env);
      await send(ctx, view.text, { reply_markup: view.keyboard });
    }, (text) => send(ctx, text));
  });

  bot.command('settings', async (ctx) => {
    await guard(async () => {
      const view = await settingsView(env);
      await send(ctx, view.text, { reply_markup: view.keyboard });
    }, (text) => send(ctx, text));
  });

  bot.command('cancel', async (ctx) => {
    await guard(async () => {
      const active = await app.repos.jobs.activeForUser(ctx.from!.id);
      if (active.length === 0) {
        await send(ctx, `${ICONS.info} عملیات در حال اجرایی وجود ندارد.`);
        return;
      }
      let canceled = 0;
      for (const job of active) {
        if (await app.repos.jobs.requestCancel(job.id)) canceled++;
      }
      await send(ctx, successText(`${canceled} عملیات لغو شد`, ['عملیات در حال اجرا تا پایان chunk جاری متوقف می‌شود.']));
    }, (text) => send(ctx, text));
  });

  bot.command('organize', async (ctx) => {
    await guard(async () => {
      const raw = argText(ctx.message?.text).toLowerCase();
      const dryRun = raw !== 'run' && raw !== 'اجرا';
      const job = await app.repos.jobs.create({
        type: 'organize',
        priority: 50,
        payload: { chatId: ctx.chat!.id, userId: ctx.from!.id, dryRun },
        createdBy: ctx.from!.id,
      });
      await send(
        ctx,
        `${dryRun ? '🔍' : '🧹'} عملیات ${dryRun ? 'پیش‌نمایش' : 'مرتب‌سازی'} در صف قرار گرفت.\n🆔 <code>${job.id.slice(0, 8)}</code>\n\n${
          dryRun ? 'برای اجرای واقعی: <code>/organize run</code>' : 'نتیجه اعلام می‌شود.'
        }`
      );
    }, (text) => send(ctx, text));
  });

  bot.command('dupes', async (ctx) => {
    await guard(async () => {
      const rows = await app.db.query<{ sha256: string; name: string; n: number; total: number; ids: string }>(
        `SELECT sha256, MIN(name) AS name, COUNT(*) AS n, SUM(size) AS total, GROUP_CONCAT(drive_file_id) AS ids
         FROM uploads WHERE sha256 IS NOT NULL GROUP BY sha256 HAVING COUNT(*) > 1 ORDER BY total DESC LIMIT 10`
      );
      if (rows.length === 0) {
        await send(ctx, `${ICONS.ok} فایل تکراری پیدا نشد.`);
        return;
      }
      const lines = [`♻️ <b>فایل‌های تکراری</b>`, '', `بر اساس هش SHA-256 محاسبه شده است.`, ''];
      for (const row of rows) {
        lines.push(`• <code>${escapeHtml(truncate(row.name, 40))}</code>\n   ${row.n} نسخه · ${formatBytes(Number(row.total))} · <code>${String(row.sha256).slice(0, 10)}…</code>`);
      }
      lines.push('', '<i>حذف نسخه‌های اضافی فقط با تأیید شما و از طریق دکمه‌های فایل انجام می‌شود.</i>');
      await send(ctx, lines.join('\n'), { reply_markup: backToMain(env.sign) });
    }, (text) => send(ctx, text));
  });

  bot.command('backup', async (ctx) => {
    await guard(async () => {
      const job = await app.repos.jobs.create({
        type: 'backup',
        priority: 40,
        payload: { chatId: ctx.chat!.id, userId: ctx.from!.id },
        createdBy: ctx.from!.id,
      });
      await send(ctx, `💾 پشتیبان‌گیری در صف قرار گرفت (بدون توکن).\n🆔 <code>${job.id.slice(0, 8)}</code>`);
    }, (text) => send(ctx, text));
  });

  bot.command('cleanup', async (ctx) => {
    await guard(async () => {
      const job = await app.repos.jobs.create({
        type: 'cleanup',
        priority: 30,
        payload: { chatId: ctx.chat!.id, userId: ctx.from!.id },
        createdBy: ctx.from!.id,
      });
      await send(ctx, `🧹 پاک‌سازی فایل‌های موقت در صف قرار گرفت.\n🆔 <code>${job.id.slice(0, 8)}</code>`);
    }, (text) => send(ctx, text));
  });

  bot.command('delete', async (ctx) => {
    await guard(async () => {
      const arg = argText(ctx.message?.text);
      const file = await resolveFileArg(env, arg);
      if (!file) {
        await send(ctx, `${ICONS.err} فایلی با این نام/شناسه پیدا نشد.\nاستفاده: <code>/delete نام یا شناسه</code>`);
        return;
      }
      const ref = env.refs.put(toRef(file));
      await send(
        ctx,
        [
          `${ICONS.warn} <b>تأیید حذف</b>`,
          '',
          `📄 <code>${escapeHtml(file.name)}</code>`,
          `📦 ${formatBytes(Number(file.size ?? 0))}`,
          '',
          'فایل به سطل زباله Drive منتقل می‌شود (قابل بازیابی).',
        ].join('\n'),
        { reply_markup: confirmKeyboard(env.sign, 'trash', ref) }
      );
    }, (text) => send(ctx, text));
  });

  bot.command('rename', async (ctx) => {
    await guard(async () => {
      const raw = argText(ctx.message?.text);
      const [target, ...rest] = raw.split('|');
      const newName = rest.join('|').trim();
      if (!target || !newName) {
        await send(ctx, 'استفاده: <code>/rename نام فعلی | نام جدید</code>');
        return;
      }
      const file = await resolveFileArg(env, target.trim());
      if (!file) {
        await send(ctx, `${ICONS.err} فایل پیدا نشد.`);
        return;
      }
      const updated = await app.drive.files.rename(file.id, safeFileName(newName));
      await app.repos.audit.log({ actor: ctx.from!.id, action: 'file.rename', target: file.id, meta: { from: file.name, to: updated.name } });
      await send(ctx, successText('نام تغییر کرد', [`📄 <code>${escapeHtml(updated.name)}</code>`]));
    }, (text) => send(ctx, text));
  });

  bot.command('move', async (ctx) => {
    await guard(async () => {
      const arg = argText(ctx.message?.text);
      const file = await resolveFileArg(env, arg);
      if (!file) {
        await send(ctx, `${ICONS.err} فایل پیدا نشد.\nاستفاده: <code>/move نام فایل</code>`);
        return;
      }
      const ref = env.refs.put(toRef(file));
      const view = await foldersView(env);
      env.sessions.set(ctx.chat!.id, { kind: 'move', ref });
      await send(ctx, `${ICONS.folder} <b>مقصد را انتخاب کنید</b>\nفایل: <code>${escapeHtml(file.name)}</code>\n\n${view.text}`, {
        reply_markup: view.keyboard,
      });
    }, (text) => send(ctx, text));
  });

  bot.command('get', async (ctx) => {
    await guard(async () => {
      const arg = argText(ctx.message?.text);
      const file = await resolveFileArg(env, arg);
      if (!file) {
        await send(ctx, `${ICONS.err} فایل پیدا نشد.`);
        return;
      }
      const size = Number(file.size ?? 0);
      if (size > app.config.MAX_TELEGRAM_SEND_BYTES) {
        await send(
          ctx,
          `${ICONS.warn} حجم فایل ${formatBytes(size)} از سقف ارسال تلگرام (${formatBytes(
            app.config.MAX_TELEGRAM_SEND_BYTES
          )}) بیشتر است.\nاز دانلود مستقیم در Google Drive استفاده کنید.`
        );
        return;
      }
      await send(ctx, `⬇️ در حال دریافت <code>${escapeHtml(file.name)}</code>…`);
      const local = await app.temp.allocate('send', `-${safeFileName(file.name)}`);
      try {
        const res = await app.drive.download.toFile({ file, destPath: local, maxBytes: app.config.MAX_TELEGRAM_SEND_BYTES });
        await app.notifier.sendDocument?.(ctx.chat!.id, local, `${file.name} · ${formatBytes(res.bytes)}`);
        await app.repos.stats.recordDownload(res.bytes);
        await app.repos.audit.log({ actor: ctx.from!.id, action: 'file.download', target: file.id });
      } finally {
        await app.temp.cleanup(local);
      }
    }, (text) => send(ctx, text));
  });

  bot.command('extract', async (ctx) => {
    await guard(async () => {
      const arg = argText(ctx.message?.text);
      const file = await resolveFileArg(env, arg);
      if (!file) {
        await send(ctx, `${ICONS.err} فایل پیدا نشد.`);
        return;
      }
      const ref = env.refs.put(toRef(file));
      await send(
        ctx,
        [
          `${ICONS.warn} <b>استخراج آرشیو</b>`,
          '',
          `🗜 <code>${escapeHtml(file.name)}</code>`,
          '',
          'محتوای آرشیو بررسی و سپس هر فایل به Drive آپلود می‌شود.',
          'آرشیوهای حاوی مسیر مخرب، symlink یا Zip Bomb رد می‌شوند.',
        ].join('\n'),
        { reply_markup: confirmKeyboard(env.sign, 'extract', ref) }
      );
    }, (text) => send(ctx, text));
  });

  bot.command('zip', async (ctx) => {
    await guard(async () => {
      const basket = env.basket.get(ctx.chat!.id);
      if (!basket || basket.size === 0) {
        await send(
          ctx,
          [
            `🗜 <b>ساخت آرشیو</b>`,
            '',
            'ابتدا فایل‌ها را انتخاب کنید:',
            '• در «My Drive» روی فایل بزنید و «افزودن به آرشیو» را انتخاب کنید',
            '',
            `سپس دوباره /zip را بزنید. (سطل فعلی: ${basket?.size ?? 0} فایل)`,
          ].join('\n')
        );
        return;
      }
      const job = await app.repos.jobs.create({
        type: 'zip_create',
        priority: 60,
        payload: {
          chatId: ctx.chat!.id,
          userId: ctx.from!.id,
          fileIds: [...basket],
          archiveName: `jb-archive-${new Date().toISOString().slice(0, 10)}.zip`,
        },
        createdBy: ctx.from!.id,
      });
      env.basket.delete(ctx.chat!.id);
      await send(ctx, successText('ساخت آرشیو در صف قرار گرفت', [`🗜 ${basket.size} فایل`, `🆔 <code>${job.id.slice(0, 8)}</code>`]));
    }, (text) => send(ctx, text));
  });
}


function toRef(file: DriveFile) {
  return {
    fileId: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: Number(file.size ?? 0),
    ...(file.parents ? { parents: file.parents } : {}),
    ...(file.webViewLink ? { webViewLink: file.webViewLink } : {}),
  };
}

/** Shared by /search and the search button. */
export async function performSearch(
  ctx: { reply: (text: string, extra?: Record<string, unknown>) => Promise<unknown> },
  env: BotEnv,
  query: string,
  page: number
): Promise<void> {
  const key = `${ctx && 'chat' in ctx ? (ctx as { chat?: { id: number } }).chat?.id ?? 0 : 0}:${page}`;
  const cursor = env.pages.get(key);
  const result = await searchDrive(env.ctx, {
    query,
    pageSize: 10,
    ...(cursor && page > 0 ? { pageToken: cursor.token } : {}),
  });
  if (result.files.length === 0) {
    await ctx.reply(`${ICONS.search} نتیجه‌ای برای <code>${escapeHtml(query)}</code> پیدا نشد.`, { parse_mode: 'HTML' });
    return;
  }
  const refs = env.refs.putMany(result.files.map(toRef));
  if (result.nextPageToken) {
    const chatId = (ctx as { chat?: { id: number } }).chat?.id ?? 0;
    env.pages.set(`${chatId}:${page + 1}`, { token: result.nextPageToken, query });
  }
  const text = [
    `${ICONS.search} <b>نتایج جستجو</b> — صفحه ${page + 1}`,
    `🔎 <code>${escapeHtml(query)}</code>`,
    '',
    result.files.map((f, i) => fileLine(f, i)).join('\n'),
  ].join('\n');
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: fileListKeyboard(result.files, refs, env.sign, {
      page,
      ...(result.nextPageToken ? { token: result.nextPageToken } : {}),
      back: 'search',
    }),
  });
}

class InlineKeyboardBuilder extends InlineKeyboard {}
