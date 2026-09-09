const CACHE = 'prs-assetverify-v3-root';
const CORE = [
  './',
  './index.html',
  './app.js?v=300-universal-scanner',
  './prs-scan.js?v=300',
  './scan-worker.js?v=300',
  './styles.css?v=300',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function cacheResponse(request, response) {
  if (!response || !response.ok) return response;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch (_) {}
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const trustedRuntimeAsset = url.hostname === 'unpkg.com' || url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'esm.sh';
  if (!sameOrigin && !trustedRuntimeAsset) return;

  // Navigation and all same-origin application files are network-first. This is
  // intentional: an iPhone must never stay trapped on an older cached scanner.
  if (request.mode === 'navigate' || sameOrigin) {
    event.respondWith((async () => {
      try {
        return await cacheResponse(request, await fetch(request, { cache: 'no-store' }));
      } catch (_) {
        return (await caches.match(request)) ||
          (request.mode === 'navigate' ? ((await caches.match('./index.html')) || (await caches.match('./'))) : Response.error());
      }
    })());
    return;
  }

  // Barcode decoder CDN dependencies (ZXing / Quagga2 / extended-linear / fallbacks) use cache-first after the first successful load.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil(fetch(request).then(r => cacheResponse(request, r)).catch(() => {}));
      return cached;
    }
    try { return await cacheResponse(request, await fetch(request)); }
    catch (_) { return Response.error(); }
  })());
});
