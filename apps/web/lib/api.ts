export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let refreshPromise: Promise<boolean> | null = null;

export async function refreshSession(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const response = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
          cache: 'no-store',
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        setTimeout(() => {
          refreshPromise = null;
        }, 0);
      }
    })();
  }
  return refreshPromise;
}

export interface ApiOptions extends RequestInit {
  skipRefresh?: boolean;
  idempotencyKey?: string;
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { skipRefresh, idempotencyKey, headers, ...init } = options;
  const requestHeaders = new Headers(headers);
  if (init.body && !(init.body instanceof FormData) && !requestHeaders.has('content-type')) {
    requestHeaders.set('content-type', 'application/json');
  }
  if (idempotencyKey) requestHeaders.set('idempotency-key', idempotencyKey);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: requestHeaders,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'Cannot reach SocietyOS right now. Check your connection.', 0);
  }

  if (response.status === 401 && !skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) return apiRequest<T>(path, { ...options, skipRefresh: true });
    window.dispatchEvent(new Event('societyos:unauthorized'));
  }

  if (!response.ok) {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      // Keep the fallback below for non-JSON proxy errors.
    }
    throw new ApiError(
      typeof body.code === 'string' ? body.code : `HTTP_${response.status}`,
      typeof body.message === 'string' ? body.message : 'The request could not be completed.',
      response.status,
      body.details,
      typeof body.requestId === 'string' ? body.requestId : undefined,
    );
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
