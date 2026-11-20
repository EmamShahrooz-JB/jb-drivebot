import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { AppError } from '../utils/errors.js';
import { resolveInside, safeFileName } from '../security/sanitize.js';
import type { Logger } from '../utils/logger.js';

export interface ZipGuardLimits {
  maxEntries: number;
  maxTotalUncompressedBytes: number;
  /** uncompressed / compressed ratio per entry */
  maxCompressionRatio: number;
  maxEntryBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipGuardLimits = {
  maxEntries: 5_000,
  maxTotalUncompressedBytes: 8 * 1024 ** 3,
  maxCompressionRatio: 200,
  maxEntryBytes: 4 * 1024 ** 3,
};

export interface ZipEntryInfo {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

export interface CreateZipInput {
  outputPath: string;
  entries: Array<{ path: string; name?: string }>;
  onProgress?: (bytesWritten: number, entriesDone: number) => void;
  shouldAbort?: () => Promise<boolean> | boolean;
}

export class ZipService {
  constructor(private readonly logger: Logger) {}

  /** Create a zip from local files. Streams; never buffers whole files in memory. */
  async create(input: CreateZipInput): Promise<{ bytes: number; entries: number }> {
    await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
    const output = fs.createWriteStream(input.outputPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let entries = 0;

    const done = new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (err) => (err.code === 'ENOENT' ? undefined : reject(err)));
    });

    const abort = async (err: unknown): Promise<never> => {
      try {
        archive.abort();
      } catch {
        /* already finished */
      }
      output.destroy();
      await fsp.unlink(input.outputPath).catch(() => undefined);
      throw err;
    };

    archive.pipe(output);
    for (const entry of input.entries) {
      if (input.shouldAbort && (await input.shouldAbort())) {
        await abort(new AppError('canceled', 'zip creation canceled'));
      }
      const stat = await fsp.stat(entry.path).catch(() => null);
      if (!stat?.isFile()) continue;
      const name = safeFileName(entry.name ?? path.basename(entry.path));
      archive.file(entry.path, { name });
      entries++;
    }
    if (entries === 0) {
      await abort(new AppError('bad_request', 'no files to archive'));
    }
    try {
      await archive.finalize();
      await done;
    } catch (err) {
      await abort(err);
    }
    const stat = await fsp.stat(input.outputPath);
    this.logger.info('zip created', { entries, bytes: stat.size });
    return { bytes: stat.size, entries };
  }

  /** List entries with guard validation, without extracting anything. */
  async list(zipPath: string, limits: ZipGuardLimits = DEFAULT_ZIP_LIMITS): Promise<ZipEntryInfo[]> {
    const zipfile = await this.open(zipPath);
    return new Promise<ZipEntryInfo[]>((resolve, reject) => {
      const entries: ZipEntryInfo[] = [];
      const finish = () => {
        zipfile.close();
        resolve(entries);
      };
      zipfile.on('error', (err) => {
        zipfile.close();
        reject(err);
      });
      zipfile.on('end', finish);
      zipfile.on('entry', (entry: yauzl.Entry) => {
        try {
          this.checkEntry(entry, limits, entries);
        } catch (err) {
          zipfile.close();
          reject(err);
          return;
        }
        entries.push({
          name: entry.fileName,
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          isDirectory: /\/$/.test(entry.fileName),
        });
        if (entries.length > limits.maxEntries) {
          zipfile.close();
          reject(new AppError('zip_bomb', `archive has more than ${limits.maxEntries} entries`));
          return;
        }
        zipfile.readEntry();
      });
      zipfile.readEntry();
    });
  }

  /** Extract into destDir with traversal + zip-bomb protection. */
  async extract(
    zipPath: string,
    destDir: string,
    opts: { limits?: ZipGuardLimits; still(entryName: string): Promise<boolean> | boolean } 
  ): Promise<{ files: number; bytes: number }> {
    const limits = opts.limits ?? DEFAULT_ZIP_LIMITS;
    await fsp.mkdir(destDir, { recursive: true });
    const zipfile = await this.open(zipPath);

    return new Promise((resolve, reject) => {
      let files = 0;
      let totalBytes = 0;
      const seen: ZipEntryInfo[] = [];

      const fail = (err: unknown) => {
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        reject(err);
      };

      zipfile.on('error', fail);
      zipfile.on('end', () => resolve({ files, bytes: totalBytes }));
      zipfile.on('entry', async (entry: yauzl.Entry) => {
        try {
          this.checkEntry(entry, limits, seen);
          seen.push({ name: entry.fileName, size: entry.uncompressedSize, compressedSize: entry.compressedSize, isDirectory: /\/$/.test(entry.fileName) });
          totalBytes += entry.uncompressedSize;
          if (totalBytes > limits.maxTotalUncompressedBytes) {
            return fail(new AppError('zip_bomb', 'archive expands beyond the configured limit'));
          }
          if (!(await opts.still(entry.fileName))) {
            return fail(new AppError('canceled', 'extraction canceled'));
          }
          const target = resolveInside(destDir, entry.fileName);
          if (/\/$/.test(entry.fileName)) {
            await fsp.mkdir(target, { recursive: true });
            zipfile.readEntry();
            return;
          }
          await fsp.mkdir(path.dirname(target), { recursive: true });
          zipfile.openReadStream(entry, async (err, readStream) => {
            if (err || !readStream) return fail(err ?? new Error('cannot open entry'));
            try {
              await pipeline(readStream, fs.createWriteStream(target));
              files++;
              zipfile.readEntry();
            } catch (e) {
              fail(e);
            }
          });
        } catch (err) {
          fail(err);
        }
      });
      zipfile.readEntry();
    });
  }

  private open(zipPath: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zipfile) => {
        if (err || !zipfile) reject(new AppError('bad_zip', `cannot open archive: ${err?.message ?? 'unknown'}`));
        else resolve(zipfile);
      });
    });
  }

  /** Reject traversal, absolute paths, symlinks and zip bombs. */
  private checkEntry(entry: yauzl.Entry, limits: ZipGuardLimits, seen: ZipEntryInfo[]): void {
    const name = entry.fileName;
    if (!name || name.length > 1024) throw new AppError('bad_zip', 'entry name missing or too long');
    if (name.includes('\u0000')) throw new AppError('bad_zip', 'entry name contains NUL');
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
      throw new AppError('path_traversal', `entry has an absolute path: ${name}`);
    }
    if (normalized.split('/').includes('..')) {
      throw new AppError('path_traversal', `entry escapes the destination: ${name}`);
    }
    // symlinks are stored with the unix mode in the high bits of externalFileAttributes
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const isSymlink = (mode & 0o170000) === 0o120000;
    if (isSymlink) throw new AppError('unsafe_archive', `symlink entries are rejected: ${name}`);

    if (entry.uncompressedSize > limits.maxEntryBytes) {
      throw new AppError('zip_bomb', `entry ${name} is larger than ${limits.maxEntryBytes} bytes`);
    }
    if (entry.compressedSize > 0) {
      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        throw new AppError('zip_bomb', `entry ${name} has a suspicious compression ratio (${ratio.toFixed(0)}x)`);
      }
    }
    if (seen.length >= limits.maxEntries) {
      throw new AppError('zip_bomb', `archive has more than ${limits.maxEntries} entries`);
    }
    void limits;
  }
}
