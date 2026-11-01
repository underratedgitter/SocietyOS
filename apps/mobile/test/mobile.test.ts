import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  setApiUrl,
  getApiUrl,
  setAuthTokens,
  getAccessToken,
  getRefreshToken,
  parseSetCookie,
  ApiError,
  api,
} from '../src/api/client';
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
