/* WORKBRIDGE service worker — app shell caching only. API calls always go to the network. */
const CACHE = 'workbridge-v6';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/api.js',
  '/ui.js',
  '/views/common.js',
  '/views/public.js',
  '/views/worker.js',
  '/views/business.js',
  '/views/admin.js',
  '/views/docs.js',
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
      .then((cache) => cache.addAll(SHELL))
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

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Brand artwork and the manifest are network-first. Cache-first would keep
  // serving the previous logo from an older cache even after the file changed,
  // which is exactly how a replaced logo stays invisible to a returning visitor.
  if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});
