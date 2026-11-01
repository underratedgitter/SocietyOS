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

export function formatTime(value: string | Date, timezone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
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
