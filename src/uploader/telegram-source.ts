import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

export interface TelegramFileInfo {
  fileId: string;
  fileUniqueId?: string;
  fileName: string;
  fileSize?: number;
  mimeType?: string;
  /** already-resolved Bot API path, when the caller has it */
  filePath?: string;
}

export interface DownloadTelegramInput {
  info: TelegramFileInfo;
  destPath: string;
  apiRoot: string;
  token: string;
  maxBytes: number;
  onProgress?: (received: number, total: number) => void;
  shouldAbort?: () => Promise<boolean> | boolean;
}

export interface TelegramDownloadResult {
  bytes: number;
  sha256: string;
  mimeType: string | null;
}

/**
 * Stream a Telegram-hosted file to disk.
 *
 * The Bot API hands back a `file_path`; the bytes then come from
 * `<apiRoot>/file/bot<token>/<file_path>`. With the cloud Bot API this is capped
 * at 20 MB by Telegram itself; pointing `apiRoot` at a self-hosted
 * telegram-bot-api server raises that to 2 GB.
 */
export class TelegramFileSource {
  constructor(private readonly logger: Logger) {}

  async getFilePath(info: TelegramFileInfo, apiRoot: string, token: string): Promise<string> {
    if (info.filePath) return info.filePath;
    const res = await fetch(`${apiRoot}/bot${token}/getFile?file_id=${encodeURIComponent(info.fileId)}`);
    if (!res.ok) {
      throw new AppError('telegram_error', `getFile failed (${res.status})`, { retryable: res.status >= 500 });
    }
    const json = (await res.json()) as { ok: boolean; result?: { file_path?: string; file_size?: number }; description?: string };
    if (!json.ok || !json.result?.file_path) {
      throw new AppError('telegram_error', json.description ?? 'getFile returned no file_path');
    }
    return json.result.file_path;
  }

  async download(input: DownloadTelegramInput): Promise<TelegramDownloadResult> {
    const filePath = await this.getFilePath(input.info, input.apiRoot, input.token);
    const url = `${input.apiRoot}/file/bot${input.token}/${filePath.replace(/^\/+/, '')}`;

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new AppError('telegram_error', `file download failed (${res.status})`, { retryable: res.status >= 500 });
    }
    const total = Number(res.headers.get('content-length') ?? input.info.fileSize ?? 0);
    if (total > input.maxBytes) {
      throw new AppError('too_large', `فایل ${total} بایت است و از سقف ${input.maxBytes} بایت بیشتر است`);
    }

    const sha256 = createHash('sha256');
    let received = 0;
    let lastReport = 0;

    const meter = new Transform({
      async transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > input.maxBytes) {
          cb(new AppError('too_large', `file exceeds ${input.maxBytes} bytes`));
          return;
        }
        sha256.update(chunk);
        const now = Date.now();
        if (input.onProgress && now - lastReport > 700) {
          lastReport = now;
          input.onProgress(received, total || received);
        }
        if (input.shouldAbort && (await input.shouldAbort())) {
          cb(new AppError('canceled', 'telegram download canceled'));
          return;
        }
        cb(null, chunk);
      },
    });

    const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    try {
      await pipeline(source, meter, fs.createWriteStream(input.destPath));
    } catch (err) {
      await new Promise<void>((resolve) => fs.unlink(input.destPath, () => resolve()));
      throw err;
    }
    input.onProgress?.(received, total || received);
    this.logger.debug('telegram file streamed to disk', { bytes: received });
    return {
      bytes: received,
      sha256: sha256.digest('hex'),
      mimeType: (res.headers.get('content-type') as string | undefined) ?? null,
    };
  }
}
