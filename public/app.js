/* Enregistrement du service worker, sur TOUTES les pages du personnel.
 *
 * DÉFAUT CORRIGÉ ICI. Le service worker n'était enregistré que par
 * `offline.js`, et `offline.js` n'est chargé que par l'écran de saisie des
 * notes. Conséquence : un directeur qui n'ouvre jamais un cahier de notes
 * n'avait pas de service worker, donc pas d'application installable, donc pas
 * d'icône sur son écran d'accueil. Le seul rôle qui n'avait jamais besoin de
 * hors-ligne était aussi le seul à qui on voulait faire installer l'outil.
 *
 * Ce fichier ne fait que cela. Il ne met rien en cache lui-même et n'a aucun
 * effet visible : si l'enregistrement échoue — navigateur ancien, http en
 * production, mode privé — la page continue de fonctionner à l'identique.
 */
(function () {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(function () { /* sans effet */ });
})();
