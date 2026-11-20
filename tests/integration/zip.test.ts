import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZipService, DEFAULT_ZIP_LIMITS } from '../../src/archive/zip.js';
import { buildZip } from '../helpers/zip-writer.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('error');

describe('ZipService', () => {
  let dir: string;
  let zip: ZipService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jbd-zip-'));
    zip = new ZipService(logger);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates an archive from files and lists it back', async () => {
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    fs.writeFileSync(a, 'hello a');
    fs.writeFileSync(b, 'hello b');
    const out = path.join(dir, 'out.zip');
    const result = await zip.create({ outputPath: out, entries: [{ path: a }, { path: b }] });
    expect(result.entries).toBe(2);
    expect(fs.statSync(out).size).toBeGreaterThan(0);

    const listing = await zip.list(out);
    expect(listing.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('refuses to create an empty archive', async () => {
    await expect(zip.create({ outputPath: path.join(dir, 'x.zip'), entries: [] })).rejects.toThrow(/no files/i);
  });

  it('extracts a valid archive', async () => {
    const archive = path.join(dir, 'ok.zip');
    fs.writeFileSync(
      archive,
      buildZip([
        { name: 'docs/a.txt', data: Buffer.from('aaa') },
        { name: 'b.txt', data: Buffer.from('bbb') },
      ])
    );
    const dest = path.join(dir, 'out');
    const result = await zip.extract(archive, dest, { still: () => true });
    expect(result.files).toBe(2);
    expect(fs.readFileSync(path.join(dest, 'docs/a.txt'), 'utf8')).toBe('aaa');
    expect(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8')).toBe('bbb');
  });

  it('blocks path traversal entries', async () => {
    const archive = path.join(dir, 'evil.zip');
    fs.writeFileSync(archive, buildZip([{ name: '../../evil.txt', data: Buffer.from('pwned') }]));
    const dest = path.join(dir, 'out');
    await expect(zip.extract(archive, dest, { still: () => true })).rejects.toThrow(/escapes the destination|invalid relative path/);
    expect(fs.existsSync(path.join(os.tmpdir(), 'evil.txt'))).toBe(false);
  });

  it('blocks absolute paths', async () => {
    const archive = path.join(dir, 'abs.zip');
    fs.writeFileSync(archive, buildZip([{ name: '/etc/cron.d/evil', data: Buffer.from('x') }]));
    await expect(zip.extract(archive, path.join(dir, 'out2'), { still: () => true })).rejects.toThrow(/absolute path/);
  });

  it('blocks symlink entries', async () => {
    const archive = path.join(dir, 'sym.zip');
    fs.writeFileSync(archive, buildZip([{ name: 'link', data: Buffer.from('/etc/passwd'), symlink: true }]));
    await expect(zip.extract(archive, path.join(dir, 'out3'), { still: () => true })).rejects.toThrow(/symlink/);
  });

  it('blocks an archive that lies about its uncompressed size', async () => {
    const archive = path.join(dir, 'bomb.zip');
    // claims 50 MB uncompressed from 4 bytes of stored data
    fs.writeFileSync(archive, buildZip([{ name: 'bomb.bin', data: Buffer.from('xxxx'), declaredUncompressedSize: 50 * 1024 * 1024 }]));
    await expect(zip.extract(archive, path.join(dir, 'out4'), { still: () => true })).rejects.toThrow(
      /compression ratio|larger than|size mismatch/
    );
  });

  it('blocks a real high-ratio (deflated) zip bomb', async () => {
    // 20 MB of zeroes compresses to a few KB: ratio far above any sane limit
    const zeroes = path.join(dir, 'zeroes.bin');
    fs.writeFileSync(zeroes, Buffer.alloc(20 * 1024 * 1024));
    const archive = path.join(dir, 'ratio.zip');
    await zip.create({ outputPath: archive, entries: [{ path: zeroes, name: 'zeroes.bin' }] });
    const compressed = fs.statSync(archive).size;
    expect(compressed).toBeLessThan(1024 * 1024); // sanity: it really is a bomb

    await expect(
      zip.extract(archive, path.join(dir, 'out-ratio'), {
        still: () => true,
        limits: { ...DEFAULT_ZIP_LIMITS, maxCompressionRatio: 50 },
      })
    ).rejects.toThrow(/compression ratio/);
  });

  it('blocks an archive with too many entries', async () => {
    const archive = path.join(dir, 'many.zip');
    const entries = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.txt`, data: Buffer.from('x') }));
    fs.writeFileSync(archive, buildZip(entries));
    const limits = { ...DEFAULT_ZIP_LIMITS, maxEntries: 5 };
    await expect(zip.extract(archive, path.join(dir, 'out5'), { still: () => true, limits })).rejects.toThrow(/more than 5 entries/);
  });

  it('blocks extraction that would exceed the total size budget', async () => {
    const archive = path.join(dir, 'total.zip');
    fs.writeFileSync(archive, buildZip([{ name: 'a.txt', data: Buffer.from('1234') }]));
    const limits = { ...DEFAULT_ZIP_LIMITS, maxTotalUncompressedBytes: 2 };
    await expect(zip.extract(archive, path.join(dir, 'out6'), { still: () => true, limits })).rejects.toThrow(/expands beyond/);
  });

  it('supports cancelling extraction mid-way', async () => {
    const archive = path.join(dir, 'cancel.zip');
    fs.writeFileSync(archive, buildZip([{ name: 'a.txt', data: Buffer.from('1') }, { name: 'b.txt', data: Buffer.from('2') }]));
    let seen = 0;
    await expect(
      zip.extract(archive, path.join(dir, 'out7'), {
        still: () => {
          seen++;
          return seen < 2;
        },
      })
    ).rejects.toThrow(/canceled/);
  });

  it('lists entries of a corrupt archive without crashing', async () => {
    const archive = path.join(dir, 'corrupt.zip');
    fs.writeFileSync(archive, Buffer.from('this is not a zip file at all'));
    await expect(zip.list(archive)).rejects.toThrow();
  });
});
