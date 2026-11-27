// Each worker serves a complete, versioned shell, even on a stalled Wi-Fi or VPN connection.
const CACHE = 'brain-shell-v41';
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

// Notifications from the Mac (server/push.ts). Every push must show one, or iOS stops delivering them.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'בריין', {
    body: data.body || '',
    icon: '/icon-180.png',
    badge: '/icon-180.png',
    tag: data.tag || undefined,
    dir: 'rtl',
    lang: 'he',
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
  }));
});
// Tapping one opens Brain at that conversation: the open app if there is one, else a new window.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of open) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      client.postMessage({ type: 'open', url });
      return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});
