/* Service worker do Mar & Memória:
   - páginas (navegação): rede primeiro, cache como reserva (para não servir versão velha)
   - demais arquivos: cache primeiro (abre rápido e funciona offline nos modos locais)
   - /socket.io/ nunca passa pelo cache */
var CACHE = 'mar-memoria-v1';
var BASICOS = ['./', './index.html', './manifest.json', './icone-192.png', './icone-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BASICOS); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (nomes) {
    return Promise.all(nomes.filter(function (n) { return n !== CACHE; })
      .map(function (n) { return caches.delete(n); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.indexOf('/socket.io/') === 0) return; /* jogo online: sempre rede */

  if (e.request.mode === 'navigate') {
    /* rede primeiro; se estiver offline, usa a cópia guardada */
    e.respondWith(
      fetch(e.request).then(function (resp) {
        var copia = resp.clone();
        caches.open(CACHE).then(function (c) { c.put('./index.html', copia); });
        return resp;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(function (achado) {
      if (achado) return achado;
      return fetch(e.request).then(function (resp) {
        if (resp.ok && url.origin === location.origin) {
          var copia = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copia); });
        }
        return resp;
      });
    })
  );
});
