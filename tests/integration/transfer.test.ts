import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createContext, type AppContext } from '../../src/services/context.js';
import { createSqliteDb } from '../../src/database/sqlite.js';
import { transferToDrive } from '../../src/services/transfer.js';
import { getRootFolder, resolveDestination } from '../../src/services/folders.js';
import { NullNotifier } from '../../src/services/notifier.js';
import { FakeDrive } from '../helpers/fake-drive.js';
import { testConfig, tempDir } from '../helpers/config.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger('error');

describe('transferToDrive (upload pipeline)', () => {
  let drive: FakeDrive;
  let app: AppContext;
  let dir: string;

  beforeEach(async () => {
    drive = new FakeDrive();
    const base = await drive.start();
    dir = tempDir('jbd-transfer-');
    const config = testConfig({ DATA_DIR: dir, SQLITE_PATH: `${dir}/t.sqlite`, TMP_DIR: `${dir}/tmp` });
    app = await createContext(config, {
      db: createSqliteDb(config.SQLITE_PATH!),
      logger,
      notifier: new NullNotifier(),
      driveApiBase: `${base}/drive/v3`,
      driveUploadApiBase: `${base}/upload/drive/v3`,
      fetchImpl: fetch,
    });
    await app.repos.accounts.saveConnection({
      email: 'owner@example.com',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      refreshTokenEnc: app.tokens.sealRefreshToken('refresh'),
    });
    // pre-seed a valid access token so no token refresh is needed during the test
    await app.repos.accounts.setAccessToken(
      app.box.seal('ya29.test-access-token', 'google-access-token', 'jb-drivebot:primary'),
      Date.now() + 3_600_000
    );
  });

  afterEach(async () => {
    await drive.close();
    await app.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeLocalFile = (name: string, size = 4096): { filePath: string; sha256: string; size: number } => {
    const buffer = randomBytes(size);
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, buffer);
    return { filePath, sha256: createHash('sha256').update(buffer).digest('hex'), size };
  };

  it('creates the bot root folder on first use and remembers it', async () => {
    const root = await getRootFolder(app);
    expect(root.mimeType).toBe('application/vnd.google-apps.folder');
    const settings = await app.repos.settings.all();
    expect(settings.defaultFolderId).toBe(root.id);
    // second call reuses it instead of creating another folder
    const again = await getRootFolder(app);
    expect(again.id).toBe(root.id);
    expect(drive.folders.size).toBe(1);
  });

  it('uploads a file into the auto organized folder and records it', async () => {
    const { filePath, sha256, size } = makeLocalFile('holiday.mp4');
    const result = await transferToDrive(app, {
      localPath: filePath,
      size,
      name: 'holiday.mp4',
      mimeType: 'video/mp4',
      sha256,
      userId: 111111,
      source: 'telegram',
    });

    expect(result.deduped).toBe(false);
    expect(result.folderPath).toBe('JB-DriveBot/Videos/2026/November');
    expect(result.file.id).toMatch(/^file-/);

    const row = result.existing!;
    expect(row.name).toBe('holiday.mp4');
    expect(Number(row.size)).toBe(size);
    expect(row.sha256).toBe(sha256);
    expect(row.mime).toBe('video/mp4');
    expect(row.extension).toBe('mp4');
    expect(row.source).toBe('telegram');
    expect(Number(row.uploaded_at)).toBeGreaterThan(0);

    // the folder chain really exists
    const names = [...drive.folders.values()].map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['JB-DriveBot', 'Videos', '2026', 'November']));

    // stats reflect it
    expect(await app.repos.stats.getDay().then((d) => d.bytes_uploaded)).toBe(size);
  });

  it('skips a duplicate upload by content hash', async () => {
    const { filePath, sha256, size } = makeLocalFile('dup.pdf');
    const first = await transferToDrive(app, { localPath: filePath, size, name: 'dup.pdf', sha256, userId: 1, source: 'telegram' });
    const second = await transferToDrive(app, { localPath: filePath, size, name: 'dup.pdf', sha256, userId: 1, source: 'link' });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.file.id).toBe(first.file.id);
    expect(drive.uploads.size).toBe(1); // only one real upload happened
    expect(await app.repos.uploads.totalCount()).toBe(1);
  });

  it('honours an explicit destination folder and can bypass the organizer', async () => {
    const explicit = await app.drive.files.createFolder('Manual', 'root');
    const { filePath, size } = makeLocalFile('manual.txt', 128);
    const result = await transferToDrive(app, {
      localPath: filePath,
      size,
      name: 'manual.txt',
      folderId: explicit.id,
      userId: 1,
      source: 'link',
      skipAutoOrganize: true,
    });
    expect(result.folderPath).toContain('Manual');
    const record = [...drive.uploads.values()][0]!;
    expect(record.parents).toEqual([explicit.id]);
  });

  it('sanitises hostile file names before upload', async () => {
    const { filePath, size } = makeLocalFile('hostile.bin', 64);
    const result = await transferToDrive(app, {
      localPath: filePath,
      size,
      name: '../../etc/passwd\u0000.mp4',
      userId: 1,
      source: 'link',
    });
    expect(result.file.name).not.toContain('/');
    expect(result.file.name).not.toContain('\u0000');
  });

  it('applies each organize mode', async () => {
    const modes = ['type', 'type-date', 'extension', 'date', 'none'] as const;
    const expected: Record<string, string> = {
      type: 'JB-DriveBot/Documents',
      'type-date': 'JB-DriveBot/Documents/2026/November',
      extension: 'JB-DriveBot/Documents/PDF',
      date: 'JB-DriveBot/2026/November',
      none: 'JB-DriveBot',
    };
    for (const mode of modes) {
      await app.repos.settings.set('organizeMode', mode);
      const dest = await resolveDestination(app, { fileName: 'report.pdf', mimeType: 'application/pdf' });
      expect(dest.path, mode).toBe(expected[mode]);
    }
  });

  it('turns the organizer off when autoOrganize is false', async () => {
    await app.repos.settings.set('autoOrganize', false);
    const dest = await resolveDestination(app, { fileName: 'report.pdf' });
    expect(dest.path).toBe('JB-DriveBot');
  });
});
