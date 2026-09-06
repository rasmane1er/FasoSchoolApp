/**
 * Création des évaluations.
 *
 * C'était la première marche qui manquait : on pouvait saisir des notes, les
 * synchroniser hors ligne et publier des bulletins, mais rien ne permettait de
 * dire « j'ai donné un devoir le 12 novembre ». Tout le reste en dépendait.
 *
 * Le point burkinabè éprouvé ici : une COMPOSITION est harmonisée. Son sujet
 * est arrêté au district, pas par l'enseignant. Elle s'ouvre donc pour toutes
 * les classes d'un niveau à la fois, et seul le censeur peut l'ouvrir.
 *
 *   node tests/evaluations.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4204;
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

const { rows: kl } = await client.query(
  `select cl.id, cl.label, cl.level_code, cl.academic_year_id from classes cl
     join evaluations ev on ev.class_id = cl.id limit 1`);
const classe = kl[0];
// La matière de l'enseignante — elle a un service dessus.
const { rows: sienne } = await client.query(
  `select s.id, s.label from subjects s
     join teacher_assignments ta on ta.subject_id = s.id order by s.label limit 1`);
/* Une matière qu'elle N'ENSEIGNE PAS : « différente de la première » ne
   suffisait pas — elle en enseigne deux, et le test tombait sur la seconde. */
const { rows: autre } = await client.query(
  `select distinct s.id, s.label from subjects s
     join evaluations ev on ev.subject_id = s.id
    where s.id not in (select subject_id from teacher_assignments)
    order by s.label limit 1`);

const LIBELLE = "Contrôle de vérification";
// Une deuxième classe du même niveau, pour éprouver l'harmonisation.
const SOEUR = "6e Z test";
const purge = async () => {
  // Tout ce que le test peut créer, y compris ce qu'il crée en cas d'échec.
  await client.query(
    `delete from evaluations where label = any($1)`,
    [[LIBELLE, "Intrusion", "Après clôture", "X"]]);
  await client.query(
    `delete from evaluations where class_id in (select id from classes where label = $1)`,
    [SOEUR]);
  await client.query(`delete from classes where label = $1`, [SOEUR]);
  await client.query(`update terms set status = 'ouvert'`);
};
await purge();
await client.query(
  `insert into classes (school_id, academic_year_id, level_code, letter, label)
   values (current_school_id(), $1, $2, 'Z', $3)`,
  [classe.academic_year_id, classe.level_code, SOEUR]);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: "fr-FR" });
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
const envoyer = async (p, sel) =>
  Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click(sel)]);

const creer = async (p, { type, intitule, date }) => {
  await p.selectOption('form[action="/notes/evaluation"] [name="type"]', type);
  await p.fill('form[action="/notes/evaluation"] [name="intitule"]', intitule ?? "");
  await p.fill('form[action="/notes/evaluation"] [name="date"]', date ?? "");
  await envoyer(p, 'form[action="/notes/evaluation"] button[type=submit]');
  return p.content();
};

try {
  console.log("\nUne enseignante crée son devoir");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const prof = await ens.newPage();
  await connecter(prof, "70000002");
  await prof.goto(`${BASE}/notes?classe=${classe.id}&matiere=${sienne[0].id}`);
  await prof.waitForSelector('form[action="/notes/evaluation"]');

  check("l'écran de saisie porte la création d'évaluation",
    (await prof.content()).includes("Évaluations du trimestre"));
  check("une composition ne lui est pas proposée",
    !(await prof.$$eval('form[action="/notes/evaluation"] [name=type] option',
      (os) => os.map((o) => o.value))).includes("composition"),
    "le sujet d'une composition est arrêté au district, pas par elle");

  await creer(prof, { type: "devoir", intitule: LIBELLE, date: "12/11/2026" });
  const { rows: cree } = await client.query(
    `select eval_type, scope, to_char(held_on,'DD/MM/YYYY') as d, class_id
       from evaluations where label = $1`, [LIBELLE]);
  check("le devoir est créé", cree.length === 1, `${cree.length} créées`);
  check("il porte sa date", cree[0]?.d === "12/11/2026", cree[0]?.d);
  check("il reste attaché à sa seule classe", cree[0]?.scope === "classe");

  check("la nouvelle colonne apparaît dans le tableau de notes",
    (await prof.content()).includes(LIBELLE));

  console.log("\nCe qui est refusé");
  check("la même évaluation à la même date est refusée",
    (await creer(prof, { type: "devoir", intitule: LIBELLE, date: "12/11/2026" }))
      .includes("existe déjà"));
  check("une date illisible est refusée",
    (await creer(prof, { type: "devoir", intitule: "X", date: "bientôt" }))
      .includes("Date illisible"));

  // La matière d'un collègue, forcée par POST.
  const force = await prof.evaluate(async ([classe, matiere, trimestre]) => {
    const body = new URLSearchParams();
    body.set("classe", classe); body.set("matiere", matiere);
    body.set("trimestre", trimestre); body.set("type", "devoir");
    body.set("intitule", "Intrusion"); body.set("date", "13/11/2026");
    const r = await fetch("/notes/evaluation", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [classe.id, autre[0].id,
      (await client.query(`select id from terms order by sequence limit 1`)).rows[0].id]);
  console.log("DEBUG body =", (force.split("<div class=\"content\">")[1] ?? force)
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
  console.log("DEBUG contient class=ok ?", force.includes('class="ok"'));
  console.log("DEBUG note bad =", (force.match(/note bad">[^<]*/) ?? ["(aucun)"])[0]);
  check("créer dans la matière d'un collègue est refusé",
    force.includes("répartition de services"),
    "et le refus doit être VISIBLE, pas avalé par une branche de l'écran");
  const { rows: intrusion } = await client.query(
    `select count(*)::int as n from evaluations where label = 'Intrusion'`);
  check("et rien n'est écrit", intrusion[0].n === 0);

  console.log("\nLa composition est harmonisée");
  await connecter(page, "70000001");                      // censeur
  await page.goto(`${BASE}/notes?classe=${classe.id}&matiere=${sienne[0].id}`);
  await page.waitForSelector('form[action="/notes/evaluation"]');
  check("le censeur, lui, peut ouvrir une composition",
    (await page.$$eval('form[action="/notes/evaluation"] [name=type] option',
      (os) => os.map((o) => o.value))).includes("composition"));
  check("l'écran explique ce que cela déclenche",
    (await page.content()).includes("toutes les classes du niveau"));

  const compo = await creer(page, {
    type: "composition", intitule: LIBELLE, date: "05/12/2026" });
  check("l'ouverture est confirmée pour plusieurs classes",
    compo.includes("Composition ouverte pour 2 classes"), "6e B et 6e Z test");

  const { rows: partout } = await client.query(
    `select cl.label, ev.scope from evaluations ev join classes cl on cl.id = ev.class_id
      where ev.label = $1 and ev.eval_type = 'composition' order by cl.label`, [LIBELLE]);
  check("elle existe dans chaque classe du niveau", partout.length === 2,
    partout.map((r) => r.label).join(", "));
  check("et elle est marquée harmonisée",
    partout.every((r) => r.scope === "etablissement"));
  check("l'écran l'affiche comme telle",
    (await page.content()).includes("harmonisée"));
  await page.screenshot({ path: "out/captures/24-evaluations.png", fullPage: true });

  console.log("\nSuppression");
  // Une évaluation notée ne se supprime pas : cela effacerait les notes.
  const { rows: notee } = await client.query(
    `select ev.id from evaluations ev join grade_entries g on g.evaluation_id = ev.id
      where ev.class_id = $1 and ev.subject_id = $2 limit 1`,
    [classe.id, sienne[0].id]);
  const refus = await page.evaluate(async ([id, classe, matiere]) => {
    const body = new URLSearchParams();
    body.set("id", id); body.set("classe", classe); body.set("matiere", matiere);
    const r = await fetch("/notes/evaluation/retirer", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [notee[0].id, classe.id, sienne[0].id]);
  check("une évaluation notée ne se supprime pas",
    refus.includes("les effacerait"), "supprimer effacerait les notes en cascade");
  const { rows: toujours } = await client.query(
    `select count(*)::int as n from evaluations where id = $1`, [notee[0].id]);
  check("elle est toujours là", toujours[0].n === 1);

  // Une évaluation vide, en revanche, se retire.
  await page.goto(`${BASE}/notes?classe=${classe.id}&matiere=${sienne[0].id}`);
  const vide = await client.query(
    `select id from evaluations where label = $1 and class_id = $2`,
    [LIBELLE, classe.id]);
  const retrait = await page.evaluate(async ([id, classe, matiere]) => {
    const body = new URLSearchParams();
    body.set("id", id); body.set("classe", classe); body.set("matiere", matiere);
    const r = await fetch("/notes/evaluation/retirer", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [vide.rows[0].id, classe.id, sienne[0].id]);
  check("une évaluation sans note se retire", retrait.includes("supprimée"));

  console.log("\nTrimestre clôturé");
  await client.query(`update terms set status = 'clos'`);
  await page.goto(`${BASE}/notes?classe=${classe.id}&matiere=${sienne[0].id}`);
  check("aucun formulaire de création dans un trimestre clos",
    (await page.locator('form[action="/notes/evaluation"]').count()) === 0);
  const forceClos = await page.evaluate(async ([classe, matiere, trimestre]) => {
    const body = new URLSearchParams();
    body.set("classe", classe); body.set("matiere", matiere);
    body.set("trimestre", trimestre); body.set("type", "devoir");
    body.set("intitule", "Après clôture"); body.set("date", "20/12/2026");
    const r = await fetch("/notes/evaluation", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [classe.id, sienne[0].id,
      (await client.query(`select id from terms order by sequence limit 1`)).rows[0].id]);
  check("et la création forcée est refusée avec son motif",
    forceClos.includes("clôturé"));
  const { rows: apresClos } = await client.query(
    `select count(*)::int as n from evaluations where label = 'Après clôture'`);
  check("rien n'est écrit après la clôture", apresClos[0].n === 0);

  await ens.close();

} finally {
  await browser.close();
  server.kill();
  await purge().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Création des évaluations vérifiée de bout en bout.");
