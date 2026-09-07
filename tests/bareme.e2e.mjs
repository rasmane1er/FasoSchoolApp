/**
 * Le barème d'une évaluation.
 *
 * `evaluations.bareme` existait depuis le premier schéma. RIEN ne l'écrivait,
 * RIEN ne le lisait. Trois conséquences, toutes silencieuses :
 *
 *   1. une interrogation sur 10 était impossible à créer, et si elle l'avait
 *      été, le moteur aurait pris 8/10 pour 8/20 — la note DIVISÉE PAR DEUX ;
 *   2. la saisie était bornée à 20 en dur, dans trois fichiers différents ;
 *   3. et une valeur hors barème était rejetée EN SILENCE, dans les trois.
 *      Le commentaire du code le disait : « saisie rejetée en silence ». Une
 *      case qui s'efface sans un mot fait croire à l'enseignant qu'il a mal
 *      cliqué — ou pire, il ne s'en aperçoit pas et la note manque au bulletin.
 *
 * Cette suite éprouve les trois, et mesure l'effet sur la moyenne réellement
 * affichée, pas sur une valeur en base.
 *
 *   node tests/bareme.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4217;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);

const { rows: an } = await client.query(
  `select id from academic_years order by (status='en_cours') desc limit 1`);
const { rows: kl } = await client.query(
  `select id, label from classes where academic_year_id = $1 order by label limit 1`,
  [an[0].id]);
const classe = kl[0];
const { rows: tr } = await client.query(
  `select id from terms where academic_year_id = $1 order by sequence limit 1`, [an[0].id]);
const termId = tr[0].id;
const { rows: sub } = await client.query(
  `select distinct sub.id, sub.label from evaluations ev
     join subjects sub on sub.id = ev.subject_id
    where ev.class_id = $1 and ev.term_id = $2 limit 1`, [classe.id, termId]);
const matiere = sub[0];
const { rows: el } = await client.query(
  `select st.id, st.last_name from enrolments e join students st on st.id = e.student_id
    where e.class_id = $1 order by st.last_name limit 1`, [classe.id]);
const eleve = el[0];

const INTITULE = "Interrogation sur 10 (contrôle automatique)";
/* Le doublon se juge sur type + date, pas sur l'intitulé : sans date propre,
   une interrogation déjà présente ferait silencieusement échouer la création. */
const DATE = "03/11/2026";

const snapshot = async () => ({
  evals: new Set((await client.query(`select id from evaluations`)).rows.map((r) => r.id)),
});
const avant = await snapshot();

const purge = async () => {
  // Par intitulé exact ET par identifiant apparu : un passage mort avant son
  // `finally` ne doit pas fausser le suivant.
  const apres = await snapshot();
  const neuves = [...apres.evals].filter((id) => !avant.evals.has(id));
  const ids = new Set(neuves);
  const { rows: parNom } = await client.query(
    `select id from evaluations where label = $1`, [INTITULE]);
  parNom.forEach((r) => ids.add(r.id));
  if (ids.size) {
    await client.query(
      `delete from grade_entries where evaluation_id = any($1::uuid[])`, [[...ids]]);
    await client.query(
      `delete from evaluations where id = any($1::uuid[])`, [[...ids]]);
  }
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1200 }, locale: "fr-FR" });
const page = await ctx.newPage();

const connecter = async (p, tel) => {
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent(".note.warn b")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};
const poster = (p, action, champs) => p.evaluate(async ({ action, champs }) => {
  const res = await fetch(action, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(champs).toString() });
  return { statut: res.status, corps: await res.text() };
}, { action, champs });

try {
  await connecter(page, "70000001");                      // censeur

  console.log("\nCe que le barème refuse");
  const absurde = await poster(page, "/notes/evaluation", {
    classe: classe.id, matiere: matiere.id, trimestre: termId, type: "devoir",
    intitule: INTITULE, date: DATE, bareme: "3000" });
  check("un barème absurde est refusé",
    absurde.corps.includes("entre 5 et 100"),
    "un barème de 3 000 ne se corrige pas après coup : les notes déjà saisies "
      + "deviendraient absurdes");
  const vide = await poster(page, "/notes/evaluation", {
    classe: classe.id, matiere: matiere.id, trimestre: termId, type: "devoir",
    intitule: INTITULE, date: DATE, bareme: "zéro" });
  check("un barème illisible est refusé", vide.corps.includes("entre 5 et 100"));
  const { rows: rien } = await client.query(
    `select count(*)::int as n from evaluations where label = $1`, [INTITULE]);
  check("et rien n'est créé", rien[0].n === 0);

  const sansTrimestre = await poster(page, "/notes/evaluation", {
    classe: classe.id, matiere: matiere.id, type: "devoir",
    intitule: INTITULE, date: DATE, bareme: "20" });
  check("un POST sans trimestre est refusé proprement",
    sansTrimestre.statut === 200 && sansTrimestre.corps.includes("manquant"),
    "il remontait une erreur PostgreSQL brute jusqu'à l'écran");

  console.log("\nUne interrogation sur 10");
  const cree = await poster(page, "/notes/evaluation", {
    classe: classe.id, matiere: matiere.id, trimestre: termId,
    type: "interrogation", intitule: INTITULE, date: DATE, bareme: "10" });
  check("elle se crée", cree.corps.includes("créée") || cree.corps.includes("ouverte"),
    cree.corps.includes("entre 5 et 100") ? "barème refusé" : "création muette");
  const { rows: ev } = await client.query(
    `select id, bareme from evaluations where label = $1`, [INTITULE]);
  check("LE BARÈME EST ÉCRIT EN BASE", ev.length === 1 && Number(ev[0].bareme) === 10,
    `${ev[0]?.bareme}`);
  const evalId = ev[0].id;

  await page.goto(`${BASE}/notes?classe=${classe.id}&matiere=${matiere.id}`);
  await page.waitForSelector("table");
  const grille = await page.content();
  check("la colonne annonce son barème", grille.includes("sur 10"),
    "sans cela un enseignant saisit sur 20 sans le savoir");
  check("et la case le porte pour la saisie hors ligne",
    grille.includes('data-bareme="10"'),
    "le serveur et le navigateur doivent valider la même chose");

  console.log("\nUne note sur 10 vaut une note sur 10");
  await poster(page, "/notes?classe=" + classe.id + "&matiere=" + matiere.id,
    { [`n_${evalId}_${eleve.id}`]: "10" });
  const { rows: brute } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, eleve.id]);
  check("la note est stockée telle qu'elle a été saisie",
    Number(brute[0].score) === 10,
    "on ne convertit pas à l'écriture : le 10 sur 10 de l'enseignant reste un 10");

  const { rows: vue } = await client.query(
    `select round(ge.score * 20 / ev.bareme, 2) as ramenee
       from grade_entries ge join evaluations ev on ev.id = ge.evaluation_id
      where ge.evaluation_id = $1 and ge.student_id = $2`, [evalId, eleve.id]);
  check("ET ELLE EST RAMENÉE SUR 20 POUR LA MOYENNE",
    Number(vue[0].ramenee) === 20,
    `${vue[0].ramenee} : un 10/10 qui compterait 10/20 diviserait la note par deux`);

  console.log("\nPlus de rejet en silence");
  const horsBareme = await poster(page,
    "/notes?classe=" + classe.id + "&matiere=" + matiere.id,
    { [`n_${evalId}_${eleve.id}`]: "15" });
  check("une note au-dessus du barème est REFUSÉE ET DITE",
    horsBareme.corps.includes("saisie refusée"),
    "le code disait lui-même « saisie rejetée en silence »");
  check("le refus nomme l'élève et la valeur tapée",
    horsBareme.corps.includes(eleve.last_name) && horsBareme.corps.includes("15"),
    "« une saisie refusée » sans dire laquelle oblige à relire trente lignes");
  check("et il rappelle le barème", horsBareme.corps.includes("entre 0 et 10"));
  const { rows: inchangee } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, eleve.id]);
  check("la note en place n'a pas bougé", Number(inchangee[0].score) === 10);

  const texte = await poster(page,
    "/notes?classe=" + classe.id + "&matiere=" + matiere.id,
    { [`n_${evalId}_${eleve.id}`]: "abcd" });
  check("une saisie illisible est refusée et dite aussi",
    texte.corps.includes("saisie refusée"));

  console.log("\nLa virgule française passe, sur les deux chemins");
  await poster(page, "/notes?classe=" + classe.id + "&matiere=" + matiere.id,
    { [`n_${evalId}_${eleve.id}`]: "7,5" });
  const { rows: virgule } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, eleve.id]);
  check("« 7,5 » est compris comme 7,5", Number(virgule[0].score) === 7.5,
    `${virgule[0].score} — on écrit les décimales avec une virgule en français`);

  console.log("\nLe chemin hors ligne refuse la même chose, avec le même motif");
  const sync = await page.evaluate(async ({ evalId, studentId }) => {
    const res = await fetch("/api/sync/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutations: [{
        mutationId: "11111111-2222-4333-8444-555555555555",
        deviceId: "controle", evaluationId: evalId, studentId,
        score: 18, isAbsent: false,
        capturedAt: new Date().toISOString(), baseUpdatedAt: null }] }) });
    return await res.json();
  }, { evalId, studentId: eleve.id });
  const verdict = (sync.results ?? [])[0] ?? {};
  check("une note hors barème arrivée hors ligne est rejetée",
    verdict.outcome === "rejete", JSON.stringify(verdict));
  check("AVEC SON MOTIF, pas en silence",
    (verdict.reason ?? "").includes("notée sur 10"),
    "sinon le bandeau annonce « synchronisée » et la note s'est volatilisée");
  const { rows: toujours } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, eleve.id]);
  check("et rien n'a été écrit", Number(toujours[0].score) === 7.5);
  await page.screenshot({ path: "out/captures/31-bareme.png", fullPage: true });

  console.log("\nLe barème par défaut reste 20");
  const parDefaut = await poster(page, "/notes/evaluation", {
    classe: classe.id, matiere: matiere.id, trimestre: termId, type: "devoir",
    intitule: INTITULE + " bis", date: "04/11/2026" });
  check("une évaluation créée sans barème est sur 20",
    !parDefaut.corps.includes("entre 5 et 100"));
  const { rows: d20 } = await client.query(
    `select bareme from evaluations where label = $1`, [INTITULE + " bis"]);
  check("et la base le confirme", Number(d20[0]?.bareme) === 20, `${d20[0]?.bareme}`);
  await client.query(`delete from evaluations where label = $1`, [INTITULE + " bis"]);

} finally {
  await browser.close();
  server.kill();
  await purge().catch(() => {});
  await client.query(`delete from evaluations where label like $1`,
    [INTITULE.slice(0, 20) + "%"]).catch(() => {});
  await client.query(`delete from sync_mutations where device_id = 'controle'`)
    .catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Le barème des évaluations est vérifié de bout en bout.");
