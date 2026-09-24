/**
 * Emprunter les notes — et rendre aussi leur histoire.
 *
 * POURQUOI CETTE AIDE EXISTE. Depuis 0029, l'histoire d'une note est écrite
 * par la base, à chaque écriture et à chaque suppression, quel que soit le
 * chemin. C'est exactement ce qu'on voulait : aucun chemin d'écriture n'y
 * échappe. Conséquence immédiate et attendue : une suite qui écrit une note
 * pour éprouver un écran, puis remet la note à sa valeur, laisse DEUX lignes
 * d'histoire derrière elle — celle de l'écriture, celle du retour.
 *
 * `test:fixture` l'a dit au premier `check:all` : « il y en a 14 de trop ».
 * Le témoin a fait son travail ; c'est aux suites de faire le leur.
 *
 * LA RÈGLE, DÉJÀ ÉCRITE, APPLIQUÉE ICI : une suite possède ce qu'elle
 * emprunte autant que ce qu'elle crée, et elle reconnaît ce qu'elle a créé à
 * une marque qu'elle a posée elle-même — ici, la liste des identifiants
 * d'avant. Pas à une date : les lignes semées par `npm run demo` partagent
 * toutes le même `now()`, et le pilote rend l'horodatage à la milliseconde là
 * où PostgreSQL le garde à la microseconde. Un « strictement postérieur »
 * emporte alors les 288.
 *
 * USAGE, au plus près de la connexion, avant que la suite n'écrive :
 *
 *     import { emprunterLesNotes } from "./notes-epreuve.mjs";
 *     const notes = await emprunterLesNotes(client);
 *     try { … } finally { await notes.rendre(); }
 *
 * `rendre()` ne touche QUE les lignes d'histoire apparues depuis l'emprunt.
 * Il ne remet pas les notes elles-mêmes : chaque suite sait ce qu'elle a
 * changé et le rend déjà.
 */

export async function emprunterLesNotes(client) {
  /* Le contexte d'établissement doit être posé : sans lui le RLS ne montre
     aucune ligne, et l'emprunt croirait partir d'une base vide — puis
     supprimerait tout au retour. */
  const { rows: ctx } = await client.query(
    `select coalesce(current_setting('schoolfaso.school_id', true), '') as s`);
  if (ctx[0].s === "") {
    throw new Error(
      "emprunterLesNotes : le contexte d'établissement n'est pas posé. "
      + "Appelez set_config('schoolfaso.school_id', …) d'abord — sinon "
      + "l'emprunt part d'une base vide et le retour efface tout.");
  }

  const { rows } = await client.query(`select id from grade_entry_revisions`);
  const avant = rows.map((r) => r.id);

  return {
    combien: avant.length,
    rendre: async () => {
      await client.query(
        `delete from grade_entry_revisions where id <> all($1::uuid[])`,
        [avant]);
    },
  };
}
