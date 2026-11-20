import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { DriveHttp, driveErrorFrom } from './http.js';
import { AppError } from '../utils/errors.js';
import { GOOGLE_EXPORT_AS } from './upload.js';
import type { DriveFile } from './types.js';

export interface DownloadToFileInput {
  file: DriveFile;
  destPath: string;
  onProgress?: (received: number, total: number) => void;
  shouldAbort?: () => Promise<boolean> | boolean;
  maxBytes?: number;
}

export interface DownloadToFileResult {
  bytes: number;
  md5: string;
}

export class DriveDownloadService {
  constructor(private readonly http: DriveHttp) {}

  private urlFor(file: DriveFile): string {
    const exportAs = GOOGLE_EXPORT_AS[file.mimeType];
    if (exportAs) {
      const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(file.id)}/export`);
      url.searchParams.set('mimeType', exportAs);
      return url.toString();
    }
    const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(file.id)}`);
    url.searchParams.set('alt', 'media');
    url.searchParams.set('supportsAllDrives', 'true');
    return url.toString();
  }

  async toFile(input: DownloadToFileInput): Promise<DownloadToFileResult> {
    const expected = Number(input.file.size ?? 0);
    if (input.maxBytes && expected > input.maxBytes) {
      throw new AppError('too_large', `file is ${expected} bytes which exceeds the ${input.maxBytes} byte limit`);
    }
    const res = await this.http.stream(this.urlFor(input.file));
    if (!res.body) throw new AppError('drive_error', 'empty response body');

    const hash = createHash('md5');
    let received = 0;
    let lastReport = 0;
    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    const meter = new Transform({
      async transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (input.maxBytes && received > input.maxBytes) {
          cb(new AppError('too_large', `download exceeded ${input.maxBytes} bytes`));
          return;
        }
        hash.update(chunk);
        const now = Date.now();
        if (input.onProgress && now - lastReport > 700) {
          lastReport = now;
          input.onProgress(received, expected || received);
        }
        if (input.shouldAbort && (await input.shouldAbort())) {
          cb(new AppError('canceled', 'download canceled by user'));
          return;
        }
        cb(null, chunk);
      },
    });

    await pipeline(source, meter, createWriteStream(input.destPath));
    input.onProgress?.(received, expected || received);

    if (expected > 0 && received !== expected) {
      throw new AppError('size_mismatch', `downloaded ${received} bytes but Drive reported ${expected}`, { retryable: true });
    }
    const md5 = hash.digest('hex');
    if (input.file.md5Checksum && md5.toLowerCase() !== input.file.md5Checksum.toLowerCase()) {
      throw new AppError('integrity', `md5 mismatch: got ${md5}, drive says ${input.file.md5Checksum}`, { retryable: true });
    }
    return { bytes: received, md5 };
  }

  /** Fetch a byte range (used for zip streaming / previews). */
  async range(file: DriveFile, start: number, endInclusive: number): Promise<Buffer> {
    const headers = await this.http.authHeaders({ range: `bytes=${start}-${endInclusive}` });
    const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(file.id)}`);
    url.searchParams.set('alt', 'media');
    const res = await fetch(url.toString(), { headers });
    if (!res.ok && res.status !== 206) throw driveErrorFrom(res.status, await res.text());
    return Buffer.from(await res.arrayBuffer());
  }

  async cleanup(path: string): Promise<void> {
    try {
      await fsp.unlink(path);
    } catch {
      /* already gone */
    }
  }
}
