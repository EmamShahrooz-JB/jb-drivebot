/**
 * Turn a user supplied link into a direct download target.
 *
 * Only public, unauthenticated links are supported on purpose: the bot will
 * never ask for (or store) cookies or credentials for third party services.
 */
export type Provider = 'direct' | 'google-drive' | 'dropbox' | 'onedrive' | 'github' | 'unsupported';

export interface ResolvedLink {
  provider: Provider;
  /** url to fetch; may still be a redirect chain */
  url: string;
  filenameHint?: string;
  /** human readable note when something is only partially supported */
  note?: string;
  requiresAuth?: boolean;
}

const DRIVE_FILE_PATTERNS = [
  /drive\.google\.com\/file\/d\/([\w-]{10,})/,
  /drive\.google\.com\/open\?id=([\w-]{10,})/,
  /drive\.google\.com\/uc\?(?:export=download&)?id=([\w-]{10,})/,
  /docs\.google\.com\/\w+\/d\/([\w-]{10,})/,
  /lh3\.googleusercontent\.com\/d\/([\w-]{10,})/,
];

export function extractDriveFileId(url: string): string | null {
  for (const re of DRIVE_FILE_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1]) return m[1];
  }
  return null;
}

export function isDriveFolderUrl(url: string): boolean {
  return /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\//.test(url) || /drive\.google\.com\/drive\/my-drive/.test(url);
}

export function resolveLink(raw: string): ResolvedLink {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { provider: 'unsupported', url: raw, note: 'لینک معتبر نیست' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { provider: 'unsupported', url: raw, note: 'فقط لینک http/https پشتیبانی می‌شود' };
  }
  const host = url.hostname.toLowerCase();

  // ---------- Google Drive ----------
  if (host === 'drive.google.com' || host.endsWith('.googleusercontent.com') || host === 'docs.google.com') {
    if (isDriveFolderUrl(raw)) {
      return {
        provider: 'unsupported',
        url: raw,
        note: 'دانلود پوشه Google Drive به‌صورت لینک پشتیبانی نمی‌شود؛ لینک فایل بفرستید.',
      };
    }
    const fileId = extractDriveFileId(raw);
    if (fileId) {
      return {
        provider: 'google-drive',
        url: `https://drive.google.com/uc?export=download&id=${fileId}`,
        note: 'برای فایل‌های بزرگ، گوگل صفحه تأیید ویروس را نشان می‌دهد',
      };
    }
    return { provider: 'unsupported', url: raw, note: 'شناسه فایل در لینک پیدا نشد' };
  }

  // ---------- Dropbox ----------
  if (host === 'dropbox.com' || host === 'www.dropbox.com' || host.endsWith('.dropbox.com')) {
    if (host.startsWith('dl.')) return { provider: 'dropbox', url: raw };
    const u = new URL(raw);
    u.searchParams.set('dl', '1');
    return { provider: 'dropbox', url: u.toString() };
  }

  // ---------- OneDrive ----------
  if (host === '1drv.ms' || host.endsWith('.onedrive.live.com') || host.endsWith('.sharepoint.com') || host.endsWith('.1drv.com')) {
    const u = new URL(raw);
    if (host === '1drv.ms') {
      return { provider: 'onedrive', url: raw, note: 'لینک کوتاه OneDrive دنبال می‌شود؛ اگر فایل خصوصی باشد دانلود ناموفق خواهد بود' };
    }
    if (!u.searchParams.has('download')) u.searchParams.set('download', '1');
    return { provider: 'onedrive', url: u.toString() };
  }

  // ---------- GitHub ----------
  if (host === 'github.com' || host === 'www.github.com' || host === 'objects.githubusercontent.com' || host === 'raw.githubusercontent.com') {
    if (/\/releases\/download\//.test(url.pathname) || /\/archive\//.test(url.pathname) || host !== 'github.com') {
      return { provider: 'github', url: raw };
    }
    if (/\/blob\//.test(url.pathname)) {
      const rawUrl = raw.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
      return { provider: 'github', url: rawUrl };
    }
    return {
      provider: 'unsupported',
      url: raw,
      note: 'لینک باید به یک فایل یا Release اشاره کند (مثلاً /releases/download/...)',
    };
  }

  // ---------- direct ----------
  const lowerPath = url.pathname.toLowerCase();
  const hasExtension = /\.[a-z0-9]{1,8}$/.test(lowerPath);
  return {
    provider: 'direct',
    url: raw,
    ...(hasExtension ? {} : { note: 'پسوند فایل در لینک مشخص نیست؛ نام از هدر سرور گرفته می‌شود' }),
  };
}

export function fileNameFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const base = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return base || undefined;
  } catch {
    return undefined;
  }
}

/** Does this message look like a link the bot should handle? */
export function findFirstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text);
  return match ? match[0] : null;
}
