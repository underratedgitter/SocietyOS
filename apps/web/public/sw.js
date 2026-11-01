// SocietyOS Resident PWA Service Worker
const CACHE_NAME = 'societyos-cache-v2';
const PRECACHE_ASSETS = [
  '/offline.html',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon-maskable-512x512.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon.svg',
  '/manifest.webmanifest',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(async (cache) => {
        await Promise.allSettled(
          PRECACHE_ASSETS.map(async (asset) => {
            try {
              const res = await fetch(asset);
              if (res.ok) {
                await cache.put(asset, res);
              }
            } catch {
              // Ignore individual precache asset failure
            }
          }),
        );
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Never intercept API requests, auth calls, or dynamic RSC queries
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/_next/data/') ||
    event.request.headers.get('RSC')
  ) {
    return;
  }

  // Network-first strategy with cache fallback for assets and offline navigation
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache static assets and next static bundles on successful response
        if (
          response.status === 200 &&
          (url.pathname.startsWith('/_next/static/') ||
            url.pathname.startsWith('/icons/') ||
            url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.svg') ||
            url.pathname.endsWith('.css') ||
            url.pathname.endsWith('.js') ||
            url.pathname.endsWith('.webmanifest'))
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const offlinePage = await caches.match('/offline.html');
          if (offlinePage) return offlinePage;
        }
        return new Response('Network unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'Content-Type': 'text/plain' },
        });
      }),
  );
});
