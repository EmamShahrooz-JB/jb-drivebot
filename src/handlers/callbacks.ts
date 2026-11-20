import type { Context } from 'grammy';
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
import { fileActionsKeyboard, confirmKeyboard, mainMenu } from '../keyboards/index.js';
import { ICONS, errorText, fmtDate, successText } from '../bot/format.js';
import { formatBytes } from '../utils/bytes.js';
import { escapeHtml, safeFileName, truncate } from '../security/sanitize.js';
import { AppError, errorMessage } from '../utils/errors.js';
import { performSearch } from '../commands/index.js';
import { searchDrive } from '../services/search.js';
import { fileListKeyboard } from '../keyboards/index.js';
import { fileLine } from '../bot/format.js';

const HTML = { parse_mode: 'HTML' as const };

async function edit(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    await ctx.editMessageText(text, { ...HTML, link_preview_options: { is_disabled: true }, ...extra });
  } catch (err) {
    if (/message is not modified/i.test(errorMessage(err))) return;
    await ctx.reply(text, { ...HTML, link_preview_options: { is_disabled: true }, ...extra });
  }
}

async function answer(ctx: Context, text?: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery(text ? { text } : {}).catch(() => undefined);
}

export async function handleCallback(env: BotEnv, ctx: Context, payload: string): Promise<void> {
  const app = env.ctx;
  const [verb, a1, a2] = payload.split(':');
  const chatId = ctx.chat?.id ?? 0;
  const userId = ctx.from?.id ?? 0;

  const requireRef = (id: string | undefined) => {
    const ref = id ? env.refs.get(id) : null;
    if (!ref) throw new AppError('expired', 'این دکمه منقضی شده است؛ دوباره فایل را باز کنید.');
    return ref;
  };

  const notConnected = async (): Promise<boolean> => {
    if (await app.tokens.hasConnection()) return false;
    await edit(ctx, `${ICONS.warn} <b>Google Drive متصل نیست</b>\n\nابتدا /connect را اجرا کنید.`, {
      reply_markup: mainMenu(env.sign),
    });
    return true;
  };

  switch (verb) {
    // ------------------------------------------------ navigation
    case 'm': {
      switch (a1) {
        case 'main': {
          const view = await mainView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'refresh': {
          if (await notConnected()) return;
          const view = await mainView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          await answer(ctx, 'بروزرسانی شد');
          return;
        }
        case 'drive': {
          if (await notConnected()) return;
          const view = await driveView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'folders': {
          if (await notConnected()) return;
          const view = await foldersView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'stats': {
          if (await notConnected()) return;
          const view = await statsView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'settings': {
          const view = await settingsView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'queue': {
          const view = await queueView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'history': {
          const view = await historyView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'help': {
          const view = helpView(env);
          await edit(ctx, view.text, { reply_markup: view.keyboard });
          return;
        }
        case 'connect': {
          const view = await connectView(env);
          const account = await app.repos.accounts.get();
          if (account?.status === 'connected' && account.refresh_token_enc) {
            await edit(ctx, view.text, { reply_markup: view.keyboard });
            return;
          }
          if (!app.config.googleConfigured) {
            await edit(
              ctx,
              [
                `${ICONS.warn} <b>اعتبارنامه Google تنظیم نشده است</b>`,
                '',
                '<code>GOOGLE_CLIENT_ID</code> و <code>GOOGLE_CLIENT_SECRET</code> را در Altare → Environment Variables بگذارید (README گام ۲ و ۳).',
                'پس از دیپلوی مجدد، همین دکمه کار می‌کند.',
              ].join('\n'),
              { reply_markup: mainMenu(env.sign) }
            );
            return;
          }
          if (!env.pairing) {
            await edit(ctx, `${ICONS.err} سرویس جفت‌سازی فعال نیست.`, { reply_markup: mainMenu(env.sign) });
            return;
          }
          const { code, expiresAt } = await env.pairing.issuePairingCode(userId, 'server-exchange');
          const base = app.config.PUBLIC_BASE_URL ?? `http://127.0.0.1:${app.config.PORT}`;
          await edit(
            ctx,
            [
              `${ICONS.link} <b>کد اتصال یک‌بارمصرف</b>`,
              '',
              `<code>${code}</code>`,
              `⏱ اعتبار تا ${fmtDate(expiresAt)}`,
              '',
              '<b>روی کامپیوتر خود اجرا کنید:</b>',
              `<pre>npx tsx auth-local/src/cli.ts --server ${escapeHtml(base)} --code ${code}</pre>`,
              '<i>مرورگر باز می‌شود؛ حساب Google را انتخاب و تأیید کنید.</i>',
            ].join('\n'),
            { reply_markup: mainMenu(env.sign) }
          );
          return;
        }
        case 'upload': {
          await edit(
            ctx,
            [
              `${ICONS.up} <b>آپلود فایل</b>`,
              '',
              'فایل را همین‌جا برای ربات بفرستید (Document یا به‌صورت فایل).',
              '',
              `📏 سقف فعلی دریافت: <b>${formatBytes(app.config.MAX_TELEGRAM_DOWNLOAD_BYTES)}</b>`,
              `📁 مقصد: ${app.config.DEFAULT_DRIVE_FOLDER_NAME} (با دسته‌بندی خودکار)`,
              '',
              '<i>برای فایل‌های بزرگ‌تر، لینک دانلود مستقیم بفرستید یا Local Bot API Server را فعال کنید.</i>',
            ].join('\n'),
            { reply_markup: mainMenu(env.sign) }
          );
          return;
        }
        case 'link': {
          await edit(
            ctx,
            [
              `${ICONS.down} <b>دانلود از لینک</b>`,
              '',
              'یک لینک بفرستید. پشتیبانی می‌شود از:',
              '• لینک مستقیم HTTP/HTTPS',
              '• Google Drive (فایل عمومی)',
              '• Dropbox · OneDrive · GitHub Releases',
              '',
              `<i>سقف حجم: ${formatBytes(app.config.MAX_LINK_DOWNLOAD_BYTES)}</i>`,
              '<i>آدرس‌های داخلی، خصوصی و متادیتای ابری مسدود هستند (ضد SSRF).</i>',
            ].join('\n'),
            { reply_markup: mainMenu(env.sign) }
          );
          return;
        }
        case 'search': {
          env.sessions.set(chatId, { kind: 'search' });
          await edit(
            ctx,
            [
              `${ICONS.search} <b>جستجو</b>`,
              '',
              'عبارت جستجو را بفرستید. فیلترها:',
              '<code>ext:pdf</code> · <code>type:image</code> · <code>size:&gt;10mb</code> · <code>after:2026-01-01</code>',
            ].join('\n'),
            { reply_markup: mainMenu(env.sign) }
          );
          return;
        }
        default:
          await answer(ctx, 'گزینه ناشناخته');
          return;
      }
    }

    // ------------------------------------------------ file level
    case 'i': {
      const ref = requireRef(a1);
      if (ref.mimeType === 'application/vnd.google-apps.folder') {
        const view = await driveView(env, ref.fileId);
        await edit(ctx, view.text, { reply_markup: view.keyboard });
        return;
      }
      const file = await app.drive.files.get(ref.fileId);
      const sharing = await app.drive.permissions.isPublic(ref.fileId).catch(() => null);
      const lines = [
        `ℹ️ <b>اطلاعات فایل</b>`,
        '',
        `📄 نام: <code>${escapeHtml(file.name)}</code>`,
        `🧩 MIME: <code>${escapeHtml(file.mimeType)}</code>`,
        `📦 حجم: ${formatBytes(Number(file.size ?? 0))}`,
        `🆔 Drive ID: <code>${escapeHtml(file.id)}</code>`,
        `📅 ایجاد: ${fmtDate(file.createdTime ?? null)}`,
        `🕒 ویرایش: ${fmtDate(file.modifiedTime ?? null)}`,
        file.md5Checksum ? `🔑 MD5: <code>${escapeHtml(file.md5Checksum)}</code>` : '',
        sharing ? `🔓 اشتراک عمومی: ${sharing.isPublic ? '<b>فعال</b>' : 'غیرفعال (خصوصی)'}` : '',
        file.webViewLink ? `🔗 <a href="${escapeHtml(file.webViewLink)}">باز کردن در Drive</a>` : '',
      ].filter(Boolean);
      await edit(ctx, lines.join('\n'), { reply_markup: fileActionsKeyboard(a1!, file, env.sign) });
      return;
    }

    case 'o': {
      const ref = requireRef(a1);
      if (ref.mimeType === 'application/vnd.google-apps.folder') {
        const session = env.sessions.get(chatId);
        if (session?.kind === 'move') {
          // choosing a destination folder for a pending move
          const fileRef = requireRef(session.ref);
          await app.drive.files.move(fileRef.fileId, ref.fileId);
          env.sessions.clear(chatId);
          await app.repos.audit.log({ actor: userId, action: 'file.move', target: fileRef.fileId, meta: { to: ref.fileId } });
          await edit(ctx, successText('فایل منتقل شد', [`📄 <code>${escapeHtml(fileRef.name)}</code>`, `📁 <code>${escapeHtml(ref.name)}</code>`]), {
            reply_markup: mainMenu(env.sign),
          });
          return;
        }
        const view = await foldersView(env, ref.fileId);
        await edit(ctx, view.text, { reply_markup: view.keyboard });
        return;
      }
      await answer(ctx, 'این مورد پوشه نیست');
      return;
    }

    case 'sel': {
      const ref = requireRef(a1);
      const session = env.sessions.get(chatId);
      if (session?.kind === 'move') {
        const fileRef = requireRef(session.ref);
        await app.drive.files.move(fileRef.fileId, ref.fileId);
        env.sessions.clear(chatId);
        await app.repos.audit.log({ actor: userId, action: 'file.move', target: fileRef.fileId, meta: { to: ref.fileId } });
        await edit(ctx, successText('فایل منتقل شد', [`📄 <code>${escapeHtml(fileRef.name)}</code>`, `📁 <code>${escapeHtml(ref.name)}</code>`]), {
          reply_markup: mainMenu(env.sign),
        });
        return;
      }
      await app.repos.settings.set('defaultFolderId', ref.fileId);
      await app.repos.settings.set('defaultFolderPath', ref.name);
      await edit(ctx, successText('پوشه پیش‌فرض ذخیره شد', [`📁 <code>${escapeHtml(ref.name)}</code>`]), {
        reply_markup: mainMenu(env.sign),
      });
      return;
    }

    case 'lk': {
      const ref = requireRef(a1);
      const link = await app.drive.permissions.getLink(ref.fileId);
      await edit(
        ctx,
        [
          `${ICONS.link} <b>لینک فایل</b>`,
          '',
          `<code>${escapeHtml(link.webViewLink ?? '')}</code>`,
          '',
          '<i>وضعیت پیش‌فرض خصوصی است. برای اشتراک عمومی از دکمه «وضعیت اشتراک» استفاده کنید.</i>',
        ].join('\n'),
        { reply_markup: mainMenu(env.sign) }
      );
      return;
    }

    case 'sh': {
      const ref = requireRef(a1);
      const { isPublic, permissions } = await app.drive.permissions.isPublic(ref.fileId);
      const kb = new (await import('grammy')).InlineKeyboard();
      if (isPublic) kb.text('🔒 لغو دسترسی عمومی', env.sign(`y:revoke:${a1}`)).row();
      else kb.text('🔓 ساخت لینک عمومی', env.sign(`y:public:${a1}`)).row();
      kb.text('« بازگشت', env.sign('m:drive'));
      await edit(
        ctx,
        [
          `🔐 <b>وضعیت اشتراک</b>`,
          '',
          `📄 <code>${escapeHtml(ref.name)}</code>`,
          `وضعیت: ${isPublic ? '<b>عمومی (هر کسی با لینک)</b>' : 'خصوصی'}`,
          `تعداد دسترسی‌های تعریف‌شده: ${permissions.length}`,
          '',
          '<i>عمومی‌کردن نیاز به تأیید صریح شما دارد و در گزارش فعالیت ثبت می‌شود.</i>',
        ].join('\n'),
        { reply_markup: kb }
      );
      return;
    }

    case 'snd': {
      const ref = requireRef(a1);
      const size = ref.size;
      if (size > app.config.MAX_TELEGRAM_SEND_BYTES) {
        await answer(ctx, `حجم ${formatBytes(size)} بیش از سقف ارسال تلگرام است`);
        return;
      }
      await edit(ctx, `⬇️ در حال دریافت <code>${escapeHtml(ref.name)}</code> از Google Drive…`);
      const local = await app.temp.allocate('send', `-${safeFileName(ref.name)}`);
      try {
        const file = await app.drive.files.get(ref.fileId);
        const res = await app.drive.download.toFile({ file, destPath: local, maxBytes: app.config.MAX_TELEGRAM_SEND_BYTES });
        await app.notifier.sendDocument?.(chatId, local, `${file.name} · ${formatBytes(res.bytes)}`);
        await app.repos.stats.recordDownload(res.bytes);
        await app.repos.audit.log({ actor: userId, action: 'file.download', target: file.id });
        await edit(ctx, `${ICONS.ok} فایل ارسال شد.`, { reply_markup: mainMenu(env.sign) });
      } finally {
        await app.temp.cleanup(local);
      }
      return;
    }

    case 'mv': {
      const ref = requireRef(a1);
      env.sessions.set(chatId, { kind: 'move', ref: a1! });
      const view = await foldersView(env);
      await edit(ctx, `${ICONS.folder} <b>مقصد را انتخاب کنید</b>\n📄 <code>${escapeHtml(ref.name)}</code>\n\n${view.text}`, {
        reply_markup: view.keyboard,
      });
      return;
    }

    case 'rn': {
      const ref = requireRef(a1);
      env.sessions.set(chatId, { kind: 'rename', ref: a1! });
      await edit(
        ctx,
        [`✏️ <b>تغییر نام</b>`, '', `نام فعلی: <code>${escapeHtml(ref.name)}</code>`, '', 'نام جدید را بفرستید:'].join('\n'),
        { reply_markup: mainMenu(env.sign) }
      );
      return;
    }

    case 'd': {
      const ref = requireRef(a1);
      const settings = await app.repos.settings.all();
      if (!settings.confirmDangerous) {
        await app.drive.files.trash(ref.fileId);
        await edit(ctx, successText('به سطل زباله منتقل شد', [`📄 <code>${escapeHtml(ref.name)}</code>`]), { reply_markup: mainMenu(env.sign) });
        return;
      }
      await edit(
        ctx,
        [
          `${ICONS.warn} <b>تأیید حذف</b>`,
          '',
          `📄 <code>${escapeHtml(ref.name)}</code>`,
          `📦 ${formatBytes(ref.size)}`,
          '',
          'فایل به سطل زباله Drive منتقل می‌شود (قابل بازیابی از Drive).',
        ].join('\n'),
        { reply_markup: confirmKeyboard(env.sign, 'trash', a1!) }
      );
      return;
    }

    case 'z': {
      const ref = requireRef(a1);
      const basket = env.basket.get(chatId) ?? new Set<string>();
      basket.add(ref.fileId);
      env.basket.set(chatId, basket);
      await answer(ctx, `به آرشیو اضافه شد (${basket.size} فایل)`);
      const file = await app.drive.files.get(ref.fileId).catch(() => null);
      if (file) {
        await edit(ctx, `🗜 <code>${escapeHtml(file.name)}</code> به سطل آرشیو اضافه شد.\nتعداد: ${basket.size}\n\nبرای ساخت آرشیو /zip را بزنید.`, {
          reply_markup: fileActionsKeyboard(a1!, file, env.sign),
        });
      }
      return;
    }

    // ------------------------------------------------ confirmations
    case 'y': {
      const action = a1;
      const refId = a2;
      switch (action) {
        case 'trash': {
          const ref = requireRef(refId);
          await app.drive.files.trash(ref.fileId);
          await app.repos.audit.log({ actor: userId, action: 'file.trash', target: ref.fileId, meta: { name: ref.name } });
          await edit(ctx, successText('به سطل زباله منتقل شد', [`📄 <code>${escapeHtml(ref.name)}</code>`]), { reply_markup: mainMenu(env.sign) });
          return;
        }
        case 'delete': {
          const ref = requireRef(refId);
          await app.drive.files.deleteForever(ref.fileId);
          await app.repos.audit.log({ actor: userId, action: 'file.delete', target: ref.fileId, meta: { name: ref.name } });
          await edit(ctx, successText('برای همیشه حذف شد', [`📄 <code>${escapeHtml(ref.name)}</code>`]), { reply_markup: mainMenu(env.sign) });
          return;
        }
        case 'public': {
          const ref = requireRef(refId);
          await app.drive.permissions.makeAnyoneReader(ref.fileId);
          const link = await app.drive.permissions.getLink(ref.fileId).catch(() => ({ webViewLink: undefined }));
          await app.repos.audit.log({ actor: userId, action: 'file.public', target: ref.fileId });
          await edit(
            ctx,
            [successText('لینک عمومی ساخته شد', [`📄 <code>${escapeHtml(ref.name)}</code>`]), link.webViewLink ? `<code>${escapeHtml(link.webViewLink)}</code>` : ''].join('\n'),
            { reply_markup: mainMenu(env.sign) }
          );
          return;
        }
        case 'revoke': {
          const ref = requireRef(refId);
          const removed = await app.drive.permissions.revokePublic(ref.fileId);
          await app.repos.audit.log({ actor: userId, action: 'file.revoke_public', target: ref.fileId, meta: { removed } });
          await edit(ctx, successText('دسترسی عمومی لغو شد', [`${removed} دسترسی حذف شد`]), { reply_markup: mainMenu(env.sign) });
          return;
        }
        case 'extract': {
          const ref = requireRef(refId);
          const job = await app.repos.jobs.create({
            type: 'zip_extract',
            priority: 70,
            payload: { chatId, userId, fileId: ref.fileId },
            createdBy: userId,
          });
          await app.repos.audit.log({ actor: userId, action: 'archive.extract', target: ref.fileId });
          await edit(ctx, successText('استخراج در صف قرار گرفت', [`🗜 <code>${escapeHtml(ref.name)}</code>`, `🆔 <code>${job.id.slice(0, 8)}</code>`]), {
            reply_markup: mainMenu(env.sign),
          });
          return;
        }
        case 'disconnect': {
          await app.tokens.disconnect(true);
          await app.repos.audit.log({ actor: userId, action: 'oauth.disconnect' });
          await edit(ctx, successText('اتصال Google قطع شد', ['توکن روی سرور حذف و در گوگل باطل شد.', 'فایل‌های Drive شما دست‌نخورده باقی ماندند.']), {
            reply_markup: mainMenu(env.sign),
          });
          return;
        }
        default:
          await answer(ctx, 'عملیات ناشناخته');
          return;
      }
    }

    // ------------------------------------------------ settings
    case 't': {
      const settings = await app.repos.settings.all();
      switch (a1) {
        case 'autoOrganize':
          await app.repos.settings.set('autoOrganize', !settings.autoOrganize);
          break;
        case 'smartRename':
          await app.repos.settings.set('smartRename', !settings.smartRename);
          break;
        case 'confirmDangerous':
          await app.repos.settings.set('confirmDangerous', !settings.confirmDangerous);
          break;
        case 'progressUpdates':
          await app.repos.settings.set('progressUpdates', !settings.progressUpdates);
          break;
        case 'organizeMode': {
          const order = ['type-date', 'type', 'extension', 'date', 'none'] as const;
          const next = order[(order.indexOf(settings.organizeMode as never) + 1) % order.length]!;
          await app.repos.settings.set('organizeMode', next);
          break;
        }
        case 'shareDefault': {
          const next = settings.shareDefault === 'private' ? 'link' : 'private';
          await app.repos.settings.set('shareDefault', next);
          break;
        }
        default:
          await answer(ctx, 'تنظیم ناشناخته');
          return;
      }
      const view = await settingsView(env);
      await edit(ctx, view.text, { reply_markup: view.keyboard });
      return;
    }

    // ------------------------------------------------ queue
    case 'q': {
      const ref = requireRef(a1);
      const ok = await app.repos.jobs.requestCancel(ref.fileId);
      await answer(ctx, ok ? 'درخواست لغو ثبت شد' : 'قابل لغو نیست');
      const view = await queueView(env);
      await edit(ctx, view.text, { reply_markup: view.keyboard });
      return;
    }

    // ------------------------------------------------ pagination
    case 'n':
    case 'p': {
      const page = Number(a1 ?? '0');
      const kind = a2 ?? 'search';
      if (kind === 'search') {
        const cursor = env.pages.get(`${chatId}:${page}`);
        if (!cursor) {
          await answer(ctx, 'این صفحه منقضی شده است');
          return;
        }
        const result = await searchDrive(app, { query: cursor.query, pageSize: 10, pageToken: cursor.token });
        if (result.nextPageToken) env.pages.set(`${chatId}:${page + 1}`, { token: result.nextPageToken, query: cursor.query });
        const refs = env.refs.putMany(
          result.files.map((f) => ({
            fileId: f.id,
            name: f.name,
            mimeType: f.mimeType,
            size: Number(f.size ?? 0),
            ...(f.parents ? { parents: f.parents } : {}),
            ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
          }))
        );
        await edit(
          ctx,
          [
            `${ICONS.search} <b>نتایج جستجو</b> — صفحه ${page + 1}`,
            `🔎 <code>${escapeHtml(cursor.query)}</code>`,
            '',
            result.files.map((f, i) => fileLine(f, i)).join('\n'),
          ].join('\n'),
          {
            reply_markup: fileListKeyboard(result.files, refs, env.sign, {
              page,
              ...(result.nextPageToken ? { token: result.nextPageToken } : {}),
              back: 'search',
            }),
          }
        );
        return;
      }
      await answer(ctx, 'پشتیبانی نمی‌شود');
      return;
    }

    default:
      await answer(ctx, 'دکمه ناشناخته');
      return;
  }
}

export { edit as editMessage, answer as answerCallback, HTML as HTML_PARSE_MODE, truncate };
