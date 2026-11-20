export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime?: string;
  modifiedTime?: string;
  webViewLink?: string;
  webContentLink?: string;
  iconLink?: string;
  parents?: string[];
  trashed?: boolean;
  md5Checksum?: string;
  sha256Checksum?: string;
  quotaBytesUsed?: string;
  owners?: Array<{ emailAddress?: string; displayName?: string }>;
  shortcutDetails?: { targetId?: string };
  imageMediaMetadata?: Record<string, unknown>;
  videoMediaMetadata?: Record<string, unknown>;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

export interface StorageQuota {
  limit?: string;
  usage?: string;
  usageInDrive?: string;
  usageInDriveTrash?: string;
}

export interface AboutInfo {
  storageQuota?: StorageQuota;
  user?: { emailAddress?: string; displayName?: string; permissionId?: string };
}

export interface Permission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  domain?: string;
  allowFileDiscovery?: boolean;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const FILE_FIELDS =
  'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents,trashed,md5Checksum,quotaBytesUsed';

export interface SearchFilters {
  nameContains?: string;
  mimeType?: string;
  extension?: string;
  parentId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  modifiedAfter?: Date;
  modifiedBefore?: Date;
  minSize?: number;
  maxSize?: number;
  includeTrashed?: boolean;
  fullText?: string;
}
