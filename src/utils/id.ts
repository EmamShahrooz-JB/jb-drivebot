import { randomUUID, randomBytes, createHash } from 'node:crypto';

export const uuid = (): string => randomUUID();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 ambiguity

/** Human friendly one-time pairing code, e.g. "K7QP-3MZX". ~40 bits of entropy. */
export function pairingCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    if (i === 3 && length === 8) out += '-';
  }
  return out;
}

export const sha256Hex = (buf: Buffer | string): string =>
  createHash('sha256').update(buf).digest('hex');

export const sha256Base64Url = (buf: Buffer | string): string =>
  createHash('sha256').update(buf).digest('base64url');
