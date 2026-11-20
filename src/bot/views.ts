import type { BotEnv } from './bot.js';
import type { InlineKeyboard } from 'grammy';
import { mainMenu, backToMain, fileListKeyboard, folderBrowserKeyboard, settingsKeyboard, queueKeyboard, helpKeyboard } from '../keyboards/index.js';
import { welcome, ICONS, fmtDate, fileLine, jobLine, jobTypeFa } from './format.js';
import { formatBytes } from '../utils/bytes.js';
import { escapeHtml, truncate } from '../security/sanitize.js';
import { capabilitiesForScopes } from '../oauth/scopes.js';
import { getRootFolder } from '../services/folders.js';
import type { DriveFile } from '../google-drive/types.js';

export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

export async function mainView(env: BotEnv): Promise<View> {
  const { ctx } = env;
  const account = await ctx.repos.accounts.get();
  const connected = Boolean(account && account.status === 'connected' && account.refresh_token_enc);
  return {
    text: welcome(connected, account?.email ?? null, ctx.config.GOOGLE_SCOPES_MODE),
    keyboard: mainMenu(env.sign),
  };
}

export async function driveView(env: BotEnv, folderId?: string): Promise<View> {
  const { ctx } = env;
  const root = await getRootFolder(ctx);
  const targetId = folderId ?? root.id;
  const [folder, listing] = await Promise.all([
    targetId === root.id ? Promise.resolve(root) : ctx.drive.files.get(targetId, 'id,name,mimeType,parents'),
    ctx.drive.files.list({
      q: `'${targetId.replace(/'/g, "\\'")}' in parents and trashed = false`,
      pageSize: 25,
      orderBy: 'folder,name_natural',
    }),
  ]);

  const files = listing.files;
  const refs = env.refs.putMany(
    files.map((f: DriveFile) => ({
      fileId: f.id,
      name: f.name,
      mimeType: f.mimeType,
      size: Number(f.size ?? 0),
      ...(f.parents ? { parents: f.parents } : {}),
      ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
    }))
  );

  const folders = files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
  const totalBytes = files.reduce((sum, f) => sum + Number(f.size ?? 0), 0);
  const lines = [
    `${ICONS.drive} <b>${escapeHtml(folder.name)}</b>`,
    `<i>${files.length} آیتم · ${formatBytes(totalBytes)}${folders.length ? ` · ${folders.length} پوشه` : ''}</i>`,
    '',
    files.length === 0 ? '<i>این پوشه خالی است.</i>' : files.slice(0, 12).map((f, i) => fileLine(f, i)).join('\n'),
  ];
  return { text: lines.join('\n'), keyboard: fileListKeyboard(files, refs, env.sign, { page: 0, back: 'drive' }) };
}

export async function foldersView(env: BotEnv, folderId?: string): Promise<View> {
  const { ctx } = env;
  const root = await getRootFolder(ctx);
  const targetId = folderId ?? root.id;
  const folder = targetId === root.id ? root : await ctx.drive.files.get(targetId, 'id,name,mimeType,parents');
  const listing = await ctx.drive.files.listFolders(targetId);
  const refs = listing.files.map((f) =>
    env.refs.put({ fileId: f.id, name: f.name, mimeType: f.mimeType, size: 0, ...(f.parents ? { parents: f.parents } : {}) })
  );
  const parentRef =
    targetId !== root.id && folder.parents?.[0]
      ? env.refs.put({ fileId: folder.parents[0], name: 'parent', mimeType: 'application/vnd.google-apps.folder', size: 0 })
      : null;
  const selfRef = env.refs.put({ fileId: targetId, name: folder.name, mimeType: folder.mimeType, size: 0 });

  return {
    text: [
      `${ICONS.folder} <b>پوشه‌ها</b>`,
      `📍 مسیر فعلی: <code>${escapeHtml(folder.name)}</code>`,
      '',
      listing.files.length === 0 ? '<i>پوشه‌ای در این سطح وجود ندارد.</i>' : listing.files.map((f, i) => fileLine(f, i)).join('\n'),
      '',
      '<i>یک پوشه را باز کنید یا همین پوشه را به‌عنوان مقصد انتخاب کنید.</i>',
    ].join('\n'),
    keyboard: folderBrowserKeyboard(listing.files, refs, env.sign, parentRef, selfRef),
  };
}

export async function statsView(env: BotEnv): Promise<View> {
  const { ctx } = env;
  const [today, month, totals, uploadCount, managedBytes, account, jobCounts, caps] = await Promise.all([
    ctx.repos.stats.getDay(),
    ctx.repos.stats.monthBytes(),
    ctx.repos.stats.totals(),
    ctx.repos.uploads.totalCount(),
    ctx.repos.uploads.totalBytes(),
    ctx.repos.accounts.get(),
    ctx.repos.jobs.counts(),
    ctx.tokens.grantedScopes().then(capabilitiesForScopes),
  ]);

  const scopes = await ctx.tokens.grantedScopes();
  let quotaLine = '<i>دسترسی کافی برای خواندن فضای حساب وجود ندارد (نیازمند drive.readonly یا drive)</i>';
  if (caps.storageQuota) {
    try {
      const about = await ctx.drive.files.about();
      const limit = about.storageQuota?.limit ? Number(about.storageQuota.limit) : null;
      const usage = about.storageQuota?.usage ? Number(about.storageQuota.usage) : null;
      if (usage !== null) {
        const pct = limit ? ((usage / limit) * 100).toFixed(1) : '—';
        quotaLine = `مصرف حساب: <b>${formatBytes(usage)}</b> از ${limit ? formatBytes(limit) : 'نامحدود'} (${pct}%)`;
      }
    } catch {
      quotaLine = '<i>Google API فضای حساب را برنگرداند.</i>';
    }
  }

  return {
    text: [
      `${ICONS.chart} <b>آمار و فضای ذخیره‌سازی</b>`,
      '',
      '<b>Google Drive</b>',
      quotaLine,
      '',
      '<b>مدیریت‌شده توسط ربات</b>',
      `📄 تعداد فایل ثبت‌شده: <b>${uploadCount}</b>`,
      `📦 مجموع حجم: <b>${formatBytes(managedBytes)}</b>`,
      `📅 امروز: ${today.uploads} آپلود · ${formatBytes(today.bytes_uploaded)} · ${today.downloads} دانلود`,
      `🗓 این ماه: ${formatBytes(month)}`,
      '',
      '<b>عملیات</b>',
      `✅ موفق: ${totals.successes} · ❌ ناموفق: ${totals.failures}`,
      `⏳ صف: ${jobCounts.queued} · ▶️ در حال اجرا: ${jobCounts.running}`,
      '',
      `<i>تفاوت: «مصرف حساب» کل فایل‌های Drive است؛ «مدیریت‌شده» فقط فایل‌هایی است که این ربات آپلود کرده.</i>`,
      `<i>حساب: ${escapeHtml(account?.email ?? '—')} · scope: ${scopes.length}</i>`,
    ].join('\n'),
    keyboard: backToMain(env.sign),
  };
}

export async function settingsView(env: BotEnv): Promise<View> {
  const s = await env.ctx.repos.settings.all();
  return {
    text: [
      `${ICONS.gear} <b>تنظیمات</b>`,
      '',
      'روی هر گزینه بزنید تا تغییر کند. تغییرات فوراً ذخیره می‌شوند.',
      '',
      `📁 پوشه پیش‌فرض: <code>${escapeHtml(s.defaultFolderPath)}</code>`,
      `🧭 حالت پوشه‌بندی: <code>${s.organizeMode}</code>`,
    ].join('\n'),
    keyboard: settingsKeyboard(env.sign, s),
  };
}

export async function queueView(env: BotEnv): Promise<View> {
  const jobs = await env.ctx.repos.jobs.list({ limit: 10 });
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const lines = jobs.length === 0 ? ['<i>هیچ عملیاتی ثبت نشده است.</i>'] : jobs.map((j) => `${jobLine(j)}${j.last_error ? `\n   <i>${escapeHtml(truncate(j.last_error, 80))}</i>` : ''}`);
  const refs = active.map((j) => env.refs.put({ fileId: j.id, name: jobTypeFa(j.type), mimeType: 'job', size: 0 }));
  return {
    text: [`${ICONS.clock} <b>صف عملیات</b>`, '', ...lines, '', '<i>برای لغو یک عملیات روی آن بزنید.</i>'].join('\n'),
    keyboard: queueKeyboard(
      env.sign,
      active.map((j, i) => ({ ref: refs[i]!, label: `${jobTypeFa(j.type)} · ${j.progress}%` }))
    ),
  };
}

export async function historyView(env: BotEnv): Promise<View> {
  const rows = await env.ctx.repos.uploads.recent(12);
  return {
    text: [
      `${ICONS.clock} <b>تاریخچه آپلود</b>`,
      '',
      rows.length === 0
        ? '<i>هنوز فایلی آپلود نشده است.</i>'
        : rows
            .map(
              (r) =>
                `• <code>${escapeHtml(truncate(r.name, 40))}</code>\n   ${formatBytes(r.size)} · ${fmtDate(r.uploaded_at)} · ${r.source}`
            )
            .join('\n'),
    ].join('\n'),
    keyboard: backToMain(env.sign),
  };
}

export function helpView(env: BotEnv): View {
  return {
    text: [
      `${ICONS.info} <b>راهنما</b>`,
      '',
      '<b>دستورات</b>',
      '/start — منوی اصلی',
      '/connect — اتصال Google Drive',
      '/status — وضعیت اتصال و صف',
      '/folders — مدیریت پوشه‌ها',
      '/mkdir نام — ساخت پوشه',
      '/search چیزی — جستجو',
      '/recent — آخرین فایل‌ها',
      '/storage — وضعیت فضا',
      '/stats — آمار',
      '/history — تاریخچه آپلود',
      '/queue — صف عملیات',
      '/cancel — لغو عملیات جاری',
      '/settings — تنظیمات',
      '/organize — مرتب‌سازی خودکار',
      '/dupes — فایل‌های تکراری',
      '/backup — پشتیبان‌گیری',
      '/cleanup — پاک‌سازی فایل‌های موقت',
      '/disconnect — قطع اتصال Google',
      '',
      '<b>روش‌های آپلود</b>',
      '۱. فایل را مستقیم برای ربات بفرستید',
      '۲. یک لینک بفرستید (مستقیم، Drive، Dropbox، OneDrive، GitHub)',
      '۳. روی پیامی که لینک دارد Reply کنید',
      '',
      `<b>محدودیت‌ها</b>`,
      `• دریافت فایل از تلگرام: تا ${formatBytes(env.ctx.config.MAX_TELEGRAM_DOWNLOAD_BYTES)}`,
      `• ارسال فایل به تلگرام: تا ${formatBytes(env.ctx.config.MAX_TELEGRAM_SEND_BYTES)}`,
      '• برای فایل‌های بزرگ‌تر، Local Bot API Server را در .env فعال کنید.',
    ].join('\n'),
    keyboard: helpKeyboard(env.sign),
  };
}

export async function connectView(env: BotEnv): Promise<View> {
  const account = await env.ctx.repos.accounts.get();
  const connected = Boolean(account?.status === 'connected' && account.refresh_token_enc);
  return {
    text: [
      `${ICONS.link} <b>اتصال حساب Google</b>`,
      '',
      connected
        ? `${ICONS.ok} متصل به <code>${escapeHtml(account?.email ?? '—')}</code>\n📅 زمان اتصال: ${fmtDate(account?.connected_at ?? null)}`
        : `${ICONS.warn} هیچ حسابی متصل نیست.`,
      '',
      '<b>مراحل اتصال</b>',
      '۱. روی «دریافت کد اتصال» بزنید',
      '۲. ابزار JB-Drive Authenticator را روی کامپیوتر خود اجرا کنید',
      '۳. دستور نمایش‌داده‌شده را کپی کنید',
      '۴. در مرورگر حساب Google را تأیید کنید',
      '',
      `<i>سرویس: <code>${escapeHtml(env.ctx.config.PUBLIC_BASE_URL ?? 'http://127.0.0.1:' + env.ctx.config.PORT)}</code></i>`,
    ].join('\n'),
    keyboard: (() => {
      const kb = mainMenu(env.sign);
      return kb;
    })(),
  };
}
