/* Saisie des notes hors ligne.
 *
 * Amélioration progressive : sans JavaScript, le formulaire se poste
 * normalement et tout fonctionne — simplement pas hors ligne.
 *
 * Le piège que ce fichier évite : une file en mémoire. L'enseignant saisit
 * quarante notes, le système reprend la mémoire de l'onglet, les notes sont
 * perdues. La file est donc dans IndexedDB, et elle survit à la fermeture.
 */
(function () {
  "use strict";

  var DB = "fasoschool", STORE = "outbox", VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "mutationId" });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var out = fn(t.objectStore(STORE));
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  var put = function (m) { return tx("readwrite", function (s) { return s.put(m); }); };
  var drop = function (id) { return tx("readwrite", function (s) { return s.delete(id); }); };
  var all = function () { return tx("readonly", function (s) { return s.getAll(); }); };

  function deviceId() {
    var k = "fasoschool.device";
    var v = null;
    try { v = localStorage.getItem(k); } catch (e) { /* navigation privée */ }
    if (!v) {
      v = (navigator.platform || "appareil").split(" ")[0] + "-" +
          Math.random().toString(36).slice(2, 8);
      try { localStorage.setItem(k, v); } catch (e) { /* ignoré */ }
    }
    return v;
  }

  var uuid = function () {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, function (c) {
      return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
    });
  };

  var form = document.querySelector("form[data-offline]");
  if (!form || !window.indexedDB) return;

  var banner = document.getElementById("etat-file");
  var count = 0;

  function render(message, kind) {
    if (!banner) return;
    banner.className = kind || "";
    banner.textContent = message;
    banner.hidden = !message;
  }

  function refresh() {
    return all().then(function (rows) {
      count = rows.length;
      if (count === 0) {
        render(navigator.onLine ? "" : "Hors ligne. Les saisies partiront au retour du réseau.",
               navigator.onLine ? "" : "note warn");
      } else {
        render(count + (count > 1 ? " notes en attente d'envoi." : " note en attente d'envoi."),
               "note warn");
      }
      return rows;
    });
  }

  /* Les cellules modifiées, comparées à ce que le serveur a rendu. */
  function changed() {
    var out = [];
    var cells = form.querySelectorAll("input.note-cell[data-eval]");
    for (var i = 0; i < cells.length; i++) {
      var el = cells[i];
      var v = el.value.trim();
      if (v === el.getAttribute("data-original")) continue;

      var absent = v.toLowerCase() === "abs" || v.toLowerCase() === "a";
      var score = null;
      if (!absent && v !== "") {
        var n = Number(v.replace(",", "."));
        if (!isFinite(n) || n < 0 || n > 20) continue;   // hors barème : ignoré
        score = n;
      }
      if (!absent && v === "") continue;                  // effacement : voie normale

      out.push({
        mutationId: uuid(),
        deviceId: deviceId(),
        evaluationId: el.getAttribute("data-eval"),
        studentId: el.getAttribute("data-student"),
        score: score,
        isAbsent: absent,
        capturedAt: new Date().toISOString(),
        baseUpdatedAt: el.getAttribute("data-updated") || null,
        _el: el
      });
    }
    return out;
  }

  function send(mutations) {
    return fetch("/api/sync/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mutations: mutations.map(function (m) {
          var c = {}; for (var k in m) if (k !== "_el") c[k] = m[k]; return c;
        })
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  /* Rejoue la file. Le mutation_id rend l'opération idempotente : réenvoyer
     ce qui est déjà passé ne fait aucun mal. */
  function flush() {
    return all().then(function (rows) {
      if (rows.length === 0) return refresh();
      return send(rows).then(function (res) {
        var conflits = 0, rejets = 0, motif = "";
        return Promise.all(res.results.map(function (r) {
          if (r.outcome === "conflit") conflits++;
          if (r.outcome === "rejete") { rejets++; motif = r.reason || ""; }
          return drop(r.mutationId);
        })).then(function () {
          return refresh().then(function () {
            /* Un refus doit se voir. Annoncer « synchronisée » une note que le
               serveur a refusée, c'est le pire des deux mondes : l'enseignant
               croit son travail enregistre et ne le refera pas. */
            if (rejets > 0) {
              render(rejets + (rejets > 1 ? " notes refusées par le serveur. "
                                          : " note refusée par le serveur. ") + motif, "note bad");
            } else if (conflits > 0) {
              render(conflits + (conflits > 1 ? " notes divergentes signalées au censeur."
                                              : " note divergente signalée au censeur."), "note bad");
            } else if (res.results.length > 0) {
              render(res.results.length + " note(s) synchronisée(s).", "note good");
              setTimeout(refresh, 4000);
            }
          });
        });
      }).catch(function () { return refresh(); });
    });
  }

  form.addEventListener("submit", function (e) {
    var mutations = changed();
    if (mutations.length === 0) return;          // rien à faire : voie normale

    e.preventDefault();
    // On met en file D'ABORD, puis on tente l'envoi. Si le réseau tombe entre
    // les deux, rien n'est perdu.
    Promise.all(mutations.map(function (m) {
      var c = {}; for (var k in m) if (k !== "_el") c[k] = m[k];
      return put(c);
    })).then(function () {
      mutations.forEach(function (m) {
        m._el.setAttribute("data-original", m._el.value.trim());
        m._el.style.borderColor = "var(--ochre)";
      });
      return refresh();
    }).then(flush);
  });

  window.addEventListener("online", flush);
  window.addEventListener("offline", refresh);
  refresh().then(flush);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(function () { /* sans effet */ });
  }
})();
