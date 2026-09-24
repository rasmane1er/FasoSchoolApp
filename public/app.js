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

/* Les sélecteurs qui envoient leur formulaire en changeant.
 *
 * DÉFAUT CORRIGÉ ICI, ET IL A COÛTÉ UNE SUITE ENTIÈRE. Sept écrans portaient
 * `onchange="this.form.submit()"` directement dans le HTML. Le jour où le
 * produit a posé une politique de sécurité du contenu — `script-src 'self'`,
 * sans `unsafe-inline` —, le navigateur a cessé d'exécuter ces gestionnaires :
 * changer de classe dans la liste déroulante ne faisait plus RIEN. Aucune
 * erreur à l'écran, aucune trace au serveur ; `app.e2e.mjs` est mort sur une
 * navigation qui n'arrivait jamais.
 *
 * C'est l'argument de la politique, retourné contre le produit : un
 * gestionnaire écrit dans un attribut EST du script en ligne, et le navigateur
 * ne sait pas distinguer celui qu'on a écrit de celui qu'on a subi. Le prix
 * est de le déplacer ici ; le gain est que `script-src 'self'` ferme toute la
 * classe des injections, y compris là où un échappement aurait été oublié.
 *
 * Et ce n'est pas une dépendance : sans JavaScript, le formulaire garde son
 * bouton « Afficher » et se poste normalement. Le changement automatique est
 * un confort, jamais le seul chemin.
 */
(function () {
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || !el.hasAttribute || !el.hasAttribute("data-envoi-auto")) return;
    if (el.form) el.form.submit();
  });
})();
