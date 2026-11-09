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
  RegisterUserRequest,
  RegisterUserResponse,
  PushTokenRecord,
  RazorpayOrderResponse,
  RelativeMember,
  SelfRegisterVisitorRequest,
  SelfRegisterVisitorResponse,
  PassStatus,
  Session,
  SettledInvoice,
  StripeIntentResponse,
  User,
} from './types';
import { mobileStorage } from './storage';

const DEV_FALLBACK_API_URL = 'http://localhost:80/api/v1';
export const REQUEST_TIMEOUT_MS = 15_000;

// Release builds must never send credentials or bearer tokens over cleartext HTTP.
function isProductionBuild(): boolean {
  return (typeof __DEV__ !== 'undefined' && !__DEV__) || process.env.NODE_ENV === 'production';
}

// RN's URL polyfill does not implement `protocol`/`host` getters, so validate structurally.
const API_URL_PATTERN = /^(https?):\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i;

export function normalizeApiUrl(raw: string, production: boolean = isProductionBuild()): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  const match = API_URL_PATTERN.exec(trimmed);
  if (!match) {
    throw new ApiError('INVALID_API_URL', `Invalid backend API URL "${trimmed}". Use http(s)://host/api/v1.`, 0);
  }
  if (production && match[1].toLowerCase() !== 'https') {
    throw new ApiError('INSECURE_API_URL', 'Backend API URL must use HTTPS in production builds.', 0);
  }
  return trimmed;
}

export function getDefaultApiUrl(): string {
  // Inlined at build time by babel-preset-expo; set EXPO_PUBLIC_API_URL for release builds.
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  return (configured || DEV_FALLBACK_API_URL).replace(/\/+$/, '');
}

let currentApiUrl = getDefaultApiUrl();

export function setApiUrl(url: string) {
  currentApiUrl = normalizeApiUrl(url);
  void mobileStorage.saveApiUrl(currentApiUrl);
}

export async function initStorage(): Promise<void> {
  const savedUrl = await mobileStorage.loadApiUrl();
  if (savedUrl) {
    try {
      currentApiUrl = normalizeApiUrl(savedUrl);
    } catch {
      // A persisted URL that fails validation (e.g. cleartext from a dev install) is discarded
      // so the build-time default applies instead of bricking the app.
      currentApiUrl = getDefaultApiUrl();
    }
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

/** True only when the server definitively rejected the credentials; outages and 5xx keep the session. */
export function isSessionRejected(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

let sessionExpiredHandler: (() => void) | null = null;

/** Lets the UI leave the signed-in state when a refresh is rejected mid-session. */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
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

function assertSecureTransport(url: string): void {
  if (isProductionBuild() && !/^https:\/\//i.test(url)) {
    throw new ApiError('INSECURE_API_URL', 'Backend API URL must use HTTPS in production builds.', 0);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  const forwardAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort);
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', forwardAbort);
  }
}

export interface RequestOptions extends RequestInit {
  skipRefresh?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const url = path.startsWith('http') ? path : `${currentApiUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const { skipRefresh, idempotencyKey, headers, timeoutMs = REQUEST_TIMEOUT_MS, ...init } = options;
  assertSecureTransport(url);

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
    response = await fetchWithTimeout(url, { ...init, headers: requestHeaders }, timeoutMs);
  } catch (err) {
    // Timeouts keep the NETWORK_ERROR code so callers fall back to offline caches.
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

let refreshPromise: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (!storedRefreshToken) return false;
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const refreshUrl = `${currentApiUrl}/auth/refresh`;
      assertSecureTransport(refreshUrl);
      const res = await fetchWithTimeout(
        refreshUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-client-type': 'mobile',
            ...(buildCookieHeader() ? { cookie: buildCookieHeader() } : {}),
          },
          body: JSON.stringify({ refreshToken: storedRefreshToken }),
        },
        REQUEST_TIMEOUT_MS,
      );

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          // Token is revoked or expired; clear dead tokens to prevent endless auth failure loops.
          // Cached passes/PINs are purged too so the next account on this device never sees them.
          setAuthTokens(null, null);
          await Promise.all([mobileStorage.clearTokens(), mobileStorage.clearAllCache()]);
          sessionExpiredHandler?.();
        }
        return false;
      }

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
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
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

  async listPasses(societyId?: string, limit = 100, cursor?: string): Promise<PassPage> {
    const params = new URLSearchParams();
    if (societyId) params.set('societyId', societyId);
    params.set('limit', String(limit));
    if (cursor) params.set('cursor', cursor);
    const query = `?${params.toString()}`;
    return request<PassPage>(`/visitor-passes${query}`);
  },

  async listAllPasses(societyId?: string): Promise<PassView[]> {
    const items: PassView[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    while (true) {
      const page = await api.listPasses(societyId, 100, cursor);
      items.push(...page.items);
      if (!page.nextCursor) return items;
      if (seen.has(page.nextCursor)) throw new Error('Pass pagination returned a repeated cursor. Please retry.');
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
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
    const result = await request<PassWithCredentials | { pass: PassView; credentialsAlreadyIssued: true }>(endpoint, {
      method: 'POST',
      idempotencyKey: key,
      body: JSON.stringify(input),
    });
    // A retry with the same key replays the pass without credentials (they are only returned once).
    if (!('credentials' in result)) {
      throw new ApiError(
        'CREDENTIALS_ALREADY_ISSUED',
        'This pass was already created and its PIN was shown once. If you did not save it, revoke the pass and create a new one.',
        409,
      );
    }
    return result;
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

  /** Approval mints the PIN/QR and returns them once (`credentials`); rejection never does. */
  async approvePass(
    passId: string,
    decision: 'APPROVED' | 'REJECTED',
    reason?: string,
  ): Promise<PassView & { credentials?: PassWithCredentials['credentials'] }> {
    return request<PassView & { credentials?: PassWithCredentials['credentials'] }>(`/visitor-passes/${passId}/approve`, {
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
      status: PassStatus;
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

  async registerUser(
    payload: RegisterUserRequest,
  ): Promise<RegisterUserResponse & { accessToken?: string; refreshToken?: string }> {
    const res = await request<RegisterUserResponse & { accessToken?: string; refreshToken?: string }>(
      '/auth/register',
      {
        method: 'POST',
        body: JSON.stringify(payload),
        skipRefresh: true,
      },
    );
    if (res.accessToken) {
      setAuthTokens(res.accessToken, res.refreshToken ?? null);
    }
    return res;
  },

  async selfRegisterVisitor(
    payload: SelfRegisterVisitorRequest,
  ): Promise<SelfRegisterVisitorResponse> {
    return request<SelfRegisterVisitorResponse>('/visitors/self-register', {
      method: 'POST',
      body: JSON.stringify(payload),
      skipRefresh: true,
    });
  },

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<{ user: User; expiresIn: number; accessToken?: string; refreshToken?: string }> {
    const res = await request<{ user: User; expiresIn: number; accessToken?: string; refreshToken?: string }>(
      '/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      },
    );
    if (res.accessToken) {
      setAuthTokens(res.accessToken, res.refreshToken ?? null);
    }
    return res;
  },

  // Push Notifications
  async registerPushToken(
    token: string,
    platform: 'expo' | 'web' | 'ios' | 'android' = 'expo',
    deviceName?: string,
  ): Promise<{ ok: boolean; id: string; platform: string }> {
    return request<{ ok: boolean; id: string; platform: string }>('/notifications/push-token', {
      method: 'POST',
      body: JSON.stringify({ token, platform, deviceName }),
    });
  },

  async unregisterPushToken(token: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>('/notifications/push-token', {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
  },

  async listPushTokens(): Promise<PushTokenRecord[]> {
    return request<PushTokenRecord[]>('/notifications/push-token');
  },

  // Online Maintenance Payments
  async createRazorpayOrder(
    societyId: string,
    invoiceId: string,
    notes?: string,
  ): Promise<RazorpayOrderResponse> {
    return request<RazorpayOrderResponse>(
      `/societies/${societyId}/invoices/${invoiceId}/payment/razorpay/order`,
      {
        method: 'POST',
        body: JSON.stringify({ notes }),
      },
    );
  },

  async verifyRazorpayPayment(
    societyId: string,
    invoiceId: string,
    data: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
  ): Promise<SettledInvoice> {
    return request<SettledInvoice>(
      `/societies/${societyId}/invoices/${invoiceId}/payment/razorpay/verify`,
      {
        method: 'POST',
        body: JSON.stringify(data),
      },
    );
  },

  async createStripePaymentIntent(
    societyId: string,
    invoiceId: string,
    currency = 'inr',
  ): Promise<StripeIntentResponse> {
    return request<StripeIntentResponse>(
      `/societies/${societyId}/invoices/${invoiceId}/payment/stripe/intent`,
      {
        method: 'POST',
        body: JSON.stringify({ currency }),
      },
    );
  },

  async verifyStripePayment(
    societyId: string,
    invoiceId: string,
    paymentIntentId: string,
  ): Promise<SettledInvoice> {
    return request<SettledInvoice>(
      `/societies/${societyId}/invoices/${invoiceId}/payment/stripe/verify`,
      {
        method: 'POST',
        body: JSON.stringify({ paymentIntentId }),
      },
    );
  },
};

