import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DriveHttp, driveErrorFrom } from './http.js';
import { FILE_FIELDS, FOLDER_MIME, type DriveFile } from './types.js';
import { AppError } from '../utils/errors.js';

const MIN_CHUNK = 256 * 1024;
const DEFAULT_CHUNK = 8 * 1024 * 1024;

/** Round a chunk size up to a 256 KiB multiple, as the Drive API requires. */
export function normalizeChunkSize(size: number): number {
  const clamped = Math.max(MIN_CHUNK, size);
  return Math.floor(clamped / MIN_CHUNK) * MIN_CHUNK;
}

export interface ResumableUploadInput {
  filePath: string;
  size: number;
  name: string;
  mimeType: string;
  parents: string[];
  chunkSize?: number;
  /** existing session uri from a previous attempt (crash / restart recovery) */
  sessionUri?: string | null;
  onProgress?: (uploaded: number, total: number) => void;
  onSession?: (sessionUri: string) => Promise<void> | void;
  shouldAbort?: () => Promise<boolean> | boolean;
  appProperties?: Record<string, string>;
  /** verify md5 checksum reported by Drive against the local file */
  verifyIntegrity?: boolean;
}

export interface ResumableUploadResult {
  file: DriveFile;
  sessionUri: string;
  bytesUploaded: number;
  md5?: string;
}

export class DriveUploadService {
  constructor(private readonly http: DriveHttp) {}

  private async initiate(input: {
    name: string;
    mimeType: string;
    parents: string[];
    size: number;
    appProperties?: Record<string, string>;
  }): Promise<string> {
    const url = new URL(`${this.http.uploadApiBase}/files`);
    url.searchParams.set('uploadType', 'resumable');
    url.searchParams.set('supportsAllDrives', 'true');
    url.searchParams.set('fields', FILE_FIELDS);

    const headers = await this.http.authHeaders({
      'content-type': 'application/json',
      'x-upload-content-type': input.mimeType,
      'x-upload-content-length': String(input.size),
    });
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: input.name,
        mimeType: input.mimeType,
        parents: input.parents,
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      }),
    });
    if (!res.ok) throw driveErrorFrom(res.status, await res.text());
    const location = res.headers.get('location');
    if (!location) throw new AppError('drive_error', 'resumable upload initiated without a session uri');
    await res.text();
    return location;
  }

  /** Ask the session how many bytes Drive already has (after a crash). */
  private async queryOffset(sessionUri: string, total: number): Promise<number | 'complete'> {
    const res = await fetch(sessionUri, {
      method: 'PUT',
      headers: { 'content-length': '0', 'content-range': `bytes */${total}` },
    });
    if (res.status === 200 || res.status === 201) {
      await res.text();
      return 'complete';
    }
    if (res.status === 308) {
      await res.text();
      const range = res.headers.get('range');
      if (!range) return 0;
      const m = /bytes=(\d+)-(\d+)/.exec(range);
      if (!m) return 0;
      return Number(m[2]) + 1;
    }
    const body = await res.text();
    throw driveErrorFrom(res.status, body);
  }

  async upload(input: ResumableUploadInput): Promise<ResumableUploadResult> {
    if (input.size < 0) throw new AppError('bad_request', 'negative file size');
    const chunkSize = normalizeChunkSize(input.chunkSize ?? DEFAULT_CHUNK);
    const total = input.size;

    const stat = await fsp.stat(input.filePath);
    if (stat.size !== total) {
      throw new AppError('size_mismatch', `local file is ${stat.size} bytes but ${total} was expected`);
    }

    let sessionUri = input.sessionUri ?? null;
    let offset = 0;
    if (sessionUri) {
      const known = await this.queryOffset(sessionUri, total);
      if (known === 'complete') {
        // Already finished in a previous life: fetch metadata and return.
        const meta = await this.http
          .json<DriveFile>(`${this.http.apiBase}/files/${encodeURIComponent(input.sessionUri!.split('/').pop() ?? '')}?fields=${FILE_FIELDS}`)
          .catch(() => null);
        if (meta) return { file: meta, sessionUri, bytesUploaded: total };
      } else {
        offset = known;
      }
    }
    if (!sessionUri) {
      sessionUri = await this.initiate({
        name: input.name,
        mimeType: input.mimeType,
        parents: input.parents,
        size: total,
        appProperties: input.appProperties,
      });
      await input.onSession?.(sessionUri);
    }

    const hash = createHash('md5');
    let uploaded = offset;
    if (offset > 0) input.onProgress?.(uploaded, total);

    const fh = await fsp.open(input.filePath, 'r');
    try {
      while (uploaded < total || total === 0) {
        if (input.shouldAbort && (await input.shouldAbort())) {
          throw new AppError('canceled', 'upload canceled by user');
        }
        const start = uploaded;
        const length = Math.min(chunkSize, total - start);
        if (length === 0 && total !== 0) break;
        const buf = Buffer.allocUnsafe(Math.max(length, 1));
        const read = await fh.read(buf, 0, Math.max(length, 1), start);
        const chunk = buf.subarray(0, read.bytesRead);
        if (total === 0) {
          // empty file: single zero length request
          const res = await fetch(sessionUri, {
            method: 'PUT',
            headers: { 'content-length': '0', 'content-range': 'bytes */0' },
          });
          const body = await res.text();
          if (res.status === 200 || res.status === 201) {
            return { file: JSON.parse(body) as DriveFile, sessionUri, bytesUploaded: 0 };
          }
          throw driveErrorFrom(res.status, body);
        }

        hash.update(chunk);
        const end = start + chunk.length - 1;
        let res: Response;
        try {
          res = await fetch(sessionUri, {
            method: 'PUT',
            headers: {
              'content-length': String(chunk.length),
              'content-range': `bytes ${start}-${end}/${total}`,
              'content-type': input.mimeType,
            },
            body: chunk,
          });
        } catch (err) {
          // network hiccup: persist our offset so the retry can resume
          throw new AppError('network', `upload interrupted at ${uploaded} bytes: ${(err as Error).message}`, {
            retryable: true,
          });
        }

        if (res.status === 308) {
          await res.text();
          uploaded = end + 1;
          input.onProgress?.(uploaded, total);
          continue;
        }
        if (res.status === 200 || res.status === 201) {
          const body = await res.text();
          const file = JSON.parse(body) as DriveFile;
          uploaded = total;
          input.onProgress?.(uploaded, total);
          if (input.verifyIntegrity && file.md5Checksum && offset === 0) {
            const local = hash.digest('hex');
            if (local.toLowerCase() !== file.md5Checksum.toLowerCase()) {
              throw new AppError('integrity', `md5 mismatch after upload: local ${local} vs drive ${file.md5Checksum}`, {
                details: { driveFileId: file.id },
              });
            }
            return { file, sessionUri, bytesUploaded: uploaded, md5: local };
          }
          return { file, sessionUri, bytesUploaded: uploaded };
        }
        const errBody = await res.text();
        throw driveErrorFrom(res.status, errBody);
      }
    } finally {
      await fh.close();
    }
    throw new AppError('drive_error', 'upload loop finished without a response');
  }

  /** Cheap one-shot upload for tiny files (<= 5 MB) using multipart. */
  async uploadSmall(input: { buffer: Buffer; name: string; mimeType: string; parents: string[] }): Promise<DriveFile> {
    const boundary = 'jb-drivebot-' + Math.random().toString(16).slice(2);
    const metadata = JSON.stringify({
      name: input.name,
      mimeType: input.mimeType,
      parents: input.parents,
    });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      input.buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const url = new URL(`${this.http.uploadApiBase}/files`);
    url.searchParams.set('uploadType', 'multipart');
    url.searchParams.set('fields', FILE_FIELDS);
    url.searchParams.set('supportsAllDrives', 'true');
    const headers = await this.http.authHeaders({ 'content-type': `multipart/related; boundary=${boundary}` });
    const res = await fetch(url.toString(), { method: 'POST', headers, body });
    const text = await res.text();
    if (!res.ok) throw driveErrorFrom(res.status, text);
    return JSON.parse(text) as DriveFile;
  }
}

/** Convert a native Google Docs/Sheets/Slides file to an exportable mime type. */
export const GOOGLE_EXPORT_AS: Record<string, string> = {
  'application/vnd.google-apps.document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.google-apps.drawing': 'image/png',
};

export function isFolder(mimeType: string): boolean {
  return mimeType === FOLDER_MIME;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.promises.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}
