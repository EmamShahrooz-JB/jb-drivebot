import { describe, it, expect } from 'vitest';
import { deriveTransferKey as serverKey, sealWithTransferKey as serverSeal, openWithTransferKey as serverOpen } from '../../src/server/pairing-server.js';
import { deriveTransferKey as clientKey, sealWithTransferKey as clientSeal, openWithTransferKey as clientOpen } from '../../auth-local/src/pkce.js';

/**
 * The authenticator is a standalone program that cannot import the server, so
 * the key derivation and sealing code is duplicated. These tests guarantee the
 * two copies stay byte-compatible — a mismatch would silently break pairing.
 */
describe('authenticator <-> server crypto compatibility', () => {
  const codes = ['K7QP-3MZX', 'ABCD-2345', 'zzzz-9999'];

  it('derives the same transfer key', () => {
    for (const code of codes) {
      expect(clientKey(code).equals(serverKey(code)), code).toBe(true);
    }
  });

  it('ignores case and separators the same way', () => {
    expect(clientKey('k7qp3mzx').equals(serverKey('K7QP-3MZX'))).toBe(true);
  });

  it('can open a payload sealed by the other side', () => {
    const code = 'K7QP-3MZX';
    const sealedByClient = clientSeal(clientKey(code), JSON.stringify({ refreshToken: '1//abc' }));
    expect(JSON.parse(serverOpen(serverKey(code), sealedByClient))).toEqual({ refreshToken: '1//abc' });

    const sealedByServer = serverSeal(serverKey(code), 'hello');
    expect(clientOpen(clientKey(code), sealedByServer)).toBe('hello');
  });

  it('fails to open with a different pairing code', () => {
    const sealed = clientSeal(clientKey('K7QP-3MZX'), 'secret');
    expect(() => serverOpen(serverKey('AAAA-2222'), sealed)).toThrow();
  });
});
