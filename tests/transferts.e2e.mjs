/**
 * Transferts et livret scolaire.
 *
 * La règle éprouvée ici n'est pas technique : un enfant qui arrive SANS PAPIERS
 * doit pouvoir être inscrit, et son parcours déclaré par la famille doit être
 * accepté — marqué comme déclaré, jamais confondu avec une année établie par
 * l'établissement. Refuser faute de bulletin, c'est mettre un enfant déplacé
 * hors de l'école pour de bon.
 *
 *   node tests/transferts.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4202;
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

const { rows: el } = await client.query(
  `select st.id, st.last_name, st.first_names, e.id as enrolment_id, e.status
     from students st join enrolments e on e.student_id = st.id
    order by st.last_name limit 1`);
const eleve = el[0];

const ECOLE = "École B de Kaya";
const purge = async () => {
  await client.query(`delete from student_transfers where other_school_name = $1`, [ECOLE]);
  await client.query(`delete from livret_entries where school_name = $1`, [ECOLE]);
  await client.query(`update enrolments set status = $2 where id = $1`,
    [eleve.enrolment_id, eleve.status]);
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
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
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};
const envoyer = async (p, sel) =>
  Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click(sel)]);

try {
  await connecter(page, "70000001");                      // censeur

  console.log("\nUne arrivée");
  await page.goto(`${BASE}/transferts`);
  await page.waitForSelector('form[action="/transferts"]');
  check("la règle est écrite à l'écran, pas seulement dans le code",
    (await page.content()).includes("sans papiers s'inscrit quand même"));

  await page.selectOption('[name="eleve"]', eleve.id);
  await page.selectOption('[name="sens"]', "entrant");
  await page.fill('[name="etablissement"]', ECOLE);
  await page.selectOption('[name="motif"]', "Déplacement lié à l'insécurité");
  await envoyer(page, 'form[action="/transferts"] button[type=submit]');
  check("l'arrivée est enregistrée",
    (await page.content()).includes("Arrivée enregistrée"));

  const { rows: mv } = await client.query(
    `select direction, reason, status from student_transfers
      where other_school_name = $1`, [ECOLE]);
  check("le motif est conservé tel qu'il est, sans euphémisme",
    mv[0]?.reason === "Déplacement lié à l'insécurité", mv[0]?.reason);

  console.log("\nLe parcours déclaré par la famille");
  await page.fill('form[action="/transferts/livret"] [name="annee"]', "2025-2026");
  await page.fill('form[action="/transferts/livret"] [name="niveau"]', "CM2");
  await page.fill('form[action="/transferts/livret"] [name="ecole"]', ECOLE);
  await page.fill('form[action="/transferts/livret"] [name="moyenne"]', "12,40");
  await page.fill('form[action="/transferts/livret"] [name="decision"]', "admis");
  await envoyer(page, 'form[action="/transferts/livret"] button[type=submit]');
  check("l'année déclarée est ajoutée",
    (await page.content()).includes("ajoutée au livret"));

  const { rows: lv } = await client.query(
    `select academic_year_label, moyenne_annuelle, is_external, school_name
       from livret_entries where student_id = $1 and school_name = $2`,
    [eleve.id, ECOLE]);
  check("elle est marquée DÉCLARÉE, jamais confondue avec une année établie ici",
    lv[0]?.is_external === true);
  check("la moyenne à la française est comprise",
    Number(lv[0]?.moyenne_annuelle) === 12.4, `${lv[0]?.moyenne_annuelle}`);
  check("l'écran distingue les deux sources",
    (await page.content()).includes("déclarée"));

  // Une année sans moyenne doit passer : c'est le cas d'un enfant sans papiers.
  await page.fill('form[action="/transferts/livret"] [name="annee"]', "2024-2025");
  await page.fill('form[action="/transferts/livret"] [name="ecole"]', ECOLE);
  await envoyer(page, 'form[action="/transferts/livret"] button[type=submit]');
  const { rows: sansMoyenne } = await client.query(
    `select moyenne_annuelle from livret_entries
      where student_id = $1 and academic_year_label = '2024-2025'`, [eleve.id]);
  check("une année sans moyenne est acceptée",
    sansMoyenne.length === 1 && sansMoyenne[0].moyenne_annuelle === null,
    "mieux vaut une année sans moyenne qu'une moyenne inventée");

  console.log("\nCe qui est refusé");
  await page.fill('form[action="/transferts/livret"] [name="annee"]', "2025-2026");
  await page.fill('form[action="/transferts/livret"] [name="ecole"]', ECOLE);
  await envoyer(page, 'form[action="/transferts/livret"] button[type=submit]');
  check("une année en double est refusée",
    (await page.content()).includes("porte déjà l'année"));

  await page.fill('form[action="/transferts/livret"] [name="annee"]', "2023-2024");
  await page.fill('form[action="/transferts/livret"] [name="ecole"]', "");
  await envoyer(page, 'form[action="/transferts/livret"] button[type=submit]');
  check("un établissement d'origine vide est refusé",
    (await page.content()).includes("ne doit pas rester vide"),
    "« Inconnu » est acceptable ; une case vide ne l'est pas");
  check("un refus ne referme pas le dossier de l'élève",
    (await page.locator('form[action="/transferts/livret"]').count()) === 1,
    "sinon le secrétaire perd sa saisie en même temps que le message");

  await page.fill('form[action="/transferts/livret"] [name="annee"]', "2023-2024");
  await page.fill('form[action="/transferts/livret"] [name="ecole"]', ECOLE);
  await page.fill('form[action="/transferts/livret"] [name="moyenne"]', "24");
  await envoyer(page, 'form[action="/transferts/livret"] button[type=submit]');
  check("une moyenne hors barème est refusée",
    (await page.content()).includes("entre 0 et 20"));
  const { rows: pasEcrite } = await client.query(
    `select count(*)::int as n from livret_entries
      where student_id = $1 and academic_year_label = '2023-2024'`, [eleve.id]);
  check("et rien n'est écrit", pasEcrite[0].n === 0);

  await page.screenshot({ path: "out/captures/21-transferts.png", fullPage: true });

  console.log("\nLe certificat de transfert");
  const cert = await ctx.newPage();
  await cert.goto(`${BASE}/transferts/certificat?eleve=${eleve.id}`);
  const feuille = await cert.content();
  check("le certificat porte l'en-tête officiel",
    feuille.includes("Unité — Progrès — Justice"));
  check("il porte l'identité de l'élève", feuille.includes(eleve.last_name));
  check("il contient le parcours", feuille.includes("2025-2026") && feuille.includes(ECOLE));
  check("il distingue déclaré et établi ici",
    feuille.includes("déclarée") && feuille.includes("Source"));
  check("il avertit que les lignes déclarées n'ont pas été vérifiées",
    feuille.includes("pas pu être vérifiée"),
    "l'école d'accueil doit savoir sur quoi elle s'appuie");
  /* Le compte ne doit pas être répété dans la même phrase. On ne regarde que
     les petits nombres : les millésimes « 2024-2025 » et « 2025-2026 » se
     répètent légitimement dans le tableau. */
  const avertissement = feuille.replace(/<[^>]+>/g, " ")
    .split("par la famille")[1]?.split("Ce certificat")[0] ?? "";
  check("le compte n'est pas répété dans la même phrase",
    !/\b(\d{1,3})\b[^.]{0,80}?\b\1\b/.test(avertissement),
    `« ${avertissement.trim().slice(0, 90)} »`);
  check("il ne préjuge pas du placement",
    feuille.includes("ne préjuge pas"),
    "c'est l'établissement d'accueil qui décide, pas le document");
  await cert.screenshot({ path: "out/captures/22-certificat.png", fullPage: true });
  await cert.close();

  console.log("\nUn départ");
  await page.goto(`${BASE}/transferts?eleve=${eleve.id}`);
  await page.selectOption('[name="eleve"]', eleve.id);
  await page.selectOption('[name="sens"]', "sortant");
  await page.fill('[name="etablissement"]', ECOLE);
  await envoyer(page, 'form[action="/transferts"] button[type=submit]');
  check("le départ rappelle d'imprimer le certificat",
    (await page.content()).includes("Imprimez le certificat"),
    "sans lui, l'école suivante n'a aucun moyen de placer l'élève");

  const { rows: statut } = await client.query(
    `select status from enrolments where id = $1`, [eleve.enrolment_id]);
  check("l'inscription passe en transfert sortant",
    statut[0].status === "transfere_sortant", statut[0].status);

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                        // enseignante
  const r = await p2.goto(`${BASE}/transferts`);
  check("une enseignante ne gère pas les transferts",
    r.status() === 403, `HTTP ${r.status()}`);
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
console.log("Transferts et livret vérifiés de bout en bout.");
