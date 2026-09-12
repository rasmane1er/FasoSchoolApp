/**
 * Conseil de classe : la délibération de fin d'année.
 *
 * Ce qui est vérifié ici n'est pas l'arithmétique — c'est la frontière entre
 * ce que le logiciel propose et ce que des humains décident, et le fait qu'un
 * redoublement interdit par l'arrêté de 2019 soit REFUSÉ, pas corrigé en
 * silence.
 *
 *   node tests/conseil.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4194;
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

const { rows: an } = await client.query(
  `select id, label from academic_years order by (status='en_cours') desc limit 1`);
const anneeId = an[0].id;

/* Une classe de CP1 pour éprouver l'interdiction de redoublement. Elle est
   créée ici et retirée à la fin : la démonstration ne doit pas la garder. */
const CP1 = "CP1 test";
const FAITS_TEST = [
  "Exclusion de deux jours prononcee pour la deliberation de controle.",
  "Fait consigne sans sanction pour la deliberation de controle.",
];
const purge = async () => {
  const k = await client.query(`select id from classes where label = $1`, [CP1]);
  for (const r of k.rows) {
    await client.query(`delete from enrolments where class_id = $1`, [r.id]);
    await client.query(`delete from classes where id = $1`, [r.id]);
  }
  await client.query(`delete from conseil_decisions where academic_year_id = $1`, [anneeId]);
  await client.query(`delete from livret_entries`);
  // Les faits que cette suite pose pour éprouver la colonne « conduite »,
  // retirés par leur texte exact.
  await client.query(
    `delete from behavior_incidents where description = any($1::text[])`,
    [FAITS_TEST]);
};
await purge();
await client.query(
  `insert into classes (school_id, academic_year_id, level_code, letter, label)
   values (current_school_id(), $1, 'CP1', 'T', $2)`, [anneeId, CP1]);
const { rows: kcp } = await client.query(`select id from classes where label = $1`, [CP1]);
// Un élève existant y est inscrit le temps du test, puis rendu à sa classe.
const { rows: st } = await client.query(
  `select e.id, e.student_id, e.class_id from enrolments e
     join students s on s.id = e.student_id order by s.last_name limit 1`);
await client.query(`update enrolments set class_id = $1 where id = $2`, [kcp[0].id, st[0].id]);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 }, locale: "fr-FR" });
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

try {
  await connecter(page, "70000001");                   // censeur

  console.log("\nDélibération d'une classe ordinaire");
  const { rows: k6 } = await client.query(
    `select id, label from classes where academic_year_id = $1 and label <> $2
      order by label limit 1`, [anneeId, CP1]);
  await page.goto(`${BASE}/conseil?classe=${k6[0].id}`);
  await page.waitForSelector("table");
  const html6 = await page.content();

  check("la pondération des trimestres est annoncée comme non vérifiée",
    html6.includes("n'a pas pu être établie"),
    "ne jamais laisser croire à un calcul officiel");
  check("chaque trimestre a sa colonne", html6.includes(">T1<") && html6.includes(">T3<"));
  check("une proposition motivée accompagne chaque élève",
    html6.includes("Moyenne") && html6.includes("≥"));
  check("le redoublement est proposable dans une 6e",
    html6.includes('value="redouble"'));

  const eleves = await page.locator("tbody tr").count();
  check("toute la classe est délibérée", eleves >= 5, `${eleves} élèves`);
  check("une année incomplète est signalée avant toute décision",
    html6.includes("Année incomplète"),
    "délibérer sur un seul trimestre saisi ne veut rien dire");
  check("le décompte des décisions n'est pas dupliqué",
    !/(\d+)\s+\1\s+décision/.test(html6));

  // Le conseil suit la proposition pour tout le monde, sauf un redoublement.
  const premier = await page.locator("tbody tr select").first().getAttribute("name");
  const idPremier = premier.slice(2);
  await page.selectOption(`[name="${premier}"]`, "redouble");
  await page.fill(`[name="a_${idPremier}"]`, "Doit consolider les bases.");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('button[type=submit]'),
  ]);
  check("les décisions sont enregistrées",
    (await page.content()).includes("décisions enregistrées"));

  const dec = await client.query(
    `select decision, appreciation from conseil_decisions
      where student_id = $1 and academic_year_id = $2`, [idPremier, anneeId]);
  check("la décision du conseil prime sur la proposition",
    dec.rows[0]?.decision === "redouble", dec.rows[0]?.decision);
  check("l'appréciation est conservée",
    dec.rows[0]?.appreciation === "Doit consolider les bases.");

  const livret = await client.query(
    `select decision, moyenne_annuelle, school_name, academic_year_label
       from livret_entries where student_id = $1`, [idPremier]);
  check("le livret scolaire est alimenté", livret.rowCount === 1,
    `${livret.rowCount} ligne(s)`);
  check("le livret porte l'établissement et l'année",
    !!livret.rows[0]?.school_name && !!livret.rows[0]?.academic_year_label);

  // Une deuxième délibération ne doit pas dupliquer la ligne de livret.
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('button[type=submit]'),
  ]);
  const encore = await client.query(
    `select count(*)::int as n from livret_entries where student_id = $1`, [idPremier]);
  check("revenir sur une décision ne duplique pas le livret", encore.rows[0].n === 1,
    `${encore.rows[0].n} lignes`);

  await page.screenshot({ path: "out/captures/13-conseil.png", fullPage: true });

  console.log("\nCP1 : le redoublement est interdit");
  await page.goto(`${BASE}/conseil?classe=${kcp[0].id}`);
  await page.waitForSelector("table");
  const cp1 = await page.content();
  check("l'interdiction est expliquée à l'écran",
    cp1.includes("arrêté 2019") && cp1.includes("Passage automatique"));
  check("l'option « redouble » n'est pas offerte", !cp1.includes('value="redouble"'),
    "on ne propose pas ce qu'un texte interdit");
  check("la proposition est le passage",
    cp1.includes("Passage automatique : redoublement interdit"));

  // Un redoublement forcé par la voie POST doit être refusé, pas absorbé.
  const eleveCp1 = st[0].student_id;
  const forced = await page.evaluate(async ([classe, id]) => {
    const body = new URLSearchParams();
    body.set(`d_${id}`, "redouble");
    const r = await fetch(`/conseil?classe=${classe}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [kcp[0].id, eleveCp1]);
  check("un redoublement forcé est refusé et expliqué",
    forced.includes("interdit en CP1"), "le refus doit être visible");

  const cp1dec = await client.query(
    `select decision from conseil_decisions where student_id = $1 and academic_year_id = $2`,
    [eleveCp1, anneeId]);
  check("rien n'est écrit quand la décision est refusée",
    cp1dec.rows[0]?.decision !== "redouble", cp1dec.rows[0]?.decision ?? "aucune");

  console.log("\nAssiduité et conduite au conseil");
  const { rows: cible } = await client.query(
    `select e.student_id, st.last_name from enrolments e
       join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name limit 1`, [k6[0].id]);
  const { rows: sgStaff } = await client.query(
    `select id from staff where fonction = 'surveillant_general' limit 1`);
  for (const f of FAITS_TEST) {
    await client.query(
      `insert into behavior_incidents (school_id, student_id, occurred_on,
                                       description, sanction, recorded_by)
       values (current_school_id(), $1, current_date, $2, $3, $4)`,
      [cible[0].student_id, f,
       f.startsWith("Exclusion") ? "exclusion_temporaire" : null,
       sgStaff[0]?.id ?? null]);
  }

  await page.goto(`${BASE}/conseil?classe=${k6[0].id}`);
  await page.waitForSelector("table");
  const avecVie = await page.content();
  check("le conseil voit l'assiduité et la conduite",
    avecVie.includes(">Abs.<") && avecVie.includes(">Ret.<")
      && avecVie.includes(">Disc.<"),
    "délibérer sur la seule moyenne, c'est délibérer sur un tiers du dossier");
  check("une exclusion est signalée sur la ligne de l'élève",
    avecVie.includes("dont 1 exclusion"));
  check("L'ÉCRAN DIT QUE CELA N'ENTRE DANS AUCUN CALCUL",
    avecVie.includes("entrent dans aucun calcul"),
    "un seuil d'absences inventé serait une règle nationale écrite en privé");
  check("et que le repère de lecture n'est pas un seuil réglementaire",
    avecVie.includes("pas un seuil réglementaire"));

  /* La proposition doit être EXACTEMENT la même avec et sans incidents : le
     logiciel montre, il ne juge pas à la place du conseil. */
  const propAvec = await page.$eval(
    `xpath=//tbody/tr[1]//span[contains(@class,"pill")]`,
    (el) => el.textContent.trim());
  await client.query(
    `delete from behavior_incidents where description = any($1::text[])`,
    [FAITS_TEST]);
  await page.goto(`${BASE}/conseil?classe=${k6[0].id}`);
  await page.waitForSelector("table");
  const propSans = await page.$eval(
    `xpath=//tbody/tr[1]//span[contains(@class,"pill")]`,
    (el) => el.textContent.trim());
  check("LA CONDUITE NE CHANGE PAS LA PROPOSITION", propAvec === propSans,
    `${propAvec} avec incidents, ${propSans} sans`);

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                     // enseignante
  const r = await p2.goto(`${BASE}/conseil`);
  check("une enseignante ne délibère pas", r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  await client.query(`update enrolments set class_id = $1 where id = $2`,
    [st[0].class_id, st[0].id]).catch(() => {});
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
console.log("Conseil de classe vérifié de bout en bout.");
