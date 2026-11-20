import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../utils/errors.js';
import { validateTarget } from '../security/ssrf.js';
import { safeFileName } from '../security/sanitize.js';
import type { Logger } from '../utils/logger.js';

/**
 * Optional yt-dlp bridge.
 *
 * This is intentionally the only place that shells out. It is disabled by
 * default (ENABLE_YTDLP=false) because it requires the binaries to exist in the
 * runtime image, and because "download a video" has to be legal for the user's
 * jurisdiction and consistent with the source site's terms.
 */
export interface YtDlpMetadata {
  title: string;
  ext: string;
  filesize: number | null;
  durationSeconds: number | null;
  webpage_url: string;
}

export interface YtDlpOptions {
  binary: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  maxBytes: number;
}

async function binaryExists(bin: string): Promise<boolean> {
  try {
    await fsp.access(bin, (await import('node:fs')).constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AppError('timeout', 'yt-dlp timed out'));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new AppError('ytdlp_missing', `cannot start ${args[0]}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new AppError('ytdlp_failed', `yt-dlp exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

export class YtDlpService {
  constructor(
    private readonly opts: YtDlpOptions,
    private readonly logger: Logger
  ) {}

  async available(): Promise<boolean> {
    return binaryExists(this.opts.binary);
  }

  async probe(url: string): Promise<YtDlpMetadata> {
    // never let yt-dlp resolve an internal address, even indirectly
    await validateTarget(url);
    const { stdout } = await run([this.opts.binary, '-J', '--no-playlist', '--no-warnings', '--', url], this.opts.timeoutMs ?? 60_000);
    const json = JSON.parse(stdout) as Record<string, unknown>;
    const filesize = typeof json.filesize === 'number' ? json.filesize : typeof json.filesize_approx === 'number' ? json.filesize_approx : null;
    return {
      title: String(json.title ?? 'video'),
      ext: String(json.ext ?? 'mp4'),
      filesize,
      durationSeconds: typeof json.duration === 'number' ? json.duration : null,
      webpage_url: String(json.webpage_url ?? url),
    };
  }

  async download(url: string, destDir: string, meta: YtDlpMetadata, onProgress?: (pct: number) => void): Promise<string> {
    await validateTarget(url);
    if (meta.filesize && meta.filesize > this.opts.maxBytes) {
      throw new AppError('too_large', `video is ${meta.filesize} bytes, above the limit`);
    }
    await fsp.mkdir(destDir, { recursive: true });
    const template = path.join(destDir, `${Date.now()}-%(title).80s.%(ext)s`);
    const args = [
      this.opts.binary,
      '--no-playlist',
      '--no-warnings',
      '--restrict-filenames',
      '--no-part',
      '--newline',
      '--max-filesize',
      String(this.opts.maxBytes),
      '-o',
      template,
      '--print',
      'after_move:filepath',
    ];
    if (this.opts.ffmpegPath) args.push('--ffmpeg-location', this.opts.ffmpegPath);
    args.push('--', url);

    const filePath = await new Promise<string>((resolve, reject) => {
      const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new AppError('timeout', 'yt-dlp download timed out'));
      }, this.opts.timeoutMs ?? 30 * 60_000);
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        const pct = /\[download\]\s+([\d.]+)%/.exec(d.toString());
        if (pct && onProgress) onProgress(Number(pct[1]));
      });
      child.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new AppError('ytdlp_missing', e.message));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new AppError('ytdlp_failed', `yt-dlp exited ${code}: ${err.slice(-400)}`));
        const lines = out.trim().split('\n').filter(Boolean);
        const last = lines[lines.length - 1];
        if (!last) return reject(new AppError('ytdlp_failed', 'yt-dlp produced no file path'));
        resolve(last.trim());
      });
    });

    const name = safeFileName(path.basename(filePath));
    const finalPath = path.join(destDir, name);
    if (finalPath !== filePath) await fsp.rename(filePath, finalPath);
    this.logger.info('yt-dlp download complete', { bytes: (await fsp.stat(finalPath)).size });
    return finalPath;
  }
}
