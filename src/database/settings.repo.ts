import type { Db } from './types.js';

export interface BotSettings {
  defaultFolderId: string | null;
  defaultFolderPath: string;
  autoOrganize: boolean;
  /** how the auto organizer builds sub folders */
  organizeMode: 'type-date' | 'type' | 'extension' | 'date' | 'none';
  /** ask for confirmation before destructive / public actions */
  confirmDangerous: boolean;
  smartRename: boolean;
  /** 'private' | 'link'  — anything but private requires an explicit confirmation */
  shareDefault: 'private' | 'link';
  progressUpdates: boolean;
  /** bytes; warn when the managed set grows beyond this */
  storageWarnBytes: number;
  backupEnabled: boolean;
}

export const DEFAULT_SETTINGS: BotSettings = {
  defaultFolderId: null,
  defaultFolderPath: 'JB-DriveBot',
  autoOrganize: true,
  organizeMode: 'type-date',
  confirmDangerous: true,
  smartRename: false,
  shareDefault: 'private',
  progressUpdates: true,
  storageWarnBytes: 10 * 1024 ** 3,
  backupEnabled: true,
};

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  async all(): Promise<BotSettings> {
    const rows = await this.db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (!(row.key in DEFAULT_SETTINGS)) continue;
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        /* ignore corrupt value, keep default */
      }
    }
    return out as unknown as BotSettings;
  }

  async get<K extends keyof BotSettings>(key: K): Promise<BotSettings[K]> {
    const rows = await this.db.query<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
    if (!rows[0]) return DEFAULT_SETTINGS[key];
    try {
      return JSON.parse(rows[0].value) as BotSettings[K];
    } catch {
      return DEFAULT_SETTINGS[key];
    }
  }

  async set<K extends keyof BotSettings>(key: K, value: BotSettings[K]): Promise<void> {
    const now = Date.now();
    const serialized = JSON.stringify(value);
    const existing = await this.db.query('SELECT key FROM settings WHERE key = ?', [key]);
    if (existing.length > 0) {
      await this.db.execute('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', [serialized, now, key]);
    } else {
      await this.db.execute('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)', [key, serialized, now]);
    }
  }

  async setMany(patch: Partial<BotSettings>): Promise<void> {
    for (const [k, v] of Object.entries(patch)) {
      await this.set(k as keyof BotSettings, v as never);
    }
  }

  async reset(): Promise<void> {
    await this.db.execute('DELETE FROM settings');
  }
}
