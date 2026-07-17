const CACHE = 'brickfeed-v4';
const VAPID_PUBLIC = 'BKodQ5y7xAtsmjFySGu-mDiMrKJVK4uVhDpNAsbgTy5zUaSUglRrPJo3Vjm6FtJp7H0Y85lYsVF6bZVgWYkVnMU';

function vapidKey() {
  const s = VAPID_PUBLIC, pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// avvisa le finestre aperte di ricaricare il feed (extra: es. fonti prioritarie)
async function tellClients(type, extra) {
  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  list.forEach(c => c.postMessage(Object.assign({ type }, extra)));
}
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Notifiche push: arrivano dal "postino" esterno anche ad app chiusa.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'BrickFeed', {
      body: d.body || 'Ci sono novità nel tuo feed.',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: 'brickfeed-push',
      data: { url: d.url || './', srcs: d.srcs || [] },
    });
    // se l'app è aperta, aggiorna subito il feed partendo dalle fonti con le novità
    await tellClients('bf-refresh', { srcs: d.srcs || [] });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const srcs = e.notification.data?.srcs || [];
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ type: 'bf-refresh', srcs }); return c.focus(); }
    }
    // avvio a freddo: le fonti con le novità viaggiano nell'URL (#bfsrc=…)
    const url = (e.notification.data?.url || './') + (srcs.length ? '#bfsrc=' + srcs.join(',') : '');
    return clients.openWindow(url);
  })());
});

// Il browser (soprattutto iOS) rigenera l'iscrizione: la ricreiamo subito e
// chiediamo alle finestre aperte di risalvarla su Firestore.
self.addEventListener('pushsubscriptionchange', e => {
  e.waitUntil((async () => {
    try { await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey() }); } catch (_) {}
    await tellClients('bf-resubscribe');
  })());
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only handle same-origin shell requests; news fetches always go to the network.
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
