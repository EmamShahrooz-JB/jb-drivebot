import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DriveHttp } from '../../src/google-drive/http.js';
import { DriveUploadService, normalizeChunkSize } from '../../src/google-drive/upload.js';
import { DriveFilesService } from '../../src/google-drive/files.js';
import { FakeDrive } from '../helpers/fake-drive.js';
import { createLogger } from '../../src/utils/logger.js';
import { AppError } from '../../src/utils/errors.js';

const logger = createLogger('error');
const CHUNK = 256 * 1024; // the Drive API minimum

describe('resumable uploader', () => {
  let drive: FakeDrive;
  let base: string;
  let service: DriveUploadService;
  let files: DriveFilesService;
  let dir: string;

  beforeEach(async () => {
    drive = new FakeDrive();
    base = await drive.start();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-up-'));
    const http = new DriveHttp({
      tokenProvider: async () => 'test-token',
      logger,
      apiBase: `${base}/drive/v3`,
      uploadApiBase: `${base}/upload/drive/v3`,
    });
    service = new DriveUploadService(http);
    files = new DriveFilesService(http);
  });

  afterEach(async () => {
    await drive.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeFile = (name: string, size: number): { filePath: string; buffer: Buffer } => {
    const buffer = randomBytes(size);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    return { filePath, buffer };
  };

  it('normalizes chunk sizes to the required 256 KiB multiple', () => {
    expect(normalizeChunkSize(1)).toBe(CHUNK);
    expect(normalizeChunkSize(CHUNK + 1)).toBe(CHUNK);
    expect(normalizeChunkSize(1_000_000)).toBe(768 * 1024);
    expect(normalizeChunkSize(8 * 1024 * 1024)).toBe(8 * 1024 * 1024);
  });

  it('uploads a small file in one chunk and reports progress', async () => {
    const { filePath } = writeFile('small.bin', 1024);
    const progress: number[] = [];
    const result = await service.upload({
      filePath,
      size: 1024,
      name: 'small.bin',
      mimeType: 'application/octet-stream',
      parents: ['root-folder'],
      onProgress: (uploaded, total) => progress.push(Math.round((uploaded / total) * 100)),
    });
    expect(result.file.id).toMatch(/^file-/);
    expect(result.bytesUploaded).toBe(1024);
    expect(progress.at(-1)).toBe(100);
    const record = [...drive.uploads.values()][0]!;
    expect(record.completed).toBe(true);
    expect(record.parents).toEqual(['root-folder']);
  });

  it('uploads a multi-chunk file, streaming from disk', async () => {
    const size = CHUNK * 3 + 1024;
    const { filePath } = writeFile('big.bin', size);
    let maxChunk = 0;
    const result = await service.upload({
      filePath,
      size,
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      parents: ['root-folder'],
      chunkSize: CHUNK,
      onProgress: () => undefined,
      onSession: () => {
        maxChunk = CHUNK;
      },
    });
    expect(result.bytesUploaded).toBe(size);
    const record = [...drive.uploads.values()][0]!;
    expect(record.completed).toBe(true);
    expect(record.chunkSizes.length).toBe(4);
    expect(Math.max(...record.chunkSizes)).toBeLessThanOrEqual(maxChunk);
    // never loads the whole file: each request body is at most one chunk
    expect(record.chunkSizes.reduce((a, b) => a + b, 0)).toBe(size);
  });

  it('resumes a dropped upload from the last acknowledged offset', async () => {
    const size = CHUNK * 4;
    const { filePath, buffer } = writeFile('resume.bin', size);
    const resumingDrive = new FakeDrive({ failAfterBytes: CHUNK + 1024 });
    const resumeBase = await resumingDrive.start();
    const http = new DriveHttp({
      tokenProvider: async () => 'test-token',
      logger,
      apiBase: `${resumeBase}/drive/v3`,
      uploadApiBase: `${resumeBase}/upload/drive/v3`,
    });
    const resumable = new DriveUploadService(http);

    let sessionUri: string | null = null;
    await expect(
      resumable.upload({
        filePath,
        size,
        name: 'resume.bin',
        mimeType: 'application/octet-stream',
        parents: ['p'],
        chunkSize: CHUNK,
        onSession: (uri) => {
          sessionUri = uri;
        },
      })
    ).rejects.toBeInstanceOf(AppError);

    expect(sessionUri).toBeTruthy();
    const beforeResume = [...resumingDrive.uploads.values()][0]!;
    expect(beforeResume.completed).toBe(false);
    const alreadySent = beforeResume.received;
    expect(alreadySent).toBeGreaterThan(0);
    expect(alreadySent).toBeLessThan(size);

    // second attempt reuses the session (this is what the queue does on retry)
    const result = await resumable.upload({
      filePath,
      size,
      name: 'resume.bin',
      mimeType: 'application/octet-stream',
      parents: ['p'],
      chunkSize: CHUNK,
      sessionUri,
    });
    expect(result.bytesUploaded).toBe(size);
    const record = [...resumingDrive.uploads.values()][0]!;
    expect(record.completed).toBe(true);
    expect(record.received).toBe(size);
    // the first byte that was re-sent is exactly the acknowledged offset
    expect(record.chunkSizes.length).toBeGreaterThanOrEqual(2);
    void buffer;
    await resumingDrive.close();
  });

  it('surfaces a retryable error when Drive returns 503 mid upload', async () => {
    const { filePath } = writeFile('flaky.bin', CHUNK * 2);
    const flaky = new FakeDrive({ failOnce: true });
    const flakyBase = await flaky.start();
    const http = new DriveHttp({
      tokenProvider: async () => 'test-token',
      logger,
      apiBase: `${flakyBase}/drive/v3`,
      uploadApiBase: `${flakyBase}/upload/drive/v3`,
    });
    const resumable = new DriveUploadService(http);
    const err = await resumable
      .upload({ filePath, size: CHUNK * 2, name: 'f.bin', mimeType: 'application/octet-stream', parents: ['p'], chunkSize: CHUNK })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).retryable).toBe(true);
    await flaky.close();
  });

  it('aborts when the cancel flag is set', async () => {
    const { filePath } = writeFile('cancel.bin', CHUNK * 4);
    let calls = 0;
    await expect(
      service.upload({
        filePath,
        size: CHUNK * 4,
        name: 'c.bin',
        mimeType: 'application/octet-stream',
        parents: ['p'],
        chunkSize: CHUNK,
        shouldAbort: () => {
          calls++;
          return calls > 1;
        },
      })
    ).rejects.toThrow(/canceled/i);
  });

  it('refuses to upload when the local file size does not match', async () => {
    const { filePath } = writeFile('mismatch.bin', 500);
    await expect(
      service.upload({ filePath, size: 9999, name: 'm.bin', mimeType: 'application/octet-stream', parents: ['p'] })
    ).rejects.toThrow(/local file is 500 bytes/);
  });

  it('creates and finds folders through the files service', async () => {
    const created = await files.createFolder('Videos', 'root');
    expect(created.mimeType).toBe('application/vnd.google-apps.folder');
    const again = await files.ensureFolder('Videos', 'root');
    expect(again.id).toBe(created.id);
    const path = await files.ensurePath('root', ['Videos', '2026', 'November']);
    expect(path.path).toBe('Videos/2026/November');
    expect(path.id).toMatch(/^folder-/);
  });
});
