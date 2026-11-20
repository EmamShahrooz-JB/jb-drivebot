import { describe, it, expect } from 'vitest';
import { safeFileName, resolveInside, truncate, escapeHtml } from '../../src/security/sanitize.js';

describe('safeFileName', () => {
  it('strips path separators', () => {
    expect(safeFileName('../../etc/passwd')).not.toContain('/');
    expect(safeFileName('a/b/c.txt')).toBe('a_b_c.txt');
  });

  it('removes control characters and bidi overrides', () => {
    expect(safeFileName('a\u0000b\u202ec.txt')).toBe('abc.txt');
  });

  it('never returns an empty name', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('...')).toBe('file');
  });

  it('escapes windows reserved names', () => {
    expect(safeFileName('CON.txt')).toMatch(/^_/);
    expect(safeFileName('nul')).toMatch(/^_/);
  });

  it('truncates long names but keeps the extension', () => {
    const name = safeFileName('a'.repeat(500) + '.pdf');
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });

  it('collapses whitespace', () => {
    expect(safeFileName('a    b.txt')).toBe('a b.txt');
  });
});

describe('resolveInside', () => {
  it('accepts nested files', () => {
    expect(resolveInside('/tmp/base', 'a/b.txt')).toBe('/tmp/base/a/b.txt');
  });
  it('blocks traversal', () => {
    expect(() => resolveInside('/tmp/base', '../evil')).toThrow();
    expect(() => resolveInside('/tmp/base', 'a/../../evil')).toThrow();
  });
  it('blocks absolute paths', () => {
    expect(() => resolveInside('/tmp/base', '/etc/passwd')).toThrow();
  });
});

describe('misc helpers', () => {
  it('truncates with an ellipsis', () => {
    expect(truncate('abcdef', 3)).toBe('ab…');
    expect(truncate('ab', 5)).toBe('ab');
  });
  it('escapes html', () => {
    expect(escapeHtml('<b>&')).toBe('&lt;b&gt;&amp;');
  });
});
