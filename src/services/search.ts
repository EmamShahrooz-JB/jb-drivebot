import type { AppContext } from './context.js';
import type { DriveFile, SearchFilters } from '../google-drive/types.js';
import { categorize } from '../organizer/classify.js';

export interface ParsedQuery {
  filters: SearchFilters;
  leftover: string;
}

const CATEGORY_MIME: Record<string, string> = {
  image: 'image/',
  images: 'image/',
  video: 'video/',
  videos: 'video/',
  audio: 'audio/',
  sound: 'audio/',
  pdf: 'application/pdf',
  archive: 'application/zip',
  zip: 'application/zip',
  folder: 'application/vnd.google-apps.folder',
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
};

const SIZE_UNITS: Record<string, number> = { b: 1, k: 1024, kb: 1024, m: 1024 ** 2, mb: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3 };

export function parseSize(raw: string): number | null {
  const m = /^([<>]?)(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|k|m|g)?$/i.exec(raw.trim());
  if (!m) return null;
  const value = Number(m[2]) * (SIZE_UNITS[(m[3] ?? 'b').toLowerCase()] ?? 1);
  return Math.round(value);
}

/**
 * Tiny query language so the operator can type
 *   `report ext:pdf size:>5mb after:2026-01-01` instead of filling a form.
 */
export function parseQuery(input: string): ParsedQuery {
  const filters: SearchFilters = {};
  const words: string[] = [];
  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('ext:')) {
      filters.extension = token.slice(4).replace(/^\./, '').toLowerCase();
      continue;
    }
    if (lower.startsWith('type:')) {
      const kind = lower.slice(5);
      const mime = CATEGORY_MIME[kind];
      if (mime) filters.mimeType = mime;
      continue;
    }
    if (lower.startsWith('size:')) {
      const raw = lower.slice(5);
      const sign = raw.startsWith('<') ? '<' : raw.startsWith('>') ? '>' : '';
      const bytes = parseSize(raw.replace(/^[<>]/, ''));
      if (bytes !== null) {
        if (sign === '<') filters.maxSize = bytes;
        else if (sign === '>') filters.minSize = bytes;
        else {
          filters.minSize = Math.round(bytes * 0.9);
          filters.maxSize = Math.round(bytes * 1.1);
        }
      }
      continue;
    }
    if (lower.startsWith('after:')) {
      const date = new Date(token.slice(6));
      if (!Number.isNaN(date.getTime())) filters.modifiedAfter = date;
      continue;
    }
    if (lower.startsWith('before:')) {
      const date = new Date(token.slice(7));
      if (!Number.isNaN(date.getTime())) filters.modifiedBefore = date;
      continue;
    }
    if (lower.startsWith('in:')) {
      filters.parentId = token.slice(3);
      continue;
    }
    words.push(token.replace(/^"|"$/g, ''));
  }
  if (words.length > 0) filters.nameContains = words.join(' ');
  return { filters, leftover: words.join(' ') };
}

export interface SearchResult {
  files: DriveFile[];
  nextPageToken?: string;
  /** true when filtering happened client side (extension / category) */
  clientFiltered: boolean;
}

export async function searchDrive(
  ctx: AppContext,
  opts: { query: string; pageToken?: string; pageSize?: number; orderBy?: string }
): Promise<SearchResult> {
  const { filters } = parseQuery(opts.query);
  const clientFiltered = Boolean(filters.extension);
  // Drive has no "extension" operator: widen the request then filter locally.
  const driveFilters: SearchFilters = { ...filters };
  delete driveFilters.extension;

  const res = await ctx.drive.files.search(driveFilters, {
    pageSize: clientFiltered ? 200 : (opts.pageSize ?? 20),
    ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
    ...(opts.orderBy ? { orderBy: opts.orderBy } : { orderBy: 'modifiedTime desc' }),
  });

  let files = res.files;
  if (filters.extension) {
    const ext = filters.extension;
    files = files.filter((f) => f.name.toLowerCase().endsWith(`.${ext}`));
  }
  if (filters.mimeType?.endsWith('/')) {
    files = files.filter((f) => f.mimeType.startsWith(filters.mimeType!));
  }
  if (filters.nameContains) {
    const needle = filters.nameContains.toLowerCase();
    files = files.filter((f) => f.name.toLowerCase().includes(needle));
  }
  return {
    files: files.slice(0, opts.pageSize ?? 20),
    ...(res.nextPageToken ? { nextPageToken: res.nextPageToken } : {}),
    clientFiltered,
  };
}

export function categoryOf(file: DriveFile): string {
  return categorize(file.name, file.mimeType);
}
