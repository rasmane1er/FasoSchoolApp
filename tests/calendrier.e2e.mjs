/**
 * Le calendrier scolaire, et le jour où l'appel est possible.
 *
 * CE QUI ÉTAIT CASSÉ. `calendar_events` existait depuis la migration 0001 et
 * aucune ligne du logiciel ne l'avait jamais ouverte. L'appel acceptait donc
 * n'importe quelle date :
 *
 *   ?date=xyz        → erreur PostgreSQL brute (22P02) à l'écran
 *   ?date=           → idem
 *   ?date=1999-01-01 → appel enregistré, sans un mot
 *   ?date=2027-12-25 → accepté, six mois après la fin de l'année scolaire
 *   ?date=2026-12-25 → accepté, jour de Noël
 *
 * Et l'appel n'écrit pas seulement : il ENVOIE UN SMS à chaque famille d'élève
 * absent. « Votre enfant est absent aujourd'hui » un jour sans école est le
 * message le plus destructeur que ce produit puisse émettre.
 *
 * CE QUE CETTE SUITE VÉRIFIE, dans l'ordre de ce qui compte :
 *
 *   1. LE REFUS EST À L'ÉCRITURE. Chaque cas est forcé par un POST fabriqué à
 *      la main, jamais par l'écran : un écran n'est pas une protection.
 *   2. AUCUN SMS NE PART un jour fermé — compté dans la base, pas déduit.
 *   3. Les fêtes légales sont celles de la LOI DE JANVIER 2026, qui a réduit
 *      les jours chômés de 15 à 11. Le 5 août et le 1er novembre ne ferment
 *      plus ; le 15 mai, oui. Une liste d'avant 2026 est fausse aujourd'hui.
 *   4. Les quatre fêtes MOBILES sont réclamées, pas devinées.
 *   5. Une école ne ferme pas celle du voisin.
 *
 *   node tests/calendrier.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4231;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const TEMOIN = "ÉPREUVE CALENDRIER";  // préfixe des lignes que ce test crée

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: ec } = await client.query(
  `select school_id from auth_lookup_user('70000001')`);
const SCHOOL = ec[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);

/* LA PURGE NE TOUCHE QUE LES JOURS DE CE TEST.
 *
 * CE QU'ELLE FAISAIT AVANT. Elle effaçait toute séance d'appel hors de
 * l'année scolaire OU tombant dans une liste de dates — dont le 5 et le
 * 10 octobre 2026. Or le jeu de démonstration sème l'assiduité tous les
 * cinq jours À PARTIR DU 5 OCTOBRE : cette purge lui prenait deux séances
 * et vingt-quatre présences À CHAQUE `check:all`. Personne ne le voyait,
 * parce qu'un bulletin se calcule aussi bien sur dix séances que sur douze.
 *
 * La règle, posée une fois pour toutes : UNE SUITE NE SUPPRIME QUE CE
 * QU'ELLE A CRÉÉ. Elle ne s'arroge pas une plage de dates, ni « tout ce qui
 * ressemble à ». Ici cela veut dire deux choses :
 *
 *   1. les jours d'épreuve sont choisis HORS du semis de démonstration —
 *      le lundi 12 et le samedi 17 octobre, non le 5 et le 10 ;
 *   2. la purge nomme exactement ces jours-là, sans intervalle ouvert.
 *
 * La borne « hors année scolaire » est retirée : ces appels-là sont refusés,
 * donc ils n'écrivent rien — il n'y avait jamais rien à purger, seulement un
 * risque d'emporter les séances d'une autre année. */
const JOURS = [
  "2026-12-25",   // Noël, fermé
  "2026-10-04",   // un dimanche
  "2026-10-12",   // un lundi ordinaire, hors semis de démonstration
  "2026-10-06",   // le jour d'une composition : ouvert
  "2026-10-17",   // un samedi, hors semis de démonstration
  "2027-01-05", "2027-01-06",   // les congés saisis par l'école
  "2027-05-27",   // Tabaski, saisie par l'école
];

const purger = async () => {
  await client.query(`delete from calendar_events where label like $1`, [TEMOIN + "%"]);
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions where session_date = any($1::date[]))`,
    [JOURS]);
  await client.query(
    `delete from attendance_sessions where session_date = any($1::date[])`, [JOURS]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
  await client.query(`update schools set school_days = '{1,2,3,4,5}'`);
};

/* LE GARDE-FOU. Si un jour le jeu de démonstration sème une séance sur l'un
 * de ces jours, la purge recommencerait à manger la fixture — en silence.
 * On l'apprend ici, bruyamment, AVANT de supprimer quoi que ce soit. */
const { rows: collision } = await client.query(
  `select session_date::text as d from attendance_sessions
    where session_date = any($1::date[])`, [JOURS]);
if (collision.length > 0) {
  console.error(
    "REFUS : le jeu de démonstration occupe des jours de cette épreuve — "
    + collision.map((x) => x.d).join(", ") + ".\n"
    + "Les purger prendrait des données qui ne sont pas à ce test. "
    + "Choisissez d'autres jours dans JOURS.");
  process.exit(1);
}
await purger();
const semaineInitiale = (await client.query(
  `select school_days from schools limit 1`)).rows[0].school_days;

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

const poster = (chemin, cookie, corps) => {
  /* `new URLSearchParams({jour: ["1","2"]})` produit `jour=1%2C2`, pas deux
     `jour=`. Le serveur lisait donc une seule valeur « 1,2,3,4,5,6 », que
     Number() rendait NaN — et la semaine restait inchangée sans rien dire.
     Un test qui se trompe ainsi ACCUSE le produit à tort. */
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(corps)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else p.append(k, v);
  }
  return fetch(BASE + chemin, { method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: p.toString() });
};

/** Combien de SMS et de lignes d'appel existent pour cette date. */
const trace = async (date) => {
  const { rows } = await client.query(
    `select (select count(*)::int from attendance_sessions
              where session_date = $1::date) as seances,
            (select count(*)::int from sms_messages
              where queued_at::date = current_date
                and body like '%' || to_char($1::date, 'DD/MM/YYYY') || '%') as sms`,
    [date]);
  return rows[0];
};

try {
  const cookie = await login("70000001");        // censeur : il tient le calendrier
  const { rows: cl } = await client.query(
    `select id from classes order by label limit 1`);
  const classe = cl[0].id;

  /* === 1. L'écran ========================================================= */
  console.log("\nLe calendrier existe, et il dit ce qui manque");
  const page = await (await fetch(`${BASE}/calendrier`, { headers: { cookie } })).text();
  check("l'écran répond", page.includes("Calendrier"));
  /* Pas l'Assomption : le 15 août tombe hors de l'année scolaire, et l'écran
     n'affiche que l'année en cours. Choisir une fête qui n'y est jamais aurait
     fait échouer le test pour la seule raison qu'il regardait au mauvais
     endroit. */
  check("les fêtes légales fixes de l'année y sont",
    /Noël/.test(page) && /Jour de l/.test(page) && /coutumes/.test(page),
    "Noël, le Jour de l'An et le 15 mai tombent tous dans l'année scolaire");
  check("IL RÉCLAME LES QUATRE FÊTES MOBILES",
    /Tabaski/.test(page) && /Ma[o]?uloud/.test(page) && /manque/.test(page),
    "leurs dates dépendent de l'observation de la lune : les deviner serait pire");
  check("et il dit ce qu'il en coûte de ne pas les saisir",
    /recevront des SMS/.test(page));

  /* === 2. La loi de janvier 2026 ========================================== */
  console.log("\nLes fêtes légales sont celles de la loi de janvier 2026");
  const ferme = async (jour) => (await client.query(
    `select label, closes_school from calendar_events
      where starts_on = $1::date and school_id is null
      order by closes_school desc limit 1`, [jour])).rows[0] ?? null;

  const noel = await ferme("2026-12-25");
  check("Noël ferme l'école", noel?.closes_school === true, JSON.stringify(noel));
  const coutumes = await ferme("2027-05-15");
  check("LE 15 MAI FERME L'ÉCOLE", coutumes?.closes_school === true,
    "Journée des coutumes et traditions — chômée depuis la loi de 2026 ; "
      + "absente de toute liste antérieure");
  const aout = await ferme("2027-08-05");
  check("LE 5 AOÛT NE FERME PLUS", aout && aout.closes_school === false,
    "la proclamation de l'Indépendance est devenue commémorative en 2026 — "
      + `trouvé : ${JSON.stringify(aout)}`);
  const toussaint = await ferme("2026-11-01");
  check("LE 1ER NOVEMBRE NE FERME PLUS", toussaint && toussaint.closes_school === false,
    `trouvé : ${JSON.stringify(toussaint)}`);
  check("mais les deux restent inscrits au calendrier",
    Boolean(aout) && Boolean(toussaint),
    "une date absente se lit comme un oubli du logiciel");

  /* === 3. Le refus est à l'écriture ====================================== */
  console.log("\nL'appel est REFUSÉ, et le refus est à l'écriture");

  /* Chaque cas ci-dessous est un POST fabriqué : on ne passe jamais par
     l'écran, exactement comme le ferait quelqu'un qui recopie une URL. */
  const appel = async (date) => {
    const avant = await trace(date);
    const r = await poster(`/absences?classe=${classe}&date=${encodeURIComponent(date)}`,
      cookie, {});
    const corps = await r.text();
    const apres = await trace(date);
    return { statut: r.status, corps, ecrit: apres.seances > avant.seances,
             sms: apres.sms - avant.sms };
  };

  for (const [date, quoi] of [
    ["1999-01-01", "vingt-sept ans avant l'année scolaire"],
    ["2027-12-25", "six mois après sa fin"],
    ["2026-12-25", "le jour de Noël"],
    ["2026-10-04", "un dimanche"],
  ]) {
    const a = await appel(date);
    check(`${date} — ${quoi} : refusé`,
      a.statut === 200 && /Appel impossible|Pas d(?:'|&#39;)appel/.test(a.corps),
      `statut ${a.statut}`);
    check(`${date} : RIEN N'EST ÉCRIT`, !a.ecrit);
    check(`${date} : AUCUN SMS NE PART`, a.sms === 0, `${a.sms} message(s)`);
  }

  console.log("\nUne date malformée ne fait plus tomber PostgreSQL sur l'écran");
  for (const mauvaise of ["xyz", "", "2026-13-45", "'; drop table students; --"]) {
    const r = await poster(
      `/absences?classe=${classe}&date=${encodeURIComponent(mauvaise)}`, cookie, {});
    const corps = await r.text();
    check(`date=${JSON.stringify(mauvaise)} : pas de 500`, r.status === 200,
      `statut ${r.status} — avant, une 22P02 brute s'affichait`);
    check(`date=${JSON.stringify(mauvaise)} : rien n'est écrit`,
      !/Appel enregistré/.test(corps));
  }
  const { rows: vivants } = await client.query(`select count(*)::int as n from students`);
  check("et les élèves sont toujours là", vivants[0].n > 0, `${vivants[0].n}`);

  /* === 4. Un jour ouvert reste ouvert ===================================== */
  console.log("\nUn jour d'école ordinaire marche toujours");
  const lundi = "2026-10-12";
  const ouvert = await poster(`/absences?classe=${classe}&date=${lundi}`, cookie, {});
  const corpsOuvert = await ouvert.text();
  check("le lundi 12 octobre est accepté", /Appel enregistré/.test(corpsOuvert),
    corpsOuvert.slice(0, 160));

  /* === 5. Ce que l'école ajoute ========================================== */
  console.log("\nL'établissement pose ses propres congés");
  const conges = await poster("/calendrier", cookie, {
    label: `${TEMOIN} congés du 1er trimestre`, type: "conges",
    debut: "2027-01-05", fin: "2027-01-06" });
  check("les congés sont enregistrés", /enregistré/.test(await conges.text()));

  const pendant = await appel("2027-01-05");
  check("PENDANT LES CONGÉS, L'APPEL EST REFUSÉ", !pendant.ecrit,
    "c'est la période saisie par l'école, pas une fête nationale");
  check("et aucun SMS ne part", pendant.sms === 0);
  const finConges = await appel("2027-01-06");
  check("le dernier jour de la période compte aussi", !finConges.ecrit,
    "un intervalle qui exclut sa borne de fin est un piège classique");

  console.log("\nUne composition ne ferme pas l'école");
  await poster("/calendrier", cookie, {
    label: `${TEMOIN} composition`, type: "composition", debut: "2026-10-06" });
  const compo = await appel("2026-10-06");
  check("l'appel a bien lieu le jour d'une composition", compo.ecrit,
    "c'est `closes_school` qui décide, pas le fait d'être au calendrier");

  /* === 6. La semaine de l'établissement ================================== */
  console.log("\nLa semaine est une donnée, pas une constante du code");
  const samedi = "2026-10-17";
  const avant = await appel(samedi);
  check("par défaut, pas d'école le samedi", !avant.ecrit);
  await poster("/calendrier/semaine", cookie, { jour: ["1", "2", "3", "4", "5", "6"] });
  const apres = await appel(samedi);
  check("L'ÉCOLE QUI TRAVAILLE LE SAMEDI PEUT FAIRE L'APPEL", apres.ecrit,
    "beaucoup d'établissements burkinabè travaillent le samedi matin : "
      + "un lundi-vendredi codé en dur les aurait exclus");
  const vide = await poster("/calendrier/semaine", cookie, {});
  check("mais une semaine vide est refusée",
    /au moins un jour/.test(await vide.text()));

  /* === 7. Ce qu'une école ne peut pas faire ============================== */
  console.log("\nCe qu'une école ne peut pas toucher");
  const { rows: nat } = await client.query(
    `select id, label from calendar_events where school_id is null
      and starts_on = '2026-12-25' limit 1`);
  const tentative = await poster("/calendrier/retirer", cookie, { id: nat[0].id });
  const dit = await tentative.text();
  check("elle ne retire pas une fête légale nationale",
    /nationale/.test(dit) && /ne se retire pas/.test(dit), dit.slice(0, 140));
  const { rows: encore } = await client.query(
    `select count(*)::int as n from calendar_events where id = $1`, [nat[0].id]);
  check("et la ligne est bien toujours là", encore[0].n === 1);

  /* Le cloisonnement du calendrier — une école ne doit pas voir les congés
     d'une autre, alors que les fêtes NATIONALES (school_id null) doivent
     rester visibles de toutes — est éprouvé dans `db/tests/rls_isolation.sql`,
     seul endroit où deux établissements existent pour de bon. La base de
     démonstration n'en a qu'un : l'assertion aurait passé pour la mauvaise
     raison. */

  /* === 8. Les fêtes mobiles saisies disparaissent de la réclamation ====== */
  console.log("\nQuand l'école saisit Tabaski, on cesse de la réclamer");
  const avantSaisie = (await client.query(
    `select count(*)::int as n from fetes_mobiles_manquantes('2026-10-01','2027-07-15')`
  )).rows[0].n;
  await poster("/calendrier", cookie, {
    label: `${TEMOIN} Tabaski`, type: "fete", debut: "2027-05-27" });
  const apresSaisie = (await client.query(
    `select count(*)::int as n from fetes_mobiles_manquantes('2026-10-01','2027-07-15')`
  )).rows[0].n;
  check("la liste des manquantes rétrécit", apresSaisie === avantSaisie - 1,
    `${avantSaisie} → ${apresSaisie}`);
  const jourTabaski = await appel("2027-05-27");
  check("et ce jour-là l'école est fermée", !jourTabaski.ecrit);

  console.log("\nErreurs serveur :",
    stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ") || "(aucune)");
  check("le serveur n'a levé aucune erreur",
    !/error/i.test(stderr), stderr.slice(-200));

} finally {
  server.kill();
  await purger().catch(() => {});
  await client.query(`update schools set school_days = $1`, [semaineInitiale])
    .catch(() => {});
  await client.query(
    `delete from audit_log where action like 'calendrier.%'`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le calendrier tient, et aucun SMS ne part un jour sans école.");
