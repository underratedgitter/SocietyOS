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

async function getStorageItem(key: string): Promise<string | null> {
  if (SecureStore && typeof SecureStore.getItemAsync === 'function') {
    try {
      const val = await SecureStore.getItemAsync(key);
      if (val !== null && val !== undefined) return val;
    } catch {
      // Fallback if native module not ready
    }
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      // Ignore localStorage access restrictions
    }
  }

  return memoryStore.get(key) ?? null;
}

async function setStorageItem(key: string, value: string): Promise<void> {
  let written = false;

  if (SecureStore && typeof SecureStore.setItemAsync === 'function') {
    try {
      await SecureStore.setItemAsync(key, value);
      written = true;
    } catch {
      // Fallback to web/memory
    }
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(key, value);
      written = true;
    } catch {
      // Ignore
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
