import dnsCallback from 'node:dns';
import dnsPromises from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard for the link downloader.
 *
 * Everything here is deny-by-default: a URL is only fetched when it resolves
 * exclusively to public unicast addresses, and every redirect hop is
 * re-validated from scratch (a redirect is the classic SSRF bypass).
 */

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'metadata.aws.internal',
]);

export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`bad ipv4: ${ip}`);
  }
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export function isBlockedIpv4(ip: string): boolean {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

export function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0]!;
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(lower)) return true; // unique local fc00::/7
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped ::ffff:127.0.0.1
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedIpv4(mapped[1]!);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (lower.startsWith('2002:')) return true; // 6to4 can encapsulate private v4
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not an IP -> treat as blocked
}

export class SsrfError extends Error {
  constructor(
    message: string,
    readonly code = 'ssrf_blocked'
  ) {
    super(message);
    this.name = 'SsrfError';
  }
}

export interface ValidatedTarget {
  url: URL;
  hostname: string;
  addresses: string[];
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_PORTS = new Set([22, 23, 25, 110, 143, 445, 993, 995, 3306, 5432, 6379, 11211, 27017]);

export interface Resolver {
  (hostname: string): Promise<Array<{ address: string; family: number }>>;
}

const defaultResolver: Resolver = async (hostname) => {
  const results = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return results;
};

/**
 * Validate a URL for outbound fetching: scheme, credentials, port, hostname
 * blocklist and DNS resolution. Every resolved address must be public.
 */
export interface ValidateOptions {
  resolver?: Resolver;
  /**
   * Escape hatch used only by the integration tests (a local stub server).
   * The application never sets this in production — see config guard in
   * HttpDownloader, which refuses it unless NODE_ENV !== 'production'.
   */
  allowLoopback?: boolean;
}

export async function validateTarget(rawUrl: string, opts: ValidateOptions = {}): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('URL is not valid', 'invalid_url');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new SsrfError(`protocol ${url.protocol} is not allowed`, 'bad_protocol');
  }
  if (url.username || url.password) {
    throw new SsrfError('URLs with embedded credentials are not allowed', 'credentials_in_url');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (BLOCKED_PORTS.has(port)) {
    throw new SsrfError(`port ${port} is not allowed`, 'bad_port');
  }

  const loopbackAllowed = opts.allowLoopback === true;
  const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1';

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) throw new SsrfError('missing hostname', 'invalid_url');
  if (BLOCKED_HOSTNAMES.has(hostname) && !loopbackAllowed) {
    throw new SsrfError(`host ${hostname} is blocked`, 'blocked_host');
  }
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    throw new SsrfError(`host ${hostname} is blocked`, 'blocked_host');
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname) && !(loopbackAllowed && isLoopback(hostname))) {
      throw new SsrfError(`ip ${hostname} is private or reserved`, 'blocked_ip');
    }
    return { url, hostname, addresses: [hostname] };
  }

  const resolver = opts.resolver ?? defaultResolver;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new SsrfError(`cannot resolve ${hostname}`, 'dns_failure');
  }
  if (addresses.length === 0) throw new SsrfError(`cannot resolve ${hostname}`, 'dns_failure');
  for (const a of addresses) {
    if (isBlockedIp(a.address) && !(loopbackAllowed && isLoopback(a.address))) {
      throw new SsrfError(`${hostname} resolves to a private address (${a.address})`, 'blocked_ip');
    }
  }
  return { url, hostname, addresses: addresses.map((a) => a.address) };
}

/**
 * A `lookup` implementation for node:http(s) that re-checks the address at
 * connect time. This closes the DNS-rebinding window between validation and
 * the actual TCP connection.
 */
export function guardedLookup(expected: string[]) {
  return (
    hostname: string,
    options: { family?: number; all?: boolean },
    callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void
  ): void => {
    const finish = (address: string, family: number) => {
      if (isBlockedIp(address)) {
        const err: NodeJS.ErrnoException = new Error(`ssrf: ${hostname} -> ${address} is blocked`);
        err.code = 'ESSRFBLOCKED';
        callback(err, '');
        return;
      }
      if (expected.length > 0 && !expected.includes(address)) {
        const err: NodeJS.ErrnoException = new Error(`ssrf: ${hostname} resolved to unexpected address ${address}`);
        err.code = 'ESSRFBLOCKED';
        callback(err, '');
        return;
      }
      if (options?.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };

    if (expected.length > 0) {
      const first = expected[0]!;
      finish(first, net.isIP(first));
      return;
    }
    dnsCallback.lookup(hostname, { family: options?.family ?? 0 }, (err, address, family) => {
      if (err) {
        callback(err, '');
        return;
      }
      finish(address, family);
    });
  };
}
