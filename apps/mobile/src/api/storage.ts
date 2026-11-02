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
]);

async function getStorageItem(key: string): Promise<string | null> {
  if (SecureStore && typeof SecureStore.getItemAsync === 'function') {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null && val !== undefined) return val;
    } catch {
      // Fallback if native module not ready
    }
  }

  if (!SENSITIVE_KEYS.has(key) && typeof window !== 'undefined' && window.localStorage) {
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
  if (!writtenInSecureStore && !SENSITIVE_KEYS.has(key)) {
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

  async saveCachedPasses(passes: unknown[]): Promise<void> {
    if (passes && passes.length > 0) {
      await setStorageItem(KEYS.CACHED_PASSES, JSON.stringify(passes));
    } else {
      await deleteStorageItem(KEYS.CACHED_PASSES);
    }
  },

  async loadCachedPasses<T>(): Promise<T | null> {
    const raw = await getStorageItem(KEYS.CACHED_PASSES);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedRelatives(relatives: unknown[]): Promise<void> {
    if (relatives && relatives.length > 0) {
      await setStorageItem(KEYS.CACHED_RELATIVES, JSON.stringify(relatives));
    } else {
      await deleteStorageItem(KEYS.CACHED_RELATIVES);
    }
  },

  async loadCachedRelatives<T>(): Promise<T | null> {
    const raw = await getStorageItem(KEYS.CACHED_RELATIVES);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedNotices(notices: unknown[]): Promise<void> {
    if (notices && notices.length > 0) {
      await setStorageItem(KEYS.CACHED_NOTICES, JSON.stringify(notices));
    } else {
      await deleteStorageItem(KEYS.CACHED_NOTICES);
    }
  },

  async loadCachedNotices<T>(): Promise<T | null> {
    const raw = await getStorageItem(KEYS.CACHED_NOTICES);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async saveCachedCredentials(credentials: Record<string, { pin: string; qrToken: string }>): Promise<void> {
    if (typeof window !== 'undefined' && window.localStorage) {
      try {
        window.localStorage.removeItem(KEYS.CACHED_CREDENTIALS);
      } catch {
        // Ignore
      }
    }
    if (credentials && Object.keys(credentials).length > 0) {
      await setStorageItem(KEYS.CACHED_CREDENTIALS, JSON.stringify(credentials));
    } else {
      await deleteStorageItem(KEYS.CACHED_CREDENTIALS);
    }
  },

  async loadCachedCredentials(): Promise<Record<string, { pin: string; qrToken: string }> | null> {
    const raw = await getStorageItem(KEYS.CACHED_CREDENTIALS);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, { pin: string; qrToken: string }>;
    } catch {
      return null;
    }
  },

  async clearAllCache(): Promise<void> {
    await Promise.all([
      deleteStorageItem(KEYS.SESSION),
      deleteStorageItem(KEYS.CACHED_PASSES),
      deleteStorageItem(KEYS.CACHED_RELATIVES),
      deleteStorageItem(KEYS.CACHED_NOTICES),
      deleteStorageItem(KEYS.CACHED_CREDENTIALS),
    ]);
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
