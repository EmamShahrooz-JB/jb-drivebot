export type ScopeMode = 'file' | 'readonly' | 'full';

export const BASE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/drive.file',
];

export const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
export const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';

/**
 * Least privilege first.
 *
 * drive.file  -> only files/folders this app created (or the user explicitly
 *                shared with it via the picker). Drive apps created by another
 *                app, and the user's pre-existing Drive tree, are invisible.
 * drive.readonly -> read the entire Drive (needed for "My Drive", broad search
 *                and account-wide storage statistics).
 * drive       -> + move/rename/delete/trash files the app did not create.
 */
export function scopesFor(mode: ScopeMode): string[] {
  switch (mode) {
    case 'file':
      return [...BASE_SCOPES];
    case 'readonly':
      return [...BASE_SCOPES, DRIVE_READONLY];
    case 'full':
      return [...BASE_SCOPES, DRIVE_FULL];
  }
}

export interface Capabilities {
  /** can see the whole Drive tree, not just app-created files */
  browseWholeDrive: boolean;
  /** can move / rename / delete files it did not create */
  modifyForeignFiles: boolean;
  /** can read storage quota via about.get */
  storageQuota: boolean;
  mode: ScopeMode | 'unknown';
}

export function capabilitiesForScopes(granted: string[]): Capabilities {
  const has = (s: string) => granted.includes(s);
  const full = has(DRIVE_FULL);
  const readonly = has(DRIVE_READONLY) || full;
  const appFiles = has('https://www.googleapis.com/auth/drive.file');
  return {
    browseWholeDrive: readonly,
    modifyForeignFiles: full,
    // about.get/storageQuota is only documented for the broader Drive scopes
    storageQuota: readonly,
    mode: full ? 'full' : readonly ? 'readonly' : appFiles ? 'file' : 'unknown',
  };
}

export const SCOPE_EXPLANATIONS: Record<ScopeMode, string> = {
  file: 'کمترین دسترسی (drive.file): ربات فقط فایل‌های ساخته‌شده توسط خودش را می‌بیند.',
  readonly:
    'خواندن کل درایو (drive.readonly): جستجو و آمار فضای کل حساب فعال می‌شود، اما فایل‌های قدیمی قابل تغییر نیستند.',
  full:
    'دسترسی کامل (drive): جابه‌جایی، تغییر نام و حذف فایل‌های موجود هم ممکن می‌شود. پرخطرترین حالت.',
};
