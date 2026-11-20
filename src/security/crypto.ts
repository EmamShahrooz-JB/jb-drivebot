import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
  hkdfSync,
  createHmac,
} from 'node:crypto';

const ALG = 'aes-256-gcm';
const VERSION = 'v1';

export class SecretBox {
  private readonly masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
    this.masterKey = masterKey;
  }

  static fromBase64(keyB64: string): SecretBox {
    const buf = Buffer.from(keyB64, 'base64');
    if (buf.length !== 32) {
      throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes (openssl rand -base64 32)');
    }
    return new SecretBox(buf);
  }

  /** Derive a purpose-bound subkey so different data types never share a key. */
  derive(purpose: string): Buffer {
    const out = hkdfSync('sha256', this.masterKey, Buffer.from('jb-drivebot'), Buffer.from(purpose), 32);
    return Buffer.from(out);
  }

  /** Seal a secret. Output: v1:<iv>:<tag>:<ciphertext> (all base64url). */
  seal(plaintext: string, purpose = 'default', aad = ''): string {
    const key = this.derive(purpose);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join(':');
  }

  open(sealed: string, purpose = 'default', aad = ''): string {
    const parts = sealed.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('malformed sealed value');
    const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
    const key = this.derive(purpose);
    const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, 'base64url'));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // still perform a comparison to keep timing roughly constant
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Symmetric signing used for Telegram callback data. This is what stops a user
 * (or a forwarded/replayed button) from forging "yes, delete this file".
 */
export class Signer {
  constructor(private readonly key: Buffer) {
    if (key.length < 16) throw new Error('signer key too short');
  }
  mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url').slice(0, 22);
  }
  /** payload|exp|mac  — exp is unix seconds */
  sign(payload: string, ttlSeconds: number, now = Date.now()): string {
    const exp = Math.floor(now / 1000) + ttlSeconds;
    const body = `${payload}|${exp}`;
    return `${body}|${this.mac(body)}`;
  }
  verify(token: string, now = Date.now()): { ok: true; payload: string } | { ok: false; reason: string } {
    const idx = token.lastIndexOf('|');
    if (idx < 0) return { ok: false, reason: 'malformed' };
    const mac = token.slice(idx + 1);
    const body = token.slice(0, idx);
    if (!safeEqual(mac, this.mac(body))) return { ok: false, reason: 'bad_signature' };
    const expIdx = body.lastIndexOf('|');
    if (expIdx < 0) return { ok: false, reason: 'malformed' };
    const exp = Number(body.slice(expIdx + 1));
    if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false, reason: 'expired' };
    return { ok: true, payload: body.slice(0, expIdx) };
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
