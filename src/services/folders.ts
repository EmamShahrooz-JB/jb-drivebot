import type { AppContext } from './context.js';
import { planFolders } from '../organizer/classify.js';
import { safeFileName } from '../security/sanitize.js';
import { AppError } from '../utils/errors.js';
import type { DriveFile } from '../google-drive/types.js';

/** The bot's own root folder, created on demand and remembered in settings. */
export async function getRootFolder(ctx: AppContext): Promise<DriveFile> {
  const settings = await ctx.repos.settings.all();
  const name = safeFileName(ctx.config.DEFAULT_DRIVE_FOLDER_NAME, { fallback: 'JB-DriveBot' });
  if (settings.defaultFolderId) {
    try {
      const folder = await ctx.drive.files.get(settings.defaultFolderId, 'id,name,mimeType,webViewLink,parents');
      if (folder.mimeType === 'application/vnd.google-apps.folder') return folder;
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'not_found') throw err;
      ctx.logger.warn('configured root folder is gone, recreating', { id: settings.defaultFolderId });
    }
  }
  const found = await ctx.drive.files.list({
    q: `mimeType = 'application/vnd.google-apps.folder' and name = '${name.replace(/'/g, "\\'")}' and 'root' in parents and trashed = false`,
    pageSize: 2,
  });
  const folder = found.files[0] ?? (await ctx.drive.files.createFolder(name, 'root'));
  await ctx.repos.settings.set('defaultFolderId', folder.id);
  await ctx.repos.accounts.setRootFolder(folder.id);
  ctx.logger.info('drive root folder ready', { folderId: folder.id, name });
  return folder;
}

export interface DestinationOptions {
  /** explicit folder chosen by the user in the UI */
  folderId?: string | null;
  fileName: string;
  mimeType?: string | null;
  /** bypass the auto organizer for this call */
  skipAutoOrganize?: boolean;
  date?: Date;
}

export interface Destination {
  folderId: string;
  /** slash separated path relative to My Drive, for display and history */
  path: string;
  rootId: string;
}

/**
 * Decide where a file lands.
 *
 * An explicit user choice always wins. Otherwise the auto organizer builds
 * `<root>/<Category>/<Year>/<Month>` (configurable) and creates missing folders.
 */
export async function resolveDestination(ctx: AppContext, opts: DestinationOptions): Promise<Destination> {
  const settings = await ctx.repos.settings.all();

  if (opts.folderId) {
    const folder = await ctx.drive.files.get(opts.folderId, 'id,name,mimeType,parents');
    if (folder.mimeType !== 'application/vnd.google-apps.folder') {
      throw new AppError('bad_request', 'مقصد انتخاب‌شده یک پوشه نیست.');
    }
    const path = await describePath(ctx, folder);
    return { folderId: folder.id, path, rootId: (await getRootFolder(ctx)).id };
  }

  const root = await getRootFolder(ctx);
  if (!settings.autoOrganize || opts.skipAutoOrganize || settings.organizeMode === 'none') {
    return { folderId: root.id, path: root.name, rootId: root.id };
  }

  const segments = planFolders({
    mode: settings.organizeMode,
    rootPath: '',
    fileName: opts.fileName,
    mimeType: opts.mimeType ?? null,
    ...(opts.date ? { date: opts.date } : {}),
  });
  const resolved = await ctx.drive.files.ensurePath(root.id, segments);
  return {
    folderId: resolved.id,
    path: [root.name, ...segments].join('/'),
    rootId: root.id,
  };
}

/** Best-effort human readable path by walking parents (bounded). */
export async function describePath(ctx: AppContext, file: DriveFile): Promise<string> {
  const parts: string[] = [file.name];
  let current = file;
  for (let depth = 0; depth < 6; depth++) {
    const parentId = current.parents?.[0];
    if (!parentId) break;
    try {
      const parent = await ctx.drive.files.get(parentId, 'id,name,parents');
      if (parent.name) parts.unshift(parent.name);
      current = parent;
    } catch {
      break;
    }
  }
  return parts.join('/');
}
