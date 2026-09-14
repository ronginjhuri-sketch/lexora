// Bump this version string on every deploy that should force-refresh the app.
// Changing it changes the byte content of this file, which is what makes the
// browser notice there's a new service worker at all.
const CACHE_NAME = 'lexora-cache-v2';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png'
];

// Install: pre-cache the app shell, and activate the new worker immediately
// instead of waiting for all open tabs/windows to close.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// Activate: clean up old caches and take control of any already-open clients
// right away (so an installed home-screen app updates without needing to be
// fully closed and relaunched).
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: only handle same-origin GET requests.
// Firebase/Firestore/Auth calls go straight to the network so login and
// progress-sync always stay live.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // The app shell (index.html / navigations) is network-first: always try to
  // get the latest version first, and only fall back to the cached copy if
  // the device is offline. This is what makes updates show up right away
  // instead of only after the cache happens to refresh in the background.
  const isAppShell = request.mode === 'navigate' ||
    url.pathname === '/' || url.pathname.endsWith('/index.html');

  if (isAppShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Other same-origin assets (icons, manifest): cache-first with a
  // background refresh, since these rarely change.
  event.respondWith(
    caches.match(request).then((cached) => {
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

// Let a page force this worker to activate immediately (used by the
// update-check logic in index.html).
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
