import path from 'node:path';

export type Category = 'Images' | 'Videos' | 'Audio' | 'Documents' | 'Archives' | 'Applications' | 'Code' | 'Other';

export const CATEGORIES: Category[] = ['Images', 'Videos', 'Audio', 'Documents', 'Archives', 'Applications', 'Code', 'Other'];

const EXT_MAP: Record<string, Category> = {};

const add = (cat: Category, exts: string[]) => exts.forEach((e) => (EXT_MAP[e] = cat));

add('Images', ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif', 'avif', 'svg', 'ico', 'raw', 'cr2', 'nef', 'psd', 'ai', 'eps']);
add('Videos', ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'ogv']);
add('Audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'wma', 'aiff', 'alac', 'mid', 'midi']);
add('Documents', [
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt', 'md', 'csv', 'tsv',
  'epub', 'mobi', 'djvu', 'pages', 'numbers', 'key', 'tex', 'log',
]);
add('Archives', ['zip', 'rar', '7z', 'tar', 'gz', 'bzip2', 'bz2', 'xz', 'zst', 'lz4', 'iso', 'cab', 'tgz', 'tbz2', 'txz']);
add('Applications', ['exe', 'msi', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'jar', 'bin', 'snap', 'flatpak', 'msix', 'appx']);
add('Code', [
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'html', 'htm', 'css', 'scss', 'less', 'py', 'rb', 'php', 'go',
  'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'ps1', 'sql', 'yml',
  'yaml', 'toml', 'ini', 'xml', 'dockerfile', 'makefile', 'lua', 'pl', 'r', 'dart', 'vue', 'svelte', 'ipynb',
]);

const MIME_PREFIX_MAP: Array<[RegExp, Category]> = [
  [/^image\//, 'Images'],
  [/^video\//, 'Videos'],
  [/^audio\//, 'Audio'],
  [/^text\//, 'Documents'],
  [/^application\/(pdf|msword|vnd\.openxmlformats-officedocument|vnd\.oasis\.opendocument|rtf|epub)/, 'Documents'],
  [/^application\/(zip|x-rar-compressed|x-7z-compressed|x-tar|gzip|x-bzip2|x-xz|zstd)/, 'Archives'],
  [/^application\/(vnd\.android\.package-archive|x-msdownload|x-msi|x-apple-diskimage|x-deb|x-rpm|java-archive)/, 'Applications'],
  [/^application\/(json|javascript|xml|x-sh|x-typescript)/, 'Code'],
];

export function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/^\./, '');
  return ext;
}

export function categorize(name: string, mimeType?: string | null): Category {
  const ext = extOf(name);
  if (ext && EXT_MAP[ext]) return EXT_MAP[ext]!;
  if (mimeType) {
    for (const [re, cat] of MIME_PREFIX_MAP) if (re.test(mimeType)) return cat;
  }
  return 'Other';
}

export interface FolderPlanInput {
  mode: 'type-date' | 'type' | 'extension' | 'date' | 'none';
  rootPath: string;
  fileName: string;
  mimeType?: string | null;
  date?: Date;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Returns the folder segments under the bot root, e.g. ['Videos','2026','November']. */
export function planFolders(input: FolderPlanInput): string[] {
  const date = input.date ?? new Date();
  const year = String(date.getUTCFullYear());
  const month = MONTHS[date.getUTCMonth()]!;
  const root = input.rootPath.split('/').filter(Boolean);
  const category = categorize(input.fileName, input.mimeType);
  const ext = extOf(input.fileName);

  switch (input.mode) {
    case 'none':
      return [];
    case 'type':
      return [...root, category];
    case 'date':
      return [...root, year, month];
    case 'extension':
      return [...root, category, ext ? ext.toUpperCase() : 'NO-EXT'];
    case 'type-date':
    default:
      return [...root, category, year, month];
  }
}

const SAFE_BASE = /[^\p{L}\p{N}._-]+/gu;

/**
 * Smart Rename: propose a tidy, sortable file name. Never invoked
 * automatically unless the operator enables it in settings.
 */
export function proposeName(original: string, opts: { date?: Date; keepOriginalBase?: boolean } = {}): string {
  const ext = extOf(original);
  const baseRaw = ext ? original.slice(0, -(ext.length + 1)) : original;
  let base = baseRaw.normalize('NFKC').replace(SAFE_BASE, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!base) base = 'file';
  const d = opts.date ?? new Date();
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const hasStamp = /\d{8}/.test(base);
  const name = opts.keepOriginalBase
    ? base
    : `${base}${hasStamp ? '' : `-${stamp}`}`;
  return ext ? `${name}.${ext}` : name;
}
