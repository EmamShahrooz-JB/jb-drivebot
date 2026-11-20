import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

/**
 * Bounded temp directory.
 *
 * Files are always streamed to disk, never buffered in RAM, but disk is finite
 * (10 GB on Altare's free plan) so every allocation is accounted for and a hard
 * quota is enforced before the first byte is written.
 */
export class TempSpace {
  private reserved = 0;
  private readonly live = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly quotaBytes: number,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    await this.purgeOrphans(0);
  }

  private async usageBytes(): Promise<number> {
    let total = 0;
    for (const name of await fsp.readdir(this.dir)) {
      try {
        const stat = await fsp.stat(path.join(this.dir, name));
        if (stat.isFile()) total += stat.size;
      } catch {
        /* raced */
      }
    }
    return total;
  }

  async reserve(bytes: number): Promise<void> {
    const used = await this.usageBytes();
    if (used + this.reserved + bytes > this.quotaBytes) {
      throw new AppError(
        'temp_quota',
        `فضای موقت کافی نیست (${Math.round(bytes / 1024 ** 2)}MB درخواست شد، سهمیه ${Math.round(
          this.quotaBytes / 1024 ** 2
        )}MB). فایل‌های موقت پاک‌سازی شوند.`
      );
    }
    this.reserved += bytes;
  }

  release(bytes: number): void {
    this.reserved = Math.max(0, this.reserved - bytes);
  }

  async allocate(prefix: string, suffix = ''): Promise<string> {
    const name = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}${suffix}`;
    const full = path.join(this.dir, name);
    this.live.add(full);
    return full;
  }

  async cleanup(filePath: string): Promise<void> {
    this.live.delete(filePath);
    try {
      const stat = await fsp.stat(filePath);
      await fsp.unlink(filePath);
      this.release(stat.size);
    } catch {
      /* already removed */
    }
  }

  /** Remove anything in the temp dir older than `maxAgeMs` (0 = everything). */
  async purgeOrphans(maxAgeMs: number): Promise<number> {
    let removed = 0;
    const now = Date.now();
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const full = path.join(this.dir, name);
      try {
        const stat = await fsp.stat(full);
        if (!stat.isFile()) continue;
        if (this.live.has(full)) continue;
        if (maxAgeMs > 0 && now - stat.mtimeMs < maxAgeMs) continue;
        fs.unlinkSync(full);
        removed++;
      } catch {
        /* ignore */
      }
    }
    this.reserved = 0;
    if (removed > 0) this.logger.info('temp space purged', { removed });
    return removed;
  }
}
