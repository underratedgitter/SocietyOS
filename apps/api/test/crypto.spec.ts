import { decryptDeviceSecret, encryptDeviceSecret, parseCookies } from '../src/common/crypto.util';

describe('device command secret storage', () => {
  const secret = 'command-secret-that-must-not-be-stored-in-plaintext';

  it('round-trips a secret without embedding the plaintext', () => {
    const encrypted = encryptDeviceSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptDeviceSecret(encrypted)).toBe(secret);

    const again = encryptDeviceSecret(secret);
    expect(again).not.toBe(encrypted);
    expect(decryptDeviceSecret(again)).toBe(secret);
  });

  it('rejects a tampered ciphertext instead of returning corrupt data', () => {
    const bytes = Buffer.from(encryptDeviceSecret(secret), 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    expect(() => decryptDeviceSecret(bytes.toString('base64'))).toThrow();
  });

  it('rejects a truncated payload', () => {
    expect(() => decryptDeviceSecret('c2hvcnQ=')).toThrow('Malformed encrypted device secret');
  });
});

describe('parseCookies', () => {
  it('decodes values and keeps the first occurrence of a duplicated cookie', () => {
    expect(parseCookies('sos_at=one%20two; other=3; sos_at=ignored')).toEqual({
      sos_at: 'one two',
      other: '3',
    });
  });

  it('returns an empty object for absent or malformed headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('flag; empty=')).toEqual({ empty: '' });
  });
});
