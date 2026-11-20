/**
 * Telegram caps `callback_data` at 64 bytes, while Drive file ids are 33-44
 * characters. Rather than truncate ids (ambiguous) we keep a short-lived map of
 * opaque handles -> file metadata. Handles are random, so a forged button can
 * only ever point at something the admin actually saw.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface FileRef {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  parents?: string[];
  webViewLink?: string;
}

interface Entry {
  ref: FileRef;
  expiresAt: number;
}

export class RefStore {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.maxEntries = opts.maxEntries ?? 1000;
  }

  private newId(): string {
    const bytes = randomBytes(6);
    let out = '';
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
    return out;
  }

  put(ref: FileRef): string {
    this.gc();
    const id = this.newId();
    this.entries.set(id, { ref, expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(id: string): FileRef | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(id);
      return null;
    }
    return entry.ref;
  }

  /** Replace a whole result page at once (used by search / list views). */
  putMany(refs: FileRef[]): string[] {
    return refs.map((r) => this.put(r));
  }

  gc(): void {
    const now = Date.now();
    for (const [k, v] of this.entries) if (v.expiresAt < now) this.entries.delete(k);
    if (this.entries.size > this.maxEntries) {
      const excess = this.entries.size - this.maxEntries;
      let removed = 0;
      for (const k of this.entries.keys()) {
        this.entries.delete(k);
        if (++removed >= excess) break;
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Short-lived per-chat UI state for multi step flows (rename, search input...). */
export type PendingAction =
  | { kind: 'rename'; ref: string }
  | { kind: 'mkdir'; parentFolderId: string; parentPath: string }
  | { kind: 'search'; }
  | { kind: 'move'; ref: string }
  | { kind: 'newFolderPath' }
  | { kind: 'renameFolder'; folderId: string };

export class SessionStore {
  private readonly sessions = new Map<number, { action: PendingAction; expiresAt: number }>();
  private readonly ttlMs: number;
  constructor(ttlMs = 10 * 60_000) {
    this.ttlMs = ttlMs;
  }
  set(chatId: number, action: PendingAction): void {
    this.sessions.set(chatId, { action, expiresAt: Date.now() + this.ttlMs });
  }
  get(chatId: number): PendingAction | null {
    const entry = this.sessions.get(chatId);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.sessions.delete(chatId);
      return null;
    }
    return entry.action;
  }
  clear(chatId: number): void {
    this.sessions.delete(chatId);
  }
}
