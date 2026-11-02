import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { getEnv } from '../config';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateTemporaryPassword(): string {
  // 16 URL-safe characters (~96 bits), always satisfies password policy.
  return randomBytes(12).toString('base64url');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key || result[key] !== undefined) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

/** AES-256-GCM at rest protection for per-device command signing secrets. */
export function encryptDeviceSecret(plaintext: string): string {
  const key = getEnv().deviceSecretKey;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptDeviceSecret(payload: string): string {
  const key = getEnv().deviceSecretKey;
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 29) throw new Error('Malformed encrypted device secret');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export interface SignableCommand {
  commandId: string;
  deviceId: string;
  accessPointId: string;
  type: 'OPEN' | 'CLOSE' | 'STOP';
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

/** Canonical string shared by the API signer and the edge controller verifier. */
export function commandSigningString(command: SignableCommand): string {
  return [
    'societyos-command-v1',
    command.commandId,
    command.deviceId,
    command.accessPointId,
    command.type,
    command.nonce,
    command.issuedAt,
    command.expiresAt,
  ].join('\n');
}

export function signCommand(command: SignableCommand, secret: string): string {
  return createHmac('sha256', secret).update(commandSigningString(command)).digest('base64url');
}

export function verifyCommand(command: SignableCommand, secret: string, signature: string): boolean {
  return constantTimeEqual(signCommand(command, secret), signature);
}

export interface AckSignature {
  commandId: string;
  status: 'ACK' | 'EXECUTED' | 'FAILED';
  nonce: string;
  gateState?: string;
  signedAt: string;
}

export function ackSigningString(ack: AckSignature): string {
  return [
    'societyos-ack-v1',
    ack.commandId,
    ack.status,
    ack.nonce,
    ack.gateState || '',
    ack.signedAt,
  ].join('\n');
}

export function signAck(ack: AckSignature, secret: string): string {
  return createHmac('sha256', secret).update(ackSigningString(ack)).digest('base64url');
}

export function verifyAck(ack: AckSignature, secret: string, signature: string): boolean {
  return constantTimeEqual(signAck(ack, secret), signature);
}
