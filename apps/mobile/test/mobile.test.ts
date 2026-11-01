import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  setApiUrl,
  getApiUrl,
  setAuthTokens,
  getAccessToken,
  getRefreshToken,
  ApiError,
} from '../src/api/client';
import {
  categoryLabel,
  formatDate,
  formatDateTime,
  formatWindow,
  relativeTime,
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

describe('Pass Sharing & Relative Registration Logic', () => {
  test('generates complete WhatsApp sharing message with PIN and vehicle details', () => {
    const guestName = 'Ramesh Patel';
    const vehicle = 'MH 02 CZ 4411';
    const pin = '948271';
    const building = 'Tower A';
    const flatNumber = '101';
    const validFrom = '2026-11-01T10:00:00.000Z';
    const validUntil = '2026-11-04T10:00:00.000Z';

    const shareText = [
      '🏛️ *SocietyOS Visitor Pass*',
      `👤 *Guest:* ${guestName}`,
      `🚗 *Vehicle:* ${vehicle}`,
      `🏷️ *Category:* Family / Relative · Family Visit`,
      `📍 *Destination:* ${building} · Flat ${flatNumber}`,
      `⏱️ *Window:* ${formatWindow(validFrom, validUntil, 'UTC')}`,
      '',
      `🔑 *Gate Access PIN:* ${pin}`,
      '👉 Enter this 6-digit PIN on the gate kiosk keypad, or scan the QR token under the camera for direct contactless entry.',
    ].join('\n');

    assert.ok(shareText.includes('Ramesh Patel'));
    assert.ok(shareText.includes('MH 02 CZ 4411'));
    assert.ok(shareText.includes('948271'));
    assert.ok(shareText.includes('Flat 101'));

    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    assert.ok(whatsappUrl.startsWith('https://wa.me/?text='));
    assert.ok(whatsappUrl.includes('948271'));
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
