import { DriveHttp, driveErrorFrom } from './http.js';
import type { Permission } from './types.js';
import { AppError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';

/**
 * Sharing is private by default and never happens implicitly: every method
 * here is only reachable behind an explicit admin confirmation.
 */
export class DrivePermissionsService {
  constructor(
    private readonly http: DriveHttp,
    private readonly logger: Logger
  ) {}

  async list(fileId: string): Promise<Permission[]> {
    const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set('fields', 'permissions(id,type,role,emailAddress,domain,allowFileDiscovery)');
    url.searchParams.set('supportsAllDrives', 'true');
    const res = await this.http.json<{ permissions?: Permission[] }>(url.toString());
    return res.permissions ?? [];
  }

  async isPublic(fileId: string): Promise<{ isPublic: boolean; permissions: Permission[] }> {
    const permissions = await this.list(fileId);
    return { isPublic: permissions.some((p) => p.type === 'anyone'), permissions };
  }

  /** Grants anyone-with-the-link read access. Requires explicit confirmation upstream. */
  async makeAnyoneReader(fileId: string): Promise<Permission> {
    const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(fileId)}/permissions`);
    url.searchParams.set('fields', 'id,type,role,allowFileDiscovery');
    url.searchParams.set('supportsAllDrives', 'true');
    const perm = await this.http.json<Permission>(url.toString(), {
      method: 'POST',
      body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
    });
    this.logger.info('file made link-shareable', { fileId, permissionId: perm.id });
    return perm;
  }

  async revokePublic(fileId: string): Promise<number> {
    const permissions = await this.list(fileId);
    let removed = 0;
    for (const p of permissions) {
      if (p.type !== 'anyone') continue;
      const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(p.id)}`);
      url.searchParams.set('supportsAllDrives', 'true');
      const headers = await this.http.authHeaders();
      const res = await fetch(url.toString(), { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw driveErrorFrom(res.status, await res.text());
      removed++;
    }
    if (removed > 0) this.logger.info('public permission revoked', { fileId, removed });
    return removed;
  }

  async getLink(fileId: string): Promise<{ webViewLink?: string }> {
    const url = new URL(`${this.http.apiBase}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set('fields', 'id,webViewLink');
    const file = await this.http.json<{ webViewLink?: string }>(url.toString());
    if (!file.webViewLink) throw new AppError('drive_error', 'no webViewLink available for this file');
    return { webViewLink: file.webViewLink };
  }
}
