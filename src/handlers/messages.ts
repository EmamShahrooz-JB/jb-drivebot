import type { Bot, Context } from 'grammy';
import type { BotEnv } from '../bot/bot.js';
import { ICONS, errorText, successText } from '../bot/format.js';
import { formatBytes } from '../utils/bytes.js';
import { escapeHtml, safeFileName } from '../security/sanitize.js';
import { errorMessage } from '../utils/errors.js';
import { findFirstUrl, resolveLink } from '../downloader/resolve.js';
import { performSearch } from '../commands/index.js';
import { mainView } from '../bot/views.js';
import { mainMenu } from '../keyboards/index.js';

const HTML = { parse_mode: 'HTML' as const };

interface IncomingFile {
  fileId: string;
  fileUniqueId?: string;
  name: string;
  size: number;
  mimeType?: string;
}

function extractFile(ctx: Context): IncomingFile | null {
  const m = ctx.message;
  if (!m) return null;
  if (m.document) {
    return {
      fileId: m.document.file_id,
      ...(m.document.file_unique_id ? { fileUniqueId: m.document.file_unique_id } : {}),
      name: safeFileName(m.document.file_name ?? `document-${m.document.file_id.slice(-6)}`),
      size: m.document.file_size ?? 0,
      ...(m.document.mime_type ? { mimeType: m.document.mime_type } : {}),
    };
  }
  if (m.video) {
    return {
      fileId: m.video.file_id,
      name: safeFileName(m.video.file_name ?? `video-${m.video.file_id.slice(-6)}.mp4`),
      size: m.video.file_size ?? 0,
      mimeType: m.video.mime_type ?? 'video/mp4',
    };
  }
  if (m.audio) {
    return {
      fileId: m.audio.file_id,
      name: safeFileName(m.audio.file_name ?? `audio-${m.audio.file_id.slice(-6)}.mp3`),
      size: m.audio.file_size ?? 0,
      mimeType: m.audio.mime_type ?? 'audio/mpeg',
    };
  }
  if (m.voice) {
    return {
      fileId: m.voice.file_id,
      name: `voice-${Date.now()}.ogg`,
      size: m.voice.file_size ?? 0,
      mimeType: m.voice.mime_type ?? 'audio/ogg',
    };
  }
  if (m.video_note) {
    return {
      fileId: m.video_note.file_id,
      name: `video-note-${Date.now()}.mp4`,
      size: m.video_note.file_size ?? 0,
      mimeType: 'video/mp4',
    };
  }
  if (m.animation) {
    return {
      fileId: m.animation.file_id,
      name: safeFileName(m.animation.file_name ?? `animation-${Date.now()}.mp4`),
      size: m.animation.file_size ?? 0,
      mimeType: m.animation.mime_type ?? 'video/mp4',
    };
  }
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    return {
      fileId: largest.file_id,
      name: `photo-${Date.now()}.jpg`,
      size: largest.file_size ?? 0,
      mimeType: 'image/jpeg',
    };
  }
  return null;
}

export function registerMessageHandlers(env: BotEnv, bot: Bot): void {
  const app = env.ctx;

  const enqueueFile = async (ctx: Context, file: IncomingFile): Promise<void> => {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    if (!(await app.tokens.hasConnection())) {
      await ctx.reply(`${ICONS.warn} ابتدا Google Drive را وصل کنید: /connect`);
      return;
    }
    if (file.size > app.config.MAX_TELEGRAM_DOWNLOAD_BYTES) {
      const hint =
        app.config.TELEGRAM_API_ROOT === 'https://api.telegram.org'
          ? [
              '',
              `${ICONS.info} <b>چرا؟</b> Bot API ابری تلگرام اجازه دریافت فایل بزرگ‌تر از ${formatBytes(
                app.config.MAX_TELEGRAM_DOWNLOAD_BYTES
              )} را به ربات نمی‌دهد.`,
              'راه‌حل‌ها:',
              '۱. لینک دانلود مستقیم فایل را بفرستید (بدون محدودیت Bot API)',
              '۲. Local Bot API Server را فعال کنید (TELEGRAM_API_ROOT) تا سقف ۲ گیگابایت شود',
            ].join('\n')
          : '';
      await ctx.reply(
        `${ICONS.err} حجم فایل <b>${formatBytes(file.size)}</b> از سقف دریافت (${formatBytes(
          app.config.MAX_TELEGRAM_DOWNLOAD_BYTES
        )}) بیشتر است.${hint}`,
        HTML
      );
      return;
    }
    const status = await app.notifier.send(
      chatId,
      `${ICONS.up} در صف آپلود قرار گرفت:\n📄 <code>${escapeHtml(file.name)}</code>\n📦 ${formatBytes(file.size)}`,
      { parseMode: 'HTML' }
    );
    const job = await app.repos.jobs.create({
      type: 'upload_telegram',
      priority: 100,
      payload: {
        chatId,
        userId: ctx.from?.id ?? 0,
        telegramFileId: file.fileId,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType ?? null,
        statusMessageId: status,
      },
      idempotencyKey: `tg:${file.fileUniqueId ?? file.fileId}`,
      createdBy: ctx.from?.id ?? null,
    });
    await app.repos.audit.log({ actor: ctx.from?.id ?? null, action: 'job.enqueue', target: job.id, meta: { type: 'upload_telegram', name: file.name } });
  };

  const enqueueLink = async (ctx: Context, url: string, sourceLabel: string): Promise<void> => {
    if (!ctx.chat) return;
    const chatId = ctx.chat.id;
    if (!(await app.tokens.hasConnection())) {
      await ctx.reply(`${ICONS.warn} ابتدا Google Drive را وصل کنید: /connect`);
      return;
    }
    const resolved = resolveLink(url);
    if (resolved.provider === 'unsupported') {
      await ctx.reply(`${ICONS.err} <b>این لینک پشتیبانی نمی‌شود</b>\n${escapeHtml(resolved.note ?? '')}`, HTML);
      return;
    }
    const status = await app.notifier.send(
      chatId,
      [
        `${ICONS.down} لینک دریافت شد (${sourceLabel})`,
        `<code>${escapeHtml(url.slice(0, 200))}</code>`,
        resolved.note ? `${ICONS.info} ${escapeHtml(resolved.note)}` : '',
        '',
        'در حال بررسی و دانلود…',
      ]
        .filter(Boolean)
        .join('\n'),
      { parseMode: 'HTML' }
    );
    const job = await app.repos.jobs.create({
      type: 'download_link',
      priority: 90,
      payload: { chatId, userId: ctx.from?.id ?? 0, url, statusMessageId: status },
      createdBy: ctx.from?.id ?? null,
    });
    await app.repos.audit.log({ actor: ctx.from?.id ?? null, action: 'job.enqueue', target: job.id, meta: { type: 'download_link' } });
  };

  // ---- any media message is an upload ----
  bot.on(['message:document', 'message:video', 'message:audio', 'message:voice', 'message:video_note', 'message:animation', 'message:photo'], async (ctx) => {
    const file = extractFile(ctx);
    if (!file) {
      await ctx.reply(`${ICONS.err} نتوانستم این نوع فایل را تشخیص دهم.`);
      return;
    }
    // a caption that contains a URL is still a link request when the file is tiny
    await enqueueFile(ctx, file);
  });

  // ---- text: commands handled elsewhere, here we deal with links and text flows ----
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return; // commands are handled by the command router

    const session = env.sessions.get(ctx.chat.id);

    // reply-to-link support: replying to a message with a link processes it
    const replyText = ctx.message.reply_to_message && 'text' in ctx.message.reply_to_message ? ctx.message.reply_to_message.text : undefined;
    const replyUrl = replyText ? findFirstUrl(replyText) : null;
    const ownUrl = findFirstUrl(text);

    if (!ownUrl && replyUrl) {
      env.sessions.clear(ctx.chat.id);
      await enqueueLink(ctx, replyUrl, 'از پیام Reply شده');
      return;
    }

    if (session) {
      try {
        switch (session.kind) {
          case 'rename': {
            const ref = env.refs.get(session.ref);
            if (!ref) throw new Error('این عملیات منقضی شده است');
            const newName = safeFileName(text);
            const updated = await app.drive.files.rename(ref.fileId, newName);
            env.sessions.clear(ctx.chat.id);
            await app.repos.audit.log({ actor: ctx.from.id, action: 'file.rename', target: ref.fileId, meta: { to: newName } });
            await ctx.reply(successText('نام تغییر کرد', [`📄 <code>${escapeHtml(updated.name)}</code>`]), HTML);
            return;
          }
          case 'mkdir': {
            const { ensurePath } = app.drive.files;
            const path = text.split('/').map((s) => safeFileName(s)).filter(Boolean);
            const created = await ensurePath(session.parentFolderId, path);
            env.sessions.clear(ctx.chat.id);
            await ctx.reply(
              successText('پوشه ساخته شد', [`📁 <code>${escapeHtml([session.parentPath, ...path].join('/'))}</code>`, `🆔 <code>${created.id}</code>`]),
              HTML
            );
            return;
          }
          case 'search': {
            env.sessions.clear(ctx.chat.id);
            await performSearch(
              { reply: (t, e) => ctx.reply(t, e as never) },
              env,
              text,
              0
            );
            return;
          }
          case 'move':
          case 'newFolderPath':
          case 'renameFolder':
            env.sessions.clear(ctx.chat.id);
            break;
        }
      } catch (err) {
        env.sessions.clear(ctx.chat.id);
        await ctx.reply(errorText(errorMessage(err)), HTML);
        return;
      }
    }

    if (ownUrl) {
      const resolved = resolveLink(ownUrl);
      if (resolved.provider !== 'unsupported') {
        await enqueueLink(ctx, ownUrl, `سرویس: ${resolved.provider}`);
        return;
      }
      await ctx.reply(
        `${ICONS.err} <b>لینک پشتیبانی نمی‌شود</b>\n${escapeHtml(resolved.note ?? '')}\n\n<i>برای دانلود ویدیو، yt-dlp باید روی سرور فعال باشد (ENABLE_YTDLP=true).</i>`,
        HTML
      );
      return;
    }

    const view = await mainView(env);
    await ctx.reply(view.text, { ...HTML, reply_markup: mainMenu(env.sign) });
  });

  bot.on('message', async (ctx) => {
    if (ctx.message.text) return;
    // stickers, contacts, locations, polls... politely ignore
    await ctx.reply(`${ICONS.info} برای آپلود، فایل یا لینک بفرستید. /help`);
  });

  bot.on('callback_query:data', async (ctx) => {
    const payload = env.verify(ctx.callbackQuery.data);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: '⛔️ این دکمه معتبر یا منقضی نیست', show_alert: true }).catch(() => undefined);
      return;
    }
    const { handleCallback } = await import('./callbacks.js');
    try {
      await handleCallback(env, ctx, payload);
    } catch (err) {
      await ctx.answerCallbackQuery({ text: truncateMsg(errorMessage(err)), show_alert: true }).catch(() => undefined);
      await app.repos.audit.log({ actor: ctx.from?.id ?? null, action: 'callback.error', meta: { payload, err: errorMessage(err) } });
    }
    await ctx.answerCallbackQuery().catch(() => undefined);
  });
}

function truncateMsg(msg: string): string {
  return msg.length > 180 ? `${msg.slice(0, 177)}…` : msg;
}
