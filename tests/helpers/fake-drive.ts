import http from 'node:http';
import { createHash } from 'node:crypto';

export interface FakeUploadRecord {
  name: string;
  mimeType: string;
  parents: string[];
  total: number;
  received: number;
  chunkSizes: number[];
  completed: boolean;
  id: string;
  md5?: string;
  resumedFrom?: number;
}

export interface FakeDriveOptions {
  /** fail the request that would cross this byte offset, once */
  failAfterBytes?: number;
  /** reject the next chunk with 503 */
  failOnce?: boolean;
}

/**
 * A minimal but protocol-accurate stand-in for the Drive v3 API, including the
 * resumable upload handshake (initiate -> 308 partial -> 200/201 final) and the
 * status query (`Content-Range: bytes *\/total`). It lets the uploader be tested
 * for real, without Google credentials.
 */
export class FakeDrive {
  readonly uploads = new Map<string, FakeUploadRecord>();
  readonly folders = new Map<string, { id: string; name: string; parents: string[] }>();
  private server: http.Server;
  private counter = 0;
  readonly baseUrl: string;
  private failAfter: number | undefined;
  private failOnce: boolean;

  constructor(private readonly opts: FakeDriveOptions = {}) {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.failAfter = opts.failAfterBytes;
    this.failOnce = opts.failOnce ?? false;
    this.baseUrl = '';
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    (this as { baseUrl: string }).baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    // ---- initiate resumable upload ----
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const meta = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: string; mimeType?: string; parents?: string[] };
      const id = `sess-${++this.counter}`;
      this.uploads.set(id, {
        name: meta.name ?? 'unnamed',
        mimeType: meta.mimeType ?? 'application/octet-stream',
        parents: meta.parents ?? [],
        total: Number(req.headers['x-upload-content-length'] ?? 0),
        received: 0,
        chunkSizes: [],
        completed: false,
        id: `file-${this.counter}`,
      });
      json(200, {}, { location: `${this.baseUrl}/session/${id}` });
      return;
    }

    // ---- chunk PUT / status query ----
    if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
      const id = url.pathname.split('/').pop()!;
      const record = this.uploads.get(id);
      if (!record) return json(404, { error: { code: 404, message: 'unknown session' } });
      const contentRange = String(req.headers['content-range'] ?? '');
      const discarded: Buffer[] = [];
      for await (const c of req) discarded.push(c as Buffer);
      const bodyBuf = Buffer.concat(discarded);

      // status query
      const statusQuery = /^bytes \*\/(\d+)$/.exec(contentRange);
      if (statusQuery) {
        if (record.received > 0) {
          res.writeHead(308, { range: `bytes=0-${record.received - 1}` });
          res.end();
        } else {
          res.writeHead(308);
          res.end();
        }
        return;
      }

      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
      if (!m) return json(400, { error: { code: 400, message: `bad content-range ${contentRange}` } });

      if (this.failOnce) {
        this.failOnce = false;
        return json(503, { error: { code: 503, message: 'backend error (simulated)' } });
      }
      if (this.failAfter !== undefined && record.received + bodyBuf.length > this.failAfter) {
        this.failAfter = undefined;
        res.destroy(); // simulate a dropped connection mid-upload
        return;
      }

      record.received += bodyBuf.length;
      record.chunkSizes.push(bodyBuf.length);
      if (record.received >= record.total) {
        record.completed = true;
        record.md5 = createHash('md5').update(bodyBuf).digest('hex');
        const all = Buffer.alloc(0);
        void all;
        return json(200, {
          id: record.id,
          name: record.name,
          mimeType: record.mimeType,
          size: String(record.total),
          parents: record.parents,
          webViewLink: `https://drive.example/${record.id}`,
          md5Checksum: record.md5,
        });
      }
      res.writeHead(308, { range: `bytes=0-${record.received - 1}` });
      res.end();
      return;
    }

    // ---- folder creation ----
    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const meta = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { name?: string; parents?: string[]; mimeType?: string };
      const id = `folder-${++this.counter}`;
      this.folders.set(id, { id, name: meta.name ?? 'folder', parents: meta.parents ?? [] });
      json(200, { id, name: meta.name, mimeType: meta.mimeType ?? 'application/vnd.google-apps.folder', parents: meta.parents ?? [] });
      return;
    }

    // ---- list ----
    if (req.method === 'GET' && url.pathname === '/drive/v3/files') {
      const q = url.searchParams.get('q') ?? '';
      const nameMatch = /name = '([^']*)'/.exec(q);
      const files = [...this.folders.values()]
        .filter((f) => !nameMatch || f.name === nameMatch[1])
        .map((f) => ({ id: f.id, name: f.name, mimeType: 'application/vnd.google-apps.folder', parents: f.parents }));
      json(200, { files });
      return;
    }

    // ---- metadata ----
    const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && fileMatch) {
      const id = decodeURIComponent(fileMatch[1]!);
      for (const folder of this.folders.values()) {
        if (folder.id === id) {
          json(200, { id, name: folder.name, mimeType: 'application/vnd.google-apps.folder', parents: folder.parents });
          return;
        }
      }
      for (const record of this.uploads.values()) {
        if (record.id === id) {
          json(200, { id, name: record.name, mimeType: record.mimeType, size: String(record.total), md5Checksum: record.md5 });
          return;
        }
      }
      json(404, { error: { code: 404, message: 'not found' } });
      return;
    }

    json(404, { error: { code: 404, message: `unhandled ${req.method} ${url.pathname}` } });
  }
}
