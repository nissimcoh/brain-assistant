// Each worker serves a complete, versioned shell, even on a stalled Wi-Fi or VPN connection.
const CACHE = 'brain-shell-v37';
const SHELL = ['/index.html', '/app.js', '/drafts.js', '/styles.css', '/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL.map(path => new Request(path, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if ((name.startsWith('brain-shell-') || name.startsWith('felipe-shell-')) && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = req.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname) ? '/index.html' : url.pathname;
  if (!SHELL.includes(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(key) ?? fetch(req);
  })());
});
