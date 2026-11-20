import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';

const csv = (v: string) =>
  v.split(',').map((s) => s.trim()).filter(Boolean);

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // ---------- Telegram ----------
  TELEGRAM_BOT_TOKEN: z.string().min(20, 'TELEGRAM_BOT_TOKEN is required'),
  /** Comma separated numeric Telegram user ids. First one is the owner. */
  ADMIN_USER_IDS: z.string().min(1).transform(csv),
  TELEGRAM_TRANSPORT: z.enum(['polling', 'webhook']).default('polling'),
  /**
   * Custom Bot API root. Point this at a self-hosted Local Bot API Server
   * (https://github.com/tdlib/telegram-bot-api) to lift the 20 MB download limit.
   */
  TELEGRAM_API_ROOT: z.string().url().default('https://api.telegram.org'),
  /** Only used when TELEGRAM_TRANSPORT=webhook. */
  WEBHOOK_PUBLIC_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z.string().min(16).optional(),

  // ---------- HTTP / pairing server ----------
  PORT: int(8080, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  /** Public HTTPS base url of this app on Altare, e.g. https://jb-drivebot.altare.app */
  PUBLIC_BASE_URL: z.string().url().optional(),
  ENABLE_PAIRING_SERVER: bool(true),
  PAIRING_TTL_SECONDS: int(600, 60, 3600),
  PAIRING_MAX_ATTEMPTS: int(5, 1, 20),

  // ---------- Google OAuth ----------
  GOOGLE_CLIENT_ID: z.string().min(10, 'GOOGLE_CLIENT_ID is required'),
  GOOGLE_CLIENT_SECRET: z.string().min(5, 'GOOGLE_CLIENT_SECRET is required'),
  /**
   * Least privilege by default:
   *  file     -> drive.file      (only files this app created/opened)
   *  readonly -> drive.file + drive.readonly (browse/search the whole Drive)
   *  full     -> drive.file + drive (move/rename/delete pre-existing files)
   */
  GOOGLE_SCOPES_MODE: z.enum(['file', 'readonly', 'full']).default('file'),
  OAUTH_REDIRECT_PORT: int(8765, 1024, 65535),
  /** Account whose Drive is managed. Used to verify the consent screen choice. */
  GOOGLE_EXPECTED_EMAIL: z.string().email().optional(),

  // ---------- Secrets ----------
  /** base64 encoded 32 byte master key (openssl rand -base64 32) */
  APP_ENCRYPTION_KEY: z.string().min(43, 'APP_ENCRYPTION_KEY must be 32 bytes base64'),

  // ---------- Database ----------
  DB_DRIVER: z.enum(['sqlite', 'postgres']).default('sqlite'),
  DATABASE_URL: z.string().optional(),
  SQLITE_PATH: z.string().optional(),
  DB_POOL_MAX: int(5, 1, 50),

  // ---------- Storage ----------
  DATA_DIR: z.string().default('./data'),
  TMP_DIR: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  TEMP_QUOTA_BYTES: int(6 * 1024 ** 3, 64 * 1024 ** 2),

  // ---------- Limits ----------
  /** Cloud Bot API hard limit for bot downloads is 20 MB; local Bot API server raises it. */
  MAX_TELEGRAM_DOWNLOAD_BYTES: int(20 * 1024 ** 2, 1024 ** 2),
  /** Cloud Bot API upload limit is 50 MB; local Bot API server raises it to 2000 MB. */
  MAX_TELEGRAM_SEND_BYTES: int(50 * 1024 ** 2, 1024 ** 2),
  MAX_LINK_DOWNLOAD_BYTES: int(4 * 1024 ** 3, 1024 ** 2),
  MAX_REDIRECTS: int(5, 0, 10),
  LINK_TIMEOUT_MS: int(120_000, 5_000, 3_600_000),

  // ---------- Queues ----------
  UPLOAD_CONCURRENCY: int(2, 1, 8),
  DOWNLOAD_CONCURRENCY: int(2, 1, 8),
  OTHER_CONCURRENCY: int(1, 1, 8),
  JOB_MAX_ATTEMPTS: int(4, 1, 10),
  JOB_POLL_INTERVAL_MS: int(1000, 100, 10_000),
  JOB_TIMEOUT_MS: int(3_600_000, 30_000, 86_400_000),

  // ---------- Drive behaviour ----------
  DEFAULT_DRIVE_FOLDER_NAME: z.string().default('JB-DriveBot'),
  DRIVE_UPLOAD_CHUNK_BYTES: int(8 * 1024 ** 2, 256 * 1024, 64 * 1024 ** 2),

  // ---------- Security ----------
  RATE_LIMIT_PER_MINUTE: int(30, 1, 600),
  RATE_LIMIT_BURST: int(10, 1, 200),
  CALLBACK_TTL_SECONDS: int(900, 60, 3600),

  // ---------- Optional binaries ----------
  ENABLE_YTDLP: bool(false),
  YTDLP_PATH: z.string().default('yt-dlp'),
  FFMPEG_PATH: z.string().default('ffmpeg'),
});

export type RawConfig = z.infer<typeof schema>;

export interface AppConfig extends Omit<RawConfig, 'ADMIN_USER_IDS'> {
  ADMIN_USER_IDS: number[];
  OWNER_ID: number;
  dataDir: string;
  tmpDir: string;
  backupDir: string;
  redirectUri: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const raw = parsed.data;

  const admins = raw.ADMIN_USER_IDS.map((v) => Number(v));
  if (admins.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error('ADMIN_USER_IDS must contain numeric Telegram user ids');
  }
  if (admins.length === 0) throw new Error('ADMIN_USER_IDS must not be empty');

  const dataDir = path.resolve(raw.DATA_DIR);
  const tmpDir = path.resolve(raw.TMP_DIR ?? path.join(raw.DATA_DIR, 'tmp'));
  const backupDir = path.resolve(raw.BACKUP_DIR ?? path.join(raw.DATA_DIR, 'backups'));

  if (raw.DB_DRIVER === 'postgres' && !raw.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when DB_DRIVER=postgres');
  }
  if (raw.NODE_ENV === 'production' && raw.GOOGLE_SCOPES_MODE === 'file') {
    // allowed, but surfacing it once in logs helps operators understand limits
  }
  if (raw.NODE_ENV === 'production' && !raw.PUBLIC_BASE_URL && raw.ENABLE_PAIRING_SERVER) {
    throw new Error(
      'PUBLIC_BASE_URL is required in production so the local authenticator can reach this server over TLS'
    );
  }

  return {
    ...raw,
    ADMIN_USER_IDS: admins,
    OWNER_ID: admins[0]!,
    dataDir,
    tmpDir,
    backupDir,
    redirectUri: `http://127.0.0.1:${raw.OAUTH_REDIRECT_PORT}/oauth2callback`,
  };
}
