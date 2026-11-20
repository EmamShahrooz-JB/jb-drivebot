import { describe, it, expect } from 'vitest';
import { parseQuery, parseSize } from '../../src/services/search.js';
import { buildSearchQuery } from '../../src/google-drive/files.js';

describe('parseQuery', () => {
  it('extracts name words', () => {
    expect(parseQuery('annual report').filters.nameContains).toBe('annual report');
  });

  it('extracts extension', () => {
    expect(parseQuery('invoice ext:pdf').filters.extension).toBe('pdf');
    expect(parseQuery('invoice ext:.PDF').filters.extension).toBe('pdf');
  });

  it('maps type shortcuts to mime', () => {
    expect(parseQuery('holiday type:video').filters.mimeType).toBe('video/');
    expect(parseQuery('book type:pdf').filters.mimeType).toBe('application/pdf');
  });

  it('parses size comparisons', () => {
    expect(parseQuery('a size:>10mb').filters.minSize).toBe(10 * 1024 ** 2);
    expect(parseQuery('a size:<1gb').filters.maxSize).toBe(1024 ** 3);
  });

  it('parses dates', () => {
    const q = parseQuery('a after:2026-01-01 before:2026-06-01');
    expect(q.filters.modifiedAfter?.toISOString().startsWith('2026-01-01')).toBe(true);
    expect(q.filters.modifiedBefore?.toISOString().startsWith('2026-06-01')).toBe(true);
  });

  it('ignores invalid tokens instead of throwing', () => {
    const q = parseQuery('a size:notanumber after:notadate');
    expect(q.filters.minSize).toBeUndefined();
    expect(q.filters.modifiedAfter).toBeUndefined();
  });
});

describe('parseSize', () => {
  it('understands units', () => {
    expect(parseSize('10')).toBe(10);
    expect(parseSize('10kb')).toBe(10240);
    expect(parseSize('1.5mb')).toBe(1572864);
  });
});

describe('buildSearchQuery', () => {
  it('always excludes trashed files by default', () => {
    expect(buildSearchQuery({})).toContain('trashed = false');
  });

  it('escapes single quotes to prevent q injection', () => {
    const q = buildSearchQuery({ nameContains: "o'brien" });
    expect(q).toContain("o\\'brien");
  });

  it('builds a compound query', () => {
    const q = buildSearchQuery({ nameContains: 'x', mimeType: 'image/png', parentId: 'abc', minSize: 10 });
    expect(q).toContain("name contains 'x'");
    expect(q).toContain("mimeType = 'image/png'");
    expect(q).toContain("'abc' in parents");
    expect(q).toContain('quotaBytesUsed >= 10');
  });
});
