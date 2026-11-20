import { describe, it, expect } from 'vitest';
import { categorize, planFolders, proposeName, extOf } from '../../src/organizer/classify.js';
import { guessMime } from '../../src/utils/mime.js';

describe('categorize', () => {
  it('classifies by extension', () => {
    expect(categorize('holiday.JPG')).toBe('Images');
    expect(categorize('clip.mkv')).toBe('Videos');
    expect(categorize('song.flac')).toBe('Audio');
    expect(categorize('report.pdf')).toBe('Documents');
    expect(categorize('backup.tar.gz')).toBe('Archives');
    expect(categorize('setup.exe')).toBe('Applications');
    expect(categorize('index.ts')).toBe('Code');
    expect(categorize('weird.qqq')).toBe('Other');
  });

  it('falls back to mime type when the extension is unknown', () => {
    expect(categorize('noext', 'video/mp4')).toBe('Videos');
    expect(categorize('noext', 'application/pdf')).toBe('Documents');
    expect(categorize('noext', 'image/webp')).toBe('Images');
  });

  it('extracts extensions safely', () => {
    expect(extOf('a.b.C')).toBe('c');
    expect(extOf('noext')).toBe('');
  });
});

describe('planFolders', () => {
  const date = new Date('2026-11-20T10:00:00Z');

  it('builds Category/Year/Month for type-date', () => {
    expect(planFolders({ mode: 'type-date', rootPath: '', fileName: 'a.mp4', date })).toEqual(['Videos', '2026', 'November']);
  });

  it('builds type only', () => {
    expect(planFolders({ mode: 'type', rootPath: '', fileName: 'a.pdf', date })).toEqual(['Documents']);
  });

  it('builds by extension', () => {
    expect(planFolders({ mode: 'extension', rootPath: '', fileName: 'a.mp4', date })).toEqual(['Videos', 'MP4']);
  });

  it('builds date only', () => {
    expect(planFolders({ mode: 'date', rootPath: '', fileName: 'a.bin', date })).toEqual(['2026', 'November']);
  });

  it('returns nothing when disabled', () => {
    expect(planFolders({ mode: 'none', rootPath: '', fileName: 'a.bin', date })).toEqual([]);
  });

  it('keeps a configured root prefix', () => {
    expect(planFolders({ mode: 'type', rootPath: 'Nested/Root', fileName: 'a.pdf', date })).toEqual(['Nested', 'Root', 'Documents']);
  });
});

describe('proposeName', () => {
  it('slugifies and stamps the date', () => {
    const name = proposeName('My Report Final!.PDF', { date: new Date('2026-11-20T00:00:00Z') });
    expect(name).toBe('My-Report-Final-20261120.pdf');
  });

  it('does not double-stamp an existing date', () => {
    expect(proposeName('scan-20260101.jpg', { date: new Date('2026-11-20T00:00:00Z') })).toBe('scan-20260101.jpg');
  });
});

describe('guessMime', () => {
  it('prefers a real provided mime', () => {
    expect(guessMime('x.bin', 'application/pdf')).toBe('application/pdf');
  });
  it('ignores octet-stream and uses the extension', () => {
    expect(guessMime('photo.png', 'application/octet-stream')).toBe('image/png');
  });
  it('falls back to octet-stream', () => {
    expect(guessMime('unknown.zzz')).toBe('application/octet-stream');
  });
});
