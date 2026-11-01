import type {
  AccessPoint,
  Announcement,
  CreatePassInput,
  PassPage,
  PassView,
  PassWithCredentials,
  PublicFlat,
  PublicSociety,
  QuickPassRequest,
  QuickPassResult,
  RegisterRelativeRequest,
  RelativeMember,
  Session,
  User,
} from './types';
import { mobileStorage } from './storage';

let currentApiUrl = 'http://localhost:80/api/v1';

export function setApiUrl(url: string) {
  currentApiUrl = url.replace(/\/+$/, '');
  void mobileStorage.saveApiUrl(currentApiUrl);
}

export async function initStorage(): Promise<void> {
  const savedUrl = await mobileStorage.loadApiUrl();
  if (savedUrl) {
    currentApiUrl = savedUrl.replace(/\/+$/, '');
  }
  const loaded = await mobileStorage.loadTokens();
  storedAccessToken = loaded.accessToken;
  storedRefreshToken = loaded.refreshToken;
  storedCookies = loaded.cookies;
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

export function setAuthTokens(
  accessToken: string | null,
  refreshToken: string | null = null,
  cookies?: Record<string, string>,
) {
  storedAccessToken = accessToken;
  if (refreshToken !== null && refreshToken !== undefined) {
    storedRefreshToken = refreshToken;
  }
  if (cookies) {
    storedCookies = { ...storedCookies, ...cookies };
  }
  if (!accessToken) {
    storedRefreshToken = null;
    storedCookies = {};
    void mobileStorage.clearTokens();
  } else {
    void mobileStorage.saveTokens({
      accessToken,
      refreshToken: storedRefreshToken,
      cookies: storedCookies,
    });
  }
}

export function getAccessToken(): string | null {
  return storedAccessToken;
}

export function getRefreshToken(): string | null {
  return storedRefreshToken;
}

export function parseSetCookie(setCookieHeaders: string[] | string | null | undefined): Record<string, string> {
  if (!setCookieHeaders) return {};
  const cookies: Record<string, string> = {};
  const rawHeaders = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

  // Split on comma only if it's not part of an HTTP Expires date (e.g. 'Expires=Sun, 01 Nov 2026')
  const individualCookies: string[] = [];
  for (const header of rawHeaders) {
    const parts = header.split(/,(?!\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b)/i);
    for (const part of parts) {
      if (part.trim()) individualCookies.push(part.trim());
    }
  }

  for (const cookieStr of individualCookies) {
    const segments = cookieStr.split(';');
    const firstSegment = segments[0]?.trim();
    if (!firstSegment) continue;
    const eqIdx = firstSegment.indexOf('=');
    if (eqIdx > 0) {
      const name = firstSegment.slice(0, eqIdx).trim();
      const value = firstSegment.slice(eqIdx + 1).trim();
      if (
        name &&
        !['expires', 'path', 'domain', 'samesite', 'httponly', 'secure', 'max-age'].includes(
          name.toLowerCase(),
        )
      ) {
        cookies[name] = value;
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

  requestHeaders.set('x-client-type', 'mobile');

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
      void mobileStorage.saveTokens({
        accessToken: storedAccessToken,
        refreshToken: storedRefreshToken,
        cookies: storedCookies,
      });
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
        'x-client-type': 'mobile',
        ...(buildCookieHeader() ? { cookie: buildCookieHeader() } : {}),
      },
      body: JSON.stringify({ refreshToken: storedRefreshToken }),
    });

    if (!res.ok) return false;

    try {
      const data = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (data?.accessToken) {
        setAuthTokens(data.accessToken, data.refreshToken ?? storedRefreshToken);
        return true;
      }
    } catch {
      // Fall through to cookie parsing
    }

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
      void mobileStorage.saveTokens({
        accessToken: storedAccessToken,
        refreshToken: storedRefreshToken,
        cookies: storedCookies,
      });
    }
    return true;
  } catch {
    return false;
  }
}

// Concrete API calls
export const api = {
  async login(
    email: string,
    password: string,
  ): Promise<{ user: User; expiresIn: number; accessToken?: string; refreshToken?: string }> {
    const res = await request<{
      user: User;
      expiresIn: number;
      accessToken?: string;
      refreshToken?: string;
    }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      skipRefresh: true,
    });
    if (res.accessToken) {
      setAuthTokens(res.accessToken, res.refreshToken ?? null);
    }
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

  async createPass(
    input: CreatePassInput,
    idempotencyKey?: string,
    societyId?: string,
  ): Promise<PassWithCredentials> {
    const key =
      idempotencyKey ??
      `pass-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const endpoint = '/visitor-passes';
    return request<PassWithCredentials>(endpoint, {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(input),
    });
  },

  async createSocietyPass(
    societyId: string,
    input: CreatePassInput,
    idempotencyKey?: string,
  ): Promise<PassWithCredentials> {
    return this.createPass(input, idempotencyKey, societyId);
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

  // Relatives Directory Management
  async listRelatives(flatId: string): Promise<RelativeMember[]> {
    return request<RelativeMember[]>(`/flats/${flatId}/relatives`);
  },

  async registerRelative(
    flatId: string,
    payload: RegisterRelativeRequest,
  ): Promise<{
    relative: RelativeMember;
    initialPass?: {
      id: string;
      status: string;
      validFrom: string;
      validUntil: string;
      maxUses: number;
      credentials: {
        pin: string;
        qrToken: string;
      };
    };
  }> {
    return request(`/flats/${flatId}/relatives`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async issueQuickPass(
    flatId: string,
    visitorId: string,
    payload: QuickPassRequest = {},
  ): Promise<QuickPassResult> {
    return request<QuickPassResult>(`/flats/${flatId}/relatives/${visitorId}/quick-pass`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  async deleteRelative(flatId: string, visitorId: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>(`/flats/${flatId}/relatives/${visitorId}`, {
      method: 'DELETE',
    });
  },

  // Public Directory & Self Check-in
  async listPublicSocieties(): Promise<PublicSociety[]> {
    return request<PublicSociety[]>('/public/societies');
  },

  async listPublicFlats(societyId: string): Promise<PublicFlat[]> {
    return request<PublicFlat[]>(`/public/societies/${societyId}/flats`);
  },
};

