import { DriveHttp, q, driveErrorFrom } from './http.js';
import {
  FILE_FIELDS,
  FOLDER_MIME,
  type AboutInfo,
  type DriveFile,
  type DriveFileList,
  type Permission,
  type SearchFilters,
} from './types.js';
import { AppError } from '../utils/errors.js';

const escape = encodeURIComponent;

export function buildSearchQuery(f: SearchFilters): string {
  const terms: string[] = [];
  if (!f.includeTrashed) terms.push('trashed = false');
  if (f.nameContains) terms.push(`name contains ${q(f.nameContains)}`);
  if (f.fullText) terms.push(`fullText contains ${q(f.fullText)}`);
  if (f.mimeType) terms.push(`mimeType = ${q(f.mimeType)}`);
  if (f.parentId) terms.push(`${q(f.parentId)} in parents`);
  if (f.createdAfter) terms.push(`createdTime > ${q(f.createdAfter.toISOString())}`);
  if (f.createdBefore) terms.push(`createdTime < ${q(f.createdBefore.toISOString())}`);
  if (f.modifiedAfter) terms.push(`modifiedTime > ${q(f.modifiedAfter.toISOString())}`);
  if (f.modifiedBefore) terms.push(`modifiedTime < ${q(f.modifiedBefore.toISOString())}`);
  if (f.minSize !== undefined) terms.push(`quotaBytesUsed >= ${Math.floor(f.minSize)}`);
  if (f.maxSize !== undefined) terms.push(`quotaBytesUsed <= ${Math.floor(f.maxSize)}`);
  return terms.length > 0 ? terms.join(' and ') : 'trashed = false';
}

export class DriveFilesService {
  constructor(private readonly http: DriveHttp) {}

  async list(opts: {
    q?: string;
    pageSize?: number;
    pageToken?: string;
    orderBy?: string;
    fields?: string;
  } = {}): Promise<DriveFileList> {
    const url = new URL(`${this.http.apiBase}/files`);
    url.searchParams.set('q', opts.q ?? 'trashed = false');
    url.searchParams.set('pageSize', String(Math.min(1000, opts.pageSize ?? 50)));
    url.searchParams.set('fields', opts.fields ?? `nextPageToken,files(${FILE_FIELDS})`);
    url.searchParams.set('orderBy', opts.orderBy ?? 'modifiedTime desc');
    url.searchParams.set('spaces', 'drive');
    if (opts.pageToken) url.searchParams.set('pageToken', opts.pageToken);
    const res = await this.http.json<DriveFileList>(url.toString());
    return { files: res.files ?? [], nextPageToken: res.nextPageToken, incompleteSearch: res.incompleteSearch };
  }

  search(filters: SearchFilters, page: { pageSize?: number; pageToken?: string; orderBy?: string } = {}): Promise<DriveFileList> {
    return this.list({ q: buildSearchQuery(filters), ...page });
  }

  async get(id: string, fields = FILE_FIELDS): Promise<DriveFile> {
    const url = new URL(`${this.http.apiBase}/files/${escape(id)}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('supportsAllDrives', 'true');
    return this.http.json<DriveFile>(url.toString());
  }

  async listFolders(parentId: string, pageToken?: string): Promise<DriveFileList> {
    const parent = parentId === 'root' ? q('root') : q(parentId);
    return this.list({
      q: `mimeType = ${q(FOLDER_MIME)} and ${parent} in parents and trashed = false`,
      orderBy: 'name_natural',
      pageToken,
      pageSize: 100,
    });
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    const url = new URL(`${this.http.apiBase}/files`);
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    return this.http.json<DriveFile>(url.toString(), {
      method: 'POST',
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
  }

  /** Find a direct child folder by name, creating it when missing. */
  async ensureFolder(name: string, parentId: string): Promise<DriveFile> {
    const found = await this.list({
      q: `mimeType = ${q(FOLDER_MIME)} and name = ${q(name)} and ${q(parentId)} in parents and trashed = false`,
      pageSize: 2,
    });
    if (found.files[0]) return found.files[0];
    try {
      return await this.createFolder(name, parentId);
    } catch (err) {
      // concurrent creation: re-read
      const again = await this.list({
        q: `mimeType = ${q(FOLDER_MIME)} and name = ${q(name)} and ${q(parentId)} in parents and trashed = false`,
        pageSize: 2,
      });
      if (again.files[0]) return again.files[0];
      throw err;
    }
  }

  /** Resolve a slash separated path below a root folder, creating missing segments. */
  async ensurePath(rootId: string, segments: string[]): Promise<{ id: string; path: string }> {
    let current = rootId;
    const walked: string[] = [];
    for (const segment of segments) {
      if (!segment) continue;
      const folder = await this.ensureFolder(segment, current);
      current = folder.id;
      walked.push(segment);
    }
    return { id: current, path: walked.join('/') };
  }

  async rename(fileId: string, newName: string): Promise<DriveFile> {
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}`);
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    return this.http.json<DriveFile>(url.toString(), { method: 'PATCH', body: JSON.stringify({ name: newName }) });
  }

  async move(fileId: string, newParentId: string, oldParentId?: string): Promise<DriveFile> {
    const current = oldParentId ?? (await this.get(fileId, 'id,parents')).parents?.[0];
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}`);
    url.searchParams.set('addParents', newParentId);
    if (current) url.searchParams.set('removeParents', current);
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    return this.http.json<DriveFile>(url.toString(), { method: 'PATCH', body: JSON.stringify({}) });
  }

  async trash(fileId: string): Promise<void> {
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}`);
    url.searchParams.set('supportsAllDrives', 'true');
    await this.http.json<void>(url.toString(), { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
  }

  async restore(fileId: string): Promise<void> {
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}`);
    url.searchParams.set('supportsAllDrives', 'true');
    await this.http.json<void>(url.toString(), { method: 'PATCH', body: JSON.stringify({ trashed: false }) });
  }

  /** Permanent delete. Callers must obtain an explicit confirmation first. */
  async deleteForever(fileId: string): Promise<void> {
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}`);
    url.searchParams.set('supportsAllDrives', 'true');
    const headers = await this.http.authHeaders();
    const res = await fetch(url.toString(), { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw driveErrorFrom(res.status, await res.text());
    }
  }

  async copy(fileId: string, name: string, parentId?: string): Promise<DriveFile> {
    const url = new URL(`${this.http.apiBase}/files/${escape(fileId)}/copy`);
    url.searchParams.set('fields', FILE_FIELDS);
    return this.http.json<DriveFile>(url.toString(), {
      method: 'POST',
      body: JSON.stringify({ name, ...(parentId ? { parents: [parentId] } : {}) }),
    });
  }

  async about(): Promise<AboutInfo> {
    const url = new URL(`${this.http.apiBase}/about`);
    url.searchParams.set('fields', 'user(displayName,emailAddress,permissionId),storageQuota(limit,usage,usageInDrive,usageInDriveTrash)');
    try {
      return await this.http.json<AboutInfo>(url.toString());
    } catch (err) {
      if (err instanceof AppError && (err.code === 'forbidden' || err.code === 'unauthorized')) {
        throw new AppError('scope_required', 'برای مشاهده فضای حساب به دسترسی drive یا drive.readonly نیاز است.', {
          details: err.message,
        });
      }
      throw err;
    }
  }

  async getFileSize(fileId: string): Promise<number> {
    const f = await this.get(fileId, 'id,size');
    return Number(f.size ?? 0);
  }
}
