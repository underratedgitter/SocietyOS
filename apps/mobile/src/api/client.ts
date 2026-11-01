import type {
  AccessPoint,
  Announcement,
  CreatePassInput,
  PassPage,
  PassView,
  PassWithCredentials,
  Session,
  User,
} from './types';

let currentApiUrl = 'http://localhost:80/api/v1';

export function setApiUrl(url: string) {
  currentApiUrl = url.replace(/\/+$/, '');
}

export function getApiUrl(): string {
  return currentApiUrl;
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// In-memory token & cookie storage
let storedAccessToken: string | null = null;
let storedRefreshToken: string | null = null;
let storedCookies: Record<string, string> = {};

export function setAuthTokens(accessToken: string | null, refreshToken: string | null = null) {
  storedAccessToken = accessToken;
  if (refreshToken) {
    storedRefreshToken = refreshToken;
  }
  if (!accessToken) {
    storedRefreshToken = null;
    storedCookies = {};
  }
}

export function getAccessToken(): string | null {
  return storedAccessToken;
}

export function getRefreshToken(): string | null {
  return storedRefreshToken;
}

function parseSetCookie(setCookieHeaders: string[] | string | null | undefined): Record<string, string> {
  if (!setCookieHeaders) return {};
  const cookies: Record<string, string> = {};
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

  for (const header of headers) {
    for (const part of header.split(',')) {
      const match = part.trim().match(/^([^=;]+)=([^;]*)/);
      if (match) {
        const name = match[1].trim();
        const value = match[2].trim();
        if (name && !['expires', 'path', 'domain', 'samesite', 'httponly', 'secure'].includes(name.toLowerCase())) {
          cookies[name] = value;
        }
      }
    }
  }
  return cookies;
}

function buildCookieHeader(): string {
  return Object.entries(storedCookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

export interface RequestOptions extends RequestInit {
  skipRefresh?: boolean;
  idempotencyKey?: string;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${currentApiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const { skipRefresh, idempotencyKey, headers, ...init } = options;

  const requestHeaders = new Headers(headers);
  if (init.body && !(init.body instanceof FormData) && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }

  if (storedAccessToken) {
    requestHeaders.set('authorization', `Bearer ${storedAccessToken}`);
  }

  const cookieHeader = buildCookieHeader();
  if (cookieHeader) {
    requestHeaders.set('cookie', cookieHeader);
  }

  if (idempotencyKey) {
    requestHeaders.set('idempotency-key', idempotencyKey);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: requestHeaders,
    });
  } catch (err) {
    throw new ApiError(
      'NETWORK_ERROR',
      `Cannot reach SocietyOS backend at ${currentApiUrl}. Please ensure server is running.`,
      0,
    );
  }

  // Extract set-cookie if present
  try {
    // In React Native and modern fetch, headers may support getSetCookie or get('set-cookie')
    let rawSetCookie: string[] | string | null = null;
    if (typeof (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      rawSetCookie = (response.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    } else {
      rawSetCookie = response.headers.get('set-cookie');
    }
    if (rawSetCookie) {
      const parsed = parseSetCookie(rawSetCookie);
      storedCookies = { ...storedCookies, ...parsed };
      if (parsed.so_access) {
        storedAccessToken = parsed.so_access;
      }
      if (parsed.so_refresh) {
        storedRefreshToken = parsed.so_refresh;
      }
    }
  } catch {
    // Ignore header inspection errors in restricted environments
  }

  // Handle 401 Unauthorized with token refresh
  if (response.status === 401 && !skipRefresh && storedRefreshToken) {
    const refreshed = await refreshSession();
    if (refreshed) {
      return request<T>(path, { ...options, skipRefresh: true });
    }
  }

  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // non-JSON response fallback
    }

    throw new ApiError(
      typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      typeof body.message === 'string' ? body.message : `Request failed with status ${response.status}`,
      response.status,
      body.details,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function refreshSession(): Promise<boolean> {
  if (!storedRefreshToken) return false;
  try {
    const res = await fetch(`${currentApiUrl}/auth/refresh`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(buildCookieHeader() ? { cookie: buildCookieHeader() } : {}),
      },
      body: JSON.stringify({ refreshToken: storedRefreshToken }),
    });

    if (!res.ok) return false;

    let rawSetCookie: string[] | string | null = null;
    if (typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function') {
      rawSetCookie = (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie();
    } else {
      rawSetCookie = res.headers.get('set-cookie');
    }
    if (rawSetCookie) {
      const parsed = parseSetCookie(rawSetCookie);
      storedCookies = { ...storedCookies, ...parsed };
      if (parsed.so_access) storedAccessToken = parsed.so_access;
      if (parsed.so_refresh) storedRefreshToken = parsed.so_refresh;
    }
    return true;
  } catch {
    return false;
  }
}

// Concrete API calls
export const api = {
  async login(email: string, password: string): Promise<{ user: User; expiresIn: number }> {
    const res = await request<{ user: User; expiresIn: number }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipRefresh: true,
    });
    return res;
  },

  async getMe(): Promise<Session> {
    return request<Session>('/auth/me');
  },

  async logout(): Promise<void> {
    try {
      await request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: storedRefreshToken ?? undefined }),
        skipRefresh: true,
      });
    } finally {
      setAuthTokens(null, null);
    }
  },

  async listPasses(societyId?: string, limit = 100): Promise<PassPage> {
    const query = societyId ? `?societyId=${societyId}&limit=${limit}` : `?limit=${limit}`;
    return request<PassPage>(`/visitor-passes${query}`);
  },

  async getPass(passId: string): Promise<PassView> {
    return request<PassView>(`/visitor-passes/${passId}`);
  },

  async createPass(input: CreatePassInput, idempotencyKey?: string): Promise<PassWithCredentials> {
    return request<PassWithCredentials>('/visitor-passes', {
      method: 'POST',
      idempotencyKey: idempotencyKey ?? `pass-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      body: JSON.stringify(input),
    });
  },

  async revokePass(passId: string, reason = 'Revoked by resident'): Promise<PassView> {
    return request<PassView>(`/visitor-passes/${passId}/revoke`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },

  async approvePass(passId: string, decision: 'APPROVED' | 'REJECTED', reason?: string): Promise<PassView> {
    return request<PassView>(`/visitor-passes/${passId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason }),
    });
  },

  async getAccessPoints(flatId: string): Promise<AccessPoint[]> {
    return request<AccessPoint[]>(`/flats/${flatId}/access-points`);
  },

  async listAnnouncements(societyId: string): Promise<Announcement[]> {
    return request<Announcement[]>(`/societies/${societyId}/announcements`);
  },
};
