/**
 * Grille des frais et émission des factures.
 *
 * Deux règles de l'arrêté n°2026-101 sont éprouvées ici, parce qu'elles ne
 * valent que si le logiciel les applique :
 *
 *   - un supplément sans référence d'autorisation ministérielle est REFUSÉ ;
 *   - une grille qui dépasse le plafond déclaré est signalée avant que la
 *     première facture ne parte.
 *
 * Et une règle de prudence : une facture émise n'est pas recalculée quand la
 * grille bouge. Une famille qui a payé ne doit pas découvrir un autre solde.
 *
 *   node tests/frais.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4200;
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
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000004')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

const { rows: an } = await client.query(
  `select id, label from academic_years order by (status='en_cours') desc limit 1`);
const anneeId = an[0].id;

// État de départ, restitué à la fin.
const { rows: plafondAvant } = await client.query(
  `select declared_ceiling_fcfa from category_assessments where academic_year_id = $1`,
  [anneeId]);

// Factures mises de côté le temps du test, remises en place à la fin.
let factureRangee = [];
let echeancesRangees = [];

const LIGNE_TEST = "Ligne de vérification";
const GRILLE_TEST = "Grille de vérification";
const purge = async () => {
  await client.query(`delete from fee_lines where label = $1`, [LIGNE_TEST]);
  await client.query(
    `delete from fee_lines where fee_schedule_id in
       (select id from fee_schedules where label = $1)`, [GRILLE_TEST]);
  await client.query(`delete from fee_schedules where label = $1`, [GRILLE_TEST]);
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: "fr-FR" });
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
  await connecter(page, "70000004");                      // économe

  console.log("\nLa grille");
  await page.goto(`${BASE}/frais`);
  await page.waitForSelector('form[action="/frais/grille"]');
  const vue = await page.content();
  check("la grille de la démonstration est affichée", vue.includes("plafonnés"));
  check("le plafond est rappelé, pas deviné",
    vue.includes("lu dans l'arrêté") || vue.includes("Aucun plafond renseigné"));
  /* ET LE MOT « DÉCLARÉ » N'EST PAS EMPLOYÉ À LA LÉGÈRE. L'écran l'écrivait
   * sur un chiffre qu'un humain venait de taper dans un dossier resté
   * brouillon : c'était une affirmation du produit sur un fait qu'il ne
   * connaissait pas. Voir 0028. */
  const declare = await client.query(
    `select count(*)::int as n from category_assessments where status = 'declare'`);
  check("et « déclaré » n'est pas écrit sans déclaration",
    declare.rows[0].n > 0 || !/Plafond déclaré/.test(vue),
    "le dossier de la démonstration est un brouillon");

  console.log("\nUn supplément sans autorisation est refusé");
  const grilleId = await page.$eval('form[action="/frais/ligne"] input[name=grille]',
    (el) => el.value);
  await page.fill('form[action="/frais/ligne"] input[name=libelle]', LIGNE_TEST);
  await page.fill('form[action="/frais/ligne"] input[name=montant]', "5000");
  await page.selectOption('form[action="/frais/ligne"] select[name=traitement]',
    "autorise_supplementaire");
  await envoyer(page, 'form[action="/frais/ligne"] button[type=submit]');
  check("la référence d'autorisation est exigée",
    (await page.content()).includes("autorisation ministérielle"));
  const { rows: pasEcrite } = await client.query(
    `select count(*)::int as n from fee_lines where label = $1`, [LIGNE_TEST]);
  check("la ligne refusée n'est pas enregistrée", pasEcrite[0].n === 0);

  // Avec la référence, elle passe.
  await page.goto(`${BASE}/frais`);
  await page.fill('form[action="/frais/ligne"] input[name=libelle]', LIGNE_TEST);
  await page.fill('form[action="/frais/ligne"] input[name=montant]', "5000");
  await page.selectOption('form[action="/frais/ligne"] select[name=traitement]',
    "autorise_supplementaire");
  await page.fill('form[action="/frais/ligne"] input[name=autorisation]', "AUT-2026-014");
  await envoyer(page, 'form[action="/frais/ligne"] button[type=submit]');
  const { rows: ecrite } = await client.query(
    `select authorisation_ref, cap_treatment from fee_lines where label = $1`, [LIGNE_TEST]);
  check("avec sa référence, le supplément est accepté",
    ecrite[0]?.authorisation_ref === "AUT-2026-014", ecrite[0]?.authorisation_ref);
  check("un supplément autorisé n'entre pas dans le plafond",
    ecrite[0]?.cap_treatment === "autorise_supplementaire");

  console.log("\nDépassement du plafond");
  // On abaisse le plafond déclaré sous le total plafonné actuel.
  const { rows: tot } = await client.query(
    `select coalesce(sum(fl.amount_fcfa),0)::int as n from fee_lines fl
       join fee_schedules fs on fs.id = fl.fee_schedule_id
      where fs.academic_year_id = $1 and fl.cap_treatment = 'plafonne'`, [anneeId]);
  await client.query(
    `update category_assessments set declared_ceiling_fcfa = $2
      where academic_year_id = $1`, [anneeId, Math.max(1000, tot[0].n - 10000)]);

  await page.goto(`${BASE}/frais`);
  const alerte = await page.content();
  check("un dépassement du plafond est signalé",
    alerte.includes("Dépassement du plafond"),
    `total plafonné ${tot[0].n}, plafond abaissé à ${tot[0].n - 10000}`);
  check("l'écart est chiffré", alerte.includes("de trop"));
  await page.screenshot({ path: "out/captures/19-frais.png", fullPage: true });

  await client.query(
    `update category_assessments set declared_ceiling_fcfa = $2
      where academic_year_id = $1`, [anneeId, plafondAvant[0]?.declared_ceiling_fcfa ?? null]);

  console.log("\nÉmission des factures");
  // On repart d'une classe sans facture.
  const { rows: kl } = await client.query(`select id, label from classes limit 1`);
  const { rows: facturesAvant } = await client.query(
    `select id, total_fcfa, student_id from invoices where academic_year_id = $1`, [anneeId]);
  const uneFacture = facturesAvant[0];

  await page.goto(`${BASE}/frais`);
  const dejaAJour = (await page.content()).includes("à jour");
  check("une classe entièrement facturée est marquée à jour", dejaAJour,
    "la démonstration facture déjà tout le monde");

  // Réémettre ne doit ni dupliquer ni recalculer.
  const emission = await page.evaluate(async (classe) => {
    const body = new URLSearchParams();
    body.set("classe", classe);
    const r = await fetch("/frais/emettre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, kl[0].id);
  check("réémettre annonce les élèves déjà facturés",
    emission.includes("déjà facturé"), "sinon on ne sait pas ce qui s'est passé");

  const { rows: facturesApres } = await client.query(
    `select id, total_fcfa from invoices where academic_year_id = $1`, [anneeId]);
  check("aucune facture n'est dupliquée",
    facturesApres.length === facturesAvant.length,
    `${facturesAvant.length} → ${facturesApres.length}`);
  check("une facture déjà émise n'est pas recalculée",
    Number(facturesApres.find((f) => f.id === uneFacture.id)?.total_fcfa)
      === Number(uneFacture.total_fcfa),
    "une famille qui a payé ne doit pas découvrir un autre solde");

  // Une classe neuve, sans grille pour son niveau : le refus doit être clair.
  console.log("\nUne classe sans grille");
  const { rows: neuve } = await client.query(
    `insert into classes (school_id, academic_year_id, level_code, letter, label)
     values (current_school_id(), $1, 'TLE', 'Z', 'Tle Z test') returning id`, [anneeId]);
  const { rows: unEleve } = await client.query(`select id from students limit 1`);
  await client.query(
    `update enrolments set class_id = $1 where student_id = $2 and academic_year_id = $3`,
    [neuve[0].id, unEleve[0].id, anneeId]);

  // La grille « tous niveaux » de la démonstration couvre-t-elle ce cas ?
  const { rows: gTous } = await client.query(
    `select count(*)::int as n from fee_schedules
      where academic_year_id = $1 and level_code is null`, [anneeId]);

  await page.goto(`${BASE}/frais`);
  const resultat = await page.evaluate(async (classe) => {
    const body = new URLSearchParams();
    body.set("classe", classe);
    const r = await fetch("/frais/emettre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, neuve[0].id);
  if (gTous[0].n > 0) {
    check("une grille « tous niveaux » sert de repli",
      resultat.includes("facture émise") || resultat.includes("factures émises"),
      "la grille sans niveau doit couvrir les classes non prévues");
  } else {
    check("l'absence de grille est dite clairement, sans facture vide",
      resultat.includes("Aucune grille de frais"), "le refus doit nommer la classe");
  }

  console.log("\nÉmission réelle");
  // On crée la grille qui manquait, puis on facture pour de bon.
  await page.goto(`${BASE}/frais`);
  await page.fill('form[action="/frais/grille"] input[name=libelle]', GRILLE_TEST);
  await page.selectOption('form[action="/frais/grille"] select[name=niveau]', "TLE");
  await envoyer(page, 'form[action="/frais/grille"] button[type=submit]');
  check("la grille est créée", (await page.content()).includes("créée"));

  const { rows: gt } = await client.query(
    `select id from fee_schedules where label = $1`, [GRILLE_TEST]);
  await client.query(
    `insert into fee_lines (school_id, fee_schedule_id, label, amount_fcfa, cap_treatment)
     values (current_school_id(), $1, $2, 90000, 'plafonne')`, [gt[0].id, LIGNE_TEST]);

  /* L'élève déplacé doit ne pas avoir de facture pour cette année. On MET DE
     CÔTÉ la sienne — celle de la démonstration — pour la remettre en place
     après le test : sans cela, la deuxième exécution part d'un établissement
     amputé d'une facture, et se plaint d'un état qu'elle a elle-même créé. */
  ({ rows: factureRangee } = await client.query(
    `select * from invoices where student_id = $1`, [unEleve[0].id]));
  ({ rows: echeancesRangees } = await client.query(
    `select * from invoice_instalments where invoice_id = any($1::uuid[])`,
    [factureRangee.map((f) => f.id)]));
  await client.query(
    `delete from invoice_instalments where invoice_id = any($1::uuid[])`,
    [factureRangee.map((f) => f.id)]);
  await client.query(
    `delete from payments where invoice_id = any($1::uuid[])`,
    [factureRangee.map((f) => f.id)]);
  await client.query(`delete from invoices where student_id = $1`, [unEleve[0].id]);

  await page.goto(`${BASE}/frais`);
  const emise = await page.evaluate(async (classe) => {
    const body = new URLSearchParams();
    body.set("classe", classe);
    const r = await fetch("/frais/emettre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, neuve[0].id);
  check("la facture est émise", emise.includes("facture émise"));

  const { rows: f } = await client.query(
    `select id, reference, total_fcfa, status from invoices where student_id = $1`,
    [unEleve[0].id]);
  check("la facture porte le total de la grille de son niveau",
    Number(f[0]?.total_fcfa) === 90000, `${f[0]?.total_fcfa}`);
  check("sa référence est lisible et unique",
    (f[0]?.reference ?? "").startsWith("F-"), f[0]?.reference);

  const { rows: ech } = await client.query(
    `select label, amount_fcfa, to_char(due_on,'YYYY-MM-DD') as due
       from invoice_instalments where invoice_id = $1 order by sort_order`, [f[0].id]);
  check("un échéancier est posé, pas un solde unique", ech.length === 3,
    `${ech.length} tranches`);
  check("les tranches suivent les trimestres",
    ech.every((e) => e.label.startsWith("Tranche")) && ech[0].due < ech[2].due);
  check("les tranches totalisent exactement la facture",
    ech.reduce((a, e) => a + Number(e.amount_fcfa), 0) === 90000,
    `${ech.map((e) => e.amount_fcfa).join(" + ")}`);

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                        // enseignante
  const r = await p2.goto(`${BASE}/frais`);
  check("une enseignante ne touche pas à la grille des frais",
    r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  // On rend la démonstration telle qu'on l'a trouvée.
  await client.query(
    `update category_assessments set declared_ceiling_fcfa = $2
      where academic_year_id = $1`,
    [anneeId, plafondAvant[0]?.declared_ceiling_fcfa ?? null]).catch(() => {});
  await client.query(
    `update enrolments e set class_id = (select id from classes
        where academic_year_id = $1 and label <> 'Tle Z test' limit 1)
      where e.class_id in (select id from classes where label = 'Tle Z test')`,
    [anneeId]).catch(() => {});
  await client.query(
    `delete from invoice_instalments where invoice_id in
       (select id from invoices where reference like 'F-%')
       and invoice_id not in (select id from invoices)`).catch(() => {});
  await client.query(`delete from classes where label = 'Tle Z test'`).catch(() => {});
  // La facture de démonstration de cet élève est refaite par npm run demo ;
  // ici on retire seulement celle que le test a créée.
  await client.query(
    `delete from invoice_instalments where invoice_id in
       (select id from invoices where fee_schedule_id in
          (select id from fee_schedules where label = $1))`, [GRILLE_TEST]).catch(() => {});
  await client.query(
    `delete from invoices where fee_schedule_id in
       (select id from fee_schedules where label = $1)`, [GRILLE_TEST]).catch(() => {});
  // On remet la facture de démonstration mise de côté, et son échéancier.
  for (const f of factureRangee) {
    await client.query(
      `insert into invoices (id, school_id, student_id, academic_year_id,
                             fee_schedule_id, reference, total_fcfa, status, issued_on)
       values ($1, current_school_id(), $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [f.id, f.student_id, f.academic_year_id, f.fee_schedule_id, f.reference,
       f.total_fcfa, f.status, f.issued_on]).catch(() => {});
  }
  for (const e of echeancesRangees) {
    await client.query(
      `insert into invoice_instalments (id, school_id, invoice_id, label,
                                        amount_fcfa, due_on, sort_order)
       values ($1, current_school_id(), $2, $3, $4, $5, $6)
       on conflict (id) do nothing`,
      [e.id, e.invoice_id, e.label, e.amount_fcfa, e.due_on, e.sort_order]).catch(() => {});
  }
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
console.log("Grille des frais et facturation vérifiées de bout en bout.");
