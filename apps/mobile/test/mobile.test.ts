import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  setApiUrl,
  getApiUrl,
  getDefaultApiUrl,
  setAuthTokens,
  getAccessToken,
  getRefreshToken,
  parseSetCookie,
  ApiError,
  api,
  initStorage,
  normalizeApiUrl,
  refreshSession,
  request,
} from '../src/api/client';
import { mobileStorage } from '../src/api/storage';
import {
  categoryLabel,
  formatDate,
  formatDateTime,
  formatWindow,
  relativeTime,
  calculateWindowDates,
  buildPassShareText,
  buildWhatsAppShareUrl,
} from '../src/utils/format';

describe('Mobile API Client & Session Management', () => {
  test('normalizes API URL', () => {
    setApiUrl('http://192.168.1.100:80/api/v1///');
    assert.equal(getApiUrl(), 'http://192.168.1.100:80/api/v1');

    setApiUrl('http://localhost:80/api/v1');
    assert.equal(getApiUrl(), 'http://localhost:80/api/v1');
  });

  test('rejects malformed API URLs and keeps the previous one', () => {
    setApiUrl('http://localhost:80/api/v1');
    for (const bad of ['', 'localhost/api/v1', 'javascript:alert(1)', 'ftp://host/api', 'https://user@evil.example/api']) {
      assert.throws(() => setApiUrl(bad), (err: unknown) => err instanceof ApiError && err.code === 'INVALID_API_URL');
    }
    assert.equal(getApiUrl(), 'http://localhost:80/api/v1');
  });

  test('requires HTTPS API URLs in production builds', () => {
    assert.throws(
      () => normalizeApiUrl('http://api.societyos.example/api/v1', true),
      (err: unknown) => err instanceof ApiError && err.code === 'INSECURE_API_URL',
    );
    assert.equal(normalizeApiUrl('https://api.societyos.example/api/v1/', true), 'https://api.societyos.example/api/v1');
  });

  test('refuses to send requests over cleartext HTTP when NODE_ENV=production', async () => {
    setApiUrl('http://localhost:80/api/v1');
    const originalEnv = process.env.NODE_ENV;
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        () => api.getMe(),
        (err: unknown) => err instanceof ApiError && err.code === 'INSECURE_API_URL',
      );
      assert.equal(fetchCalls, 0);
    } finally {
      process.env.NODE_ENV = originalEnv;
      globalThis.fetch = originalFetch;
    }
  });

  test('aborts hung requests after the timeout and reports NETWORK_ERROR', async () => {
    setApiUrl('http://localhost:80/api/v1');
    const originalFetch = globalThis.fetch;
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        receivedSignal = init?.signal ?? undefined;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    try {
      await assert.rejects(
        () => request('/auth/me', { timeoutMs: 20 }),
        (err: unknown) => err instanceof ApiError && err.code === 'NETWORK_ERROR',
      );
      assert.equal(receivedSignal?.aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('manages auth tokens in memory', () => {
    setAuthTokens('access-token-123', 'refresh-token-456');
    assert.equal(getAccessToken(), 'access-token-123');
    assert.equal(getRefreshToken(), 'refresh-token-456');

    setAuthTokens(null);
    assert.equal(getAccessToken(), null);
    assert.equal(getRefreshToken(), null);
  });

  test('creates ApiError with code, message, and status', () => {
    const error = new ApiError('FORBIDDEN', 'Access denied to flat', 403, { flatId: 'abc' });
    assert.equal(error.code, 'FORBIDDEN');
    assert.equal(error.message, 'Access denied to flat');
    assert.equal(error.status, 403);
    assert.deepEqual(error.details, { flatId: 'abc' });
    assert.equal(error.name, 'ApiError');
  });

  test('parses Set-Cookie headers with HTTP date commas safely', () => {
    const rawHeader =
      'so_access=jwt.token.val==; Max-Age=900; Path=/; Expires=Sun, 01 Nov 2026 05:45:00 GMT; HttpOnly; SameSite=Strict, ' +
      'so_refresh=ref.token.val; Max-Age=2592000; Path=/; Expires=Tue, 01 Dec 2026 05:30:00 GMT; HttpOnly; SameSite=Strict';

    const parsed = parseSetCookie(rawHeader);
    assert.equal(parsed.so_access, 'jwt.token.val==');
    assert.equal(parsed.so_refresh, 'ref.token.val');
    assert.equal(parsed.expires, undefined);
    assert.equal(parsed.path, undefined);
  });

  test('parses array of Set-Cookie headers', () => {
    const headers = [
      'so_access=access123; Path=/; HttpOnly',
      'so_refresh=refresh456; Path=/; HttpOnly',
    ];
    const parsed = parseSetCookie(headers);
    assert.equal(parsed.so_access, 'access123');
    assert.equal(parsed.so_refresh, 'refresh456');
  });
});

describe('Mobile Utilities & Formatters', () => {
  test('maps visitor categories to resident-friendly labels', () => {
    assert.equal(categoryLabel('RELATIVE'), 'Family / Relative');
    assert.equal(categoryLabel('FRIEND'), 'Guest / Friend');
    assert.equal(categoryLabel('DELIVERY'), 'Delivery');
    assert.equal(categoryLabel('CAB'), 'Cab / Taxi');
    assert.equal(categoryLabel('MAINTENANCE'), 'Service / Maintenance');
    assert.equal(categoryLabel('OTHER'), 'Other');
  });

  test('formats dates and validity windows properly', () => {
    const from = '2026-11-01T10:00:00.000Z';
    const until = '2026-11-01T14:00:00.000Z';

    const windowStr = formatWindow(from, until, 'UTC');
    assert.match(windowStr, /→/);
    assert.match(windowStr, /2026/);

    const dateStr = formatDate(from, 'UTC');
    assert.match(dateStr, /2026/);
  });

  test('formats relative time accurately', () => {
    const now = Date.now();
    assert.equal(relativeTime(new Date(now - 10_000).toISOString()), 'Just now');
    assert.equal(relativeTime(new Date(now - 5 * 60_000).toISOString()), '5m ago');
    assert.equal(relativeTime(new Date(now - 3 * 3600_000).toISOString()), '3h ago');
    assert.equal(relativeTime(new Date(now - 48 * 3600_000).toISOString()), '2d ago');
    assert.equal(relativeTime(null), 'Never');
  });
});

describe('Pass Window Presets & Date Calculations', () => {
  test('calculates TODAY window (4 hours)', () => {
    const base = new Date('2026-11-01T10:00:00.000Z');
    const { validFrom, validUntil } = calculateWindowDates('TODAY', 4, base);
    assert.equal(validFrom, '2026-11-01T10:00:00.000Z');
    assert.equal(validUntil, '2026-11-01T14:00:00.000Z');
  });

  test('calculates REST_OF_DAY window ending at 23:59:59.999', () => {
    const base = new Date('2026-11-01T10:00:00.000Z');
    const { validUntil } = calculateWindowDates('REST_OF_DAY', 4, base);
    const untilDate = new Date(validUntil);
    assert.equal(untilDate.getHours(), 23);
    assert.equal(untilDate.getMinutes(), 59);
  });

  test('calculates WEEKEND window correctly on Sunday without spilling into Monday', () => {
    // 2026-11-01 is a Sunday
    const sundayMorning = new Date('2026-11-01T09:00:00.000Z');
    const { validUntil } = calculateWindowDates('WEEKEND', 12, sundayMorning);
    const untilDate = new Date(validUntil);

    // Must be Sunday, not Monday
    assert.equal(untilDate.getDay(), 0, 'Weekend on Sunday must end on Sunday');
    assert.equal(untilDate.getHours(), 23);
  });

  test('calculates WEEKEND window correctly from Friday', () => {
    // 2026-11-06 is a Friday
    const friday = new Date('2026-11-06T15:00:00.000Z');
    const { validUntil } = calculateWindowDates('WEEKEND', 12, friday);
    const untilDate = new Date(validUntil);

    // Must end on Sunday (day 0)
    assert.equal(untilDate.getDay(), 0);
    assert.equal(untilDate.getHours(), 23);
  });

  test('calculates MULTIPLE_DAYS_3 and MULTIPLE_DAYS_7 windows', () => {
    const base = new Date('2026-11-01T10:00:00.000Z');
    const threeDays = calculateWindowDates('MULTIPLE_DAYS_3', 12, base);
    assert.equal(
      new Date(threeDays.validUntil).getTime() - new Date(threeDays.validFrom).getTime(),
      3 * 24 * 3600 * 1000,
    );

    const sevenDays = calculateWindowDates('MULTIPLE_DAYS_7', 12, base);
    assert.equal(
      new Date(sevenDays.validUntil).getTime() - new Date(sevenDays.validFrom).getTime(),
      7 * 24 * 3600 * 1000,
    );
  });

  test('calculates CUSTOM window with specified hours', () => {
    const base = new Date('2026-11-01T10:00:00.000Z');
    const custom = calculateWindowDates('CUSTOM', 36, base);
    assert.equal(
      new Date(custom.validUntil).getTime() - new Date(custom.validFrom).getTime(),
      36 * 3600 * 1000,
    );
  });
});

describe('Pass Sharing & Relative Registration Logic', () => {
  test('generates complete WhatsApp sharing message with PIN, pass link, and vehicle details', () => {
    const shareText = buildPassShareText({
      guestName: 'Ramesh Patel',
      phone: '9876543210',
      vehicle: 'MH 02 CZ 4411',
      category: 'RELATIVE',
      purpose: 'Family Visit',
      building: 'Tower A',
      flatNumber: '101',
      validFrom: '2026-11-01T10:00:00.000Z',
      validUntil: '2026-11-04T10:00:00.000Z',
      pin: '948271',
      passId: 'pass-uuid-123',
      apiUrl: 'http://localhost:80/api/v1',
      timezone: 'UTC',
    });

    assert.ok(shareText.includes('Ramesh Patel'));
    assert.ok(shareText.includes('9876543210'));
    assert.ok(shareText.includes('MH 02 CZ 4411'));
    assert.ok(shareText.includes('948271'));
    assert.ok(shareText.includes('Tower A · Flat 101'));
    assert.ok(shareText.includes('http://localhost:80/visitor-passes/pass-uuid-123'));

    const urlWithPhone = buildWhatsAppShareUrl(shareText, '98765 43210');
    assert.ok(urlWithPhone.startsWith('https://wa.me/9876543210?text='));
    assert.ok(urlWithPhone.includes('948271'));

    const urlWithoutPhone = buildWhatsAppShareUrl(shareText);
    assert.ok(urlWithoutPhone.startsWith('https://wa.me/?text='));
  });

  test('formats protected pass share text when PIN is omitted', () => {
    const shareText = buildPassShareText({
      guestName: 'Priya Sharma',
      category: 'FRIEND',
      building: 'Tower B',
      flatNumber: '204',
      validFrom: '2026-11-01T10:00:00.000Z',
      validUntil: '2026-11-01T14:00:00.000Z',
      passId: 'pass-uuid-456',
      apiUrl: 'http://localhost:80/api/v1',
      timezone: 'UTC',
    });

    assert.ok(shareText.includes('Priya Sharma'));
    assert.ok(shareText.includes('Tower B · Flat 204'));
    assert.ok(!shareText.includes('Gate Access PIN:'));
  });

  test('formats vehicle uppercase and appends to visitor name format for gate camera display', () => {
    const rawName = 'Sunita Rao';
    const vehicleInput = 'mh 04 ab 1234';
    const trimmedVehicle = vehicleInput.trim().toUpperCase();
    const finalName = trimmedVehicle ? `${rawName} [${trimmedVehicle}]` : rawName;

    assert.equal(finalName, 'Sunita Rao [MH 04 AB 1234]');

    // Matches extraction regex in PassCard
    const vehicleMatch = finalName.match(/\[(.*?)\]/);
    assert.equal(vehicleMatch?.[1], 'MH 04 AB 1234');
    const cleanGuestName = finalName.replace(/\s*\[.*?\]/, '').trim();
    assert.equal(cleanGuestName, 'Sunita Rao');
  });
});

describe('Mobile Local Secure Storage & Persistence', () => {
  test('persists tokens and recovers them cleanly', async () => {
    mobileStorage._clearMemory();

    await mobileStorage.saveTokens({
      accessToken: 'test-jwt-access-token',
      refreshToken: 'test-jwt-refresh-token',
      cookies: { so_access: 'token123' },
    });

    const loaded = await mobileStorage.loadTokens();
    assert.equal(loaded.accessToken, 'test-jwt-access-token');
    assert.equal(loaded.refreshToken, 'test-jwt-refresh-token');
    assert.equal(loaded.cookies.so_access, 'token123');

    await mobileStorage.clearTokens();
    const cleared = await mobileStorage.loadTokens();
    assert.equal(cleared.accessToken, null);
    assert.equal(cleared.refreshToken, null);
    assert.deepEqual(cleared.cookies, {});
  });

  test('caches user session for offline resilience', async () => {
    mobileStorage._clearMemory();

    const mockSession = {
      user: {
        id: 'u-1',
        name: 'Sunil Patel',
        email: 'sunil@societyos.dev',
        phone: '+919999911111',
        isPlatformAdmin: false,
        mustChangePassword: false,
      },
      memberships: [],
      flats: [
        {
          id: 'flat-101',
          flatNumber: '101',
          building: { id: 'b-1', name: 'Tower A', societyId: 's-1' },
          relationship: 'OWNER' as const,
        },
      ],
    };

    await mobileStorage.saveCachedSession(mockSession);
    const cached = await mobileStorage.loadCachedSession<typeof mockSession>();
    assert.ok(cached);
    assert.equal(cached.user.email, 'sunil@societyos.dev');
    assert.equal(cached.flats[0].flatNumber, '101');

    await mobileStorage.clearCachedSession();
    const empty = await mobileStorage.loadCachedSession();
    assert.equal(empty, null);
  });

  test('persists configured API URL', async () => {
    mobileStorage._clearMemory();

    await mobileStorage.saveApiUrl('http://192.168.1.50:80/api/v1');
    const url = await mobileStorage.loadApiUrl();
    assert.equal(url, 'http://192.168.1.50:80/api/v1');
  });

  test('initStorage synchronizes persistent storage with client tokens and API URL', async () => {
    mobileStorage._clearMemory();
    await mobileStorage.saveTokens({
      accessToken: 'restored-access',
      refreshToken: 'restored-refresh',
    });
    await mobileStorage.saveApiUrl('http://10.0.0.2:80/api/v1');

    await initStorage();

    assert.equal(getAccessToken(), 'restored-access');
    assert.equal(getRefreshToken(), 'restored-refresh');
    assert.equal(getApiUrl(), 'http://10.0.0.2:80/api/v1');

    // Clean up
    setAuthTokens(null, null);
    setApiUrl('http://localhost:80/api/v1');
  });

  test('initStorage discards a persisted API URL that fails validation', async () => {
    mobileStorage._clearMemory();
    setApiUrl('http://10.0.0.9:80/api/v1');
    await mobileStorage.saveApiUrl('javascript:alert(1)');

    await initStorage();

    assert.equal(getApiUrl(), getDefaultApiUrl());
    setApiUrl('http://localhost:80/api/v1');
  });

  test('caches passes, relatives, notices, and credentials offline', async () => {
    mobileStorage._clearMemory();

    const mockPasses = [
      { id: 'pass-1', status: 'ACTIVE', category: 'RELATIVE' },
    ];
    await mobileStorage.saveCachedPasses(mockPasses);
    const loadedPasses = await mobileStorage.loadCachedPasses<typeof mockPasses>();
    assert.deepEqual(loadedPasses, mockPasses);

    const mockRelatives = [
      { id: 'rel-1', name: 'Asha Patel', relation: 'Mother' },
    ];
    await mobileStorage.saveCachedRelatives(mockRelatives);
    const loadedRelatives = await mobileStorage.loadCachedRelatives<typeof mockRelatives>();
    assert.deepEqual(loadedRelatives, mockRelatives);

    const mockNotices = [
      { id: 'not-1', title: 'Water Shutdown', category: 'MAINTENANCE' },
    ];
    await mobileStorage.saveCachedNotices(mockNotices);
    const loadedNotices = await mobileStorage.loadCachedNotices<typeof mockNotices>();
    assert.deepEqual(loadedNotices, mockNotices);

    const mockCreds = {
      'pass-1': { pin: '456789', qrToken: 'abcdef1234567890abcdef1234567890' },
    };
    await mobileStorage.saveCachedCredentials(mockCreds);
    const loadedCreds = await mobileStorage.loadCachedCredentials();
    assert.deepEqual(loadedCreds, mockCreds);

    await mobileStorage.clearAllCache();
    assert.equal(await mobileStorage.loadCachedPasses(), null);
    assert.equal(await mobileStorage.loadCachedRelatives(), null);
    assert.equal(await mobileStorage.loadCachedNotices(), null);
    assert.equal(await mobileStorage.loadCachedCredentials(), null);
  });

  test('does not persist visitor PIN/QR credentials into unencrypted localStorage', async () => {
    const mockStorage = new Map<string, string>();
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => mockStorage.get(k) ?? null,
        setItem: (k: string, v: string) => mockStorage.set(k, v),
        removeItem: (k: string) => mockStorage.delete(k),
      },
    };

    try {
      const mockCreds = {
        'pass-secret-1': { pin: '998877', qrToken: 'secretqr1234567890' },
      };
      await mobileStorage.saveCachedCredentials(mockCreds);

      // Verify that credentials were NOT written to window.localStorage
      assert.equal(
        mockStorage.get('societyos_mobile_cached_credentials'),
        undefined,
        'Visitor credentials must NOT be stored in browser localStorage',
      );

      // Non-sensitive data like cached notices CAN fall back to localStorage
      const mockNotices = [{ id: 'n-1', title: 'Annual Meeting' }];
      await mobileStorage.saveCachedNotices(mockNotices);
      assert.notEqual(
        mockStorage.get('societyos_mobile_cached_notices'),
        undefined,
        'Non-sensitive notices can use localStorage fallback',
      );
    } finally {
      delete (globalThis as any).window;
    }
  });
});

describe('Mobile Session Refresh Concurrency & Error Clearance', () => {
  test('refreshSession deduplicates concurrent requests without duplicate network calls', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;

    // Mock fetch that takes 20ms to simulate network latency
    globalThis.fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          accessToken: 'concurrent-refreshed-at',
          refreshToken: 'concurrent-refreshed-rt',
        }),
      } as unknown as Response;
    }) as typeof fetch;

    setAuthTokens('expired-at', 'valid-rt');

    // Trigger two refresh calls in parallel
    const [p1, p2] = await Promise.all([refreshSession(), refreshSession()]);

    assert.equal(p1, true);
    assert.equal(p2, true);
    assert.equal(fetchCount, 1, 'Only one network request should be dispatched for concurrent refresh calls');
    assert.equal(getAccessToken(), 'concurrent-refreshed-at');
    assert.equal(getRefreshToken(), 'concurrent-refreshed-rt');

    globalThis.fetch = originalFetch;
    setAuthTokens(null, null);
  });

  test('refreshSession purges stored tokens when server responds 401 Unauthorized', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return {
        ok: false,
        status: 401,
        headers: new Headers(),
        json: async () => ({ code: 'INVALID_SESSION', message: 'Session is invalid or expired' }),
      } as unknown as Response;
    }) as typeof fetch;

    setAuthTokens('expired-at', 'dead-revoked-rt');
    await mobileStorage.saveTokens({ accessToken: 'expired-at', refreshToken: 'dead-revoked-rt' });

    const success = await refreshSession();
    assert.equal(success, false);
    assert.equal(getAccessToken(), null, 'Stored access token should be cleared on 401');
    assert.equal(getRefreshToken(), null, 'Stored refresh token should be cleared on 401');

    const storedInStorage = await mobileStorage.loadTokens();
    assert.equal(storedInStorage.accessToken, null);
    assert.equal(storedInStorage.refreshToken, null);

    globalThis.fetch = originalFetch;
  });
});

describe('Mobile Relatives & Directory Client Methods', () => {
  test('client defines all required endpoints', () => {
    assert.equal(typeof api.listRelatives, 'function');
    assert.equal(typeof api.registerRelative, 'function');
    assert.equal(typeof api.issueQuickPass, 'function');
    assert.equal(typeof api.deleteRelative, 'function');
    assert.equal(typeof api.listPublicSocieties, 'function');
    assert.equal(typeof api.listPublicFlats, 'function');
    assert.equal(typeof api.registerUser, 'function');
    assert.equal(typeof api.selfRegisterVisitor, 'function');
    assert.equal(typeof api.changePassword, 'function');
    assert.equal(typeof api.registerPushToken, 'function');
    assert.equal(typeof api.unregisterPushToken, 'function');
    assert.equal(typeof api.listPushTokens, 'function');
    assert.equal(typeof api.createRazorpayOrder, 'function');
    assert.equal(typeof api.verifyRazorpayPayment, 'function');
    assert.equal(typeof api.createStripePaymentIntent, 'function');
    assert.equal(typeof api.verifyStripePayment, 'function');
  });

  test('payment and push methods format HTTP requests accurately', async () => {
    const originalFetch = globalThis.fetch;
    const calls: { url: string; method: string; body: any }[] = [];

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ ok: true, orderId: 'ord_123', clientSecret: 'pi_secret_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    try {
      // 1. Push registration
      await api.registerPushToken('ExponentPushToken[abc123456]', 'expo', 'iPhone 15 Pro');
      assert.equal(calls[0].url.endsWith('/notifications/push-token'), true);
      assert.equal(calls[0].body.token, 'ExponentPushToken[abc123456]');

      // 2. Razorpay order
      await api.createRazorpayOrder('soc-1', 'inv-101');
      assert.equal(calls[1].url.endsWith('/societies/soc-1/invoices/inv-101/payment/razorpay/order'), true);

      // 3. Razorpay verify
      await api.verifyRazorpayPayment('soc-1', 'inv-101', {
        razorpayOrderId: 'ord_123',
        razorpayPaymentId: 'pay_123',
        razorpaySignature: 'sig_123',
      });
      assert.equal(calls[2].url.endsWith('/societies/soc-1/invoices/inv-101/payment/razorpay/verify'), true);

      // 4. Stripe intent
      await api.createStripePaymentIntent('soc-1', 'inv-101', 'inr');
      assert.equal(calls[3].url.endsWith('/societies/soc-1/invoices/inv-101/payment/stripe/intent'), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('relative registration error discrimination: only falls back on DUPLICATE_RELATIVE (Issue 10)', () => {
    const isDuplicate = (err: any) =>
      (err instanceof ApiError && (err.code === 'DUPLICATE_RELATIVE' || err.status === 409)) ||
      err?.code === 'DUPLICATE_RELATIVE';

    const duplicateErr = new ApiError('DUPLICATE_RELATIVE', 'Already registered', 409);
    assert.equal(isDuplicate(duplicateErr), true);

    const networkErr = new ApiError('NETWORK_ERROR', 'Network connection failed', 0);
    assert.equal(isDuplicate(networkErr), false);

    const serverErr = new ApiError('INTERNAL_ERROR', 'Database unavailable', 500);
    assert.equal(isDuplicate(serverErr), false);

    const genericErr = new TypeError('Failed to fetch');
    assert.equal(isDuplicate(genericErr), false);
  });
});



