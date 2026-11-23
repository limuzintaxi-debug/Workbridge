/* WORKBRIDGE service worker — v9.
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
const CACHE = 'workbridge-v10';

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
  '/views/chat.js',
  '/notify.js',
  '/views/docs.js',
  '/views/agreement-open.js',
  '/assets/logo.png?v=2',
  '/assets/favicon-32.png?v=2',
  '/assets/apple-touch-icon.png?v=2',
  '/assets/icon-192.png?v=2',
  '/assets/icon-512.png?v=2',
  '/assets/icon-maskable-512.png?v=2',
  '/assets/apple-touch-icon-152.png?v=2',
  '/assets/apple-touch-icon-167.png?v=2',
  '/assets/splash-1170x2532.png',
  '/assets/splash-1284x2778.png',
  '/assets/splash-1125x2436.png',
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


/* Web Push: the server sends an empty tickle, so the worker builds the text
 * itself and only ever reveals what the payload contains. */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || 'WORKBRIDGE';
  const body = payload.body || 'You have a new notification.';
  const link = payload.link || '#/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/assets/icon-192.png?v=2',
      badge: '/assets/favicon-32.png?v=2',
      tag: payload.tag || 'workbridge',
      data: { link }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '#/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          client.postMessage({ type: 'notify-link', link });
          return client.focus();
        }
      }
      return self.clients.openWindow(`/${link}`);
    })
  );
});
