import type { VisitorCategory } from '../api/types';

export function formatDateTime(value: string | Date, timezone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone || 'Asia/Kolkata',
  }).format(date);
}

export function formatDate(value: string | Date, timezone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeZone: timezone || 'Asia/Kolkata',
  }).format(date);
}

export function formatWindow(from: string, until: string, timezone?: string): string {
  return `${formatDateTime(from, timezone)} → ${formatDateTime(until, timezone)}`;
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'Never';
  const delta = Date.now() - new Date(value).getTime();
  if (Number.isNaN(delta)) return '—';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function categoryLabel(value: VisitorCategory): string {
  switch (value) {
    case 'RELATIVE':
      return 'Family / Relative';
    case 'FRIEND':
      return 'Guest / Friend';
    case 'DELIVERY':
      return 'Delivery';
    case 'CAB':
      return 'Cab / Taxi';
    case 'MAINTENANCE':
      return 'Service / Maintenance';
    case 'OTHER':
      return 'Other';
    default:
      return value;
  }
}

export type WindowPreset =
  | 'TODAY'
  | 'REST_OF_DAY'
  | 'WEEKEND'
  | 'MULTIPLE_DAYS_3'
  | 'MULTIPLE_DAYS_7'
  | 'CUSTOM';

export function calculateWindowDates(
  preset: WindowPreset,
  customHours = 12,
  baseDate?: Date,
): { validFrom: string; validUntil: string } {
  const now = baseDate ? new Date(baseDate) : new Date();
  const from = new Date(now);
  let until = new Date(now);

  switch (preset) {
    case 'TODAY':
      until = new Date(now.getTime() + 4 * 3600 * 1000);
      break;
    case 'REST_OF_DAY':
      until.setHours(23, 59, 59, 999);
      if (until.getTime() <= from.getTime()) {
        until = new Date(from.getTime() + 4 * 3600 * 1000);
      }
      break;
    case 'WEEKEND': {
      const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
      const daysUntilSunday = (7 - dayOfWeek) % 7;
      until.setDate(now.getDate() + daysUntilSunday);
      until.setHours(23, 59, 59, 999);
      if (until.getTime() <= from.getTime()) {
        until = new Date(from.getTime() + 4 * 3600 * 1000);
      }
      break;
    }
    case 'MULTIPLE_DAYS_3':
      until = new Date(now.getTime() + 3 * 24 * 3600 * 1000);
      break;
    case 'MULTIPLE_DAYS_7':
      until = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      break;
    case 'CUSTOM': {
      const hours = Math.max(1, Math.min(168, Number(customHours) || 12));
      until = new Date(now.getTime() + hours * 3600 * 1000);
      break;
    }
  }

  return {
    validFrom: from.toISOString(),
    validUntil: until.toISOString(),
  };
}

export interface PassShareOptions {
  guestName: string;
  phone?: string | null;
  vehicle?: string | null;
  category: VisitorCategory;
  purpose?: string | null;
  building: string;
  flatNumber: string;
  validFrom: string;
  validUntil: string;
  pin?: string | null;
  passId?: string | null;
  apiUrl?: string | null;
  timezone?: string | null;
}

export function buildPassShareText(opts: PassShareOptions): string {
  const baseUrl = opts.apiUrl ? opts.apiUrl.replace(/\/api\/v1\/?$/, '') : 'http://localhost:80';
  const passLink = opts.passId ? `${baseUrl}/visitor-passes/${opts.passId}` : null;

  const lines = [
    '🏛️ *SocietyOS Visitor Pass*',
    `👤 *Guest:* ${opts.guestName}`,
    opts.phone ? `📱 *Phone:* ${opts.phone}` : null,
    opts.vehicle ? `🚗 *Vehicle:* ${opts.vehicle}` : null,
    `🏷️ *Category:* ${categoryLabel(opts.category)}${opts.purpose ? ` · ${opts.purpose}` : ''}`,
    `📍 *Destination:* ${opts.building} · Flat ${opts.flatNumber}`,
    `⏱️ *Window:* ${formatWindow(opts.validFrom, opts.validUntil, opts.timezone || undefined)}`,
    opts.pin ? '' : null,
    opts.pin ? `🔑 *Gate Access PIN:* ${opts.pin}` : null,
    opts.pin
      ? '👉 Enter this 6-digit PIN on the gate kiosk keypad, or scan the QR token under the camera for direct contactless entry.'
      : null,
    passLink ? `🔗 *Pass Link:* ${passLink}` : null,
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

export function buildWhatsAppShareUrl(shareText: string, phone?: string | null): string {
  const cleanPhone = phone ? phone.replace(/\D/g, '') : '';
  const encoded = encodeURIComponent(shareText);
  if (cleanPhone.length >= 10) {
    return `https://wa.me/${cleanPhone}?text=${encoded}`;
  }
  return `https://wa.me/?text=${encoded}`;
}

