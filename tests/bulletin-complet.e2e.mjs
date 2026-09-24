/**
 * Un bulletin doit dire sur quoi il a été calculé.
 *
 * CE QUI ÉTAIT SILENCIEUX. Une discipline sans AUCUNE note sortait du calcul
 * de la moyenne générale — ni au numérateur, ni au dénominateur :
 *
 *     if (s.moyenne === null) continue;
 *
 * La règle est JUSTE : une matière non notée ne vaut pas zéro, et la
 * neutraliser est ce qu'il faut faire. Ce qui manquait, c'est de le DIRE.
 *
 * Conséquences, toutes invisibles :
 *
 *   - le bulletin imprimait une moyenne parfaitement plausible, calculée sur
 *     une partie du programme ;
 *   - le RANG comparait des élèves notés sur des ensembles de matières
 *     DIFFÉRENTS ;
 *   - et rien n'empêchait de publier. La publication FIGE : le papier remis
 *     aux familles portait ce rang-là.
 *
 * Il suffit qu'un enseignant n'ait pas fini sa saisie le jour du conseil.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. avec toutes les notes, la publication passe — pas de faux refus ;
 *   2. une matière vide fait REFUSER la publication, en la nommant, et rien
 *      n'est figé ;
 *   3. forcée, la publication passe et le bulletin LE DIT lui-même ;
 *   4. LA RÈGLE DE CALCUL NE CHANGE PAS : la matière manquante ne vaut
 *      toujours pas zéro. On compare les deux nombres.
 *
 *   node tests/bulletin-complet.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";
import { emprunterLesNotes } from "./notes-epreuve.mjs";
import { emprunterCalendrier } from "./calendrier-epreuve.mjs";

const PORT = 4245;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/* CETTE SUITE A BESOIN D'ÊTRE DANS UN TRIMESTRE.
 *
 * Le produit refuse de deviner un trimestre quand aujourd'hui n'en désigne
 * aucun (voir 0025) : il demande lequel. Une suite qui clique sans avoir
 * répondu meurt sur un délai d'attente qui ne parle pas du calendrier —
 * c'est arrivé à quatre suites le même jour. Elle pose donc elle-même le
 * réglage dont ses assertions dépendent, et le rend. */
const calendrier = await emprunterCalendrier(client);
const { rows: sc } = await client.query(
  `select school_id from auth_lookup_user('70000001')`);
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [SCHOOL]);

/* L'HISTOIRE DES NOTES EST ÉCRITE PAR LA BASE (0029) : écrire une note
 * pour éprouver un écran, puis la remettre, laisse deux lignes derrière
 * soi. On les emprunte, on les rend. */
const notesEmpruntees = await emprunterLesNotes(client);

const { rows: cl } = await client.query(
  `select id, label from classes order by label limit 1`);
const CLASSE = cl[0];

/* Les notes qu'on va retirer, relevées AVANT : cette suite doit rendre la
   démonstration exactement telle qu'elle l'a trouvée. */
const { rows: victime } = await client.query(
  `select st.id, st.last_name from enrolments e
     join students st on st.id = e.student_id
    where e.class_id = $1 order by st.last_name limit 1`, [CLASSE.id]);
const ELEVE = victime[0];
const { rows: mat } = await client.query(
  `select distinct ev.subject_id, s.label, co.coefficient
     from evaluations ev
     join subjects s on s.id = ev.subject_id
     join coefficients co on co.subject_id = s.id
    where ev.class_id = $1 order by s.label limit 1`, [CLASSE.id]);
const MATIERE = mat[0];

const { rows: notesRetirees } = await client.query(
  `select ge.id, ge.evaluation_id, ge.student_id, ge.score, ge.is_absent,
          ge.is_justified, ge.recorded_by
     from grade_entries ge
     join evaluations ev on ev.id = ge.evaluation_id
    where ge.student_id = $1 and ev.subject_id = $2`,
  [ELEVE.id, MATIERE.subject_id]);

/* `purger()` est appelée AUSSI EN COURS D'ÉPREUVE, entre les deux
 * publications. Elle ne doit donc toucher qu'aux bulletins : fermer les
 * sessions ici déconnecterait le censeur au milieu de son propre test, et
 * la moitié des assertions liraient l'écran de connexion en croyant lire
 * un refus de publication. Les sessions se ferment au début et à la fin,
 * là où personne n'est connecté. */
const purger = async () => {
  await client.query(`delete from bulletin_lines`);
  await client.query(`delete from bulletins`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
};
const fermerLesSessions = async () => {
  await client.query(`delete from auth_sessions`);
};
await purger();
await fermerLesSessions();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });
const up = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/sante`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
})();
if (!up) { console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1200)); server.kill(); process.exit(1); }

const login = async (phone) => {
  const a = await fetch(`${BASE}/connexion`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone }).toString() });
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};
const publier = async (cookie, forcer = false) => (await fetch(
  `${BASE}/bulletins/publier?classe=${CLASSE.id}`, { method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: forcer ? "forcer=1" : "" })).text();
const imprimer = async (cookie) => (await fetch(
  `${BASE}/bulletins/imprimer?classe=${CLASSE.id}`, { headers: { cookie } })).text();
const figes = async () => Number((await client.query(
  `select count(*)::int as n from bulletins where status = 'publie'`)).rows[0].n);

try {
  const cookie = await login("70000001");   // censeur

  /* === 1. Rien ne manque : pas de faux refus ============================= */
  console.log("\nAvec toutes les notes, la publication passe");
  const complet = await publier(cookie);
  check("aucun refus quand le trimestre est complet",
    /bulletins figés/.test(complet),
    complet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
  check("les douze bulletins sont figés", (await figes()) === 12);

  const sansBandeau = await imprimer(cookie);
  check("et AUCUN bulletin ne porte l'avertissement",
    !/Moyenne calculée sur/.test(sansBandeau),
    "un avertissement qui s'affiche toujours ne veut plus rien dire");

  const { rows: avant } = await client.query(
    `select moyenne_generale, total_coefficients, total_coefficients_attendus, rang
       from bulletins where student_id = $1 and status = 'publie'`, [ELEVE.id]);
  check("les coefficients retenus et attendus sont égaux",
    Number(avant[0].total_coefficients) === Number(avant[0].total_coefficients_attendus),
    `${avant[0].total_coefficients} / ${avant[0].total_coefficients_attendus}`);

  /* === 2. Une matière vide fait refuser ================================== */
  console.log(`\nOn vide « ${MATIERE.label} » pour ${ELEVE.last_name}`);
  await client.query(
    `delete from grade_entries where id = any($1::uuid[])`,
    [notesRetirees.map((g) => g.id)]);
  await purger();

  const refus = await publier(cookie);
  check("LA PUBLICATION EST REFUSÉE", /est incomplet|sont incomplets/.test(refus),
    refus.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160));
  check("et elle nomme la matière", refus.includes(MATIERE.label));
  check("elle dit pourquoi c'est grave",
    /rang comparerait/.test(refus),
    "le rang compare des élèves notés sur des matières différentes");
  check("RIEN N'EST FIGÉ", (await figes()) === 0,
    "publier, c'est figer : un refus ne doit rien laisser derrière lui");
  check("et le refus est forçable", /name="forcer"/.test(refus),
    "un établissement peut publier sans une matière dont l'enseignant est "
      + "parti — mais il doit le décider");

  /* === 3. Forcée, la publication le dit ================================== */
  console.log("\nForcée, la publication passe — et le bulletin le dit");
  const force = await publier(cookie, true);
  check("la publication aboutit", /bulletins figés/.test(force));
  check("les douze bulletins sont là", (await figes()) === 12);

  const { rows: apres } = await client.query(
    `select moyenne_generale, total_coefficients, total_coefficients_attendus,
            bulletin_incomplet(id) as incomplet
       from bulletins where student_id = $1 and status = 'publie'`, [ELEVE.id]);
  check("LE BULLETIN FIGÉ PORTE LES DEUX NOMBRES",
    Number(apres[0].total_coefficients) < Number(apres[0].total_coefficients_attendus),
    `${apres[0].total_coefficients} retenus sur ${apres[0].total_coefficients_attendus}`);
  check("l'écart vaut exactement le coefficient de la matière retirée",
    Number(apres[0].total_coefficients_attendus) - Number(apres[0].total_coefficients)
      === Number(MATIERE.coefficient),
    `écart ${Number(apres[0].total_coefficients_attendus) - Number(apres[0].total_coefficients)}, `
      + `coefficient ${MATIERE.coefficient}`);
  check("et la base sait le dire", apres[0].incomplet === true);

  const bulletin = await imprimer(cookie);
  check("LE BULLETIN IMPRIMÉ LE DIT", /Moyenne calculée sur/.test(bulletin),
    "sans cela, la famille reçoit une moyenne calculée sur une partie du "
      + "programme sans rien qui le signale");
  check("il nomme la discipline sans note", bulletin.includes(MATIERE.label));
  check("ET IL DIT QUE CE N'EST PAS UN ZÉRO",
    /ne compte pas zéro/.test(bulletin),
    "sinon un parent lit l'avertissement comme une sanction");
  check("il prévient que le rang porte sur un programme partiel",
    /programme partiel/.test(bulletin));

  /* === 4. La règle de calcul n'a pas changé ============================== */
  console.log("\nLa matière manquante ne vaut toujours PAS zéro");
  const { rows: lignes } = await client.query(
    `select bl.moyenne_matiere, bl.coefficient from bulletin_lines bl
       join bulletins b on b.id = bl.bulletin_id
      where b.student_id = $1 and bl.moyenne_matiere is not null`, [ELEVE.id]);
  const num = lignes.reduce(
    (a, l) => a + Number(l.moyenne_matiere) * Number(l.coefficient), 0);
  const den = lignes.reduce((a, l) => a + Number(l.coefficient), 0);
  const attendue = Math.round((num / den) * 100) / 100;
  const avecZero = Math.round(
    (num / (den + Number(MATIERE.coefficient))) * 100) / 100;

  check("la moyenne est celle des matières NOTÉES",
    Math.abs(Number(apres[0].moyenne_generale) - attendue) < 0.02,
    `${apres[0].moyenne_generale} attendu ${attendue}`);
  check("ET NON CELLE QU'ON OBTIENDRAIT EN COMPTANT ZÉRO",
    Math.abs(Number(apres[0].moyenne_generale) - avecZero) > 0.05,
    `un zéro donnerait ${avecZero} — la règle est juste, c'est le silence `
      + `qui ne l'était pas`);

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  await calendrier.rendre();
  server.kill();
  await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [SCHOOL])
    .catch(() => {});
  /* Les notes retirées reviennent, avec leurs valeurs d'origine. */
  for (const g of notesRetirees) {
    await client.query(
      `insert into grade_entries (id, school_id, evaluation_id, student_id, score,
                                  is_absent, is_justified, recorded_by, updated_at)
       values ($1, current_school_id(), $2, $3, $4, $5, $6, $7, now())
       on conflict (evaluation_id, student_id) do update
         set score = excluded.score, is_absent = excluded.is_absent,
             is_justified = excluded.is_justified`,
      [g.id, g.evaluation_id, g.student_id, g.score, g.is_absent,
       g.is_justified, g.recorded_by]).catch(() => {});
  }
  await purger().catch(() => {});
  await fermerLesSessions().catch(() => {});
  await notesEmpruntees.rendre().catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le bulletin dit désormais sur quoi il a été calculé.");
