/* Service worker mínimo: permite instalar la app y abrir más rápido.
   Los datos (Supabase) nunca se guardan en caché: siempre se piden en vivo. */
var V = 'caja-v1';
var BASE = ['./', 'index.html', 'adapter.js', 'config.js', 'logo.png', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(BASE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== V; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;   // Supabase y CDN: directo a la red
  // Primero la red (así siempre ves la versión más nueva); si no hay internet, lo guardado.
  e.respondWith(fetch(r).then(function (res) {
    var cp = res.clone(); caches.open(V).then(function (c) { c.put(r, cp); }); return res;
  }).catch(function () { return caches.match(r).then(function (m) { return m || caches.match('index.html'); }); }));
});
