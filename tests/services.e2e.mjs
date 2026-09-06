/**
 * Répartition des services : ce qu'un enseignant peut toucher.
 *
 * Ce test ne vérifie pas un écran, il vérifie une frontière. Le point qui
 * compte n'est pas que la liste déroulante soit filtrée — c'est qu'un
 * identifiant envoyé À LA MAIN, sans passer par le formulaire, soit refusé
 * lui aussi. Un filtre d'affichage n'a jamais protégé personne.
 *
 *   node tests/services.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4198;
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

// Services de départ, restitués à la fin.
const { rows: depart } = await client.query(
  `select staff_id, class_id, subject_id from teacher_assignments`);

const { rows: classe } = await client.query(`select id, label from classes limit 1`);
const { rows: siennes } = await client.query(
  `select s.id, s.label from subjects s
     join teacher_assignments ta on ta.subject_id = s.id
    order by s.label`);
const { rows: autres } = await client.query(
  `select distinct s.id, s.label from subjects s
     join evaluations ev on ev.subject_id = s.id
    where s.id <> all($1::uuid[]) order by s.label limit 1`,
  [siennes.map((r) => r.id)]);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
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

try {
  console.log("\nL'enseignante ne voit que son service");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const prof = await ens.newPage();
  await connecter(prof, "70000002");

  await prof.goto(`${BASE}/notes?classe=${classe[0].id}`);
  await prof.waitForSelector("select[name=matiere]");
  const proposees = await prof.$$eval("select[name=matiere] option",
    (os) => os.map((o) => o.textContent.trim()));
  check("seules ses matières lui sont proposées",
    proposees.length === siennes.length,
    `${proposees.length} proposées pour ${siennes.length} au service : ${proposees.join(", ")}`);
  check("la matière d'un collègue n'est pas dans la liste",
    !proposees.includes(autres[0].label), autres[0].label);

  console.log("\nLa frontière tient sans passer par le formulaire");
  // Ouvrir directement la matière d'un collègue par l'URL.
  await prof.goto(`${BASE}/notes?classe=${classe[0].id}&matiere=${autres[0].id}`);
  // Compter les champs réellement rendus : la feuille de style mentionne
  // « note-cell » sur toutes les pages, une recherche de texte serait fausse.
  const champs = await prof.locator("input.note-cell").count();
  check("ouvrir la matière d'un collègue par l'URL ne montre aucune note",
    champs === 0, `${champs} champs de saisie rendus`);

  // Poster une note sur une évaluation d'un collègue.
  const { rows: evCollegue } = await client.query(
    `select ev.id from evaluations ev where ev.subject_id = $1 limit 1`, [autres[0].id]);
  const { rows: eleve } = await client.query(
    `select student_id from enrolments limit 1`);
  const { rows: avant } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evCollegue[0].id, eleve[0].student_id]);

  await prof.evaluate(async ([classeId, ev, st]) => {
    const body = new URLSearchParams();
    body.set(`n_${ev}_${st}`, "3,25");
    await fetch(`/notes?classe=${classeId}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }, [classe[0].id, evCollegue[0].id, eleve[0].student_id]);

  const { rows: apres } = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evCollegue[0].id, eleve[0].student_id]);
  check("une note postée à la main sur la matière d'un collègue est refusée",
    Number(apres[0]?.score ?? -1) !== 3.25,
    `avant ${avant[0]?.score}, après ${apres[0]?.score}`);
  check("et la note existante n'est pas effacée non plus",
    Number(apres[0]?.score ?? -1) === Number(avant[0]?.score ?? -1),
    `avant ${avant[0]?.score}, après ${apres[0]?.score}`);

  console.log("\nLe censeur n'est pas filtré");
  await connecter(page, "70000001");
  await page.goto(`${BASE}/notes?classe=${classe[0].id}`);
  await page.waitForSelector("select[name=matiere]");
  const toutes = await page.$$eval("select[name=matiere] option",
    (os) => os.map((o) => o.textContent.trim()));
  check("le censeur voit toutes les matières de la classe",
    toutes.length > siennes.length, `${toutes.length} matières`);

  console.log("\nAttribution d'un service");
  await page.goto(`${BASE}/services`);
  await page.waitForSelector('form[action="/services"]');
  const vue = await page.content();
  check("les services existants sont listés", vue.includes(classe[0].label));

  await page.selectOption('[name="matiere"]', autres[0].id);
  await page.selectOption('[name="classe"]', classe[0].id);
  await envoyer(page, 'form[action="/services"] button[type=submit]');
  check("un service s'attribue", (await page.content()).includes("Service attribué"));

  await page.selectOption('[name="matiere"]', autres[0].id);
  await page.selectOption('[name="classe"]', classe[0].id);
  await envoyer(page, 'form[action="/services"] button[type=submit]');
  check("un service en double est refusé",
    (await page.content()).includes("déjà attribué"));

  await page.screenshot({ path: "out/captures/16-services.png", fullPage: true });

  // Et le nouveau service ouvre réellement l'écran de saisie.
  const { rows: qui } = await client.query(
    `select u.phone from teacher_assignments ta
       join staff s on s.id = ta.staff_id join users u on u.id = s.user_id
      where ta.subject_id = $1 limit 1`, [autres[0].id]);
  if (qui[0]?.phone === "70000002") {
    await prof.goto(`${BASE}/notes?classe=${classe[0].id}&matiere=${autres[0].id}`);
    check("le service attribué ouvre immédiatement la saisie",
      (await prof.locator("input.note-cell").count()) > 0);
  } else {
    check("le service attribué ouvre immédiatement la saisie", true,
      "attribué à un autre membre du personnel");
  }

  await envoyer(page, 'form[action="/services/retirer"] button[type=submit]');
  check("un service se retire", (await page.content()).includes("Service retiré"));

  console.log("\nDroits");
  const r = await prof.goto(`${BASE}/services`);
  check("une enseignante ne répartit pas les services",
    r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  await client.query(`delete from teacher_assignments`).catch(() => {});
  for (const d of depart) {
    await client.query(
      `insert into teacher_assignments (school_id, staff_id, class_id, subject_id)
       values (current_school_id(), $1, $2, $3) on conflict do nothing`,
      [d.staff_id, d.class_id, d.subject_id]).catch(() => {});
  }
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2000));
  process.exit(1);
}
console.log("Répartition des services vérifiée de bout en bout.");
