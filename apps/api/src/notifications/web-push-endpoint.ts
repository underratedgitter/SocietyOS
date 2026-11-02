import { AppException } from '../common/app.exception';

/**
 * Hosts operated by the browser push services. Only these may receive server-originated
 * requests: a denylist of private ranges cannot catch DNS names that resolve internally,
 * DNS rebinding, alternate IP notations or redirects.
 */
const ALLOWED_PUSH_HOSTS = new Set<string>([
  'fcm.googleapis.com', // Chrome / Chromium / Android
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari
]);

/** Push services that shard subscriptions across per-region subdomains. */
const ALLOWED_PUSH_HOST_SUFFIXES = [
  '.notify.windows.com', // Edge (WNS)
  '.push.apple.com', // Safari regional endpoints
];

function isAllowedPushHost(hostname: string): boolean {
  if (ALLOWED_PUSH_HOSTS.has(hostname)) return true;
  return ALLOWED_PUSH_HOST_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
}

/**
 * Shared by subscription registration and dispatch so a stored endpoint is re-checked
 * right before the server fetches it.
 */
export function validateWebPushEndpoint(endpoint?: string | null): void {
  if (!endpoint) return;

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw AppException.badRequest('INVALID_PUSH_ENDPOINT', 'Web push endpoint must be a valid URL');
  }

  if (url.protocol !== 'https:') {
    throw AppException.badRequest('INVALID_PUSH_ENDPOINT', 'Web push endpoint must use HTTPS protocol');
  }

  if (url.port !== '' || url.username !== '' || url.password !== '') {
    throw AppException.badRequest(
      'DISALLOWED_PUSH_ENDPOINT',
      'Web push endpoint must use the default HTTPS port without credentials',
    );
  }

  if (!isAllowedPushHost(url.hostname.toLowerCase())) {
    throw AppException.badRequest(
      'DISALLOWED_PUSH_ENDPOINT',
      'Web push endpoint must belong to a supported browser push service',
    );
  }
}
