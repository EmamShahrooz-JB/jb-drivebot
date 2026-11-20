import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AppContext } from '../services/context.js';
import { transferToDrive, fetchDriveFileToTemp } from '../services/transfer.js';
import { ProgressReporter } from '../services/progress-reporter.js';
import { resolveDestination, getRootFolder, describePath } from '../services/folders.js';
import { resolveLink, fileNameFromUrl } from '../downloader/resolve.js';
import { planFolders } from '../organizer/classify.js';
import { safeFileName, escapeHtml } from '../security/sanitize.js';
import { formatBytes } from '../utils/bytes.js';
import { AppError, errorMessage } from '../utils/errors.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

interface BasePayload {
  chatId: number;
  userId: number;
  statusMessageId?: number | null;
}

function reporter(ctx: AppContext, p: BasePayload, header: string): ProgressReporter {
  return new ProgressReporter(ctx.notifier, p.chatId, {
    ...(p.statusMessageId ? { initialMessageId: p.statusMessageId } : {}),
    header,
  });
}

function num(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('bad_payload', `expected a number, received ${String(v)}`);
  return n;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new AppError('bad_payload', `missing ${field}`);
  return v;
}

export function registerJobHandlers(ctx: AppContext): void {
  const { queue, config, logger } = ctx;

  // --------------------------------------------------------------- Telegram upload
  queue.register('upload_telegram', {
    concurrency: config.UPLOAD_CONCURRENCY,
    async handle({ payload, shouldCancel, setSession }) {
      const p = payload as unknown as BasePayload & {
        telegramFileId: string;
        name: string;
        size: number;
        mimeType?: string | null;
        folderId?: string | null;
      };
      const fileId = str(p.telegramFileId, 'telegramFileId');
      const name = safeFileName(str(p.name, 'name'));
      const size = num(p.size);
      const chatId = num(p.chatId);
      const userId = num(p.userId);

      if (size > config.MAX_TELEGRAM_DOWNLOAD_BYTES) {
        throw new AppError(
          'too_large',
          `این فایل ${formatBytes(size)} است و از سقف دریافت Bot API (${formatBytes(config.MAX_TELEGRAM_DOWNLOAD_BYTES)}) بزرگ‌تر است.`
        );
      }

      const progress = reporter(ctx, { chatId, userId, statusMessageId: (p as BasePayload).statusMessageId ?? null }, '⬆️ آپلود به Google Drive');
      await progress.update({ title: 'آپلود', phase: 'دریافت فایل از تلگرام', percent: 2, startedAt: Date.now() });

      await ctx.temp.reserve(size);
      const localPath = await ctx.temp.allocate('tg', `-${name}`);
      let downloaded;
      try {
        downloaded = await ctx.telegramFiles.download({
          info: { fileId, fileName: name, ...(p.mimeType ? { mimeType: p.mimeType } : {}), fileSize: size },
          destPath: localPath,
          apiRoot: config.TELEGRAM_API_ROOT,
          token: config.TELEGRAM_BOT_TOKEN,
          maxBytes: config.MAX_TELEGRAM_DOWNLOAD_BYTES,
          onProgress: (received, total) => {
            void progress.update({
              title: 'آپلود',
              phase: 'دریافت از تلگرام',
              percent: total ? (received / total) * 45 : 5,
              bytesDone: received,
              bytesTotal: total,
              startedAt: Date.now() - 1,
            });
          },
          shouldAbort: shouldCancel,
        });

        const result = await transferToDrive(ctx, {
          localPath,
          size: downloaded.bytes,
          name,
          mimeType: p.mimeType ?? downloaded.mimeType,
          sha256: downloaded.sha256,
          folderId: p.folderId ?? null,
          userId,
          source: 'telegram',
          sourceRef: `telegram:${fileId}`,
          ...(p.statusMessageId ? { jobId: undefined } : {}),
          onProgress: (uploaded, total) => {
            void progress.update({
              title: 'آپلود',
              phase: 'ارسال به Google Drive',
              percent: 45 + (total ? (uploaded / total) * 53 : 20),
              bytesDone: uploaded,
              bytesTotal: total,
              startedAt: Date.now() - 1,
            });
          },
          onSession: async (uri) => {
            await setSession(uri, 0);
          },
          shouldAbort: shouldCancel,
          verifyIntegrity: true,
        });

        if (result.deduped) {
          await progress.finish(
            [
              '♻️ <b>این فایل قبلاً آپلود شده بود</b>',
              '',
              `📄 نام: <code>${escapeHtml(result.file.name)}</code>`,
              `🆔 Drive ID: <code>${escapeHtml(result.file.id)}</code>`,
              'برای جلوگیری از آپلود تکراری، ارسال مجدد انجام نشد.',
            ].join('\n')
          );
          return { deduped: true, driveFileId: result.file.id };
        }

        await progress.finish(
          [
            '✅ <b>آپلود با موفقیت انجام شد</b>',
            '',
            `📄 نام: <code>${escapeHtml(result.file.name)}</code>`,
            `📦 حجم: ${formatBytes(result.bytes)}`,
            `🧩 نوع: <code>${escapeHtml(result.file.mimeType ?? 'unknown')}</code>`,
            `📁 پوشه: <code>${escapeHtml(result.folderPath)}</code>`,
            `🆔 Drive ID: <code>${escapeHtml(result.file.id)}</code>`,
            result.file.webViewLink ? `🔗 <a href="${escapeHtml(result.file.webViewLink)}">لینک فایل</a>` : '',
            '📌 وضعیت: موفق',
          ]
            .filter(Boolean)
            .join('\n')
        );

        await ctx.repos.audit.log({
          actor: userId,
          action: 'upload.telegram',
          target: result.file.id,
          meta: { name, size: result.bytes },
        });
        return { driveFileId: result.file.id, webViewLink: result.file.webViewLink ?? null, bytes: result.bytes };
      } finally {
        await ctx.temp.cleanup(localPath);
      }
    },
  });

  // --------------------------------------------------------------- Link download
  queue.register('download_link', {
    concurrency: config.DOWNLOAD_CONCURRENCY,
    async handle({ payload, shouldCancel, setSession }) {
      const p = payload as unknown as BasePayload & { url: string; folderId?: string | null };
      const rawUrl = str(p.url, 'url');
      const chatId = num(p.chatId);
      const userId = num(p.userId);
      const resolved = resolveLink(rawUrl);
      if (resolved.provider === 'unsupported') {
        throw new AppError('unsupported_link', resolved.note ?? 'این نوع لینک پشتیبانی نمی‌شود');
      }

      const progress = reporter(ctx, { chatId, userId, statusMessageId: (p as BasePayload).statusMessageId ?? null }, '⬇️ دانلود از لینک');
      await progress.update({ title: 'دانلود لینک', phase: 'بررسی لینک', percent: 3, startedAt: Date.now() });

      let probe;
      try {
        probe = await ctx.downloader.probe(resolved.url, { maxRedirects: config.MAX_REDIRECTS, timeoutMs: 30_000 });
      } catch (err) {
        // probing is best effort; the download itself may still succeed
        ctx.logger.debug('probe failed, continuing', { err: errorMessage(err) });
      }

      if (probe?.size && probe.size > config.MAX_LINK_DOWNLOAD_BYTES) {
        throw new AppError('too_large', `حجم فایل ${formatBytes(probe.size)} از سقف مجاز (${formatBytes(config.MAX_LINK_DOWNLOAD_BYTES)}) بیشتر است.`);
      }

      const filename = safeFileName(probe?.filename ?? fileNameFromUrl(probe?.finalUrl ?? resolved.url) ?? 'download.bin');
      await ctx.temp.reserve(probe?.size ?? 0);
      const downloaded = await ctx.downloader.download(resolved.url, {
        destDir: config.tmpDir,
        filenameHint: filename,
        maxBytes: config.MAX_LINK_DOWNLOAD_BYTES,
        maxRedirects: config.MAX_REDIRECTS,
        timeoutMs: config.LINK_TIMEOUT_MS,
        onProgress: (received, total) => {
          void progress.update({
            title: 'دانلود لینک',
            phase: 'در حال دانلود',
            percent: total ? (received / total) * 50 : 10,
            bytesDone: received,
            bytesTotal: total,
            startedAt: Date.now() - 1,
          });
        },
        shouldAbort: shouldCancel,
      });

      const sha256 = await hashFile(downloaded.path);
      try {
        const result = await transferToDrive(ctx, {
          localPath: downloaded.path,
          size: downloaded.bytes,
          name: filename,
          mimeType: downloaded.contentType,
          sha256,
          folderId: p.folderId ?? null,
          userId,
          source: 'link',
          sourceRef: downloaded.finalUrl.slice(0, 500),
          onProgress: (uploaded, total) => {
            void progress.update({
              title: 'دانلود لینک',
              phase: 'ارسال به Google Drive',
              percent: 50 + (total ? (uploaded / total) * 48 : 20),
              bytesDone: uploaded,
              bytesTotal: total,
              startedAt: Date.now() - 1,
            });
          },
          onSession: async (uri) => {
            await setSession(uri, 0);
          },
          shouldAbort: shouldCancel,
        });

        await ctx.repos.stats.recordDownload(downloaded.bytes);
        await progress.finish(
          result.deduped
            ? [
                '♻️ <b>فایل از قبل در Drive موجود بود</b>',
                `📄 نام: <code>${escapeHtml(result.file.name)}</code>`,
                `🆔 <code>${escapeHtml(result.file.id)}</code>`,
              ].join('\n')
            : [
                '✅ <b>دانلود و آپلود کامل شد</b>',
                '',
                `📄 نام: <code>${escapeHtml(result.file.name)}</code>`,
                `📦 حجم: ${formatBytes(downloaded.bytes)}`,
                `📁 پوشه: <code>${escapeHtml(result.folderPath)}</code>`,
                `🌐 منبع: <code>${escapeHtml(new URL(downloaded.finalUrl).hostname)}</code>`,
                `🆔 Drive ID: <code>${escapeHtml(result.file.id)}</code>`,
                result.file.webViewLink ? `🔗 <a href="${escapeHtml(result.file.webViewLink)}">لینک فایل</a>` : '',
              ]
                .filter(Boolean)
                .join('\n')
        );
        await ctx.repos.audit.log({ actor: userId, action: 'upload.link', target: result.file.id, meta: { url: rawUrl.slice(0, 300) } });
        return { driveFileId: result.file.id, bytes: downloaded.bytes, sourceUrl: downloaded.finalUrl };
      } finally {
        await fsp.unlink(downloaded.path).catch(() => undefined);
      }
    },
  });

  // --------------------------------------------------------------- Zip create
  queue.register('zip_create', {
    concurrency: config.OTHER_CONCURRENCY,
    async handle({ payload, shouldCancel }) {
      const p = payload as unknown as BasePayload & { fileIds: string[]; archiveName?: string; folderId?: string | null };
      const chatId = num(p.chatId);
      const userId = num(p.userId);
      const fileIds = Array.isArray(p.fileIds) ? p.fileIds : [];
      if (fileIds.length === 0) throw new AppError('bad_request', 'هیچ فایلی انتخاب نشده است');

      const progress = reporter(ctx, { chatId, userId, statusMessageId: (p as BasePayload).statusMessageId ?? null }, '🗜 ساخت آرشیو');
      const downloads: string[] = [];
      const entries: Array<{ path: string; name: string }> = [];
      try {
        for (let i = 0; i < fileIds.length; i++) {
          const file = await ctx.drive.files.get(fileIds[i]!);
          if (file.mimeType === 'application/vnd.google-apps.folder') {
            throw new AppError('bad_request', 'فشرده‌سازی پوشه در این نسخه پشتیبانی نمی‌شود؛ فایل‌ها را انتخاب کنید.');
          }
          await progress.update({
            title: 'ساخت آرشیو',
            phase: `دانلود ${i + 1}/${fileIds.length}: ${file.name}`,
            percent: (i / fileIds.length) * 40,
            startedAt: Date.now(),
          });
          const local = await fetchDriveFileToTemp(ctx, file, { maxBytes: config.MAX_LINK_DOWNLOAD_BYTES, shouldAbort: shouldCancel });
          downloads.push(local.path);
          entries.push({ path: local.path, name: safeFileName(file.name) });
        }

        const archiveName = safeFileName(p.archiveName ?? `archive-${new Date().toISOString().slice(0, 10)}.zip`);
        const outPath = await ctx.temp.allocate('zip', '.zip');
        await progress.update({ title: 'ساخت آرشیو', phase: 'فشرده‌سازی', percent: 45, startedAt: Date.now() });
        const zipResult = await ctx.zip.create({
          outputPath: outPath,
          entries,
          shouldAbort: shouldCancel,
        });

        const result = await transferToDrive(ctx, {
          localPath: outPath,
          size: zipResult.bytes,
          name: archiveName.endsWith('.zip') ? archiveName : `${archiveName}.zip`,
          mimeType: 'application/zip',
          userId,
          source: 'archive',
          folderId: p.folderId ?? null,
          skipDedupe: true,
          onProgress: (uploaded, total) => {
            void progress.update({
              title: 'ساخت آرشیو',
              phase: 'آپلود آرشیو',
              percent: 55 + (total ? (uploaded / total) * 43 : 20),
              bytesDone: uploaded,
              bytesTotal: total,
              startedAt: Date.now() - 1,
            });
          },
          shouldAbort: shouldCancel,
        });

        await progress.finish(
          [
            '✅ <b>آرشیو ساخته شد</b>',
            `🗜 فایل: <code>${escapeHtml(result.file.name)}</code>`,
            `📄 تعداد فایل: ${zipResult.entries}`,
            `📦 حجم آرشیو: ${formatBytes(zipResult.bytes)}`,
            `📁 ${escapeHtml(result.folderPath)}`,
            `🆔 <code>${escapeHtml(result.file.id)}</code>`,
          ].join('\n')
        );
        await fsp.unlink(outPath).catch(() => undefined);
        return { driveFileId: result.file.id, entries: zipResult.entries, bytes: zipResult.bytes };
      } finally {
        for (const d of downloads) await fsp.unlink(d).catch(() => undefined);
      }
    },
  });

  // --------------------------------------------------------------- Zip extract
  queue.register('zip_extract', {
    concurrency: config.OTHER_CONCURRENCY,
    async handle({ payload }) {
      const p = payload as unknown as BasePayload & { fileId: string; folderId?: string | null };
      const chatId = num(p.chatId);
      const userId = num(p.userId);
      const file = await ctx.drive.files.get(str(p.fileId, 'fileId'));
      const progress = reporter(ctx, { chatId, userId, statusMessageId: (p as BasePayload).statusMessageId ?? null }, '📂 استخراج آرشیو');

      await progress.update({ title: 'استخراج', phase: 'دانلود آرشیو', percent: 5, startedAt: Date.now() });
      const local = await fetchDriveFileToTemp(ctx, file, {
        maxBytes: config.MAX_LINK_DOWNLOAD_BYTES,
        onProgress: (received, total) => {
          void progress.update({
            title: 'استخراج',
            phase: 'دانلود آرشیو',
            percent: total ? (received / total) * 35 : 10,
            bytesDone: received,
            bytesTotal: total,
            startedAt: Date.now() - 1,
          });
        },
      });

      const destDir = await ctx.temp.allocate('unzip', '');
      await fsp.mkdir(destDir, { recursive: true });
      try {
        const listing = await ctx.zip.list(local.path);
        const files = listing.filter((e) => !e.isDirectory);
        await progress.update({
          title: 'استخراج',
          phase: `استخراج ${files.length} فایل`,
          percent: 40,
          startedAt: Date.now(),
        });
        const extracted = await ctx.zip.extract(local.path, destDir, {
          still: () => true,
        });

        const names = await collectFiles(destDir);
        let uploaded = 0;
        let lastFolderPath = '';
        for (let i = 0; i < names.length; i++) {
          const rel = names[i]!;
          const abs = path.join(destDir, rel);
          const stat = await fsp.stat(abs);
          const result = await transferToDrive(ctx, {
            localPath: abs,
            size: stat.size,
            name: safeFileName(path.basename(rel)),
            userId,
            source: 'archive',
            sourceRef: file.id,
            folderId: p.folderId ?? null,
            skipDedupe: true,
          });
          lastFolderPath = result.folderPath;
          uploaded++;
          await progress.update({
            title: 'استخراج',
            phase: `آپلود ${uploaded}/${names.length}`,
            percent: 40 + (uploaded / Math.max(1, names.length)) * 58,
            startedAt: Date.now(),
          });
        }

        await progress.finish(
          [
            '✅ <b>آرشیو استخراج و آپلود شد</b>',
            `📂 فایل‌های استخراج‌شده: ${uploaded}`,
            `📦 حجم استخراج‌شده: ${formatBytes(extracted.bytes)}`,
            `📁 مقصد: <code>${escapeHtml(lastFolderPath)}</code>`,
          ].join('\n')
        );
        return { uploaded, extractedBytes: extracted.bytes };
      } finally {
        await fsp.unlink(local.path).catch(() => undefined);
        await fsp.rm(destDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });

  // --------------------------------------------------------------- Auto organizer
  queue.register('organize', {
    concurrency: 1,
    async handle({ payload, shouldCancel }) {
      const p = payload as unknown as BasePayload & { dryRun?: boolean };
      const userId = num(p.userId);
      const chatId = num(p.chatId);
      const dryRun = p.dryRun === true;
      const root = await getRootFolder(ctx);
      const settings = await ctx.repos.settings.all();

      const listing = await ctx.drive.files.list({
        q: `'${root.id.replace(/'/g, "\\'")}' in parents and trashed = false`,
        pageSize: 200,
        orderBy: 'modifiedTime desc',
      });

      const moves: Array<{ fileId: string; name: string; target: string }> = [];
      for (const file of listing.files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') continue;
        if (await shouldCancel()) throw new AppError('canceled', 'organizer canceled');
        const segments = planFolders({
          mode: settings.organizeMode,
          rootPath: '',
          fileName: file.name,
          mimeType: file.mimeType,
        });
        if (segments.length === 0) continue;
        const target = await ctx.drive.files.ensurePath(root.id, segments);
        moves.push({ fileId: file.id, name: file.name, target: target.id });
      }

      if (!dryRun) {
        for (const move of moves) {
          await ctx.drive.files.move(move.fileId, move.target, root.id);
        }
      }
      const text = [
        dryRun ? '🔍 <b>پیش‌نمایش مرتب‌سازی</b>' : '✅ <b>مرتب‌سازی انجام شد</b>',
        `📄 فایل‌های جابه‌جا${dryRun ? 'شدنی' : 'شده'}: ${moves.length}`,
        moves.slice(0, 15).map((m) => `• ${escapeHtml(m.name)}`).join('\n'),
      ]
        .filter(Boolean)
        .join('\n');
      await ctx.notifier.send(chatId, text, { parseMode: 'HTML' });
      await ctx.repos.audit.log({ actor: userId, action: dryRun ? 'organize.preview' : 'organize.run', meta: { moves: moves.length } });
      return { moved: moves.length, dryRun };
    },
  });

  // --------------------------------------------------------------- Backup
  queue.register('backup', {
    concurrency: 1,
    async handle({ payload }) {
      const p = payload as unknown as BasePayload;
      const userId = num(p.userId);
      const chatId = num(p.chatId);
      const snapshot = {
        version: 1,
        createdAt: new Date().toISOString(),
        settings: await ctx.repos.settings.all(),
        uploads: await ctx.repos.uploads.recent(50),
        jobs: await ctx.repos.jobs.list({ limit: 50 }),
        audit: await ctx.repos.audit.recent(50),
        // NOTE: no tokens, no refresh tokens, no pairing codes. Ever.
      };
      const json = JSON.stringify(snapshot, null, 2);
      const localPath = await ctx.temp.allocate('backup', '.json');
      await fsp.writeFile(localPath, json, 'utf8');
      await fsp.mkdir(config.backupDir, { recursive: true });
      await fsp.writeFile(path.join(config.backupDir, `backup-${Date.now()}.json`), json, 'utf8').catch(() => undefined);
      try {
        const result = await transferToDrive(ctx, {
          localPath,
          size: Buffer.byteLength(json),
          name: `jb-drivebot-backup-${new Date().toISOString().slice(0, 10)}.json`,
          mimeType: 'application/json',
          userId,
          source: 'backup',
          skipDedupe: true,
          skipAutoOrganize: true,
        });
        await ctx.notifier.send(
          chatId,
          `💾 <b>پشتیبان‌گیری انجام شد</b>\n📄 <code>${escapeHtml(result.file.name)}</code>\n📁 ${escapeHtml(result.folderPath)}\n🔒 بدون توکن و اطلاعات محرمانه`,
          { parseMode: 'HTML' }
        );
        return { driveFileId: result.file.id };
      } finally {
        await ctx.temp.cleanup(localPath);
      }
    },
  });

  // --------------------------------------------------------------- Maintenance
  queue.register('cleanup', {
    concurrency: 1,
    async handle() {
      const purged = await ctx.temp.purgeOrphans(6 * 3600_000);
      const prunedJobs = await ctx.repos.jobs.prune(30 * 86_400_000);
      const prunedCodes = await ctx.repos.pairing.purgeExpired();
      logger.info('maintenance cleanup done', { purged, prunedJobs, prunedCodes });
      return { purged, prunedJobs, prunedCodes };
    },
  });
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function collectFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await collectFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

export { resolveDestination, describePath };
