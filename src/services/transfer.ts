import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from './context.js';
import type { DriveFile } from '../google-drive/types.js';
import { resolveDestination } from './folders.js';
import { guessMime } from '../utils/mime.js';
import { extOf, safeFileName } from '../security/sanitize.js';
import { AppError } from '../utils/errors.js';
import type { UploadRow } from '../database/types.js';

export interface TransferInput {
  localPath: string;
  size: number;
  name: string;
  mimeType?: string | null;
  sha256?: string | null;
  folderId?: string | null;
  userId: number | null;
  source: 'telegram' | 'link' | 'archive' | 'organizer' | 'backup';
  sourceRef?: string | null;
  jobId?: string | null;
  skipDedupe?: boolean;
  skipAutoOrganize?: boolean;
  onProgress?: (uploaded: number, total: number) => void;
  onSession?: (sessionUri: string) => Promise<void>;
  shouldAbort?: () => Promise<boolean> | boolean;
  verifyIntegrity?: boolean;
}

export interface TransferResult {
  file: DriveFile;
  folderPath: string;
  deduped: boolean;
  existing: UploadRow | null;
  bytes: number;
}

/**
 * The single upload path used by every feature (Telegram upload, link download,
 * archive, organizer, backup). Keeping it in one place is what makes progress,
 * dedupe, resume and history consistent.
 */
export async function transferToDrive(ctx: AppContext, input: TransferInput): Promise<TransferResult> {
  const name = safeFileName(input.name, { fallback: 'file' });
  const mimeType = guessMime(name, input.mimeType ?? null);

  // ---- duplicate prevention by content hash ----
  if (!input.skipDedupe && input.sha256) {
    const known = await ctx.repos.uploads.knownDriveFile(input.sha256);
    if (known) {
      try {
        const existingFile = await ctx.drive.files.get(known, 'id,name,mimeType,size,webViewLink,parents');
        const row = (await ctx.repos.uploads.findByHash(input.sha256))[0] ?? null;
        ctx.logger.info('duplicate upload skipped', { sha256: input.sha256, driveFileId: known });
        return {
          file: existingFile,
          folderPath: row?.folder_path ?? '',
          deduped: true,
          existing: row,
          bytes: 0,
        };
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== 'not_found') throw err;
        ctx.logger.info('previously recorded duplicate no longer exists, uploading again', { driveFileId: known });
      }
    }
  }

  const destination = await resolveDestination(ctx, {
    folderId: input.folderId ?? null,
    fileName: name,
    mimeType,
    ...(input.skipAutoOrganize ? { skipAutoOrganize: true } : {}),
  });

  const started = Date.now();
  const job = input.jobId ? await ctx.repos.jobs.get(input.jobId) : null;
  const canResume = job && job.session_uri && job.payload.includes(name);
  const result = await ctx.drive.upload.upload({
    filePath: input.localPath,
    size: input.size,
    name,
    mimeType,
    parents: [destination.folderId],
    chunkSize: ctx.config.DRIVE_UPLOAD_CHUNK_BYTES,
    sessionUri: canResume ? job!.session_uri : null,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.onSession ? { onSession: input.onSession } : {}),
    ...(input.shouldAbort ? { shouldAbort: input.shouldAbort } : {}),
    ...(input.verifyIntegrity ? { verifyIntegrity: true } : {}),
    appProperties: { jbSource: input.source, jbSha256: input.sha256 ?? '' },
  });

  const stat = await fsp.stat(input.localPath).catch(() => ({ size: input.size }));
  const row = await ctx.repos.uploads.record({
    driveFileId: result.file.id,
    name: result.file.name ?? name,
    size: stat.size,
    mime: mimeType,
    extension: extOf(name) || null,
    folderId: destination.folderId,
    folderPath: destination.path,
    sha256: input.sha256 ?? null,
    source: input.source,
    sourceRef: input.sourceRef ?? null,
    webLink: result.file.webViewLink ?? null,
    status: 'ok',
    durationMs: Date.now() - started,
    createdBy: input.userId,
    budgetBytes: nativeDocsBudget(result.file) ?? stat.size,
  });
  await ctx.repos.stats.recordUpload(stat.size);

  return {
    file: result.file,
    folderPath: destination.path,
    deduped: false,
    existing: row,
    bytes: stat.size,
  };
}

/** Native Google Docs/Sheets/Slides consume no Drive quota in some plans. */
function nativeDocsBudget(file: DriveFile): number | null {
  if (file.mimeType?.startsWith('application/vnd.google-apps.')) return 0;
  const q = file.quotaBytesUsed ?? file.size;
  return q ? Number(q) : null;
}

/** Download a Drive file into the temp space (used by resend/zip/extract flows). */
export async function fetchDriveFileToTemp(
  ctx: AppContext,
  file: DriveFile,
  opts: { maxBytes: number; onProgress?: (received: number, total: number) => void; shouldAbort?: () => Promise<boolean> | boolean }
): Promise<{ path: string; bytes: number; md5: string }> {
  const dest = await ctx.temp.allocate('drive', `-${safeFileName(file.name)}`);
  await ctx.temp.reserve(Number(file.size ?? 0));
  const res = await ctx.drive.download.toFile({
    file,
    destPath: dest,
    maxBytes: opts.maxBytes,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.shouldAbort ? { shouldAbort: opts.shouldAbort } : {}),
  });
  return { path: dest, bytes: res.bytes, md5: res.md5 };
}

export function tempFileNameFor(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, '_');
}
