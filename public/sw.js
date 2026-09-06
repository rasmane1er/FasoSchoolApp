/* Service worker : rendre la page de saisie ouvrable sans réseau.
 *
 * Portée volontairement étroite. On ne met pas toute l'application en cache —
 * une page d'administration périmée serait pire qu'une page absente. Seule la
 * saisie des notes est mise en cache, parce que c'est le seul écran qu'un
 * enseignant ouvre là où il n'y a pas de réseau.
 */
var CACHE = "fasoschool-v1";

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.add("/offline.js"); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // La synchronisation ne passe jamais par le cache.
  if (url.pathname.indexOf("/api/") === 0) return;

  var cacheable = url.pathname === "/offline.js" || url.pathname.indexOf("/notes") === 0;
  if (!cacheable) return;

  // Réseau d'abord : une note fraîche vaut mieux qu'une note en cache.
  // Le cache ne sert que lorsque le réseau ne répond pas.
  e.respondWith(
    fetch(e.request).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        return hit || new Response(
          "<!doctype html><meta charset=utf-8><p style='font-family:sans-serif;padding:40px'>" +
          "Cette page n'a pas encore été ouverte avec du réseau.</p>",
          { headers: { "content-type": "text/html; charset=utf-8" } });
      });
    })
  );
});
