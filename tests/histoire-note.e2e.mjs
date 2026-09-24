/**
 * « La réponse au parent qui conteste une note » — et elle n'existait que pour
 * les notes saisies hors ligne.
 *
 * CE QUI A ÉTÉ TROUVÉ. `grade_entry_revisions` porte, dans le code qui
 * l'alimentait, ce commentaire : « Append-only : la réponse au parent qui
 * conteste une note. » Deux endroits l'écrivaient, et les deux étaient le
 * chemin HORS LIGNE — la synchronisation d'un appareil, l'arbitrage d'un
 * conflit. Le chemin NORMAL, celui par lequel passe la quasi-totalité des
 * notes d'une année — un enseignant qui tape sur l'écran des notes —
 * n'écrivait rien.
 *
 * Éprouvé sur le produit qui tournait :
 *
 *   * 14,50 remplacé par 19 : la note change, `grade_entry_revisions` reste à
 *     ZÉRO ligne ;
 *   * la case vidée : `delete from grade_entries`, la ligne disparaît, et
 *     l'écran annonce « 0 note enregistrée » — le message exact de « il ne
 *     s'est rien passé » ;
 *   * le journal garde `{"classe": "…", "saisies": 0}`. Un compte.
 *
 * Et la clé étrangère achevait le travail : `on delete cascade`. L'histoire
 * d'une note était câblée pour être détruite par le geste même qu'elle existe
 * pour documenter.
 *
 * POURQUOI C'EST LE PLUS GRAVE. Une note est le seul nombre de ce produit
 * qu'une famille peut contester, et celui qu'il est le plus tentant de
 * changer : un redoublement, une bourse, un rang se jouent à un demi-point.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. une note modifiée par l'écran laisse son histoire — avec l'avant,
 *      l'après, le chemin et la main ;
 *   2. renvoyer la feuille sans rien changer n'écrit RIEN (sinon la seule
 *      ligne qui compte serait noyée) ;
 *   3. effacer une note est compté, nommé à l'écran, et laisse une ligne —
 *      qui SURVIT à la disparition de la note ;
 *   4. l'histoire se lit, et une histoire vide est distinguée de « cette note
 *      n'a jamais bougé » ;
 *   5. le chemin hors ligne dit d'où il parle, et un `psql` qui l'oublie
 *      retombe sur « online » plutôt que de ne rien écrire ;
 *   6. la saisie des notes montre quelles cases ont bougé ;
 *   7. le tableau de bord signale les notes effacées de la semaine.
 *
 *   node tests/histoire-note.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4294;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(
  `select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE : trois notes, et l'histoire semée avec le jeu. On rend
 * les notes à leur valeur, et on retire les lignes d'histoire que CETTE suite
 * a écrites — reconnues à leur date, postérieure à la photo. */
const { rows: NOTES } = await client.query(
  `select ge.id, ge.evaluation_id, ge.student_id, ge.score, ge.is_absent,
          ge.is_justified, ge.recorded_by
     from grade_entries ge
     join evaluations ev on ev.id = ge.evaluation_id
    where ge.score is not null
    order by ev.held_on, ge.id limit 3`);
/* LA MARQUE N'EST PAS UNE DATE. Première version : « supprimer les révisions
 * postérieures au max(recorded_at) ». Les 288 lignes du jeu de démonstration
 * sont écrites dans une seule transaction, donc portent TOUTES le même
 * `now()` — et le pilote rendant l'horodatage à la milliseconde là où
 * PostgreSQL le garde à la microseconde, le « strictement postérieur »
 * attrapait les 288. Le témoin l'a dit tout de suite. On reconnaît donc ce
 * qu'on a créé par ce qu'on a relevé soi-même : la liste des identifiants
 * d'avant. */
const { rows: REVISIONS } = await client.query(
  `select id from grade_entry_revisions`);

if (NOTES.length < 3) {
  console.error("Il faut au moins trois notes chiffrées : lancez « npm run demo ».");
  await client.end();
  process.exit(1);
}

/* CE QUE LA SUITE EMPRUNTE EN PLUS : les lignes d'histoire d'UNE note, qu'elle
 * retire un instant pour montrer ce que le produit dit d'une note sans
 * histoire. Elle les remet — on possède ce qu'on emprunte autant que ce qu'on
 * crée. */
let empruntees = [];

const rendre = async () => {
  /* On remet les notes AVANT de nettoyer l'histoire : le déclencheur écrit en
   * remettant, et ces lignes-là sont aussi à nous. */
  for (const g of NOTES) {
    await client.query(
      `insert into grade_entries (id, school_id, evaluation_id, student_id,
                                  score, is_absent, is_justified, recorded_by)
       values ($1, current_school_id(), $2, $3, $4, $5, $6, $7)
       on conflict (id) do update
         set score = excluded.score, is_absent = excluded.is_absent,
             is_justified = excluded.is_justified`,
      [g.id, g.evaluation_id, g.student_id, g.score, g.is_absent,
       g.is_justified, g.recorded_by]);
  }
  await client.query(
    `delete from grade_entry_revisions where id <> all($1::uuid[])`,
    [REVISIONS.map((r) => r.id)]);
  for (const r of empruntees) {
    await client.query(
      `insert into grade_entry_revisions
         (id, school_id, grade_entry_id, evaluation_id, student_id, score,
          is_absent, ancien_score, ancien_is_absent, action, source,
          device_id, recorded_by, recorded_at)
       values ($1, current_school_id(), $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (id) do nothing`,
      [r.id, r.grade_entry_id, r.evaluation_id, r.student_id, r.score,
       r.is_absent, r.ancien_score, r.ancien_is_absent, r.action, r.source,
       r.device_id, r.recorded_by, r.recorded_at]);
  }
  empruntees = [];
  await client.query(`delete from audit_log where action = 'grades.save'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await rendre();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" },
  stdio: ["ignore", "pipe", "pipe"] });
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
const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

try {
  const cookie = await login("70000001");            // le censeur
  const page = async (chemin) =>
    texte(await (await fetch(`${BASE}${chemin}`, { headers: { cookie } })).text());

  const A = NOTES[0];
  const saisir = async (note, valeur) => texte(await (await fetch(
    `${BASE}/notes?classe=`, { method: "POST", headers: { cookie,
      "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      [`n_${note.evaluation_id}_${note.student_id}`]: valeur }).toString() })).text());
  const histoire = async (note) => (await client.query(
    `select * from histoire_d_une_note($1, $2)`,
    [note.evaluation_id, note.student_id])).rows;

  /* === 1. Une note modifiée laisse son histoire ======================== */
  console.log("\nUne note modifiée par l'écran laisse son histoire");

  const ecran1 = await saisir(A, "19");
  const enBase = (await client.query(
    `select score from grade_entries where id = $1`, [A.id])).rows[0];
  check("la note est bien passée à 19", Number(enBase.score) === 19,
    `${enBase?.score}`);

  const h1 = await histoire(A);
  check("l'histoire porte une ligne de plus", h1.length >= 1, `${h1.length}`);
  const der = h1[h1.length - 1];
  check("avec la valeur d'avant", Number(der.ancien_score) === Number(A.score),
    `${der.ancien_score} au lieu de ${A.score}`);
  check("et la valeur d'après", Number(der.score) === 19, `${der.score}`);
  check("le chemin est celui de l'écran des notes", der.source === "online",
    `${der.source} — une source non déclarée doit retomber sur « online », le`
      + ` chemin normal, pas sur un refus`);
  check("et la main qui l'a écrite est nommée", der.par !== null, `${der.par}`);
  check("l'écran confirme l'enregistrement",
    /1 note enregistrée/.test(ecran1), ecran1.slice(0, 160));

  /* === 2. Renvoyer la feuille sans rien changer n'écrit rien =========== */
  console.log("\nUne réécriture à l'identique n'est pas une révision");

  const avant2 = (await histoire(A)).length;
  await saisir(A, "19");
  await saisir(A, "19");
  const apres2 = (await histoire(A)).length;
  check("deux renvois identiques n'ajoutent aucune ligne",
    apres2 === avant2, `${avant2} → ${apres2}`
      + " — renvoyer une feuille réécrit quarante lignes dont trente-neuf"
      + " n'ont pas bougé ; les garder noierait la seule qui compte");

  /* === 3. Effacer une note : compté, nommé, et l'histoire survit ======= */
  console.log("\nEffacer une note ne se fait plus en silence");

  const efface = await saisir(A, "");
  const partie = await client.query(
    `select 1 from grade_entries where id = $1`, [A.id]);
  check("la note a bien été supprimée", partie.rowCount === 0);
  check("l'écran le dit, et nomme la valeur effacée",
    /1 note effacée/.test(efface) && /19/.test(efface),
    efface.slice(efface.indexOf("effacée") - 80, efface.indexOf("effacée") + 80)
      + " — elle produisait « 0 note enregistrée », le message exact de « il"
      + " ne s'est rien passé »");

  const h3 = await histoire(A);
  const sup = h3[h3.length - 1];
  check("l'histoire SURVIT à la disparition de la note",
    sup && sup.action === "suppression", JSON.stringify(sup));
  check("et elle porte ce que la note valait", Number(sup.ancien_score) === 19,
    `${sup?.ancien_score} — la clé étrangère portait « on delete cascade » :`
      + ` le geste emportait la preuve que la note avait existé`);
  check("les lignes d'avant sont toujours là", h3.length >= 2, `${h3.length}`);

  const jrn = (await client.query(
    `select detail from audit_log where action = 'grades.save'
      order by occurred_at desc limit 1`)).rows[0];
  check("le journal garde ce qui a disparu, pas seulement un compte",
    jrn && Number(jrn.detail.effacees) === 1
      && Array.isArray(jrn.detail.valeurs_effacees),
    JSON.stringify(jrn?.detail));

  /* === 4. L'histoire se lit, et le silence se distingue ================ */
  console.log("\nL'histoire se lit, et une histoire vide se distingue");

  const vue = await page(
    `/notes/histoire?evaluation=${A.evaluation_id}&eleve=${A.student_id}`);
  check("l'écran montre les mouvements de la note",
    /Ce que cette note a valu/.test(vue) && /effacée/.test(vue),
    vue.slice(0, 200));
  check("il dit qu'il n'y a plus de note aujourd'hui",
    /aucune note/.test(vue), vue.slice(vue.indexOf("Aujourd'hui"), vue.indexOf("Aujourd'hui") + 120));
  check("il nomme le chemin en clair, pas en jargon",
    /écran des notes/.test(vue) && !/'online'/.test(vue));

  /* Une note dont l'histoire n'a jamais été tenue. */
  const B = NOTES[1];
  empruntees = (await client.query(
    `select * from grade_entry_revisions
      where evaluation_id = $1 and student_id = $2`,
    [B.evaluation_id, B.student_id])).rows;
  await client.query(
    `delete from grade_entry_revisions where evaluation_id = $1 and student_id = $2`,
    [B.evaluation_id, B.student_id]);
  const vide = await page(
    `/notes/histoire?evaluation=${B.evaluation_id}&eleve=${B.student_id}`);
  check("une histoire vide n'est PAS présentée comme « n'a jamais bougé »",
    /n'a pas d'histoire enregistrée/.test(vide)
      && /ne veut pas dire qu'elle n'a jamais changé/.test(vide),
    vide.slice(vide.indexOf("histoire"), vide.indexOf("histoire") + 220));
  const combien = (await client.query(
    `select combien from notes_sans_histoire()`)).rows[0];
  check("et le produit sait combien de notes sont dans ce cas",
    Number(combien.combien) >= 1, `${combien.combien}`);

  /* === 5. Aucun chemin d'écriture n'échappe au déclencheur ============= */
  console.log("\nAucun chemin d'écriture n'échappe à l'histoire");

  const C = NOTES[2];
  const avant5 = (await histoire(C)).length;
  await client.query(
    `update grade_entries set score = 7 where id = $1`, [C.id]);
  const h5 = await histoire(C);
  check("un `update` en SQL brut laisse aussi son histoire",
    h5.length === avant5 + 1, `${avant5} → ${h5.length}`
      + " — la règle est posée dans la base et non dans le code, comme le"
      + " cloisonnement : deux chemins sur trois l'avaient, le troisième non");
  check("et il retombe sur « online » faute de source déclarée",
    h5[h5.length - 1].source === "online", `${h5[h5.length - 1].source}`);

  /* LA SOURCE SE DÉCLARE POUR LA TRANSACTION, comme `school_id`. C'est
   * `withSchool()` qui ouvre la transaction dans le produit ; ici on l'ouvre
   * à la main, sinon le réglage s'évapore à la fin de l'instruction — et le
   * déclencheur retomberait sur « online », ce qu'on vérifie juste au-dessus. */
  await client.query(`begin`);
  await client.query(
    `select set_config('schoolfaso.school_id', $1, true)`, [sc[0].school_id]);
  await client.query(`select set_config('schoolfaso.grade_source', 'offline', true)`);
  await client.query(`update grade_entries set score = 8 where id = $1`, [C.id]);
  await client.query(`commit`);
  const h5b = await histoire(C);
  check("un chemin qui déclare sa source la voit enregistrée",
    h5b[h5b.length - 1].source === "offline", `${h5b[h5b.length - 1].source}`);

  await client.query(`begin`);
  await client.query(
    `select set_config('schoolfaso.school_id', $1, true)`, [sc[0].school_id]);
  await client.query(`select set_config('schoolfaso.grade_source', 'n_importe_quoi', true)`);
  await client.query(`update grade_entries set score = 9 where id = $1`, [C.id]);
  await client.query(`commit`);
  const h5c = await histoire(C);
  check("une source inventée ne passe pas, et ne casse rien",
    h5c[h5c.length - 1].source === "online",
    `${h5c[h5c.length - 1].source} — une valeur refusée par la contrainte ferait`
      + ` échouer l'enregistrement de la note elle-même`);

  /* === 6. La saisie montre quelles cases ont bougé ===================== */
  console.log("\nLa saisie des notes montre quelles cases ont bougé");

  const klass = (await client.query(
    `select ev.class_id, ev.subject_id from evaluations ev where ev.id = $1`,
    [C.evaluation_id])).rows[0];
  const grille = await page(
    `/notes?classe=${klass.class_id}&matiere=${klass.subject_id}`);
  check("une note modifiée est signalée sur la feuille",
    /modifiée \d+×/.test(grille),
    grille.slice(grille.indexOf("modifiée"), grille.indexOf("modifiée") + 80)
      + " — le censeur qui relit avant le conseil n'a sinon aucun moyen de"
      + " savoir laquelle a changé");

  /* === 7. Le tableau de bord signale les effacements =================== */
  console.log("\nLe tableau de bord signale les notes effacées");

  const bord = await page("/");
  check("il nomme les notes effacées de la semaine",
    /note a été effacée|notes ont été effacées/.test(bord),
    bord.slice(bord.indexOf("effacée"), bord.indexOf("effacée") + 200));
  check("en disant que le geste est légitime mais qu'il change une moyenne",
    /geste légitime, mais il change une moyenne/.test(bord));
} catch (e) {
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
  await rendre();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 1500));
  process.exit(1);
}
console.log("Une note a désormais une histoire, quel que soit le chemin — et "
  + "l'effacer n'efface plus la preuve qu'elle a existé.");
