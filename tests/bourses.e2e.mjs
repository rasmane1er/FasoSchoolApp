/**
 * Bourses et remises.
 *
 * L'arithmétique compte ici plus qu'ailleurs : une erreur se traduit
 * directement en francs, dans un sens ou dans l'autre. Deux points sont donc
 * éprouvés de près :
 *
 *   - deux remises de 50 % font 75 %, pas la gratuité ;
 *   - une facture déjà émise n'est jamais rabotée en silence — le décalage est
 *     signalé, et c'est un humain qui réémet.
 *
 *   node tests/bourses.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4203;
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
  `select id from academic_years order by (status='en_cours') desc limit 1`);
const anneeId = an[0].id;
const { rows: el } = await client.query(
  `select st.id, st.last_name from enrolments e join students st on st.id = e.student_id
    where e.academic_year_id = $1 order by st.last_name limit 1`, [anneeId]);
const eleve = el[0];

// Facture et remises de cet élève, mises de côté et restituées à la fin.
const { rows: factureRangee } = await client.query(
  `select * from invoices where student_id = $1`, [eleve.id]);
const { rows: echeancesRangees } = await client.query(
  `select * from invoice_instalments where invoice_id = any($1::uuid[])`,
  [factureRangee.map((f) => f.id)]);

const purge = async () => {
  await client.query(`delete from scholarships where academic_year_id = $1`, [anneeId]);
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1150 }, locale: "fr-FR" });
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

/* Lire la valeur d'une tuile par sa structure, pas par une expression sur le
   HTML : « Factures décalées » contient le mot « décalée », et une recherche
   de texte y verrait toujours un décalage. */
const tuile = async (label) => Number((await page.$eval(
  `xpath=//div[@class="tile"][.//div[@class="k"][normalize-space()="${label}"]]//div[@class="v"]`,
  (el) => el.textContent.trim())).replace(/[^\d]/g, ""));

const accorder = async (champs) => {
  await page.goto(`${BASE}/bourses`);
  await page.selectOption('[name="eleve"]', eleve.id);
  if (champs.motif) await page.selectOption('[name="motif"]', champs.motif);
  if (champs.nature) await page.selectOption('[name="nature"]', champs.nature);
  await page.fill('[name="pourcent"]', champs.pourcent ?? "");
  await page.fill('[name="montant"]', champs.montant ?? "");
  await envoyer(page, 'form[action="/bourses"] button[type=submit]');
  return page.content();
};

try {
  await connecter(page, "70000004");                      // économe

  console.log("\nCe qui est refusé");
  check("un pourcentage ET un montant sont refusés",
    (await accorder({ pourcent: "50", montant: "20000" })).includes("pas les deux"),
    "sinon personne ne sait lequel a été appliqué");
  check("ni pourcentage ni montant est refusé",
    (await accorder({})).includes("soit un pourcentage"));
  check("un pourcentage hors 1-100 est refusé",
    (await accorder({ pourcent: "150" })).includes("entre 1 et 100"));
  check("un montant négatif est refusé",
    (await accorder({ montant: "-500" })).includes("doit être positif"));
  const { rows: rien } = await client.query(
    `select count(*)::int as n from scholarships where academic_year_id = $1`, [anneeId]);
  check("aucune ligne refusée n'est écrite", rien[0].n === 0, `${rien[0].n} écrites`);

  console.log("\nDeux remises de 50 % font 75 %");
  await accorder({ motif: "Orphelin", pourcent: "50" });
  await accorder({ motif: "Fratrie", pourcent: "50" });

  const { rows: grille } = await client.query(
    `select coalesce(sum(fl.amount_fcfa),0)::int as total
       from fee_lines fl join fee_schedules fs on fs.id = fl.fee_schedule_id
      where fs.academic_year_id = $1`, [anneeId]);
  const brut = grille[0].total;

  const vue = await page.content();
  const accorde = await tuile("Accordé cette année");
  check("le cumul est 75 %, pas 100 %",
    accorde === Math.round(brut * 0.5) + Math.round(brut * 0.5 / 2),
    `${accorde} accordé sur un brut de ${brut}`);
  check("le total accordé n'atteint pas la gratuité", accorde < brut,
    `${accorde} sur ${brut}`);
  check("l'écran l'explique au lieu de laisser deviner",
    vue.includes("deux fois") && vue.includes("pas la gratuité"));

  console.log("\nLa facture existante n'est pas rabotée");
  const { rows: inchangee } = await client.query(
    `select total_fcfa from invoices where student_id = $1`, [eleve.id]);
  check("la facture déjà émise garde son montant",
    Number(inchangee[0]?.total_fcfa) === Number(factureRangee[0]?.total_fcfa),
    `${factureRangee[0]?.total_fcfa} → ${inchangee[0]?.total_fcfa}`);
  check("le décalage est signalé", (await tuile("Factures décalées")) === 2,
    "les deux lignes de cet élève portent sur une facture émise avant elles");
  check("et l'écran dit où aller le corriger",
    (await page.content()).includes("réémettre"));
  await page.screenshot({ path: "out/captures/23-bourses.png", fullPage: true });

  console.log("\nRéémission avec les remises");
  await client.query(
    `delete from invoice_instalments where invoice_id = any($1::uuid[])`,
    [factureRangee.map((f) => f.id)]);
  await client.query(
    `delete from payments where invoice_id = any($1::uuid[])`,
    [factureRangee.map((f) => f.id)]);
  await client.query(`delete from invoices where student_id = $1`, [eleve.id]);

  const { rows: kl } = await client.query(
    `select cl.id from classes cl join enrolments e on e.class_id = cl.id
      where e.student_id = $1 limit 1`, [eleve.id]);
  await page.goto(`${BASE}/frais`);
  const emission = await page.evaluate(async (classe) => {
    const body = new URLSearchParams();
    body.set("classe", classe);
    const r = await fetch("/frais/emettre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, kl[0].id);
  check("l'émission annonce les remises déduites",
    emission.includes("de remises déduits"),
    "un économe doit voir ce qu'il a donné, pas seulement ce qu'il facture");

  const { rows: nouvelle } = await client.query(
    `select total_fcfa from invoices where student_id = $1`, [eleve.id]);
  const attendu = brut - (Math.round(brut * 0.5) + Math.round(brut * 0.5 / 2));
  check("la nouvelle facture déduit les deux remises",
    Number(nouvelle[0]?.total_fcfa) === attendu,
    `${nouvelle[0]?.total_fcfa} au lieu de ${attendu}`);

  const { rows: ech } = await client.query(
    `select coalesce(sum(amount_fcfa),0)::int as n from invoice_instalments
      where invoice_id = (select id from invoices where student_id = $1)`, [eleve.id]);
  check("l'échéancier suit le montant remisé, pas le brut",
    ech[0].n === attendu, `${ech[0].n} réparti pour ${attendu} dus`);

  await page.goto(`${BASE}/bourses`);
  check("le décalage a disparu", (await tuile("Factures décalées")) === 0,
    "la facture reflète désormais les remises");

  console.log("\nRetrait");
  await envoyer(page, 'form[action="/bourses/retirer"] button[type=submit]');
  check("une remise se retire", (await page.content()).includes("retirée"));
  check("le retrait prévient que les factures ne bougent pas",
    (await page.content()).includes("ne changent pas d'elles-mêmes"));

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select action from audit_log where action in ('bourse.grant','bourse.revoke')`);
  check("accorder et retirer sont journalisés", journal.length >= 3,
    journal.map((j) => j.action).join(", "));

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                        // enseignante
  const r = await p2.goto(`${BASE}/bourses`);
  check("une enseignante n'accorde pas de remises",
    r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  await purge().catch(() => {});
  // On rend la facture de démonstration telle qu'elle était.
  await client.query(
    `delete from invoice_instalments where invoice_id in
       (select id from invoices where student_id = $1)`, [eleve.id]).catch(() => {});
  await client.query(`delete from invoices where student_id = $1`, [eleve.id]).catch(() => {});
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
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Bourses et remises vérifiées de bout en bout.");
