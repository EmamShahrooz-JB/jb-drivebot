import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SecretBox, Signer, safeEqual } from '../../src/security/crypto.js';

describe('SecretBox', () => {
  const box = new SecretBox(randomBytes(32));

  it('round-trips a secret', () => {
    const sealed = box.seal('1//refresh-token-value', 'google-refresh-token', 'aad');
    expect(sealed).not.toContain('1//refresh-token-value');
    expect(box.open(sealed, 'google-refresh-token', 'aad')).toBe('1//refresh-token-value');
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = box.seal('same', 'p');
    const b = box.seal('same', 'p');
    expect(a).not.toBe(b);
  });

  it('rejects a wrong purpose (key separation)', () => {
    const sealed = box.seal('secret', 'purpose-a');
    expect(() => box.open(sealed, 'purpose-b')).toThrow();
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const sealed = box.seal('secret', 'p');
    const parts = sealed.split(':');
    const ct = Buffer.from(parts[3]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString('base64url');
    expect(() => box.open(parts.join(':'), 'p')).toThrow();
  });

  it('rejects a mismatched AAD', () => {
    const sealed = box.seal('secret', 'p', 'tenant-1');
    expect(() => box.open(sealed, 'p', 'tenant-2')).toThrow();
  });

  it('derives independent subkeys per purpose', () => {
    expect(box.derive('a').equals(box.derive('b'))).toBe(false);
    expect(box.derive('a').equals(box.derive('a'))).toBe(true);
  });

  it('refuses a short master key', () => {
    expect(() => SecretBox.fromBase64(Buffer.from('short').toString('base64'))).toThrow();
  });
});

describe('Signer', () => {
  const signer = new Signer(randomBytes(32));

  it('verifies a fresh token and returns the payload', () => {
    const token = signer.sign('d:ABC123', 60);
    const res = signer.verify(token);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.payload).toBe('d:ABC123');
  });

  it('rejects an expired token', () => {
    const token = signer.sign('d:ABC123', 1, Date.now() - 10_000);
    const res = signer.verify(token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  it('rejects a forged payload with a valid-looking mac', () => {
    const good = signer.sign('d:ABC123', 60);
    const [, exp, mac] = good.split('|');
    const forged = `d:EVIL99|${exp}|${mac}`;
    const res = signer.verify(forged);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('bad_signature');
  });

  it('rejects a token signed with another key', () => {
    const other = new Signer(randomBytes(32));
    expect(signer.verify(other.sign('x', 60)).ok).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(signer.verify('garbage').ok).toBe(false);
    expect(signer.verify('').ok).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
