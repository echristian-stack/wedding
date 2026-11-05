const VERSION = 'wedding-v6';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'store.js', 'guide.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/couple.jpg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Pustaka Firebase dari gstatic: pakai cache dulu supaya pembukaan terasa instan.
  if (url.hostname === 'www.gstatic.com') {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;   // Firestore / Worker tidak disentuh

  // Aplikasi sendiri: tampilkan dari cache dulu (cepat), lalu perbarui diam-diam.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req);
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })
      .catch(() => hit || c.match('index.html'));
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});
