/* WORKBRIDGE service worker — v7.
 *
 * Why this file matters: the previous version (v6) served /app.js and
 * /views/*.js CACHE-FIRST and was itself never changed, so a returning browser
 * kept running the pre-upgrade application forever — new panels existed on the
 * server but were never executed in the browser.
 *
 * v7 is NETWORK-FIRST for every same-origin GET. The cache is an offline
 * fallback only, so each new deployment reaches an existing visitor on their
 * next load. /api/ is never intercepted.
 */
const CACHE = 'workbridge-v8';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/api.js',
  '/ui.js',
  '/views/common.js',
  '/views/public.js',
  '/views/account.js',
  '/views/worker.js',
  '/views/business.js',
  '/views/admin.js',
  '/views/admin-extras.js',
  '/views/owner.js',
  '/views/ride.js',
  '/views/bookings.js',
  '/views/mall.js',
  '/views/docs.js',
  '/views/agreement-open.js',
  '/assets/logo.png?v=2',
  '/assets/favicon-32.png?v=2',
  '/assets/apple-touch-icon.png?v=2',
  '/assets/icon-192.png?v=2',
  '/assets/icon-512.png?v=2',
  '/assets/icon-maskable-512.png?v=2',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // allSettled: one missing optional file must not stop the worker from
      // installing, otherwise the update is silently dropped.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromNetwork(request, cacheKey) {
  return fetch(request, { cache: 'no-cache' }).then((response) => {
    if (response && response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(cacheKey || request, copy)).catch(() => {});
    }
    return response;
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API traffic: sessions, invoices and bookings must be live.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fromNetwork(request, '/index.html').catch(() =>
        caches.match('/index.html').then((cached) => cached || caches.match('/'))
      )
    );
    return;
  }

  event.respondWith(
    fromNetwork(request).catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
