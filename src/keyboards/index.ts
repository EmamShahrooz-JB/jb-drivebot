import { InlineKeyboard } from 'grammy';
import type { DriveFile } from '../google-drive/types.js';
import { truncate } from '../security/sanitize.js';

export type Signed = (payload: string) => string;

const isFolder = (f: DriveFile) => f.mimeType === 'application/vnd.google-apps.folder';

export function mainMenu(sign: Signed): InlineKeyboard {
  return new InlineKeyboard()
    .text('⬆️ آپلود فایل', sign('m:upload')).text('⬇️ دانلود از لینک', sign('m:link')).row()
    .text('☁️ My Drive', sign('m:drive')).text('📁 پوشه‌ها', sign('m:folders')).row()
    .text('🔍 جستجو', sign('m:search')).text('🕒 تاریخچه آپلود', sign('m:history')).row()
    .text('📊 آمار و فضا', sign('m:stats')).text('⚙️ تنظیمات', sign('m:settings')).row()
    .text('🔗 اتصال حساب', sign('m:connect')).text('❓ راهنما', sign('m:help')).row()
    .text('📋 صف عملیات', sign('m:queue')).text('🔄 بروزرسانی', sign('m:refresh'));
}

export function backToMain(sign: Signed): InlineKeyboard {
  return new InlineKeyboard().text('« منوی اصلی', sign('m:main'));
}

export function fileListKeyboard(files: DriveFile[], refs: string[], sign: Signed, nav?: { page: number; token?: string | null; back?: string }): InlineKeyboard {
  const kb = new InlineKeyboard();
  files.slice(0, 10).forEach((file, i) => {
    const ref = refs[i];
    if (!ref) return;
    const label = `${isFolder(file) ? '📁' : '📄'} ${truncate(file.name, 28)}`;
    kb.text(label, sign(`i:${ref}`)).row();
  });
  if (nav) {
    if (nav.page > 0) kb.text('« قبلی', sign(`p:${nav.page - 1}:${nav.back ?? 'search'}`));
    if (nav.token) kb.text('بعدی »', sign(`n:${nav.page + 1}`));
    if (nav.page > 0 || nav.token) kb.row();
  }
  kb.text('« منوی اصلی', sign('m:main'));
  return kb;
}

export function fileActionsKeyboard(ref: string, file: DriveFile, sign: Signed): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (isFolder(file)) {
    kb.text('📂 باز کردن', sign(`o:${ref}`)).text('✏️ تغییر نام', sign(`rn:${ref}`)).row();
    kb.text('🗑 حذف پوشه', sign(`d:${ref}`)).row();
    return kb.text('« بازگشت', sign('m:folders'));
  }
  kb.text('ℹ️ اطلاعات فنی', sign(`i:${ref}`)).text('🔗 لینک', sign(`lk:${ref}`)).row();
  kb.text('📤 ارسال به تلگرام', sign(`snd:${ref}`)).text('📁 انتقال', sign(`mv:${ref}`)).row();
  kb.text('✏️ تغییر نام', sign(`rn:${ref}`)).text('🔓 وضعیت اشتراک', sign(`sh:${ref}`)).row();
  kb.text('🗜 افزودن به آرشیو', sign(`z:${ref}`)).text('🗑 حذف', sign(`d:${ref}`)).row();
  return kb.text('« بازگشت', sign('m:drive'));
}

export function confirmKeyboard(sign: Signed, action: string, ref: string, danger = true): InlineKeyboard {
  return new InlineKeyboard()
    .text(danger ? '✅ بله، انجام بده' : '✅ تأیید', sign(`y:${action}:${ref}`))
    .text('❌ لغو', sign('m:main'));
}

export function folderBrowserKeyboard(folders: DriveFile[], refs: string[], sign: Signed, parentRef: string | null, folderRef: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  folders.slice(0, 12).forEach((folder, i) => {
    const ref = refs[i];
    if (!ref) return;
    kb.text(`📁 ${truncate(folder.name, 26)}`, sign(`o:${ref}`)).row();
  });
  if (parentRef) kb.text('⬆️ پوشه والد', sign(`o:${parentRef}`));
  kb.text('✅ انتخاب این پوشه', sign(`sel:${folderRef}`)).row();
  kb.text('« منوی اصلی', sign('m:main'));
  return kb;
}

export function settingsKeyboard(sign: Signed, s: { autoOrganize: boolean; smartRename: boolean; confirmDangerous: boolean; progressUpdates: boolean; organizeMode: string; shareDefault: string }): InlineKeyboard {
  const on = (v: boolean) => (v ? '🟢' : '🔴');
  return new InlineKeyboard()
    .text(`${on(s.autoOrganize)} دسته‌بندی خودکار`, sign('t:autoOrganize')).row()
    .text(`${on(s.smartRename)} تغییر نام هوشمند`, sign('t:smartRename')).row()
    .text(`${on(s.confirmDangerous)} تأیید عملیات حساس`, sign('t:confirmDangerous')).row()
    .text(`${on(s.progressUpdates)} نمایش پیشرفت`, sign('t:progressUpdates')).row()
    .text(`🧭 حالت پوشه‌بندی: ${s.organizeMode}`, sign('t:organizeMode')).row()
    .text(`🔐 اشتراک پیش‌فرض: ${s.shareDefault}`, sign('t:shareDefault')).row()
    .text('« منوی اصلی', sign('m:main'));
}

export function helpKeyboard(sign: Signed): InlineKeyboard {
  return new InlineKeyboard().text('« منوی اصلی', sign('m:main'));
}

export function queueKeyboard(sign: Signed, lines: Array<{ ref: string; label: string }>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const line of lines.slice(0, 8)) kb.text(`🚫 ${truncate(line.label, 40)}`, sign(`q:${line.ref}`)).row();
  return kb.text('« منوی اصلی', sign('m:main'));
}
