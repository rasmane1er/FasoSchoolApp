/**
 * Justifier une absence.
 *
 * Cette suite existe parce que `is_justified` a passé toute la vie du projet à
 * `false`. Trois écrans et le bulletin affichaient pourtant la distinction, et
 * le moteur de calcul comptait ZÉRO toute absence non justifiée à une
 * évaluation. Un élève malade le jour de la composition — coefficient 2 —
 * perdait donc des points que rien, dans le logiciel, ne pouvait lui rendre.
 *
 * Ce qui est éprouvé ici :
 *
 *   - justifier une absence à une évaluation CHANGE LA MOYENNE, et la suite le
 *     mesure sur le bulletin réel, pas sur une case cochée ;
 *   - la règle « une absence non justifiée compte zéro » est en base, avec sa
 *     date d'effet, et le censeur peut la renverser ;
 *   - un motif écrit est obligatoire dans les deux sens ;
 *   - qui ne fait pas l'appel ne justifie pas, même en postant à la main.
 *
 *   node tests/justifications.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4216;
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
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000003')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

const { rows: an } = await client.query(
  `select id from academic_years order by (status='en_cours') desc limit 1`);
const { rows: kl } = await client.query(
  `select id, label from classes where academic_year_id = $1 order by label limit 1`,
  [an[0].id]);
const classe = kl[0];

/* On prend une COMPOSITION — coefficient 2 — parce que c'est là que l'écart
   entre « zéro » et « neutralisé » se voit le mieux sur une moyenne. */
const { rows: ev } = await client.query(
  `select ev.id, ev.label, ev.subject_id from evaluations ev
    where ev.class_id = $1 and ev.eval_type = 'composition'
    order by ev.held_on limit 1`, [classe.id]);
const compo = ev[0];

const { rows: el } = await client.query(
  `select st.id, st.last_name from enrolments e join students st on st.id = e.student_id
    where e.class_id = $1 order by st.last_name limit 1`, [classe.id]);
const eleve = el[0];

/* L'état d'origine de la note de cet élève à cette composition, et de la règle
   de notation : la démonstration doit ressortir exactement comme elle est
   entrée. */
const { rows: noteRangee } = await client.query(
  `select * from grade_entries where evaluation_id = $1 and student_id = $2`,
  [compo.id, eleve.id]);
/* La règle de l'année en cours : son `effective_from` est celui de la rentrée,
   qui peut être dans le futur quand on est en septembre. Filtrer sur la date du
   jour ne trouverait rien. */
const { rows: polRangee } = await client.query(
  `select id, unjustified_absence_counts_as_zero as zero from grading_policies
    order by effective_from desc limit 1`);

const snapshot = async () => ({
  notes: new Set((await client.query(`select id from grade_entries`)).rows.map((r) => r.id)),
});
const avant = await snapshot();

const restaurer = async () => {
  const apres = await snapshot();
  const neuves = [...apres.notes].filter((id) => !avant.notes.has(id));
  if (neuves.length) await client.query(
    `delete from grade_entries where id = any($1::uuid[])`, [neuves]);
  for (const n of noteRangee) {
    await client.query(
      `update grade_entries set score = $2, is_absent = $3, is_justified = false,
                                justification = null, justified_by = null,
                                justified_at = null
        where id = $1`, [n.id, n.score, n.is_absent]);
  }
  await client.query(
    `update attendance_records set is_justified = false, justification = null,
                                   justified_by = null, justified_at = null
      where justified_at is not null`);
  await client.query(
    `update grading_policies set unjustified_absence_counts_as_zero = $2
      where id = $1`, [polRangee[0].id, polRangee[0].zero]);
  await client.query(
    `delete from audit_log where action in ('absence.justify','absence.unjustify')`);
};

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1250 }, locale: "fr-FR" });
const page = await ctx.newPage();

const connecter = async (p, tel) => {
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};
const poster = (p, action, champs) => p.evaluate(async ({ action, champs }) => {
  const res = await fetch(action, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(champs).toString() });
  return { statut: res.status, corps: await res.text() };
}, { action, champs });

/* La moyenne telle que l'imprime le bulletin : on la lit sur l'écran des
   bulletins, pas en refaisant le calcul dans le test — sinon on éprouverait sa
   propre arithmétique. */
const moyenneAffichee = async (p) => {
  await p.goto(`${BASE}/bulletins?classe=${classe.id}`);
  await p.waitForSelector("table");
  // Colonne « Moyenne » : la troisième (Rang, Élève, Moyenne). On la vise par
  // sa position dans l'en-tête, pas par une expression sur le texte.
  return p.$eval(
    `xpath=(//tbody/tr[.//td[contains(., "${eleve.last_name}")]])[1]/td[3]`,
    (el) => el.textContent.trim()).catch(() => null);
};

try {
  await connecter(page, "70000003");                      // surveillant général

  console.log("\nOn rend l'élève absent à la composition");
  const { rows: noteId } = await client.query(
    `insert into grade_entries (school_id, evaluation_id, student_id, score,
                                is_absent, is_justified)
     values (current_school_id(), $1, $2, null, true, false)
     on conflict (evaluation_id, student_id) do update
       set score = null, is_absent = true, is_justified = false,
           justification = null, justified_by = null, justified_at = null
     returning id`, [compo.id, eleve.id]);
  const ligne = noteId[0].id;

  await client.query(
    `update grading_policies set unjustified_absence_counts_as_zero = true
      where id = $1`, [polRangee[0].id]);

  const avecZero = await moyenneAffichee(page);
  check("la moyenne est calculée avec l'absence comptée zéro",
    avecZero !== null, `lue : ${avecZero}`);

  console.log("\nLe tableau de bord le signale");
  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");
  const dash = await page.content();
  check("une absence à une évaluation remonte au tableau de bord",
    dash.includes("attend une explication")
      || dash.includes("attendent une explication"),
    "sans explication, elle compte zéro et c'est un bulletin faux qui part");
  check("et il mène à l'écran où trancher", dash.includes('href="/justifications"'));

  console.log("\nL'écran dit ce que justifier change AVANT de faire cliquer");
  await page.goto(`${BASE}/justifications?classe=${classe.id}`);
  await page.waitForLoadState("networkidle");
  const vue = await page.content();
  check("l'absence à la composition y figure", vue.includes(esc(compo.label)));
  check("elle est annoncée comme comptée zéro", vue.includes("Comptée zéro"));
  check("L'ÉCRAN DIT L'EFFET AVANT LE GESTE",
    vue.includes("compte <b>zéro</b> dans la moyenne"),
    "on ne fait pas signer un geste dont on cache l'effet");
  check("et rappelle qu'une justifiée est neutralisée",
    vue.includes("ni en bien ni"));

  console.log("\nCe qui est refusé");
  const sansMotif = await poster(page, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "1", motif: "" });
  check("justifier sans motif écrit est refusé",
    sansMotif.corps.includes("Écrivez le motif"),
    "« justifié » ne se vérifie pas trois mois plus tard");
  const quoiFaux = await poster(page, "/justifications", {
    classe: classe.id, quoi: "autre", ligne, justifier: "1",
    motif: "Certificat médical du 12/11" });
  check("une ligne d'un type inventé est refusée",
    quoiFaux.corps.includes("Ligne inconnue"));
  const { rows: rien } = await client.query(
    `select is_justified from grade_entries where id = $1`, [ligne]);
  check("et rien n'a été écrit", rien[0].is_justified === false);

  console.log("\nJustifier CHANGE LA MOYENNE");
  const MOTIF = "Certificat médical du 12 novembre, remis par la mère";
  const fait = await poster(page, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "1", motif: MOTIF });
  check("la justification est acceptée", fait.corps.includes("neutralisée"));
  const { rows: apres } = await client.query(
    `select is_justified, justification, justified_by from grade_entries where id = $1`,
    [ligne]);
  check("la base porte le motif et l'auteur",
    apres[0].is_justified && apres[0].justification === MOTIF
      && apres[0].justified_by !== null);

  const avecJustification = await moyenneAffichee(page);
  check("LA MOYENNE DU BULLETIN A CHANGÉ", avecJustification !== avecZero,
    `${avecZero} → ${avecJustification} : si elles sont égales, justifier ne sert à rien`);
  check("et elle a monté, pas baissé",
    Number((avecJustification ?? "0").replace(",", "."))
      > Number((avecZero ?? "0").replace(",", ".")),
    `${avecZero} → ${avecJustification}`);

  console.log("\nRetirer une justification");
  const retraitSansMotif = await poster(page, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "0", motif: "" });
  check("retirer sans motif est refusé aussi",
    retraitSansMotif.corps.includes("Dites pourquoi"),
    "le geste rétablit une absence non justifiée au dossier d'un élève");
  const retrait = await poster(page, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "0",
    motif: "Le certificat produit était celui d'un autre élève" });
  check("le retrait est accepté", retrait.corps.includes("de nouveau comptée"));
  check("la moyenne redescend", (await moyenneAffichee(page)) === avecZero);

  console.log("\nLa règle vit en base, pas dans un if");
  await poster(page, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "0",
    motif: "Remise à zéro avant le contrôle de la règle" }).catch(() => {});
  await client.query(
    `update grading_policies set unjustified_absence_counts_as_zero = false
      where id = $1`, [polRangee[0].id]);
  const sansZero = await moyenneAffichee(page);
  check("RENVERSER LA RÈGLE CHANGE LE CALCUL", sansZero !== avecZero,
    `${avecZero} avec la règle, ${sansZero} sans : elle n'était donc pas en dur`);
  await page.goto(`${BASE}/justifications?classe=${classe.id}`);
  check("et l'écran annonce alors l'autre effet",
    (await page.content()).includes("écartée du calcul"));
  await page.screenshot({ path: "out/captures/30-justifications.png", fullPage: true });
  await client.query(
    `update grading_policies set unjustified_absence_counts_as_zero = true
      where id = $1`, [polRangee[0].id]);

  console.log("\nUne absence de la journée");
  const { rows: jour } = await client.query(
    `select ar.id from attendance_records ar
       join attendance_sessions ses on ses.id = ar.attendance_session_id
      where ses.class_id = $1 and ar.status = 'absent' and not ar.is_justified
      limit 1`, [classe.id]);
  if (jour.length) {
    const fj = await poster(page, "/justifications", {
      classe: classe.id, quoi: "jour", ligne: jour[0].id, justifier: "1",
      motif: "Décès dans la famille, mot du père" });
    check("une absence de la journée se justifie",
      fj.corps.includes("absences justifiées"));
    const { rows: v } = await client.query(
      `select is_justified from attendance_records where id = $1`, [jour[0].id]);
    check("et la base le porte", v[0].is_justified === true,
      "le bulletin imprimait « Absences justifiées : 0 » pour tout le monde");
  }

  console.log("\nDroits");
  const eco = await browser.newContext({ locale: "fr-FR" });
  const p2 = await eco.newPage();
  await connecter(p2, "70000004");                        // économe
  const refus = await p2.goto(`${BASE}/justifications`);
  check("qui ne fait pas l'appel ne justifie pas", refus.status() === 403,
    `HTTP ${refus.status()}`);
  const post = await poster(p2, "/justifications", {
    classe: classe.id, quoi: "evaluation", ligne, justifier: "1",
    motif: "Écriture forcée depuis la comptabilité" });
  check("ni en postant à la main", post.statut === 403, `HTTP ${post.statut}`);
  await eco.close();

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select distinct action from audit_log
      where action in ('absence.justify','absence.unjustify')`);
  check("justifier et retirer sont journalisés", journal.length === 2,
    journal.map((j) => j.action).join(", "));

} finally {
  await browser.close();
  server.kill();
  await restaurer().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("La justification des absences est vérifiée de bout en bout.");
