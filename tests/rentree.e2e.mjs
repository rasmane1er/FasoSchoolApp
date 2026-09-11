/**
 * Rentrée : ouvrir une année, poser les trimestres, créer les classes.
 *
 * Le parcours d'un établissement qui découvre le logiciel. Il doit pouvoir
 * tout faire seul, sans qu'on touche à la base pour lui.
 *
 *   node tests/rentree.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4193;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const LIBELLE = "2099-2100";          // hors de portée de toute donnée réelle

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
await client.query(`delete from auth_sessions`);

// L'année de test est effacée avant ET après : le reste de la démonstration
// ne doit rien voir passer.
// Le nom de l'année en cours au départ. Elle ne doit pas avoir bougé à la fin :
// c'est exactement ce qu'un écran de création mal conçu détruit.
const { rows: dep } = await client.query(
  `select id, label from academic_years where status = 'en_cours'`);
const ANNEE_REELLE = dep[0] ?? null;

const purge = async () => {
  const y = await client.query(`select id from academic_years where label = $1`, [LIBELLE]);
  for (const r of y.rows) {
    await client.query(`delete from classes where academic_year_id = $1`, [r.id]);
    await client.query(`delete from terms where academic_year_id = $1`, [r.id]);
    await client.query(`delete from academic_years where id = $1`, [r.id]);
  }
  // Le parcours ouvre l'année de test, ce qui referme la vraie : on la rouvre.
  if (ANNEE_REELLE) {
    await client.query(`update academic_years set status = 'en_cours' where id = $1`,
      [ANNEE_REELLE.id]);
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "fr-FR" });
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

const envoyer = async (p, selector = "button[type=submit]") => {
  await Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click(selector)]);
};

const remplir = async (p, champs) => {
  for (const [name, value] of Object.entries(champs)) {
    await p.fill(`[name="${name}"]`, value);
  }
};

try {
  await connecter(page, "70000005");                 // directeur

  console.log("\nCalendrier");
  await page.goto(`${BASE}/annee?nouvelle=1`);
  await page.waitForSelector('[name="libelle"]');

  // Trois trimestres égaux : accepté, mais le logiciel doit le dire.
  await remplir(page, {
    libelle: LIBELLE, debut: "01/10/2099", fin: "30/06/2100",
    t1_debut: "01/10/2099", t1_fin: "30/12/2099",
    t2_debut: "31/12/2099", t2_fin: "31/03/2100",
    t3_debut: "01/04/2100", t3_fin: "30/06/2100",
  });
  await envoyer(page, 'form[action="/annee"] button[type=submit]');
  const egaux = await page.content();
  check("l'année est enregistrée", egaux.includes("Calendrier de " + LIBELLE));
  check("trois trimestres égaux sont signalés", egaux.includes("divisé"),
    "c'est presque toujours l'année divisée en trois");

  // Le vrai calendrier : T3 tronqué par les examens.
  await remplir(page, {
    debut: "01/10/2099", fin: "15/07/2100",
    t1_debut: "01/10/2099", t1_fin: "19/12/2099",
    t2_debut: "05/01/2100", t2_fin: "27/03/2100",
    t3_debut: "06/04/2100", t3_fin: "12/06/2100",
  });
  await envoyer(page, 'form[action="/annee"] button[type=submit]');
  const bon = await page.content();
  check("un calendrier réaliste ne déclenche aucun avertissement", !bon.includes("divisé"));
  check("les durées sont affichées en semaines",
    bon.includes("11 semaines") && bon.includes("10 semaines"), "T1 = 11, T3 = 10");

  const t = await client.query(
    `select sequence, to_char(starts_on,'DD/MM/YYYY') as d, to_char(ends_on,'DD/MM/YYYY') as f
       from terms where academic_year_id =
         (select id from academic_years where label = $1) order by sequence`, [LIBELLE]);
  check("les trois trimestres sont en base", t.rowCount === 3, `${t.rowCount}`);
  check("le troisième trimestre est bien le plus court",
    t.rows[2].f === "12/06/2100", t.rows[2].f);

  console.log("\nCalendrier refusé");
  await remplir(page, { t2_debut: "01/12/2099" });     // chevauche le T1
  await envoyer(page, 'form[action="/annee"] button[type=submit]');
  check("des trimestres qui se chevauchent sont refusés",
    (await page.content()).includes("chevauchent"));
  const inchange = await client.query(
    `select to_char(starts_on,'DD/MM/YYYY') as d from terms
      where sequence = 2 and academic_year_id =
        (select id from academic_years where label = $1)`, [LIBELLE]);
  check("un calendrier refusé n'écrase rien", inchange.rows[0].d === "05/01/2100",
    inchange.rows[0].d);

  console.log("\nClasses");
  await page.goto(`${BASE}/annee?annee=` +
    (await client.query(`select id from academic_years where label = $1`, [LIBELLE])).rows[0].id);
  await page.waitForSelector('form[action="/annee/classe"]');
  check("aucune classe au départ",
    (await page.content()).includes("Aucune classe"));

  await page.selectOption('[name="niveau"]', "6E");
  await page.fill('[name="lettre"]', "a");
  await envoyer(page, 'form[action="/annee/classe"] button[type=submit]');
  check("la classe est créée et nommée à l'usage burkinabè",
    (await page.content()).includes("Classe 6e A créée"));

  await page.selectOption('[name="niveau"]', "6E");
  await page.fill('[name="lettre"]', "A");
  await envoyer(page, 'form[action="/annee/classe"] button[type=submit]');
  check("une classe en double est refusée",
    (await page.content()).includes("existe déjà"));

  await page.selectOption('[name="niveau"]', "TLE");
  await page.fill('[name="lettre"]', "1");
  await page.selectOption('[name="serie"]', "D");
  await envoyer(page, 'form[action="/annee/classe"] button[type=submit]');
  check("une terminale porte sa série, à l'usage du pays",
    (await page.content()).includes("Classe Tle D1 créée"), "attendu « Tle D1 »");

  await page.selectOption('[name="niveau"]', "CP1");
  await page.selectOption('[name="serie"]', "D");
  await envoyer(page, 'form[action="/annee/classe"] button[type=submit]');
  check("une série au primaire est refusée",
    (await page.content()).includes("seconde, première ou terminale"));

  const kl = await client.query(
    `select label, series_code from classes where academic_year_id =
       (select id from academic_years where label = $1) order by label`, [LIBELLE]);
  check("seules les classes valides sont en base", kl.rowCount === 2,
    kl.rows.map((r) => r.label).join(", "));

  console.log("\nOuverture de l'année");
  await envoyer(page, 'form[action="/annee/ouvrir"] button[type=submit]');
  check("l'année s'ouvre", (await page.content()).includes(`L'année ${LIBELLE} est ouverte`));
  const ouvertes = await client.query(
    `select count(*)::int as n from academic_years where status = 'en_cours'`);
  check("une seule année est en cours à la fois", ouvertes.rows[0].n === 1,
    `${ouvertes.rows[0].n} années en cours`);
  await page.screenshot({ path: "out/captures/12-annee.png", fullPage: true });

  const intacte = await client.query(
    `select label from academic_years where id = $1`, [ANNEE_REELLE?.id ?? null]);
  check("l'année réelle de l'établissement n'a pas été touchée",
    intacte.rows[0]?.label === ANNEE_REELLE?.label,
    `attendu « ${ANNEE_REELLE?.label} », trouvé « ${intacte.rows[0]?.label} »`);
  const orphelines = await client.query(
    `select count(*)::int as n from classes cl
       join academic_years ay on ay.id = cl.academic_year_id
      where ay.label = $1 and cl.label = '6e B'`, [LIBELLE]);
  check("aucune classe existante n'a changé d'année", orphelines.rows[0].n === 0);

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                    // enseignante
  const r = await p2.goto(`${BASE}/annee`);
  check("une enseignante ne touche pas au calendrier", r.status() === 403, `HTTP ${r.status()}`);
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
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2000));
  process.exit(1);
}
console.log("Rentrée vérifiée de bout en bout.");
