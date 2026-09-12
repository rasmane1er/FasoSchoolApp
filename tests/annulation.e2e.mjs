/**
 * L'annulation d'un paiement.
 *
 * Un économe encaisse debout, devant une file de parents, en fin de mois. Il
 * tape 50 000 au lieu de 5 000. Jusqu'ici rien ne pouvait le rattraper : le
 * reçu était émis, la facture soldée, et le seul recours était psql.
 *
 * Ce que cette suite éprouve — chaque point est une façon dont une comptabilité
 * scolaire devient invérifiable :
 *
 *   - le reçu d'origine n'est ni effacé ni modifié ; il porte seulement la
 *     marque qu'il a été annulé ;
 *   - l'annulation est un SECOND reçu, avec son propre numéro dans la même
 *     suite sans trou ;
 *   - le solde de la facture redevient juste, sur TOUS les écrans — ils
 *     appellent la même définition, montant_regle() ;
 *   - un motif est obligatoire ;
 *   - on n'annule pas deux fois, et on n'annule pas une annulation.
 *
 *   node tests/annulation.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4213;
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
const schoolId = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [schoolId]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

/* On préfère une facture encore vierge, mais on ne le SUPPOSE pas : d'autres
   suites encaissent sur la démonstration et laissent leurs lignes. Tout ce qui
   suit raisonne donc en écart par rapport au déjà-payé. */
const { rows: fa } = await client.query(
  `select i.id, i.total_fcfa, i.status, i.student_id from invoices i
    order by montant_regle(i.id), i.reference limit 1`);
const facture = fa[0];

const snapshot = async () => ({
  paiements: new Set((await client.query(`select id from payments`)).rows.map((r) => r.id)),
  recus: new Set((await client.query(`select id from receipts`)).rows.map((r) => r.id)),
  sequence: Number((await client.query(
    `select receipt_sequence as n from schools where id = $1`, [schoolId])).rows[0].n),
  statut: facture.status,
});
const avant = await snapshot();

const purge = async () => {
  const apres = await snapshot();
  const rr = [...apres.recus].filter((id) => !avant.recus.has(id));
  const pp = [...apres.paiements].filter((id) => !avant.paiements.has(id));
  if (rr.length) await client.query(`delete from receipts where id = any($1::uuid[])`, [rr]);
  if (pp.length) {
    // Les contrepassations d'abord : elles référencent les paiements annulés.
    await client.query(
      `delete from payments where id = any($1::uuid[]) and reverses_payment_id is not null`,
      [pp]);
    await client.query(`delete from payments where id = any($1::uuid[])`, [pp]);
  }
  await client.query(
    `update schools set receipt_sequence = $2 where id = $1`,
    [schoolId, avant.sequence]);
  await client.query(`update invoices set status = $2 where id = $1`,
    [facture.id, avant.statut]);
  await client.query(
    `delete from audit_log where action in ('payment.collect','payment.reverse')`);
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

const regle = async () => Number((await client.query(
  `select montant_regle($1) as n`, [facture.id])).rows[0].n);
const base = await regle();

try {
  await connecter(page, "70000004");                      // économe

  console.log("\nUne erreur de saisie");
  const trop = Math.min(50000, Number(facture.total_fcfa) - base);
  await poster(page, "/scolarite/encaisser", {
    facture: facture.id, montant: String(trop), methode: "especes" });
  const { rows: p1 } = await client.query(
    `select p.id, rc.receipt_number from payments p
       join receipts rc on rc.payment_id = p.id
      where p.invoice_id = $1 order by rc.sequence desc limit 1`, [facture.id]);
  check("le paiement est enregistré et le reçu émis", Boolean(p1[0]?.receipt_number));
  check("la facture le compte", (await regle()) === base + trop,
    `${await regle()} au lieu de ${base + trop}`);

  console.log("\nCe qui est refusé");
  const sansMotif = await poster(page, "/scolarite/annuler",
    { paiement: p1[0].id, motif: "" });
  check("une annulation sans motif est refusée",
    sansMotif.corps.includes("Dites pourquoi"),
    "c'est la seule chose qu'un contrôle pourra lire ensuite");
  const motifCourt = await poster(page, "/scolarite/annuler",
    { paiement: p1[0].id, motif: "erreur" });
  check("un motif d'un mot ne suffit pas",
    motifCourt.corps.includes("Dites pourquoi"));
  check("et rien n'a été écrit", (await regle()) === base + trop);

  console.log("\nL'annulation");
  const MOTIF = "Erreur de saisie : 50 000 au lieu de 5 000";
  const annul = await poster(page, "/scolarite/annuler",
    { paiement: p1[0].id, motif: MOTIF });
  check("l'annulation est acceptée", annul.corps.includes("Paiement annulé"));
  check("elle annonce le reçu de contrepartie à remettre",
    annul.corps.includes("ne vaut plus quittance"));

  check("LE SOLDE REDEVIENT JUSTE", (await regle()) === base,
    `${await regle()} encaissé au lieu des ${base} d'avant l'erreur`);

  const { rows: lignes } = await client.query(
    `select p.id, p.amount_fcfa, p.reverses_payment_id, p.reversal_reason,
            rc.receipt_number, rc.sequence
       from payments p left join receipts rc on rc.payment_id = p.id
      where p.invoice_id = $1 order by rc.sequence`, [facture.id]);
  check("LE PAIEMENT D'ORIGINE EST INTACT",
    lignes.some((l) => l.id === p1[0].id
      && Number(l.amount_fcfa) === trop && !l.reverses_payment_id),
    "on n'efface pas un reçu, et on n'en diminue pas le montant");
  const contre = lignes.find((l) => l.reverses_payment_id === p1[0].id);
  check("une contrepassation a été écrite", Boolean(contre));
  check("elle porte son propre numéro de reçu",
    Boolean(contre?.receipt_number) && contre.receipt_number !== p1[0].receipt_number,
    `${p1[0].receipt_number} / ${contre?.receipt_number}`);
  check("dans la même suite, sans trou",
    Number(contre.sequence) === Number(
      lignes.find((l) => l.id === p1[0].id).sequence) + 1,
    "un numéro sauté est ce qu'un contrôle cherche en premier");
  check("et elle garde le motif", contre.reversal_reason === MOTIF);

  console.log("\nLes deux documents disent ce qu'ils sont");
  await page.goto(`${BASE}/recus/${p1[0].receipt_number}`);
  const ancien = await page.content();
  check("l'ancien reçu se déclare annulé", ancien.includes("CE REÇU EST ANNULÉ"));
  check("et renvoie au reçu qui l'annule",
    ancien.includes(contre.receipt_number));
  check("il ne vaut plus quittance, et le dit",
    ancien.includes("ne vaut plus quittance"));

  await page.goto(`${BASE}/recus/${contre.receipt_number}`);
  const nouveau = await page.content();
  check("le second se déclare ANNULATION", nouveau.includes("ANNULATION"));
  check("il nomme le reçu annulé et le motif",
    nouveau.includes(p1[0].receipt_number) && nouveau.includes("50 000 au lieu"));
  check("son montant est présenté en négatif", nouveau.includes("−"));

  console.log("\nLes écrans disent tous la même chose");
  await page.goto(`${BASE}/scolarite/encaisser?facture=${facture.id}`);
  const guichet = await page.content();
  check("le registre montre les DEUX lignes",
    guichet.includes(p1[0].receipt_number) && guichet.includes(contre.receipt_number),
    "cacher la première ferait douter de la seconde");
  check("il explique pourquoi on n'efface pas",
    guichet.includes("suite\n        sans trou") || guichet.includes("sans trou"));
  await page.screenshot({ path: "out/captures/27-annulation.png", fullPage: true });

  await page.goto(`${BASE}/scolarite?filtre=tous`);
  const liste = await page.content();
  const { rows: att } = await client.query(
    `select i.total_fcfa from invoices i where i.id = $1`, [facture.id]);
  check("la liste des factures ne compte pas le paiement annulé",
    !liste.includes(`>${trop.toLocaleString("fr-FR").replace(/ | /g, " ")} F<`)
      || (await regle()) === 0);

  const { rows: fam } = await client.query(
    `select montant_regle(i.id) as paye from invoices i where i.id = $1`, [facture.id]);
  check("et la même définition sert à l'espace des familles",
    Number(fam[0].paye) === base,
    "un parent ne doit pas lire deux soldes différents sur deux écrans");

  console.log("\nOn n'annule pas deux fois");
  const encore = await poster(page, "/scolarite/annuler",
    { paiement: p1[0].id, motif: "Deuxième tentative pour voir" });
  check("un paiement déjà annulé refuse une seconde contrepassation",
    encore.corps.includes("déjà été annulé"),
    "deux contrepassations rendraient la facture créditrice");
  const surLaContre = await poster(page, "/scolarite/annuler",
    { paiement: contre.id, motif: "Annuler l'annulation pour voir" });
  check("et on n'annule pas une annulation",
    surLaContre.corps.includes("déjà une annulation"));
  check("le solde n'a pas bougé", (await regle()) === base);

  console.log("\nDroits");
  const sg = await browser.newContext({ locale: "fr-FR" });
  const p2 = await sg.newPage();
  await connecter(p2, "70000003");                        // surveillant général
  const refus = await poster(p2, "/scolarite/annuler",
    { paiement: p1[0].id, motif: "Intrusion volontaire dans la caisse" });
  check("qui n'encaisse pas n'annule pas, même en postant à la main",
    refus.statut === 403, `HTTP ${refus.statut}`);
  await sg.close();

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select detail from audit_log where action = 'payment.reverse'`);
  check("l'annulation est journalisée avec son motif",
    journal.some((j) => JSON.stringify(j.detail).includes("50 000 au lieu")),
    journal.length + " entrées");

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
console.log("L'annulation d'un paiement est vérifiée de bout en bout.");
