import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { HttpDownloader } from '../../src/downloader/http-download.js';
import { SsrfError } from '../../src/security/ssrf.js';
import { createLogger } from '../../src/utils/logger.js';
import { AppError } from '../../src/utils/errors.js';
import { resolveLink } from '../../src/downloader/resolve.js';

const logger = createLogger('error');

describe('HttpDownloader', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  let downloader: HttpDownloader;
  const payload = randomBytes(300_000);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/file.bin') {
        res.writeHead(200, {
          'content-length': String(payload.length),
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report-final.pdf"',
          'accept-ranges': 'bytes',
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(payload);
      }
      if (url.pathname === '/chunked') {
        res.writeHead(200, { 'content-type': 'application/zip' });
        res.write(payload.subarray(0, 1000));
        res.end(payload.subarray(1000));
        return;
      }
      if (url.pathname === '/redirect1') {
        res.writeHead(302, { location: '/redirect2' });
        return res.end();
      }
      if (url.pathname === '/redirect2') {
        res.writeHead(302, { location: '/file.bin' });
        return res.end();
      }
      if (url.pathname === '/redirect-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      }
      if (url.pathname === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' });
        return res.end();
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<html><body>Sign in to continue</body></html>');
      }
      if (url.pathname === '/huge') {
        res.writeHead(200, { 'content-length': String(10 * 1024 * 1024), 'content-type': 'application/octet-stream' });
        return res.end();
      }
      if (url.pathname === '/error') {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('boom');
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-dl-'));
    downloader = new HttpDownloader(logger);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('downloads a file, verifies the checksum and uses the server filename', async () => {
    const result = await downloader.download(`${base}/file.bin`, {
      destDir: dir,
      maxBytes: 5 * 1024 * 1024,
      allowLoopback: true,
    });
    expect(result.bytes).toBe(payload.length);
    expect(result.filename).toBe('report-final.pdf');
    expect(result.md5).toBe(createHash('md5').update(payload).digest('hex'));
    expect(fs.readFileSync(result.path).equals(payload)).toBe(true);
  });

  it('handles a response without content-length', async () => {
    const result = await downloader.download(`${base}/chunked`, {
      destDir: dir,
      maxBytes: 5 * 1024 * 1024,
      allowLoopback: true,
    });
    expect(result.bytes).toBe(payload.length);
  });

  it('follows redirects', async () => {
    const result = await downloader.download(`${base}/redirect1`, {
      destDir: dir,
      maxBytes: 5 * 1024 * 1024,
      allowLoopback: true,
    });
    expect(result.bytes).toBe(payload.length);
    expect(result.finalUrl).toContain('/file.bin');
  });

  it('re-validates redirects and blocks one that points at cloud metadata', async () => {
    await expect(
      downloader.download(`${base}/redirect-metadata`, { destDir: dir, maxBytes: 5 * 1024 * 1024, allowLoopback: true })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('stops a redirect loop', async () => {
    await expect(
      downloader.download(`${base}/redirect-loop`, { destDir: dir, maxBytes: 5 * 1024 * 1024, allowLoopback: true, maxRedirects: 3 })
    ).rejects.toThrow(/redirects/i);
  });

  it('rejects a login/captcha HTML page instead of saving it as the file', async () => {
    await expect(downloader.download(`${base}/login`, { destDir: dir, maxBytes: 5 * 1024 * 1024, allowLoopback: true })).rejects.toThrow(
      /صفحه HTML/
    );
  });

  it('refuses a file larger than the configured limit before writing', async () => {
    await expect(downloader.download(`${base}/huge`, { destDir: dir, maxBytes: 1024 * 1024, allowLoopback: true })).rejects.toThrow(
      /above the 1048576 byte limit/
    );
  });

  it('maps a 5xx to a retryable error', async () => {
    const err = await downloader
      .download(`${base}/error`, { destDir: dir, maxBytes: 5 * 1024 * 1024, allowLoopback: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).retryable).toBe(true);
  });

  it('probes size, type and filename before downloading', async () => {
    const probe = await downloader.probe(`${base}/file.bin`, { allowLoopback: true });
    expect(probe.size).toBe(payload.length);
    expect(probe.filename).toBe('report-final.pdf');
    expect(probe.supportsRange).toBe(true);
  });

  it('blocks loopback targets unless explicitly allowed (and never in production)', async () => {
    await expect(downloader.download(`${base}/file.bin`, { destDir: dir, maxBytes: 1024 * 1024 })).rejects.toBeInstanceOf(SsrfError);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        downloader.download(`${base}/file.bin`, { destDir: dir, maxBytes: 1024 * 1024, allowLoopback: true })
      ).rejects.toBeInstanceOf(SsrfError);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('resolveLink', () => {
  it('recognises Google Drive file links', () => {
    const r = resolveLink('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=sharing');
    expect(r.provider).toBe('google-drive');
    expect(r.url).toContain('uc?export=download&id=1AbCdEfGhIjKlMnOpQrStUvWxYz');
  });

  it('rejects Drive folder links with an explanation', () => {
    const r = resolveLink('https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz');
    expect(r.provider).toBe('unsupported');
    expect(r.note).toContain('پوشه');
  });

  it('rewrites Dropbox links to force a download', () => {
    const r = resolveLink('https://www.dropbox.com/s/abc/file.pdf?dl=0');
    expect(r.provider).toBe('dropbox');
    expect(r.url).toContain('dl=1');
  });

  it('handles OneDrive short links and GitHub releases', () => {
    expect(resolveLink('https://1drv.ms/u/s!abc').provider).toBe('onedrive');
    expect(resolveLink('https://github.com/o/r/releases/download/v1/app.zip').provider).toBe('github');
    expect(resolveLink('https://github.com/o/r/blob/main/src/index.ts').url).toContain('raw.githubusercontent.com');
  });

  it('rejects non-http schemes and non-file GitHub links', () => {
    expect(resolveLink('ftp://example.com/x').provider).toBe('unsupported');
    expect(resolveLink('https://github.com/o/r').provider).toBe('unsupported');
  });
});

// vitest exposes beforeAll/afterAll as globals only when globals:true
import { beforeAll, afterAll } from 'vitest';
