/**
 * Le double-clic au guichet : la serrure était posée, la clé refaite à chaque
 * tour.
 *
 * CE QUI A ÉTÉ TROUVÉ EN CLIQUANT DEUX FOIS SUR « ENCAISSER ». Deux POST
 * identiques lancés ensemble — sur une connexion lente, cliquer une seconde
 * fois est le geste humain normal — et voici ce que la base portait :
 *
 *     paiements : 2 · reçus : 2 · réglé : 20 000 F
 *     R-2026-0025  10 000 F   « total payé : 10 000 »
 *     R-2026-0026  10 000 F   « total payé : 10 000 »
 *
 * Un billet de dix mille remis au guichet, vingt mille portés au crédit de la
 * famille, deux numéros tirés du registre, et une caisse qui manque de dix
 * mille francs au soir. La touche F5 sur l'écran de confirmation en ajoutait
 * un troisième.
 *
 * ET LES DEUX PAPIERS PORTAIENT LE MÊME « total payé : 10 000 » — tous deux
 * avaient lu la facture avant qu'aucun n'ait écrit. L'état figé de 0018, celui
 * qui garantit qu'un reçu réimprimé dit la même chose que le papier remis,
 * était lui-même faux : la course avait eu lieu en amont de lui.
 *
 * LA SERRURE EXISTAIT DEPUIS LE PREMIER SCHÉMA :
 *
 *     idempotency_key text not null, ... unique (school_id, idempotency_key)
 *
 * Et le code la nourrissait de `guichet:<facture>:<Date.now()>` — une clé
 * neuve à chaque milliseconde. La contrainte n'a jamais refusé personne. Le
 * verrou d'avis qui sérialise la NUMÉROTATION, lui, marchait : il ne faisait
 * que rendre le doublon net, avec deux numéros consécutifs.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. deux POST simultanés ne produisent QU'UN paiement et QU'UN reçu ;
 *   2. le second retombe sur le MÊME numéro, et l'écran dit que c'était déjà
 *      enregistré — un guichetier à qui l'on répond « erreur » ne sait pas si
 *      l'argent est passé, et recommence ;
 *   3. le rechargement de page et le re-clic tardif sont attrapés aussi ;
 *   4. un versement LÉGITIMEMENT différent passe : autre montant, autre moyen ;
 *   5. et le même versement passe de nouveau UNE FOIS LA FENÊTRE ÉCOULÉE — une
 *      famille qui verse deux fois cinq mille dans la journée existe ;
 *   6. la fenêtre est un réglage de l'établissement : à zéro, la garde se tait,
 *      et cela se décide au lieu de se subir ;
 *   7. la clé est DÉTERMINISTE : le même geste, la même clé.
 *
 *   node tests/double-clic.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4286;
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
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE : la fenêtre de l'établissement, le compteur de reçus et
 * l'état des factures. Tout est rendu dans le `finally`. */
const { rows: reglages } = await client.query(
  `select fenetre_double_clic_secondes as fenetre, receipt_sequence from schools limit 1`);
const { rows: factures } = await client.query(
  `select id, status from invoices order by id`);

const MARQUE = "EPREUVE double-clic";

const rendre = async () => {
  await client.query(
    `delete from receipts where payment_id in
       (select id from payments where idempotency_key like 'guichet:%')`);
  await client.query(`delete from payments where idempotency_key like 'guichet:%'`);
  for (const f of factures) {
    await client.query(`update invoices set status = $2 where id = $1`, [f.id, f.status]);
  }
  await client.query(
    `update schools set fenetre_double_clic_secondes = $1, receipt_sequence = $2`,
    [reglages[0].fenetre, reglages[0].receipt_sequence]);
  await client.query(`delete from audit_log where action like 'payment%'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await rendre();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" },
  stdio: ["ignore", "pipe", "pipe"] });
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
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};
const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

const etat = async (inv) => (await client.query(
  `select (select count(*)::int from payments p
            where p.invoice_id = $1 and p.reverses_payment_id is null) as paiements,
          (select count(*)::int from receipts r
             join payments p on p.id = r.payment_id
            where p.invoice_id = $1) as recus,
          montant_regle($1)::int as regle`, [inv])).rows[0];

try {
  const cookie = await login("70000004");   // économe
  /* UNE FACTURE QUI A DE LA PLACE. Cette suite versait sur « la première
   * facture par identifiant » — un ordre que rien ne garantit, puisque les
   * identifiants sont des UUID : au premier resemis, elle est tombée sur une
   * facture déjà soldée et onze assertions ont accusé la garde anti-doublon
   * d'un défaut qui n'était pas le sien. Une suite dont le résultat dépend de
   * l'ordre d'identifiants tirés au hasard n'est pas une épreuve. */
  const { rows: inv } = await client.query(
    `select i.id, i.total_fcfa, (i.total_fcfa - montant_regle(i.id))::int as reste
       from invoices i
      where i.status <> 'annulee' and i.total_fcfa - montant_regle(i.id) >= 30000
      order by i.reference limit 1`);
  if (inv.length === 0) {
    console.error("Il faut une facture avec au moins 30 000 F de reste : "
      + "lancez « npm run demo ».");
    server.kill(); process.exit(1);
  }
  const F = inv[0].id;

  const encaisser = (montant, methode = "especes") =>
    fetch(`${BASE}/scolarite/encaisser`, {
      method: "POST", redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ facture: F, montant: String(montant), methode }).toString() });
  const recuDe = (r) => {
    const l = r.headers.get("location") ?? "";
    return [(l.match(/recu=([^&]+)/) ?? [])[1] ?? null, /deja=1/.test(l)];
  };

  /* === 1. Deux clics, un seul reçu ===================================== */
  console.log("\nDeux POST simultanés ne font qu'un versement");

  const depart = await etat(F);
  const [a, b] = await Promise.all([encaisser(10000), encaisser(10000)]);
  const [ra, dejaA] = recuDe(a);
  const [rb, dejaB] = recuDe(b);
  const apres = await etat(F);

  check("un seul paiement est enregistré",
    apres.paiements === depart.paiements + 1,
    `${depart.paiements} → ${apres.paiements} — avant, DEUX : vingt mille `
      + `francs portés au crédit pour un billet de dix mille`);
  check("un seul reçu est émis",
    apres.recus === depart.recus + 1,
    `${depart.recus} → ${apres.recus} — deux numéros consécutifs étaient tirés `
      + `du registre, et le verrou de numérotation ne faisait que les rendre nets`);
  check("et un seul versement est porté au crédit",
    apres.regle === depart.regle + 10000,
    `${depart.regle} → ${apres.regle} F`);

  check("les deux réponses renvoient le MÊME numéro de reçu",
    ra !== null && ra === rb, `${ra} / ${rb}`);
  check("et l'une des deux dit que c'était déjà enregistré",
    dejaA !== dejaB,
    "un guichetier à qui l'on répond « erreur » ne sait pas si l'argent est "
      + "passé, et recommence — ce qui est le geste qu'on voulait empêcher");

  const page = texte(await (await fetch(`${BASE}/scolarite?recu=${ra}&deja=1`,
    { headers: { cookie } })).text());
  check("l'écran le dit en toutes lettres",
    /Ce versement était déjà enregistré : un seul reçu a été émis/.test(page),
    page.slice(0, 200));

  /* === 2. Le rechargement et le re-clic tardif ========================= */
  console.log("\nLe rechargement de page est attrapé lui aussi");

  const c3 = await encaisser(10000);
  const [rc, dejaC] = recuDe(c3);
  const apres3 = await etat(F);
  check("un troisième envoi identique n'ajoute rien",
    apres3.paiements === apres.paiements && apres3.recus === apres.recus,
    `${apres3.paiements} paiements, ${apres3.recus} reçus`);
  check("et il retombe sur le même reçu, en le disant",
    rc === ra && dejaC, `${rc} (deja=${dejaC})`);

  /* === 3. Un versement légitimement différent passe =================== */
  console.log("\nCe qui est vraiment un second versement passe");

  const d = await encaisser(5000);
  const [rd] = recuDe(d);
  const apres4 = await etat(F);
  check("un autre montant est un autre versement",
    apres4.paiements === apres3.paiements + 1 && rd !== ra,
    `${rd} — la garde compare LE GESTE, pas la facture seule`);

  const e = await encaisser(5000, "virement");
  const [re] = recuDe(e);
  const apres5 = await etat(F);
  check("un autre moyen de paiement aussi",
    apres5.paiements === apres4.paiements + 1 && re !== rd,
    `${re} — cinq mille en espèces et cinq mille par virement sont deux `
      + `versements, même montant`);

  /* === 4. Une fois la fenêtre écoulée ================================= */
  console.log("\nUne fois la fenêtre écoulée, le même versement repasse");

  /* On ne dort pas quatre-vingt-dix secondes : on recule l'horodatage du
   * versement, ce qui est exactement ce que le temps aurait fait. */
  await client.query(
    `update payments set initiated_at = initiated_at - interval '10 minutes'
      where invoice_id = $1`, [F]);
  const f = await encaisser(5000, "virement");
  const [rf, dejaF] = recuDe(f);
  const apres6 = await etat(F);
  check("le même geste, dix minutes plus tard, est un vrai second versement",
    apres6.paiements === apres5.paiements + 1 && !dejaF && rf !== re,
    `${rf} (deja=${dejaF}) — une famille qui verse deux fois cinq mille dans `
      + `la journée existe ; deux fois dans la même minute, non`);

  /* === 5. La fenêtre est un réglage ================================== */
  console.log("\nLa fenêtre est un réglage de l'établissement");

  await client.query(`update schools set fenetre_double_clic_secondes = 0`);
  const g1 = await encaisser(3000);
  const g2 = await encaisser(3000);
  const apres7 = await etat(F);
  check("à zéro, la garde se tait — et cela se décide",
    apres7.paiements === apres6.paiements + 2,
    `${apres6.paiements} → ${apres7.paiements} — une garde qu'on ne peut pas `
      + `désactiver finit par être contournée autrement`);
  await client.query(
    `update schools set fenetre_double_clic_secondes = $1`, [reglages[0].fenetre]);

  const { rows: borne } = await client.query(
    `select count(*)::int as n from pg_constraint
      where conname = 'schools_fenetre_double_clic_valide'`);
  check("et il est borné : pas de fenêtre d'un mois par faute de frappe",
    borne[0].n === 1);

  /* === 6. La clé est déterministe ==================================== */
  console.log("\nLa clé décrit le geste et son rang, jamais l'instant");

  const cle = async (montant, rang) => (await client.query(
    `select cle_encaissement($1, $2, 'especes', null, $3) as k`,
    [F, montant, rang])).rows[0].k;

  const k1 = await cle(7000, 0);
  await new Promise((r) => setTimeout(r, 1100));
  const k2 = await cle(7000, 0);
  check("le même geste, au même rang, donne la même clé une seconde plus tard",
    k1 === k2,
    `${k1}\n        ${k2} — l'ancienne portait Date.now() et était neuve à `
      + `chaque milliseconde ; une deuxième version portait un créneau de `
      + `temps, et refusait un versement légitime tombé dans la même case`);
  check("un montant différent donne une clé différente", k1 !== await cle(7001, 0));
  check("et un RANG différent aussi — c'est ce qui laisse passer un vrai second versement",
    k1 !== await cle(7000, 1));

  /* Le rang se calcule sur ce qui a DÉJÀ été accepté : deux clics simultanés
   * le trouvent identique, et c'est ce qui les rend détectables. */
  const { rows: rg } = await client.query(
    `select rang_encaissement($1, 5000, 'virement', $2) as r`,
    [F, (await client.query(`select id from staff where user_id =
        (select id from users where phone = '70000004')`)).rows[0]?.id ?? null]);
  check("le rang compte les versements identiques déjà acceptés",
    Number(rg[0].r) >= 2,
    `${rg[0].r} — deux versements de 5 000 F par virement ont été acceptés `
      + `plus haut`);

  const { rows: cles } = await client.query(
    `select count(*)::int as n, count(distinct idempotency_key)::int as distinctes
       from payments where invoice_id = $1`, [F]);
  check("aucune clé n'est réutilisée par accident",
    cles[0].n === cles[0].distinctes,
    `${cles[0].n} paiements, ${cles[0].distinctes} clés`);

  /* === 7. La contrainte de la base est bien la dernière ligne ======== */
  console.log("\nEt la base refuse le doublon même sans l'application");

  const { rows: un } = await client.query(
    `select id, idempotency_key from payments where invoice_id = $1 limit 1`, [F]);
  let refuse = false;
  try {
    await client.query(
      `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                             idempotency_key)
       values (current_school_id(), $1, 1000, 'especes', 'confirme', $2)`,
      [F, un[0].idempotency_key]);
  } catch (e) { refuse = /unique|duplicate/i.test(String(e.message)); }
  check("la contrainte d'unicité refuse une clé déjà employée", refuse,
    "elle était là depuis le premier schéma, et n'avait jamais servi");
} catch (e) {
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
  await rendre();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Un billet remis au guichet ne produit plus qu'un reçu, même "
  + "cliqué deux fois.");
