import path from 'node:path';

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Make an arbitrary (possibly attacker supplied) string safe as a Drive/file name. */
export function safeFileName(input: string, opts: { fallback?: string; maxLength?: number } = {}): string {
  const maxLength = opts.maxLength ?? 200;
  let name = (input || '').replace(CONTROL_CHARS, '').replace(/[\\/]+/g, '_').trim();
  name = name.replace(/[\u200e\u200f\u202a-\u202e]/g, ''); // bidi overrides
  name = name.replace(/\s+/g, ' ');
  name = name.replace(/^\.+/, '').replace(/\.+$/, (m) => (m === '.' ? '' : m.slice(0, 0)));
  if (!name) name = opts.fallback ?? 'file';
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > maxLength) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, maxLength - ext.length) + ext;
  }
  return name;
}

/** Reject absolute paths and traversal; resolve inside a base dir. */
export function resolveInside(baseDir: string, candidate: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, candidate);
  const rel = path.relative(base, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes base directory: ${candidate}`);
  }
  return resolved;
}

export function extOf(name: string): string {
  const ext = path.extname(name).toLowerCase().replace(/^\./, '');
  return ext;
}

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return input.slice(0, Math.max(0, max - 1)) + '…';
}
