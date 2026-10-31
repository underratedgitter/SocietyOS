import type { PassStatus, Role, VisitorCategory } from './types';

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

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function categoryLabel(value: VisitorCategory): string {
  return titleCase(value);
}

export function reasonLabel(value: string): string {
  if (value === 'VALID_VISITOR_PASS') return 'Valid visitor pass';
  return titleCase(value);
}

export function roleLabel(role: Role | string): string {
  if (role === 'SOCIETY_ADMIN') return 'Society administrator';
  if (role === 'RESIDENT') return 'Resident';
  if (role === 'GUARD') return 'Security guard';
  if (role === 'PLATFORM_ADMIN') return 'Platform operator';
  return titleCase(role);
}

export function passTone(status: PassStatus | string): string {
  switch (status) {
    case 'ACTIVE':
      return 'active';
    case 'PENDING_APPROVAL':
      return 'pending';
    case 'SCHEDULED':
      return 'scheduled';
    case 'REVOKED':
      return 'revoked';
    case 'EXPIRED':
      return 'expired';
    case 'EXHAUSTED':
      return 'exhausted';
    default:
      return 'neutral';
  }
}

export function gateLabel(type: string): string {
  if (type === 'BOOM_BARRIER') return 'Boom barrier';
  if (type === 'SLIDING_GATE') return 'Sliding gate';
  if (type === 'DOOR_LOCK') return 'Door lock';
  return titleCase(type);
}

export function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) return Promise.resolve();
  return navigator.clipboard.writeText(value);
}
