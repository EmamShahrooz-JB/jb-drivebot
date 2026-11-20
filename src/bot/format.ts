import { formatBytes } from '../utils/bytes.js';
import { escapeHtml, truncate } from '../security/sanitize.js';
import type { DriveFile } from '../google-drive/types.js';
import type { JobRow } from '../database/types.js';

export const ICONS = {
  ok: '✅',
  warn: '⚠️',
  err: '❌',
  info: 'ℹ️',
  folder: '📁',
  file: '📄',
  drive: '☁️',
  up: '⬆️',
  down: '⬇️',
  link: '🔗',
  search: '🔍',
  lock: '🔒',
  unlock: '🔓',
  zip: '🗜',
  chart: '📊',
  gear: '⚙️',
  clock: '🕒',
  trash: '🗑',
  bot: '🤖',
};

export function fmtDate(ms: number | string | null | undefined): string {
  if (!ms) return '—';
  const date = typeof ms === 'number' ? new Date(ms) : new Date(ms);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function fileLine(file: DriveFile, index?: number): string {
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const icon = isFolder ? ICONS.folder : ICONS.file;
  const size = isFolder ? '' : ` · ${formatBytes(Number(file.size ?? 0))}`;
  const name = truncate(file.name, 55);
  return `${index !== undefined ? `${index + 1}. ` : ''}${icon} <code>${escapeHtml(name)}</code>${size}`;
}

export function jobStatusFa(status: string): string {
  const map: Record<string, string> = {
    queued: 'در صف',
    running: 'در حال اجرا',
    succeeded: 'موفق',
    failed: 'ناموفق',
    canceled: 'لغو شده',
  };
  return map[status] ?? status;
}

export function jobTypeFa(type: string): string {
  const map: Record<string, string> = {
    upload_telegram: 'آپلود از تلگرام',
    download_link: 'دانلود لینک',
    zip_create: 'ساخت آرشیو',
    zip_extract: 'استخراج آرشیو',
    organize: 'مرتب‌سازی',
    backup: 'پشتیبان‌گیری',
    cleanup: 'پاک‌سازی',
  };
  return map[type] ?? type;
}

export function jobLine(job: JobRow): string {
  const pct = job.status === 'succeeded' ? 100 : Math.round(Number(job.progress ?? 0));
  return `${jobStatusFa(job.status)} · ${jobTypeFa(job.type)} · ${pct}%`;
}

export function welcome(connected: boolean, email: string | null, mode: string): string {
  return [
    `${ICONS.bot} <b>JB-DriveBot</b>`,
    '<i>مدیریت حرفه‌ای Google Drive از تلگرام</i>',
    '',
    connected ? `${ICONS.ok} اتصال Drive: <b>فعال</b>${email ? ` (<code>${escapeHtml(email)}</code>)` : ''}` : `${ICONS.warn} اتصال Drive: <b>برقرار نیست</b> — /connect`,
    `🔐 سطح دسترسی تنظیم‌شده: <code>${escapeHtml(mode)}</code>`,
    '',
    'از منوی زیر یک گزینه انتخاب کنید:',
  ].join('\n');
}

export function errorText(message: string): string {
  return `${ICONS.err} <b>خطا</b>\n<code>${escapeHtml(truncate(message, 900))}</code>`;
}

export function successText(message: string, details?: string[]): string {
  return [`${ICONS.ok} <b>${escapeHtml(message)}</b>`, ...(details ?? [])].join('\n');
}
