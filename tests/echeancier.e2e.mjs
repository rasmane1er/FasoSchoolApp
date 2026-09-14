/**
 * « En retard » voulait dire « doit quelque chose ».
 *
 * CE QUI A ÉTÉ TROUVÉ EN LISANT LE MOT SUR L'ÉCRAN. Dans `finance.ts` :
 *
 *     const enRetard = rows.filter((r) => r.rest > 0);
 *
 * et, à côté, la tuile : « 9 familles en retard ». Or `rest` est le solde de
 * l'ANNÉE ENTIÈRE. Le jour où les factures sont émises, avant qu'un seul franc
 * ne soit exigible, cette ligne désignait donc TOUTES les familles, et peignait
 * leur ligne en rouge.
 *
 * Mesuré sur le jeu de démonstration : neuf familles annoncées « en retard »,
 * dont quatre qui avaient versé 40 000 F sur 78 000 — c'est-à-dire la première
 * tranche et une partie de la deuxième, EN AVANCE sur l'échéancier.
 *
 * Ce n'est pas un mot mal choisi dans un coin d'écran : c'est le mot sur lequel
 * un établissement décide qui il renvoie à la maison.
 *
 * L'ÉCHÉANCIER EXISTAIT DÉJÀ. `frais.ts` écrit `invoice_instalments` à chaque
 * émission — une tranche par trimestre, aux dates saisies par l'école. Aucune
 * requête de l'application ne lisait cette table. Les suites de tests la
 * sauvegardaient et la restauraient ; une en sommait le total pour vérifier
 * qu'une bourse la rabote. Pas un écran ne la montrait, ni à l'économe, ni à la
 * famille, qui lisait donc « vous devez 78 000 F » sans savoir ce qui était dû
 * maintenant.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. une famille à jour de ses tranches échues N'EST PAS « en retard », même
 *      si elle doit encore la moitié de l'année — c'est le défaut exact ;
 *   2. une famille qui a dépassé une échéance l'est, pour le MONTANT échu et
 *      non pour le solde annuel ;
 *   3. une facture SANS échéancier ne bascule d'aucun côté : le logiciel dit
 *      qu'il ne sait pas, plutôt que de choisir à la place de l'école ;
 *   4. un versement en avance ne produit pas un retard négatif ;
 *   5. la famille voit ce qu'elle doit MAINTENANT et la prochaine échéance,
 *      pas seulement une somme annuelle ;
 *   6. le tableau de bord compte les retards réels, pas les soldes ;
 *   7. le SMS de paiement dit ce qui reste échu, pas le solde de l'année.
 *
 *   node tests/echeancier.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4253;
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

const MARQUE = "EPREUVE ECHEANCIER";

/* LA DÉMONSTRATION SÈME DÉSORMAIS UN ÉCHÉANCIER — trois tranches par facture,
 * aux débuts de trimestre, comme `frais.ts` les pose. Cette suite avait été
 * écrite quand elle n'en semait aucun : elle doit donc METTRE DE CÔTÉ les
 * tranches de démonstration des factures qu'elle utilise, poser les siennes,
 * et les rendre à la fin. C'est la règle habituelle, appliquée à une fixture
 * qui a grandi : on ne supprime que ce qu'on a mis, et on rend ce qu'on a pris. */
const purger = async () => {
  await client.query(
    `delete from invoice_instalments where label like $1`, ["%" + MARQUE + "%"]);
  await client.query(
    `delete from sms_messages where body like '%Recu%' or body like '%a jour%'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

/* Les paiements posés par cette suite, pour les retirer ensuite. Un reçu est
 * append-only : on ne le supprime jamais dans le produit, mais une épreuve doit
 * rendre la base telle qu'elle l'a trouvée, et ces lignes-ci sont les siennes. */
const paiementsPoses = [];
/** Les tranches de démonstration mises de côté, à rendre telles quelles. */
let tranchesEmpruntees = [];

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
const ligneDe = (html, nom, largeur = 900) => {
  const i = html.indexOf(nom);
  return i < 0 ? "" : nu(html.slice(i, i + largeur));
};

/* Pose un échéancier de trois tranches : une ÉCHUE, deux à venir.
 *
 * Les dates sont calculées par PostgreSQL À PARTIR DE `current_date`, et non
 * écrites en dur. Une date d'octobre 2026 écrite en dur serait échue ou non
 * selon le jour où la suite est lancée — c'est exactement l'erreur qui faisait
 * échouer trois autres suites le soir venu. */
const poserEcheancier = async (invoiceId, total) => {
  const part = Math.floor(total / 3);
  const tranches = [
    [`${MARQUE} Tranche 1`, part + (total - part * 3), "-30 days"],
    [`${MARQUE} Tranche 2`, part, "+60 days"],
    [`${MARQUE} Tranche 3`, part, "+150 days"],
  ];
  for (const [i, [label, montant, decalage]] of tranches.entries()) {
    await client.query(
      `insert into invoice_instalments (school_id, invoice_id, label,
                                        amount_fcfa, due_on, sort_order)
       values ($1,$2,$3,$4, current_date + $5::interval, $6)`,
      [SCHOOL, invoiceId, label, montant, decalage, i]);
  }
  return tranches;
};

/** La date lisible d'une tranche, telle que les écrans l'écrivent. */
const dateTranche = async (invoiceId, rang) => {
  const { rows } = await client.query(
    `select to_char(due_on, 'DD/MM/YYYY') as j from invoice_instalments
      where invoice_id = $1 order by due_on offset $2 limit 1`, [invoiceId, rang]);
  return rows[0]?.j ?? "";
};

try {
  const eco = await login("70000004");   // l'économe

  const { rows: factures } = await client.query(
    `select i.id, i.total_fcfa, i.student_id, st.last_name,
            montant_regle(i.id) as paye
       from invoices i join students st on st.id = i.student_id
      where i.status <> 'annulee' order by st.last_name`);

  /* Le jeu de démonstration porte déjà trois profils utiles : des familles qui
   * ont versé 40 000 F sur 78 000, d'autres rien du tout, d'autres tout. On
   * les prend telles quelles plutôt que de fabriquer des cas. */
  const AJOUR = factures.find((f) => Number(f.paye) > 0 && Number(f.paye) < Number(f.total_fcfa));
  const RIEN = factures.find((f) => Number(f.paye) === 0);
  const SANS = factures.find((f) => Number(f.paye) === 0 && f.id !== RIEN?.id);
  check("le jeu de démonstration porte les profils qu'il faut",
    Boolean(AJOUR && RIEN && SANS),
    "une famille ayant versé une partie, deux n'ayant rien versé");

  /* On emprunte les tranches de démonstration des trois factures utilisées :
     celles d'AJOUR et de RIEN sont remplacées par les nôtres, celle de SANS
     est simplement retirée — c'est ainsi qu'on obtient une facture « sans
     échéancier » maintenant que la démonstration en pose partout. */
  const EMPRUNTEES = [AJOUR.id, RIEN.id, SANS.id];
  ({ rows: tranchesEmpruntees } = await client.query(
    `select * from invoice_instalments where invoice_id = any($1::uuid[])`,
    [EMPRUNTEES]));
  await client.query(
    `delete from invoice_instalments where invoice_id = any($1::uuid[])`,
    [EMPRUNTEES]);

  /* AJOUR : 40 000 versés ; tranche 1 échue = 26 000 → à jour, et il lui
   * reste 38 000 sur l'année. C'est EXACTEMENT le cas que l'ancien filtre
   * comptait « en retard ».
   * RIEN : rien versé, tranche 1 échue → en retard de 26 000.
   * SANS : aucun échéancier → inconnu. */
  const tr = await poserEcheancier(AJOUR.id, Number(AJOUR.total_fcfa));
  await poserEcheancier(RIEN.id, Number(RIEN.total_fcfa));
  const T1 = tr[0][1];

  console.log("\nCe que disent les fonctions");
  const nombre = async (sql, id) => {
    const r = await client.query(sql, [id]);
    const v = Object.values(r.rows[0])[0];
    return v === null ? null : Number(v);
  };
  check("l'échu d'une facture sans échéancier est INCONNU, pas zéro",
    (await nombre(`select montant_echu($1, current_date)`, SANS.id)) === null,
    "répondre « rien » rendrait toute famille éternellement à jour ; "
      + "répondre « tout » les mettrait toutes en retard dès l'émission");
  check("son retard l'est aussi",
    (await nombre(`select retard_de($1, current_date)`, SANS.id)) === null);
  check("la famille à jour n'a AUCUN retard",
    (await nombre(`select retard_de($1, current_date)`, AJOUR.id)) === 0,
    "elle doit encore 38 000 F sur l'année — et n'est en retard de rien");
  check("celle qui n'a rien versé est en retard de la tranche échue",
    (await nombre(`select retard_de($1, current_date)`, RIEN.id)) === T1,
    `attendu ${T1}`);
  check("un versement en avance ne produit pas de retard négatif",
    (await nombre(`select retard_de($1, current_date)`, AJOUR.id)) >= 0);

  /* === L'écran de l'économe ============================================== */
  console.log("\nSur l'écran de la scolarité");
  const sco = await (await fetch(`${BASE}/scolarite?filtre=tous`,
    { headers: { cookie: eco } })).text();

  check("une tuile compte le retard RÉEL", /En retard aujourd(?:'|&#39;)hui/.test(sco),
    nu(sco).slice(0, 200));

  /* LA TUILE COMPTE-T-ELLE LE BON NOMBRE ? C'est l'assertion décisive, et elle
   * porte sur le CHIFFRE, pas sur l'intitulé : une seule famille a dépassé une
   * échéance. L'ancien filtre — `rest > 0` — en comptait neuf, dont celles qui
   * avaient payé leur première tranche en avance. */
  const tuile = (() => {
    const i = sco.indexOf("En retard aujourd");
    return i < 0 ? "" : nu(sco.slice(i, i + 400));
  })();
  /* Combien de familles la démonstration met-elle en retard à elle seule ?
     On le DEMANDE : la réponse dépend du jour où l'année de démonstration est
     placée, et l'écrire ici la figerait de nouveau. */
  const { rows: base } = await client.query(
    `select count(*)::int as n from invoices i
      where i.status <> 'annulee'
        and not (i.id = any($1::uuid[]))
        and coalesce(retard_de(i.id, current_date), 0) > 0`, [EMPRUNTEES]);
  const attendu = base[0].n + 1;   // + RIEN, que cette suite met en retard
  check(`ET ELLE EN COMPTE ${attendu}`,
    new RegExp(`\\b${attendu} famille`).test(tuile),
    `« ${tuile.slice(0, 140)} » — les autres doivent encore de l'argent sur `
      + `l'année sans avoir dépassé d'échéance`);
  check("et « reste à recouvrer » dit qu'il porte sur l'année",
    /sur l(?:'|&#39;)année entière/.test(sco));

  const ligneAjour = ligneDe(sco, AJOUR.last_name);
  check("LA FAMILLE À JOUR EST ANNONCÉE À JOUR", /à jour/.test(ligneAjour),
    "avant, elle était comptée « en retard » et sa ligne peinte en rouge : "
      + ligneAjour.slice(0, 160));
  check("et sa prochaine tranche lui est nommée", /Tranche 2/.test(ligneAjour),
    ligneAjour.slice(0, 200));

  const ligneRien = ligneDe(sco, RIEN.last_name);
  check("celle qui n'a rien versé est en retard", /exigible, non versé/.test(ligneRien),
    ligneRien.slice(0, 160));
  check("et pour LE MONTANT ÉCHU, pas le solde annuel",
    ligneRien.includes(String(T1).replace(/\B(?=(\d{3})+(?!\d))/g, " "))
      || ligneRien.includes(String(T1)),
    `${T1} attendu dans : ${ligneRien.slice(0, 200)}`);

  const ligneSans = ligneDe(sco, SANS.last_name);
  check("UNE FACTURE SANS ÉCHÉANCIER NE BASCULE D'AUCUN CÔTÉ",
    /échéancier absent/.test(ligneSans),
    "choisir à la place de l'école se verrait un jour sur la porte d'un "
      + "élève : " + ligneSans.slice(0, 160));
  check("et l'écran explique quoi en faire",
    /Réémettre la facture/.test(sco));
  check("le mot « en retard » est expliqué en bas de page",
    /veut dire en retard sur ce qui était dû/.test(sco));

  /* === Le tableau de bord =============================================== */
  console.log("\nSur le tableau de bord");
  const board = await (await fetch(`${BASE}/`, { headers: { cookie: eco } })).text();
  check("il annonce les familles qui ont dépassé une échéance",
    /dépassé une échéance/.test(board), nu(board).slice(0, 250));
  check("et il ne compte QUE celles-là",
    new RegExp(`${attendu} famille`).test(board),
    `${attendu} attendu — les autres doivent encore de l'argent sans avoir `
      + `dépassé d'échéance : ` + nu(board).slice(0, 250));

  /* === Ce que voit la famille ========================================== */
  console.log("\nCe que voit la famille");
  const { rows: tut } = await client.query(
    `select g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and sg.receives_sms
        and coalesce(g.phone,'') <> '' limit 1`, [AJOUR.student_id]);
  const a = await fetch(`${BASE}/famille/connexion`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: tut[0].phone }).toString() });
  const tt = await a.text();
  const codeF = ((tt.match(/id="code-demo"[^>]*>(\d{6})</) ?? [])[1])
    ?? ((tt.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1]);
  const vf = await fetch(`${BASE}/famille/verifier`, { method: "POST",
    redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: tut[0].phone, code: codeF }).toString() });
  const cookieF = (vf.headers.get("set-cookie") ?? "").split(";")[0];
  const espace = await (await fetch(`${BASE}/famille`, { headers: { cookie: cookieF } })).text();

  check("LA FAMILLE VOIT CE QU'ELLE DOIT MAINTENANT",
    /À verser maintenant/.test(espace),
    "elle lisait « vous devez 78 000 F » — un chiffre qu'on ne verse pas d'un "
      + "coup, et qui ne dit pas ce qui est exigible : " + nu(espace).slice(0, 200));
  check("et qu'elle est à jour", /vous êtes à jour/.test(espace));
  const dateT2 = await dateTranche(AJOUR.id, 1);
  check("la prochaine échéance lui est annoncée, avec sa date",
    /Tranche 2/.test(espace) && espace.includes(dateT2),
    `${dateT2} attendu dans : ` + nu(espace).slice(0, 300));
  check("le solde annuel reste visible", /Reste sur l(?:'|&#39;)année/.test(espace));

  /* === Le SMS de paiement ============================================== */
  console.log("\nLe SMS de paiement");
  const av = await client.query(`select count(*)::int as n from payments`);
  const enc = await fetch(`${BASE}/scolarite/encaisser`, { method: "POST",
    headers: { cookie: eco, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ facture: RIEN.id, montant: "5000",
                               methode: "especes", sms: "1" }).toString() });
  const ditEnc = nu(await enc.text());
  check("l'encaissement passe", /[Rr]e[çc]u/.test(ditEnc), ditEnc.slice(0, 160));
  const ap = await client.query(`select count(*)::int as n from payments`);
  if (ap.rows[0].n > av.rows[0].n) {
    const { rows: neufs } = await client.query(
      `select id from payments order by initiated_at desc limit $1`,
      [ap.rows[0].n - av.rows[0].n]);
    paiementsPoses.push(...neufs.map((x) => x.id));
  }

  const { rows: sms } = await client.query(
    `select body from sms_messages where body like '%Recu%'
      order by queued_at desc limit 1`);
  check("LE SMS DIT CE QUI RESTE ÉCHU, pas le solde de l'année",
    /F echu/.test(sms[0]?.body ?? ""),
    `« ${sms[0]?.body ?? "aucun"} » — « Reste 73 000 F » se lit comme une somme `
      + `exigible tout de suite`);
  check("et il donne quand même le solde annuel",
    /sur l annee/.test(sms[0]?.body ?? ""));

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
  // Reçus puis paiements : le reçu référence le paiement.
  for (const id of paiementsPoses) {
    await c2.query(`delete from receipts where payment_id = $1`, [id]).catch(() => {});
    await c2.query(`delete from payment_events where payment_id = $1`, [id]).catch(() => {});
    await c2.query(`delete from payments where id = $1`, [id]).catch(() => {});
  }
  await c2.query(`update invoices set status = 'ouverte' where status = 'partielle'`);
  await c2.query(`delete from audit_log where action like 'payment.%'`);
  await c2.query(
    `delete from invoice_instalments where label like $1`, ["%" + MARQUE + "%"]);
  for (const t of tranchesEmpruntees) {
    await c2.query(
      `insert into invoice_instalments (id, school_id, invoice_id, label,
                                        amount_fcfa, due_on, sort_order)
       values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`,
      [t.id, t.school_id, t.invoice_id, t.label, t.amount_fcfa, t.due_on,
       t.sort_order]).catch(() => {});
  }
  await c2.query(
    `delete from sms_messages where body like '%Recu%' or body like '%a jour%'`);
  await c2.query(`delete from sms_credit_ledger where note = 'Confirmation de paiement'`);
  await c2.query(`delete from auth_sessions`);
  await c2.query(`delete from auth_otp_challenges`);
  await c2.query(`delete from auth_rate_limits`);
  await c2.query(`delete from guardian_sessions`).catch(() => {});
  await c2.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("« En retard » veut enfin dire en retard sur ce qui était dû.");
