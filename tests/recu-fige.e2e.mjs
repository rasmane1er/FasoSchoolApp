/**
 * Un reçu réimprimé disait autre chose que le papier remis à la famille.
 *
 * CE QUI A ÉTÉ TROUVÉ EN RÉIMPRIMANT. `receiptPage` fige bien le MONTANT REÇU
 * — `receipts.amount_fcfa` — mais calculait le cartouche de droite, « Total dû
 * / Total payé / Reste », au moment de l'impression :
 *
 *     montant_regle(i.id) as paye
 *     const reste = Number(d.total_fcfa) - Number(d.paye);
 *
 * Éprouvé, dans cet ordre exact :
 *
 *   1. une famille verse 10 000 F. Le reçu N°1 sort : « Reste 68 000 F ».
 *      Elle le range dans un cahier, comme on fait ;
 *   2. trois semaines plus tard elle verse le solde ;
 *   3. l'économe réimprime LE MÊME REÇU N°1 — il affiche « SCOLARITÉ SOLDÉE ».
 *
 * Deux papiers, un seul numéro, deux affirmations contradictoires sur ce
 * qu'une famille a payé. Et l'écart va dans les deux sens : qu'un paiement
 * antérieur soit annulé, et la réimpression montre un reste PLUS GRAND que
 * celui que la famille détient — le papier de la famille devient la pièce qui
 * accuse l'école, ou celle qui l'innocente, selon le jour où on l'imprime.
 *
 * Le dépôt porte déjà cette règle pour les bulletins : « le bulletin remis ne
 * bouge pas », figé à la publication. Elle vaut pour tout ce qu'un papier
 * affirme, et un reçu est le document le plus opposable du produit.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. un reçu réimprimé après un versement ULTÉRIEUR dit EXACTEMENT la même
 *      chose — c'est le défaut exact ;
 *   2. il n'annonce pas « SCOLARITÉ SOLDÉE » sous un numéro qui ne soldait
 *      rien ;
 *   3. le second reçu, lui, porte bien le nouvel état — figer ne veut pas dire
 *      cesser d'avancer ;
 *   4. après ANNULATION d'un paiement, le reçu d'origine ne bouge pas non plus,
 *      et le reçu de contrepartie porte l'état d'APRÈS l'annulation ;
 *   5. un reçu antérieur à la migration 0018 ne restitue pas un solde inventé :
 *      il dit qu'il ne peut pas, et laisse le montant reçu faire foi ;
 *   6. le montant reçu, lui, n'a jamais bougé — on le revérifie, parce que
 *      c'est la seule chose qui était déjà juste.
 *
 *   node tests/recu-fige.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4255;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(
  `select school_id from auth_lookup_user('70000004')`);
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);

/* Ce que cette suite crée, et qu'elle seule doit retirer : des paiements et
 * leurs reçus. Un reçu est append-only dans le produit — on ne le supprime
 * jamais — mais une épreuve rend la base telle qu'elle l'a trouvée. */
const paiementsPoses = [];
const { rows: seqInitiale } = await client.query(
  `select receipt_sequence from schools limit 1`);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });
const up = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/sante`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
})();
if (!up) { console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1200)); server.kill(); process.exit(1); }

const login = async (phone) => {
  const a = await fetch(`${BASE}/connexion`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone }).toString() });
  const t = await a.text();
  const code = ((t.match(/id="code-demo"[^>]*>(\d{6})</) ?? [])[1])
    ?? ((t.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1]);
  const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};

const nu = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Ce que le papier AFFIRME : le cartouche, et le verdict du bas. */
const papier = (html) => ({
  cartouche: (nu(html).match(/Total dû.*?Reste [\d  ]+F/) ?? [""])[0],
  soldee: /SCOLARITÉ SOLDÉE/.test(html),
  montant: (nu(html).match(/Montant (?:reçu|restitué) ([\d  ]+)FCFA/) ?? ["", ""])[1].trim(),
  annule: /CE REÇU EST ANNULÉ/.test(html),
});

try {
  const eco = await login("70000004");

  const { rows: f } = await client.query(
    `select i.id, i.total_fcfa from invoices i
      where i.status <> 'annulee' and montant_regle(i.id) = 0
      order by i.reference limit 1`);
  const FACT = f[0].id;
  const TOTAL = Number(f[0].total_fcfa);

  const encaisser = async (montant) => {
    const r = await fetch(`${BASE}/scolarite/encaisser`, { method: "POST",
      redirect: "manual",
      headers: { cookie: eco, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ facture: FACT, montant: String(montant),
                                  methode: "especes" }).toString() });
    const loc = r.headers.get("location") ?? "";
    return decodeURIComponent(loc.split("recu=")[1] ?? "");
  };
  const imprimer = async (numero) =>
    (await fetch(`${BASE}/recus/${encodeURIComponent(numero)}`,
      { headers: { cookie: eco } })).text();

  const noter = async () => {
    const { rows } = await client.query(
      `select id from payments where invoice_id = $1`, [FACT]);
    for (const p of rows) if (!paiementsPoses.includes(p.id)) paiementsPoses.push(p.id);
  };

  /* === 1. Le défaut exact =============================================== */
  console.log("\nUn premier versement, puis un second");

  const recu1 = await encaisser(10000);
  await noter();
  check("le premier reçu est émis", /^R-\d{4}-\d{4}$/.test(recu1), recu1);

  const avant = papier(await imprimer(recu1));
  console.log(`     à l'émission : ${avant.cartouche || "(cartouche introuvable)"}`);
  /* `nu()` a ramené les espaces insécables de `fcfa()` à des espaces
   * ordinaires : on compare donc avec un séparateur ordinaire. */
  const groupe = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  check("il porte le reste réel du jour",
    avant.cartouche.includes(groupe(TOTAL - 10000)),
    `${groupe(TOTAL - 10000)} attendu dans : ${avant.cartouche}`);
  check("et il n'annonce rien de soldé", !avant.soldee);

  const recu2 = await encaisser(TOTAL - 10000);
  await noter();

  const apres = papier(await imprimer(recu1));
  console.log(`     réimprimé    : ${apres.cartouche || "(cartouche introuvable)"}`);

  check("LE REÇU RÉIMPRIMÉ DIT EXACTEMENT LA MÊME CHOSE",
    apres.cartouche === avant.cartouche,
    `« ${avant.cartouche} » puis « ${apres.cartouche} » — deux papiers, un `
      + `numéro, deux affirmations sur ce qu'une famille a payé`);
  check("ET IL N'ANNONCE PAS « SCOLARITÉ SOLDÉE »", !apres.soldee,
    "avant, un reçu de 10 000 F sur 78 000 déclarait la scolarité soldée dès "
      + "qu'un versement ultérieur l'avait éteinte");
  check("le montant reçu n'a pas bougé non plus",
    apres.montant === avant.montant, `${avant.montant} → ${apres.montant}`);

  console.log("\nFiger ne veut pas dire cesser d'avancer");
  const p2 = papier(await imprimer(recu2));
  check("le second reçu, lui, porte le nouvel état", p2.soldee,
    `« ${p2.cartouche} » — c'est CE papier-là qui solde la scolarité`);
  check("et son cartouche diffère du premier", p2.cartouche !== avant.cartouche);

  /* === 2. L'annulation ================================================== */
  console.log("\nAprès annulation, le reçu d'origine ne bouge pas");
  const { rows: dernier } = await client.query(
    `select p.id from payments p join receipts rc on rc.payment_id = p.id
      where rc.receipt_number = $1`, [recu2]);
  const ann = await fetch(`${BASE}/scolarite/annuler`, { method: "POST",
    headers: { cookie: eco, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ paiement: dernier[0].id,
                                motif: "chèque sans provision" }).toString() });
  const ditAnn = nu(await ann.text());
  check("l'annulation est acceptée", /annulé/i.test(ditAnn), ditAnn.slice(0, 160));
  await noter();

  const apresAnnulation = papier(await imprimer(recu1));
  check("LE REÇU N°1 EST TOUJOURS IDENTIQUE",
    apresAnnulation.cartouche === avant.cartouche,
    `« ${avant.cartouche} » puis « ${apresAnnulation.cartouche} » — sans figer, `
      + `une annulation faisait remonter le reste sous un numéro déjà remis`);

  const p2Annule = papier(await imprimer(recu2));
  check("le reçu annulé le dit sur lui-même", p2Annule.annule);
  check("mais son cartouche n'a pas été réécrit",
    p2Annule.cartouche === p2.cartouche,
    "un document annulé reste la preuve de ce qu'il affirmait : c'est la "
      + "règle append-only du registre des reçus");

  const { rows: contre } = await client.query(
    `select rc.receipt_number, rc.total_du_fcfa, rc.total_paye_fcfa
       from receipts rc join payments p on p.id = rc.payment_id
      where p.reverses_payment_id = $1`, [dernier[0].id]);
  check("un reçu de contrepartie a été émis", contre.length === 1);
  check("ET IL PORTE L'ÉTAT D'APRÈS L'ANNULATION",
    Number(contre[0].total_paye_fcfa) === 10000,
    `${contre[0]?.total_paye_fcfa} — après annulation du solde, il ne reste `
      + `que les 10 000 F du premier versement`);

  /* === 3. Un reçu d'avant la migration ================================== */
  console.log("\nUn reçu antérieur à la migration ne restitue pas un solde inventé");
  const { rows: r1 } = await client.query(
    `select id from receipts where receipt_number = $1`, [recu1]);
  const { rows: fige } = await client.query(
    `select total_du_fcfa, total_paye_fcfa from receipts where id = $1`, [r1[0].id]);
  await client.query(
    `update receipts set total_du_fcfa = null, total_paye_fcfa = null
      where id = $1`, [r1[0].id]);

  const ancien = await imprimer(recu1);
  check("recu_restituable() dit faux",
    (await client.query(`select recu_restituable($1) as v`, [r1[0].id])).rows[0].v === false);
  check("LE PAPIER DIT QU'IL NE PEUT PAS RESTITUER LE SOLDE",
    /Solde non restituable/.test(ancien),
    "afficher le solde d'aujourd'hui sous un numéro d'hier est exactement le "
      + "défaut qu'on répare : " + nu(ancien).slice(0, 200));
  check("il n'affiche aucun chiffre de solde", !/Total dû/.test(ancien));
  check("mais le montant reçu fait toujours foi",
    papier(ancien).montant === avant.montant,
    "c'est la seule chose qui était déjà figée");
  check("et il ne prétend rien solder", !papier(ancien).soldee);

  await client.query(
    `update receipts set total_du_fcfa = $2, total_paye_fcfa = $3 where id = $1`,
    [r1[0].id, fige[0].total_du_fcfa, fige[0].total_paye_fcfa]);

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.end().catch(() => {});
}

{
  const c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c2.connect();
  await c2.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
  for (const id of paiementsPoses) {
    await c2.query(`delete from receipts where payment_id = $1`, [id]).catch(() => {});
    await c2.query(`delete from payment_events where payment_id = $1`, [id]).catch(() => {});
  }
  // Les contreparties référencent le paiement annulé : on les retire d'abord.
  await c2.query(
    `delete from payments where reverses_payment_id = any($1::uuid[])`,
    [paiementsPoses]).catch(() => {});
  for (const id of paiementsPoses) {
    await c2.query(`delete from payments where id = $1`, [id]).catch(() => {});
  }
  await c2.query(
    `update schools set receipt_sequence = $1`, [seqInitiale[0].receipt_sequence]);
  await c2.query(`update invoices set status = 'ouverte' where status = 'partielle'`);
  await c2.query(`delete from audit_log where action like 'payment.%'`);
  await c2.query(`delete from sms_messages where body like '%Recu%'`);
  await c2.query(`delete from sms_credit_ledger where note = 'Confirmation de paiement'`);
  await c2.query(`delete from auth_sessions`);
  await c2.query(`delete from auth_otp_challenges`);
  await c2.query(`delete from auth_rate_limits`);
  await c2.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le reçu remis à une famille dit la même chose six mois plus tard.");
