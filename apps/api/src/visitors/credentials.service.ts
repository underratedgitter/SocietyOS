import { createHmac, randomBytes, randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { CredentialType } from '@prisma/client';
import { getEnv } from '../config';

export interface GeneratedCredential {
  type: CredentialType;
  plaintext: string;
}

/**
 * Credentials are verified through a keyed HMAC and are never stored or logged
 * in plaintext. The key id is persisted so future rotations can be planned.
 */
@Injectable()
export class CredentialsService {
  hash(credential: string): string {
    const env = getEnv();
    return createHmac('sha256', `${env.credentialHmacKeyId}:${env.credentialHmacKey}`)
      .update(credential)
      .digest('hex');
  }

  generatePin(): GeneratedCredential {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { type: CredentialType.PIN, plaintext: pin };
  }

  generateQrToken(): GeneratedCredential {
    return { type: CredentialType.QR, plaintext: randomBytes(24).toString('base64url') };
  }

  get keyVersion(): string {
    return getEnv().credentialHmacKeyId;
  }
}
