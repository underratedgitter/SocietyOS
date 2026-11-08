import { loadEnv, resetEnvCacheForTests } from '../src/config/env';

const MANAGED_KEYS = [
  'NODE_ENV',
  'WEB_URL',
  'JWT_ACCESS_SECRET',
  'CREDENTIAL_HMAC_KEY',
  'SMS_PROVIDER',
  'WHATSAPP_PROVIDER',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_PHONE',
  'TWILIO_WHATSAPP_FROM',
  'MSG91_AUTH_KEY',
  'MSG91_SENDER_ID',
  'WHATSAPP_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'REDIS_URL',
  'RATE_LIMIT_ENABLED',
] as const;

describe('loadEnv notification provider validation', () => {
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      original.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
    resetEnvCacheForTests();
  });

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  });

  function useProduction(): void {
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'https://society.example.com';
    process.env.JWT_ACCESS_SECRET = 'prod-access-secret-0123456789abcdef0123456789';
    process.env.CREDENTIAL_HMAC_KEY = 'prod-credential-key-0123456789abcdef0123456789';
    process.env.REDIS_URL = 'redis://:secret@redis:6379';
  }

  it('defaults both providers to mock when unset', () => {
    const env = loadEnv();
    expect(env.smsProvider).toBe('mock');
    expect(env.whatsappProvider).toBe('mock');
  });

  it('normalises case and whitespace for known providers', () => {
    process.env.SMS_PROVIDER = ' MSG91 ';
    process.env.WHATSAPP_PROVIDER = 'Meta';
    const env = loadEnv();
    expect(env.smsProvider).toBe('msg91');
    expect(env.whatsappProvider).toBe('meta');
  });

  it('rejects a misspelled SMS provider instead of silently using the mock dispatcher', () => {
    process.env.SMS_PROVIDER = 'twillio';
    expect(() => loadEnv()).toThrow('SMS_PROVIDER must be one of twilio, msg91, mock');
  });

  it('rejects an unknown WhatsApp provider', () => {
    process.env.WHATSAPP_PROVIDER = 'gupshup';
    expect(() => loadEnv()).toThrow('WHATSAPP_PROVIDER must be one of meta, twilio, mock');
  });

  it('fails fast in production when the selected SMS provider lacks credentials', () => {
    useProduction();
    process.env.SMS_PROVIDER = 'twilio';
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    expect(() => loadEnv()).toThrow(
      'TWILIO_AUTH_TOKEN, TWILIO_FROM_PHONE required in production when SMS_PROVIDER=twilio',
    );
  });

  it('fails fast in production when the selected WhatsApp provider lacks credentials', () => {
    useProduction();
    process.env.WHATSAPP_PROVIDER = 'meta';
    expect(() => loadEnv()).toThrow(
      'WHATSAPP_API_TOKEN, WHATSAPP_PHONE_NUMBER_ID required in production when WHATSAPP_PROVIDER=meta',
    );
  });

  it('accepts a fully configured production provider', () => {
    useProduction();
    process.env.SMS_PROVIDER = 'msg91';
    process.env.MSG91_AUTH_KEY = 'auth-key';
    process.env.MSG91_SENDER_ID = 'SOCOS';
    expect(loadEnv().smsProvider).toBe('msg91');
  });

  it('does not require provider credentials outside production', () => {
    process.env.SMS_PROVIDER = 'twilio';
    expect(loadEnv().smsProvider).toBe('twilio');
  });
});

describe('loadEnv Redis requirement for rate limiting', () => {
  const keys = ['NODE_ENV', 'WEB_URL', 'JWT_ACCESS_SECRET', 'CREDENTIAL_HMAC_KEY', 'REDIS_URL', 'RATE_LIMIT_ENABLED'];
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of keys) {
      original.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/db';
    process.env.NODE_ENV = 'production';
    process.env.WEB_URL = 'https://society.example.com';
    process.env.JWT_ACCESS_SECRET = 'prod-access-secret-0123456789abcdef0123456789';
    process.env.CREDENTIAL_HMAC_KEY = 'prod-credential-key-0123456789abcdef0123456789';
    resetEnvCacheForTests();
  });

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCacheForTests();
  });

  it('refuses to start in production without REDIS_URL while rate limiting is enabled', () => {
    expect(() => loadEnv()).toThrow('REDIS_URL required in production when rate limiting is enabled');
  });

  it('starts in production when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://:secret@redis:6379';
    expect(loadEnv().redisUrl).toBe('redis://:secret@redis:6379');
  });

  it('keeps the in-memory fallback available outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(loadEnv().redisUrl).toBeUndefined();
  });
});
