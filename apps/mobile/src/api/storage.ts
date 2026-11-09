/**
 * Resilient local and secure storage manager for SocietyOS Mobile.
 * Uses expo-secure-store on iOS/Android devices for hardware-encrypted
 * credential persistence, with automatic fallback to localStorage (Web)
 * or in-memory map (Node.js test suite / SSR).
 */

let SecureStore: typeof import('expo-secure-store') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SecureStore = require('expo-secure-store');
} catch {
  SecureStore = null;
}

const memoryStore = new Map<string, string>();

// Sensitive keys that must NEVER be persisted in unencrypted browser localStorage
const SENSITIVE_KEYS = new Set<string>([
  'societyos_mobile_cached_credentials',
  'societyos_mobile_access_token',
  'societyos_mobile_refresh_token',
  // The cookie jar holds so_access / so_refresh, i.e. the same tokens as above.
  'societyos_mobile_cookies',
]);

function isSensitiveKey(key: string): boolean {
  return [...SENSITIVE_KEYS].some((base) => key === base || key.startsWith(`${base}.`));
}

async function getStorageItem(key: string): Promise<string | null> {
  if (SecureStore && typeof SecureStore.getItemAsync === 'function') {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null && val !== undefined) return val;
    } catch {
      // Fallback if native module not ready
    }
  }

  if (!isSensitiveKey(key) && typeof window !== 'undefined' && window.localStorage) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Ignore localStorage access restrictions
    }
  }

  return memoryStore.get(key) ?? null;
}

async function setStorageItem(key: string, value: string): Promise<void> {
  let writtenInSecureStore = false;

  if (SecureStore && typeof SecureStore.setItemAsync === 'function') {
    try {
      await SecureStore.setItemAsync(key, value);
      writtenInSecureStore = true;
    } catch {
      // Fallback to web/memory
    }
  }

  // Sensitive keys (such as visitor credentials PIN/QR or tokens) MUST NEVER be stored in unencrypted browser localStorage.
  // Non-sensitive cached data only falls back to localStorage if SecureStore is not available.
  if (!writtenInSecureStore && !isSensitiveKey(key)) {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ignore
      }
    }
  }

  // Always keep in memory as reliable cache
  memoryStore.set(key, value);
}

async function deleteStorageItem(key: string): Promise<void> {
  if (SecureStore && typeof SecureStore.deleteItemAsync === 'function') {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      // Ignore
    }
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore
    }
  }

  memoryStore.delete(key);
}

// Keys
const KEYS = {
  ACCESS_TOKEN: 'societyos_mobile_access_token',
  REFRESH_TOKEN: 'societyos_mobile_refresh_token',
  COOKIES: 'societyos_mobile_cookies',
  SESSION: 'societyos_mobile_cached_session',
  API_URL: 'societyos_mobile_api_url',
  CACHED_PASSES: 'societyos_mobile_cached_passes',
  CACHED_RELATIVES: 'societyos_mobile_cached_relatives',
  CACHED_NOTICES: 'societyos_mobile_cached_notices',
  CACHED_CREDENTIALS: 'societyos_mobile_cached_credentials',
};

export interface StoredTokens {
  accessToken: string | null;
  refreshToken: string | null;
  cookies: Record<string, string>;
}


export interface CacheScope {
  userId: string;
  societyId: string;
  flatId?: string;
}

function scopedKey(base: string, scope?: CacheScope): string {
  if (!scope) return base;
  // SecureStore accepts only letters, digits, dots, hyphens and underscores.
  // Encode the tuple to keep arbitrary identifiers distinct without invalid key characters.
  const suffix = JSON.stringify([scope.userId, scope.societyId, scope.flatId ?? ''])
    .split('').map((character) => character.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  return `${base}.${suffix}`;
}

// Track scoped storage keys so a global reset can purge every scope we have touched.
const knownScopedKeys = new Set<string>();
function trackKey(key: string): void {
  knownScopedKeys.add(key);
}

export const mobileStorage = {
  async saveTokens(tokens: {
    accessToken: string | null;
    refreshToken?: string | null;
    cookies?: Record<string, string>;
  }): Promise<void> {
    if (tokens.accessToken) {
      await setStorageItem(KEYS.ACCESS_TOKEN, tokens.accessToken);
    } else {
      await deleteStorageItem(KEYS.ACCESS_TOKEN);
    }

    if (tokens.refreshToken) {
      await setStorageItem(KEYS.REFRESH_TOKEN, tokens.refreshToken);
    } else if (tokens.refreshToken === null) {
      await deleteStorageItem(KEYS.REFRESH_TOKEN);
    }

    if (tokens.cookies && Object.keys(tokens.cookies).length > 0) {
      await setStorageItem(KEYS.COOKIES, JSON.stringify(tokens.cookies));
    } else if (tokens.accessToken === null) {
      await deleteStorageItem(KEYS.COOKIES);
    }
  },

  async loadTokens(): Promise<StoredTokens> {
    const accessToken = await getStorageItem(KEYS.ACCESS_TOKEN);
    const refreshToken = await getStorageItem(KEYS.REFRESH_TOKEN);
    const rawCookies = await getStorageItem(KEYS.COOKIES);

    let cookies: Record<string, string> = {};
    if (rawCookies) {
      try {
        cookies = JSON.parse(rawCookies) as Record<string, string>;
      } catch {
        cookies = {};
      }
    }

    return {
      accessToken,
      refreshToken,
      cookies,
    };
  },

  async clearTokens(): Promise<void> {
    await Promise.all([
      deleteStorageItem(KEYS.ACCESS_TOKEN),
      deleteStorageItem(KEYS.REFRESH_TOKEN),
      deleteStorageItem(KEYS.COOKIES),
    ]);
  },

  async saveCachedSession(session: unknown): Promise<void> {
    if (session) {
      await setStorageItem(KEYS.SESSION, JSON.stringify(session));
    } else {
      await deleteStorageItem(KEYS.SESSION);
    }
  },

  async loadCachedSession<T>(): Promise<T | null> {
    const raw = await getStorageItem(KEYS.SESSION);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async clearCachedSession(): Promise<void> {
    await deleteStorageItem(KEYS.SESSION);
  },

  async saveCachedPasses(passes: unknown[], scope?: CacheScope): Promise<void> {
    const key = scopedKey(KEYS.CACHED_PASSES, scope);
    if (passes && passes.length > 0) {
      await setStorageItem(key, JSON.stringify(passes));
      trackKey(key);
    } else {
      await deleteStorageItem(key);
    }
  },

  async loadCachedPasses<T>(scope?: CacheScope): Promise<T | null> {
    const key = scopedKey(KEYS.CACHED_PASSES, scope);
    if (key !== KEYS.CACHED_PASSES) trackKey(key);
    const raw = await getStorageItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedRelatives(relatives: unknown[], scope?: CacheScope): Promise<void> {
    const key = scopedKey(KEYS.CACHED_RELATIVES, scope);
    if (relatives && relatives.length > 0) {
      await setStorageItem(key, JSON.stringify(relatives));
      trackKey(key);
    } else {
      await deleteStorageItem(key);
    }
  },

  async loadCachedRelatives<T>(scope?: CacheScope): Promise<T | null> {
    const key = scopedKey(KEYS.CACHED_RELATIVES, scope);
    if (key !== KEYS.CACHED_RELATIVES) trackKey(key);
    const raw = await getStorageItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedNotices(notices: unknown[], scope?: CacheScope): Promise<void> {
    const key = scopedKey(KEYS.CACHED_NOTICES, scope);
    if (notices && notices.length > 0) {
      await setStorageItem(key, JSON.stringify(notices));
      trackKey(key);
    } else {
      await deleteStorageItem(key);
    }
  },

  async loadCachedNotices<T>(scope?: CacheScope): Promise<T | null> {
    const key = scopedKey(KEYS.CACHED_NOTICES, scope);
    if (key !== KEYS.CACHED_NOTICES) trackKey(key);
    const raw = await getStorageItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedCredentials(
    credentials: Record<string, { pin: string; qrToken: string }>,
    scope?: CacheScope,
  ): Promise<void> {
    const key = scopedKey(KEYS.CACHED_CREDENTIALS, scope);
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(KEYS.CACHED_CREDENTIALS);
        window.localStorage.removeItem(key);
      } catch {
        // Ignore
      }
    }
    if (credentials && Object.keys(credentials).length > 0) {
      await setStorageItem(key, JSON.stringify(credentials));
      if (key !== KEYS.CACHED_CREDENTIALS) trackKey(key);
    } else {
      await deleteStorageItem(key);
    }
  },

  async loadCachedCredentials(scope?: CacheScope): Promise<Record<string, { pin: string; qrToken: string }> | null> {
    const key = scopedKey(KEYS.CACHED_CREDENTIALS, scope);
    if (key !== KEYS.CACHED_CREDENTIALS) trackKey(key);
    const raw = await getStorageItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, { pin: string; qrToken: string }>;
    } catch {
      return null;
    }
  },

  async clearAllCache(scope?: CacheScope): Promise<void> {
    if (scope) {
      const keys = [
        scopedKey(KEYS.SESSION, scope),
        scopedKey(KEYS.CACHED_PASSES, scope),
        scopedKey(KEYS.CACHED_RELATIVES, scope),
        scopedKey(KEYS.CACHED_NOTICES, scope),
        scopedKey(KEYS.CACHED_CREDENTIALS, scope),
      ];
      for (const k of keys) trackKey(k);
      await Promise.all(keys.map((k) => deleteStorageItem(k)));
      return;
    }

    const keys = new Set<string>([
      KEYS.SESSION,
      KEYS.CACHED_PASSES,
      KEYS.CACHED_RELATIVES,
      KEYS.CACHED_NOTICES,
      KEYS.CACHED_CREDENTIALS,
      ...knownScopedKeys,
    ]);
    await Promise.all(Array.from(keys).map((k) => deleteStorageItem(k)));
    knownScopedKeys.clear();
  },

  async saveApiUrl(url: string): Promise<void> {
    await setStorageItem(KEYS.API_URL, url);
  },

  async loadApiUrl(): Promise<string | null> {
    return getStorageItem(KEYS.API_URL);
  },

  // Test / debug helper
  _clearMemory(): void {
    memoryStore.clear();
  },
};
