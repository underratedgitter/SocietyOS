import 'dotenv/config';
import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';

export interface AppEnv {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  redisUrl?: string;
  mqttUrl?: string;
  mqttUsername?: string;
  mqttPassword?: string;
  credentialHmacKey: string;
  credentialHmacKeyId: string;
  deviceSecretKey: Buffer;
  jwtAccessSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  webUrl: string;
  appBaseUrl: string;
  corsOrigins: string[];
  cookieSecure: boolean;
  swaggerEnabled: boolean;
  rateLimitEnabled: boolean;
  notificationWebhookUrl?: string;
  notificationWebhookSecret?: string;
  smsProvider: 'twilio' | 'msg91' | 'mock';
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromPhone?: string;
  msg91AuthKey?: string;
  msg91SenderId?: string;
  whatsappProvider: 'meta' | 'twilio' | 'mock';
  whatsappApiToken?: string;
  whatsappPhoneNumberId?: string;
  twilioWhatsappFrom?: string;
  expoAccessToken?: string;
  webPushContactEmail?: string;
  webPushPublicKey?: string;
  webPushPrivateKey?: string;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  razorpayWebhookSecret?: string;
  stripeSecretKey?: string;
  stripePublishableKey?: string;
  stripeWebhookSecret?: string;
}

const logger = new Logger('Config');
let cached: AppEnv | null = null;

function fail(message: string): never {
  throw new Error(`Invalid configuration: ${message}`);
}

function str(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) return value;
  if (fallback !== undefined) return fallback;
  return fail(`${name} is required`);
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fail(`${name} must be a boolean`);
}

function secret(name: string, devFallback: string, minLength = 32): string {
  const value = process.env[name]?.trim() || devFallback;
  if (value.length < minLength) fail(`${name} must be at least ${minLength} characters`);
  return value;
}

function httpUrl(name: string, fallback: string): string {
  const value = str(name, fallback);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${name} must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${name} must use http or https`);
  return value.replace(/\/$/, '');
}

export function loadEnv(): AppEnv {
  if (cached) return cached;

  const nodeEnv = (process.env.NODE_ENV || 'development') as AppEnv['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    fail('NODE_ENV must be development, test or production');
  }
  const isProduction = nodeEnv === 'production';
  const webUrl = httpUrl('WEB_URL', 'http://localhost:3000');
  const isLocal = webUrl.includes('localhost') || webUrl.includes('127.0.0.1');
  if (isProduction && !webUrl.startsWith('https://') && !isLocal) {
    fail('WEB_URL must use HTTPS in production');
  }

  const jwtAccessSecret = secret(
    'JWT_ACCESS_SECRET',
    'dev-only-access-secret-change-in-prod-32-bytes',
  );
  if (
    isProduction &&
    (jwtAccessSecret.includes('dev-only') || jwtAccessSecret.includes('change-in-prod'))
  ) {
    fail('JWT_ACCESS_SECRET still contains the development value');
  }

  const credentialHmacKey = secret(
    'CREDENTIAL_HMAC_KEY',
    'dev-only-credential-hmac-key-change-me-32-bytes',
  );
  if (
    isProduction &&
    (credentialHmacKey.includes('dev-only') || credentialHmacKey.includes('change-me'))
  ) {
    fail('CREDENTIAL_HMAC_KEY still contains the development value');
  }

  const configuredDeviceKey = process.env.DEVICE_SECRET_ENC_KEY?.trim();
  let deviceSecretKey: Buffer;
  if (configuredDeviceKey) {
    deviceSecretKey = Buffer.from(configuredDeviceKey, 'base64');
    if (deviceSecretKey.length !== 32) fail('DEVICE_SECRET_ENC_KEY must be 32 bytes of base64');
  } else {
    deviceSecretKey = createHash('sha256')
      .update(`${credentialHmacKey}:device-command-secret:v1`)
      .digest();
  }

  const corsOrigins = new Set<string>([webUrl]);
  for (const origin of (process.env.CORS_ORIGINS || '').split(',')) {
    const trimmed = origin.trim();
    if (trimmed) {
      try {
        new URL(trimmed);
      } catch {
        fail('CORS_ORIGINS contains an invalid URL');
      }
      corsOrigins.add(trimmed.replace(/\/$/, ''));
    }
  }

  cached = {
    nodeEnv,
    isProduction,
    port: int('API_PORT', 4000),
    databaseUrl: str('DATABASE_URL'),
    redisUrl: process.env.REDIS_URL?.trim() || undefined,
    mqttUrl: process.env.MQTT_URL?.trim() || undefined,
    mqttUsername: process.env.MQTT_USERNAME?.trim() || undefined,
    mqttPassword: process.env.MQTT_PASSWORD || undefined,
    credentialHmacKey,
    credentialHmacKeyId: process.env.CREDENTIAL_HMAC_KEY_ID?.trim() || 'v1',
    deviceSecretKey,
    jwtAccessSecret,
    jwtIssuer: process.env.JWT_ISSUER?.trim() || 'societyos-api',
    jwtAudience: process.env.JWT_AUDIENCE?.trim() || 'societyos-clients',
    webUrl,
    appBaseUrl: httpUrl('APP_BASE_URL', webUrl),
    corsOrigins: [...corsOrigins],
    cookieSecure: bool('COOKIE_SECURE', isProduction),
    swaggerEnabled: bool('ENABLE_SWAGGER', !isProduction),
    rateLimitEnabled: bool('RATE_LIMIT_ENABLED', true),
    notificationWebhookUrl: process.env.NOTIFICATION_WEBHOOK_URL?.trim() || undefined,
    notificationWebhookSecret: process.env.NOTIFICATION_WEBHOOK_SECRET?.trim() || undefined,
    smsProvider: (process.env.SMS_PROVIDER?.trim().toLowerCase() as AppEnv['smsProvider']) || 'mock',
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || undefined,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || undefined,
    twilioFromPhone: process.env.TWILIO_FROM_PHONE?.trim() || undefined,
    msg91AuthKey: process.env.MSG91_AUTH_KEY?.trim() || undefined,
    msg91SenderId: process.env.MSG91_SENDER_ID?.trim() || undefined,
    whatsappProvider: (process.env.WHATSAPP_PROVIDER?.trim().toLowerCase() as AppEnv['whatsappProvider']) || 'mock',
    whatsappApiToken: process.env.WHATSAPP_API_TOKEN?.trim() || undefined,
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || undefined,
    twilioWhatsappFrom: process.env.TWILIO_WHATSAPP_FROM?.trim() || undefined,
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN?.trim() || undefined,
    webPushContactEmail: process.env.WEB_PUSH_CONTACT_EMAIL?.trim() || undefined,
    webPushPublicKey: process.env.WEB_PUSH_PUBLIC_KEY?.trim() || undefined,
    webPushPrivateKey: process.env.WEB_PUSH_PRIVATE_KEY?.trim() || undefined,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID?.trim() || undefined,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET?.trim() || undefined,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || undefined,
    stripeSecretKey: process.env.STRIPE_SECRET_KEY?.trim() || undefined,
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() || undefined,
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined,
  };

  if (!isProduction && jwtAccessSecret.includes('dev-only')) {
    logger.warn('Using development secrets. Set production secrets before deployment.');
  }
  return cached;
}

/** Test helper: forget the cached environment after mutating process.env. */
export function resetEnvCacheForTests(): void {
  cached = null;
}
