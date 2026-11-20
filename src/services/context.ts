import { SecretBox, Signer } from '../security/crypto.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { openDatabase, migrate } from '../database/index.js';
import type { Db } from '../database/types.js';
import { AccountsRepo } from '../database/accounts.repo.js';
import { JobsRepo } from '../database/jobs.repo.js';
import { UploadsRepo } from '../database/uploads.repo.js';
import { SettingsRepo } from '../database/settings.repo.js';
import { PairingRepo } from '../database/pairing.repo.js';
import { StatsRepo } from '../database/stats.repo.js';
import { AuditRepo } from '../database/audit.repo.js';
import { GoogleOAuthClient } from '../oauth/google-oauth.js';
import { TokenManager } from '../oauth/token-manager.js';
import { DriveHttp } from '../google-drive/http.js';
import { DriveFilesService } from '../google-drive/files.js';
import { DriveUploadService } from '../google-drive/upload.js';
import { DriveDownloadService } from '../google-drive/download.js';
import { DrivePermissionsService } from '../google-drive/permissions.js';
import { HttpDownloader } from '../downloader/http-download.js';
import { YtDlpService } from '../downloader/ytdlp.js';
import { ZipService } from '../archive/zip.js';
import { JobQueue } from '../queue/queue.js';
import { TempSpace } from './temp-space.js';
import { TelegramFileSource } from '../uploader/telegram-source.js';
import { NullNotifier, type Notifier } from './notifier.js';
import type { AppConfig } from '../config/index.js';

export interface Repos {
  accounts: AccountsRepo;
  jobs: JobsRepo;
  uploads: UploadsRepo;
  settings: SettingsRepo;
  pairing: PairingRepo;
  stats: StatsRepo;
  audit: AuditRepo;
}

export interface AppContext {
  config: AppConfig;
  logger: Logger;
  db: Db;
  repos: Repos;
  box: SecretBox;
  signer: Signer;
  oauth: GoogleOAuthClient;
  tokens: TokenManager;
  driveHttp: DriveHttp;
  drive: {
    files: DriveFilesService;
    upload: DriveUploadService;
    download: DriveDownloadService;
    permissions: DrivePermissionsService;
  };
  downloader: HttpDownloader;
  ytdlp: YtDlpService;
  zip: ZipService;
  queue: JobQueue;
  temp: TempSpace;
  telegramFiles: TelegramFileSource;
  notifier: Notifier;
  /** populated once the bot is constructed */
  setNotifier(n: Notifier): void;
}

export interface ContextOverrides {
  db?: Db;
  logger?: Logger;
  notifier?: Notifier;
  fetchImpl?: typeof fetch;
  /** test seams: point the Drive/OAuth clients at a local stub */
  driveApiBase?: string;
  driveUploadApiBase?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
  skipMigrate?: boolean;
}

export async function createContext(config: AppConfig, overrides: ContextOverrides = {}): Promise<AppContext> {
  const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
  const db = overrides.db ?? (await openDatabase(config));
  if (!overrides.skipMigrate) {
    const applied = await migrate(db);
    if (applied.length > 0) logger.info('database migrated', { applied });
  }

  const repos: Repos = {
    accounts: new AccountsRepo(db),
    jobs: new JobsRepo(db),
    uploads: new UploadsRepo(db),
    settings: new SettingsRepo(db),
    pairing: new PairingRepo(db),
    stats: new StatsRepo(db),
    audit: new AuditRepo(db),
  };

  const box = SecretBox.fromBase64(config.APP_ENCRYPTION_KEY);
  const signer = new Signer(box.derive('telegram-callback-signing'));

  const oauth = new GoogleOAuthClient({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.tokenEndpoint ? { tokenEndpoint: overrides.tokenEndpoint } : {}),
    ...(overrides.userInfoEndpoint ? { userInfoEndpoint: overrides.userInfoEndpoint } : {}),
  });
  const tokens = new TokenManager(config, repos.accounts, box, oauth, logger.child({ mod: 'tokens' }));

  const driveHttp = new DriveHttp({
    tokenProvider: async () => (await tokens.getAccessToken()).accessToken,
    logger: logger.child({ mod: 'drive' }),
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.driveApiBase ? { apiBase: overrides.driveApiBase } : {}),
    ...(overrides.driveUploadApiBase ? { uploadApiBase: overrides.driveUploadApiBase } : {}),
  });

  const drive = {
    files: new DriveFilesService(driveHttp),
    upload: new DriveUploadService(driveHttp),
    download: new DriveDownloadService(driveHttp),
    permissions: new DrivePermissionsService(driveHttp, logger.child({ mod: 'permissions' })),
  };

  const queue = new JobQueue(repos.jobs, logger.child({ mod: 'queue' }), {
    pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
  });

  const temp = new TempSpace(config.tmpDir, config.TEMP_QUOTA_BYTES, logger.child({ mod: 'temp' }));
  await temp.init();

  const ctx: AppContext = {
    config,
    logger,
    db,
    repos,
    box,
    signer,
    oauth,
    tokens,
    driveHttp,
    drive,
    downloader: new HttpDownloader(logger.child({ mod: 'downloader' })),
    ytdlp: new YtDlpService(
      {
        binary: config.YTDLP_PATH,
        ffmpegPath: config.FFMPEG_PATH,
        maxBytes: config.MAX_LINK_DOWNLOAD_BYTES,
      },
      logger.child({ mod: 'ytdlp' })
    ),
    zip: new ZipService(logger.child({ mod: 'zip' })),
    queue,
    temp,
    telegramFiles: new TelegramFileSource(logger.child({ mod: 'telegram-files' })),
    notifier: overrides.notifier ?? new NullNotifier(),
    setNotifier(n: Notifier) {
      ctx.notifier = n;
    },
  };

  return ctx;
}
