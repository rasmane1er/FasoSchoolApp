/**
 * Le calendrier dont une suite a besoin, empruntée et rendue.
 *
 * POURQUOI CE MODULE EXISTE. Le 21 septembre 2026, quatre suites sont mortes
 * ensemble sur un `page.waitForNavigation: Timeout 30000ms` qui ne parlait pas
 * du calendrier. La cause : le jeu de démonstration avait été semé le 14, avec
 * « aujourd'hui » placé au 75ᵉ jour d'un premier trimestre qui en compte 80.
 * Sept jours plus tard, le 82ᵉ jour : hors trimestre.
 *
 * Le produit se comportait alors exactement comme il doit — il refusait de
 * deviner un trimestre et demandait lequel (voir 0025) — et les suites, qui
 * cliquaient « Publier » sans avoir répondu, attendaient une navigation qui ne
 * venait pas.
 *
 * LA RÈGLE, ÉCRITE DANS LE README ET APPLIQUÉE ICI : une suite de tests possède
 * les réglages dont dépendent ses assertions. Une suite dont le résultat change
 * selon le jour de l'année où on la lance n'est pas une épreuve, c'est un
 * présage. Celles qui ont besoin d'être DANS un trimestre le posent elles-mêmes
 * et le rendent.
 *
 * Usage :
 *
 *     import { emprunterCalendrier } from "./calendrier-epreuve.mjs";
 *     const calendrier = await emprunterCalendrier(client);   // avant le serveur
 *     ...
 *     finally { await calendrier.rendre(); }
 */

/**
 * Retient les bornes des trimestres, puis place l'année de sorte
 * qu'AUJOURD'HUI tombe au milieu du premier trimestre — assez loin de ses deux
 * bords pour qu'aucune assertion ne dépende de la date d'exécution.
 *
 * Les trimestres suivants sont décalés du même nombre de jours : on déplace la
 * fenêtre, on ne redessine pas l'année. Leurs durées, leurs écarts et l'ordre
 * des séances restent ceux de la démonstration.
 */
export async function emprunterCalendrier(client, { marge = 21 } = {}) {
  /* LE CONTEXTE D'ÉTABLISSEMENT D'ABORD, sinon le RLS ne rend aucune ligne et
   * l'aide conclut « aucun trimestre : lancez npm run demo » alors que l'année
   * est là, complète. Éprouvé : deux suites appellent cette fonction avant de
   * poser leur contexte, et c'est leur droit — une aide doit se suffire. */
  const { rows: ctx } = await client.query(
    `select coalesce(current_setting('schoolfaso.school_id', true), '') as pose`);
  if (!ctx[0].pose) {
    const { rows: ec } = await client.query(
      `select school_id from auth_lookup_user('70000001')`);
    if (ec[0]) {
      await client.query(
        `select set_config('schoolfaso.school_id', $1, false)`, [ec[0].school_id]);
    }
  }

  const { rows: avant } = await client.query(
    `select id, sequence, starts_on::text as s, ends_on::text as e
       from terms order by sequence`);
  if (avant.length === 0) {
    throw new Error("Aucun trimestre : lancez `npm run demo`.");
  }

  const rendre = async () => {
    for (const t of avant) {
      await client.query(
        `update terms set starts_on = $2, ends_on = $3 where id = $1`,
        [t.id, t.s, t.e]);
    }
  };

  /* Déjà bien au chaud dans un trimestre ? On ne touche à rien. Déplacer un
   * calendrier qui va déjà est le meilleur moyen d'en casser un autre — et
   * `fixture.e2e.mjs` compte ce qui reste. */
  const { rows: etat } = await client.query(
    `select s.etat,
            (select t.ends_on - current_date from terms t where t.id = s.term_id)
              as jours_restants
       from situation_de_l_annee() s`);
  if (etat[0]?.etat === "en_trimestre"
      && Number(etat[0].jours_restants) >= marge) {
    return { rendre: async () => {}, deplace: false };
  }

  /* On vise le milieu du premier trimestre. `decalage` est le nombre de jours
   * dont toute l'année glisse ; il est calculé par PostgreSQL pour que la
   * notion d'« aujourd'hui » soit celle de la base, pas celle du conteneur. */
  const { rows: d } = await client.query(
    `select (current_date - (t.starts_on + ((t.ends_on - t.starts_on) / 2)))::int
              as decalage
       from terms t where t.sequence = 1`);
  const decalage = Number(d[0].decalage);
  await client.query(
    `update terms set starts_on = starts_on + $1, ends_on = ends_on + $1`,
    [decalage]);

  return { rendre, deplace: true, decalage };
}
