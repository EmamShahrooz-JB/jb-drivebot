import { describe, it, expect } from 'vitest';
import {
  isBlockedIpv4,
  isBlockedIpv6,
  isBlockedIp,
  validateTarget,
  guardedLookup,
  SsrfError,
} from '../../src/security/ssrf.js';

const resolverFor =
  (map: Record<string, string[]>) =>
  async (hostname: string): Promise<Array<{ address: string; family: number }>> => {
    const addrs = map[hostname];
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

describe('IP blocklist', () => {
  it('blocks private, loopback, link-local and metadata ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // AWS/GCP metadata
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '192.0.2.10',
      '198.18.0.1',
    ]) {
      expect(isBlockedIpv4(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.185.78', '203.0.114.1']) {
      expect(isBlockedIpv4(ip), ip).toBe(false);
    }
  });

  it('blocks ipv6 loopback, ULA, link-local and v4-mapped private', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '2002:7f00:1::1']) {
      expect(isBlockedIpv6(ip), ip).toBe(true);
    }
    expect(isBlockedIpv6('2606:4700:4700::1111')).toBe(false);
  });

  it('treats non-IP input as blocked', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('validateTarget', () => {
  it('accepts a public host', async () => {
    const res = await validateTarget('https://example.com/file.zip', { resolver: resolverFor({ 'example.com': ['93.184.216.34'] }) });
    expect(res.hostname).toBe('example.com');
    expect(res.addresses).toEqual(['93.184.216.34']);
  });

  it('rejects non-http protocols', async () => {
    await expect(validateTarget('file:///etc/passwd')).rejects.toBeInstanceOf(SsrfError);
    await expect(validateTarget('gopher://example.com/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects credentials in the URL', async () => {
    await expect(validateTarget('https://user:pass@example.com/x')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects a host that resolves to a private IP (DNS rebinding attempt)', async () => {
    await expect(
      validateTarget('https://evil.example.com/', { resolver: resolverFor({ 'evil.example.com': ['127.0.0.1'] }) })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects when any resolved address is private', async () => {
    await expect(
      validateTarget('https://mixed.example.com/', { resolver: resolverFor({ 'mixed.example.com': ['93.184.216.34', '10.0.0.9'] }) })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects metadata hostnames and .internal domains', async () => {
    await expect(validateTarget('http://metadata.google.internal/computeMetadata/v1/')).rejects.toBeInstanceOf(SsrfError);
    await expect(validateTarget('http://foo.internal/')).rejects.toBeInstanceOf(SsrfError);
    await expect(validateTarget('http://localhost:8080/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects dangerous ports', async () => {
    await expect(validateTarget('https://example.com:6379/')).rejects.toBeInstanceOf(SsrfError);
  });

  it('rejects an unresolvable host', async () => {
    await expect(validateTarget('https://nope.invalid/', { resolver: resolverFor({}) })).rejects.toBeInstanceOf(SsrfError);
  });
});

describe('guardedLookup', () => {
  const run = (expected: string[]) =>
    new Promise<{ err: NodeJS.ErrnoException | null; address?: string }>((resolve) => {
      const lookup = guardedLookup(expected);
      lookup('whatever', {}, (err, address) => {
        resolve({ err, address: typeof address === 'string' ? address : undefined });
      });
    });

  it('connects only to the pre-validated address', async () => {
    const out = await run(['93.184.216.34']);
    expect(out.err).toBeNull();
    expect(out.address).toBe('93.184.216.34');
  });

  it('blocks a rebind to loopback at connect time', async () => {
    const out = await run(['127.0.0.1']);
    expect(out.err?.code).toBe('ESSRFBLOCKED');
  });

  it('pins the connection to the validated address (ignores later DNS answers)', async () => {
    // Even if an attacker rebinds DNS between validation and connect, the socket
    // goes to the address we already verified.
    const out = await run(['93.184.216.34']);
    expect(out.address).toBe('93.184.216.34');
  });

  it('falls back to a fresh DNS lookup (and blocks) when no address was pinned', async () => {
    const lookup = guardedLookup([]);
    await new Promise<void>((resolve) => {
      lookup('localhost', {}, (err) => {
        expect(err?.code).toBe('ESSRFBLOCKED');
        resolve();
      });
    });
  });
});
