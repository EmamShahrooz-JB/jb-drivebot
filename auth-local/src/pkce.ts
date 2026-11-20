import { createHash, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * This file is intentionally dependency free (node builtins only): the
 * authenticator has to run on the operator's laptop with nothing but Node
 * installed, and must never import the server application.
 */

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkce(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const createState = (): string => randomBytes(24).toString('base64url');

/** Must match deriveTransferKey() in the server's pairing module. */
export function deriveTransferKey(code: string): Buffer {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(normalized, 'utf8'),
      Buffer.from('jb-drivebot-pairing'),
      Buffer.from('jb-drivebot/pairing-transfer/v1'),
      32
    )
  );
}

export function sealWithTransferKey(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openWithTransferKey(key: Buffer, sealedB64: string): string {
  const raw = Buffer.from(sealedB64, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export const timingSafeEqualStr = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
};
