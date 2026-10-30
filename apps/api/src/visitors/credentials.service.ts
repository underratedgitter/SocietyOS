import { createHmac, randomBytes, randomInt } from 'crypto';
import { Injectable } from '@nestjs/common';
import { CredentialType } from '@prisma/client';

export interface GeneratedCredential {
  type: CredentialType;
  plaintext: string; // returned to the creator once; only the HMAC is stored
}

/**
 * Credentials are verified via keyed HMAC (versioned key id) — plaintext PINs
 * and QR tokens are never stored or logged (blueprint §8).
 */
@Injectable()
export class CredentialsService {
  private keyId = process.env.CREDENTIAL_HMAC_KEY_ID || 'v1';
  private key = process.env.CREDENTIAL_HMAC_KEY || 'dev-only-change-me-32-bytes-minimum!!';

  hash(credential: string): string {
    return createHmac('sha256', `${this.keyId}:${this.key}`).update(credential).digest('hex');
  }

  /** 6-digit numeric PIN with limited lifetime — not strong auth alone (rate limited upstream). */
  generatePin(): GeneratedCredential {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    return { type: CredentialType.PIN, plaintext: pin };
  }

  /** High-entropy opaque QR token; no personal data embedded. */
  generateQrToken(): GeneratedCredential {
    return { type: CredentialType.QR, plaintext: randomBytes(24).toString('base64url') };
  }

  get keyVersion(): string {
    return this.keyId;
  }
}
