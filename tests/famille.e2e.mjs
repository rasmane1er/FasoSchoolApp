/**
 * Espace famille : ce qu'un parent voit, et ce qu'il ne voit pas.
 *
 * Deux choses comptent plus que l'affichage :
 *
 *   1. Le périmètre. Un tuteur voit SES enfants. Pas la classe, pas
 *      l'établissement. C'est la promesse qui fait qu'un directeur accepte
 *      d'ouvrir ses données aux familles.
 *   2. La séparation des sessions. Un cookie de famille ne doit ouvrir aucune
 *      page du personnel, et un cookie du personnel ne doit pas ouvrir
 *      l'espace famille en se faisant passer pour un tuteur.
 *
 *   node tests/famille.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4195;
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
await client.query(`delete from auth_sessions`);
await client.query(`delete from guardian_sessions`);

// Un tuteur de la démonstration, et son enfant.
const { rows: tut } = await client.query(
  `select g.id, g.phone, g.full_name, st.id as student_id,
          st.last_name || ' ' || st.first_names as eleve
     from guardians g
     join student_guardians sg on sg.guardian_id = g.id
     join students st on st.id = sg.student_id
    order by g.full_name limit 1`);
const tuteur = tut[0];

// Un enfant qui n'est PAS le sien : il ne doit apparaître nulle part.
const { rows: autre } = await client.query(
  `select last_name || ' ' || first_names as nom from students
    where id <> $1 order by last_name limit 1`, [tuteur.student_id]);

/* L'avertissement « règles non confirmées » dépend de l'état de
   grading_policies, qu'une autre suite a pu confirmer. On force l'état non
   confirmé le temps du test, et on le rend tel qu'il était ensuite. */
const { rows: avant } = await client.query(
  `select id, source_note from grading_policies`);
await client.query(
  `update grading_policies set source_note = 'DÉFAUT NON VÉRIFIÉ — test famille'`);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
// Un téléphone bon marché, pas un ordinateur de bureau.
const ctx = await browser.newContext({
  viewport: { width: 360, height: 740 }, locale: "fr-FR",
  deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();

try {
  console.log("\nConnexion d'un parent");
  await page.goto(`${BASE}/famille`);
  check("l'espace famille s'ouvre sans compte du personnel",
    (await page.content()).includes("Espace famille"));

  // Un numéro inconnu ne doit pas révéler qu'il est inconnu.
  await page.fill("#phone", "79999999");
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  const inconnu = await page.content();
  check("un numéro inconnu reçoit la même page qu'un numéro connu",
    inconnu.includes("Code reçu par SMS"),
    "sinon la page devient un annuaire des familles");

  await page.goto(`${BASE}/famille`);
  await page.fill("#phone", tuteur.phone);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);
  const code = (await page.textContent("#code-demo")).trim();
  await page.fill("#code", code);
  await Promise.all([page.waitForNavigation(), page.click("button[type=submit]")]);

  const vue = await page.content();
  check("le parent est accueilli par son nom", vue.includes(tuteur.full_name));
  check("son enfant est affiché", vue.includes(tuteur.eleve.split(" ")[0]));
  check("la moyenne est visible", /\d,\d\d/.test(vue));
  check("le rang est visible", vue.includes("Rang"));
  check("les disciplines sont listées", vue.includes("coef."));

  check("les enfants des autres familles n'apparaissent pas",
    !vue.includes(autre[0].nom.split(" ")[0]) || autre[0].nom.startsWith(tuteur.eleve.split(" ")[0]),
    `« ${autre[0].nom} » ne doit pas être là`);

  check("les règles non confirmées sont signalées",
    vue.includes("n'ont pas encore été confirmées"),
    "une moyenne calculée avec des règles par défaut est indicative");

  // La page doit rester légère : c'est un téléphone bon marché en 2G.
  const poids = Buffer.byteLength(vue, "utf-8");
  check("la page reste légère", poids < 60_000, `${Math.round(poids / 1024)} Ko`);
  check("aucun JavaScript n'est nécessaire", !vue.includes("<script"),
    "le hors-ligne est pour l'enseignant, pas pour le parent");

  await page.screenshot({ path: "out/captures/14-famille.png", fullPage: true });

  console.log("\nCloisonnement des sessions");
  const cookies = await ctx.cookies();
  const fam = cookies.find((c) => c.name === "fs_famille");
  check("la session famille a son propre cookie", !!fam);
  check("le cookie famille est limité à /famille", fam?.path === "/famille",
    `path = ${fam?.path}`);
  check("le cookie famille n'est pas lisible en JavaScript", fam?.httpOnly === true);
  check("aucun cookie du personnel n'a été posé",
    !cookies.some((c) => c.name === "fs_session"));

  // Le cookie famille ne doit ouvrir aucune page du personnel.
  for (const chemin of ["/", "/notes", "/scolarite", "/conseil"]) {
    const r = await page.goto(`${BASE}${chemin}`);
    const ouSuisJe = page.url();
    check(`le cookie famille n'ouvre pas ${chemin}`,
      ouSuisJe.includes("/connexion"), `arrivé sur ${ouSuisJe}`);
  }

  // Et un cookie du personnel ne doit pas ouvrir l'espace famille.
  const perso = await browser.newContext({ locale: "fr-FR" });
  const p2 = await perso.newPage();
  await p2.goto(`${BASE}/connexion`);
  await p2.fill("#phone", "70000001");
  await p2.click("button[type=submit]");
  await p2.waitForSelector("#code");
  await p2.fill("#code", (await p2.textContent("#code-demo")).trim());
  await p2.click("button[type=submit]");
  await p2.waitForLoadState("networkidle");
  await p2.goto(`${BASE}/famille`);
  check("un compte du personnel n'entre pas dans l'espace famille par son cookie",
    (await p2.content()).includes("Numéro de téléphone"),
    "il doit se présenter comme tuteur, ou pas du tout");
  await perso.close();

  console.log("\nSortie");
  await page.goto(`${BASE}/famille/sortie`);
  await page.goto(`${BASE}/famille`);
  check("quitter referme la session",
    (await page.content()).includes("Numéro de téléphone"));
  const restant = await client.query(
    `select count(*)::int as n from guardian_sessions where revoked_at is null`);
  check("la session est révoquée en base, pas seulement effacée du navigateur",
    restant.rows[0].n === 0, `${restant.rows[0].n} sessions vivantes`);

} finally {
  await browser.close();
  server.kill();
  for (const r of avant) {
    await client.query(`update grading_policies set source_note = $2 where id = $1`,
      [r.id, r.source_note]).catch(() => {});
  }
  await client.query(`delete from guardian_sessions`).catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2000));
  process.exit(1);
}
console.log("Espace famille vérifié de bout en bout.");
