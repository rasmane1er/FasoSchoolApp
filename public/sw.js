/* Service worker : rendre la page de saisie ouvrable sans réseau, et donner à
 * l'application une entrée honnête quand on la lance sans réseau du tout.
 *
 * Portée volontairement étroite. On ne met pas toute l'application en cache —
 * une page d'administration périmée serait pire qu'une page absente. Seule la
 * saisie des notes est mise en cache, parce que c'est le seul écran qu'un
 * enseignant ouvre là où il n'y a pas de réseau.
 *
 * CE QUI A CHANGÉ AVEC L'INSTALLATION SUR L'ÉCRAN D'ACCUEIL.
 *
 * Une fois l'application installée, on peut la lancer sans réseau : on touche
 * l'icône, et il n'y a pas d'onglet, pas de barre d'adresse, rien pour
 * expliquer une page blanche. Il fallait donc une page — mais pas n'importe
 * laquelle. Servir le tableau de bord depuis le cache aurait affiché des
 * effectifs et des impayés d'avant-hier avec l'aplomb de chiffres justes.
 *
 * D'où la règle : `/hors-ligne` est une page SANS DONNÉES. Elle dit ce qui
 * marche encore, ce qui ne marche pas, et pourquoi. Elle ne peut pas mentir,
 * puisqu'elle n'affirme rien sur l'école.
 */
var CACHE = "schoolfaso-v2";

/* Le strict nécessaire pour que l'application s'ouvre sans réseau. */
var COQUILLE = ["/hors-ligne", "/offline.js"];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(COQUILLE); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                           .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

var horsLigne = function () {
  return caches.match("/hors-ligne").then(function (hit) {
    return hit || new Response(
      "<!doctype html><meta charset=utf-8><p style='font-family:sans-serif;padding:40px'>" +
      "Pas de réseau.</p>",
      { headers: { "content-type": "text/html; charset=utf-8" } });
  });
};

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // La synchronisation ne passe jamais par le cache.
  if (url.pathname.indexOf("/api/") === 0) return;

  /* L'espace des familles est une autre porte, avec son propre cookie et son
     propre public. On ne lui impose pas la page hors-ligne du personnel. */
  if (url.pathname.indexOf("/famille") === 0) return;

  var cacheable = url.pathname === "/offline.js"
    || url.pathname === "/hors-ligne"
    || url.pathname.indexOf("/notes") === 0;

  if (cacheable) {
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
          return hit || horsLigne();
        });
      })
    );
    return;
  }

  /* Tout le reste : réseau, et rien d'autre. Si la navigation échoue, on ouvre
     la page hors-ligne plutôt qu'une erreur du navigateur — mais on ne met
     RIEN de tout cela en cache, jamais. */
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(horsLigne));
  }
});
