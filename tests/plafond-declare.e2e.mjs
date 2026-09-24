/**
 * « Plafond déclaré » : le mot était du produit, la déclaration n'existait pas.
 *
 * CE QUI A ÉTÉ TROUVÉ, EN TROIS TEMPS.
 *
 * 1. L'ÉCRAN NOMMAIT LA SANCTION, ET LE BOUTON PASSAIT QUAND MÊME. L'écran des
 *    frais imprimait en rouge : « Dépassement du plafond déclaré … Facturer
 *    ainsi expose l'établissement à une sanction. » Éprouvé : on appuyait sur
 *    « Émettre les factures », deux centimètres plus bas, et le produit
 *    répondait « 12 factures émises. » Rien d'autre. Douze factures à
 *    118 000 F contre un plafond de 1 000 F.
 *
 *    C'est la première règle du dépôt, prise en défaut sur le chemin de
 *    l'argent : un affichage n'est jamais la protection.
 *
 * 2. LE CHIFFRE QUI DÉCIDE DE LA SANCTION BOUGEAIT SANS NOM, SANS DATE, SANS
 *    RAISON. Éprouvé : un POST, et le plafond passait de 1 000 à 9 999 999 ;
 *    le journal gardait `{"criteres": 0}`. Or le chemin le plus court, quand
 *    la grille dépasse, n'est pas de baisser la grille.
 *
 * 3. ET RIEN N'AVAIT JAMAIS ÉTÉ DÉCLARÉ. `category_assessments.status` était
 *    écrit une fois à la création, à « brouillon », et plus jamais ;
 *    `declared_on` n'était écrit nulle part. Les deux écrans disaient pourtant
 *    « déclaré ». Le mot était une affirmation du produit sur un fait qu'il ne
 *    connaissait pas.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. tant que rien n'est déclaré, aucun écran n'écrit « déclaré » ;
 *   2. le geste de déclaration existe, refuse sans catégorie ni plafond, et
 *      écrit qui et quand ;
 *   3. la base refuse un statut « declare » sans sa trace ;
 *   4. le plafond ne bouge pas sans laisser une ligne ; après déclaration il
 *      exige un motif ;
 *   5. une grille au-dessus du plafond fait REFUSER l'émission des factures —
 *      et le refus est forçable, explicitement, avec sa trace ;
 *   6. un POST partiel n'efface plus la catégorie ni le plafond ;
 *   7. le tableau de bord nomme les deux situations.
 *
 *   node tests/plafond-declare.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4293;
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
  `select school_id from auth_lookup_user('70000005')`);
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE : l'état du dossier et celui des factures. Rendu dans le
 * `finally`, quoi qu'il arrive — y compris à une valeur CONNUE pour le
 * dossier, parce qu'une photo prise au début recopierait la fuite du tour
 * précédent. */
const { rows: DOSSIER } = await client.query(
  `select id, status, category, declared_ceiling_fcfa,
          declared_on::text as declared_on, declared_by
     from category_assessments`);
const { rows: FACTURES } = await client.query(
  `select id, status, total_fcfa, reference from invoices order by reference`);

/* La démonstration sème une catégorie 2 et AUCUN plafond : c'est cet état-là
 * qu'on exige au départ, et c'est celui qu'on rend. */
const sale = DOSSIER.filter((d) => d.status !== "brouillon"
  || d.declared_ceiling_fcfa !== null);
if (sale.length > 0) {
  console.error(
    `Le dossier de catégorisation de la démonstration n'est pas vierge : `
    + `${JSON.stringify(sale[0])}.\nCette suite le déclare et fait bouger son `
    + `plafond ; elle ne peut pas distinguer son propre reste du jeu semé. `
    + `Relancez « npm run demo ».`);
  await client.end();
  process.exit(1);
}

const rendre = async () => {
  /* L'ordre compte : la contrainte lie le statut à sa trace, donc on remet
   * les quatre colonnes ensemble, et on repasse par « brouillon ». */
  for (const d of DOSSIER) {
    await client.query(
      `update category_assessments
          set status = $2, category = $3, declared_ceiling_fcfa = $4,
              declared_on = $5::date, declared_by = $6
        where id = $1`,
      [d.id, d.status, d.category, d.declared_ceiling_fcfa,
       d.declared_on, d.declared_by]);
  }
  await client.query(`delete from category_ceiling_changes`);
  for (const f of FACTURES) {
    await client.query(
      `update invoices set status = $2, total_fcfa = $3, annulee_le = null,
                           annulee_par = null, motif_annulation = null
        where id = $1`, [f.id, f.status, f.total_fcfa]);
  }
  await client.query(
    `delete from invoice_instalments where invoice_id in
       (select id from invoices where reference <> all($1::text[]))`,
    [FACTURES.map((f) => f.reference)]);
  await client.query(
    `delete from invoices where reference <> all($1::text[])`,
    [FACTURES.map((f) => f.reference)]);
  await client.query(
    `delete from audit_log where action like 'categorisation%'
        or action = 'invoices.issue'`);
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
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

try {
  const cookie = await login("70000005");            // le directeur
  const page = async (chemin) =>
    texte(await (await fetch(`${BASE}${chemin}`, { headers: { cookie } })).text());
  const poste = async (chemin, champs) => texte(await (await fetch(
    `${BASE}${chemin}`, { method: "POST", headers: { cookie,
      "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(champs).toString() })).text());

  const classe = (await client.query(`select id, label from classes limit 1`)).rows[0];
  const dossierId = DOSSIER[0].id;

  /* === 1. Sans déclaration, personne n'écrit « déclaré » ================ */
  console.log("\nTant que rien n'est déclaré, aucun écran n'écrit « déclaré »");

  await poste("/categorisation", { categorie: "2", plafond: "200000" });
  const etat = (await client.query(
    `select montant, statut, declare_le from plafond_du_dossier()`)).rows[0];
  check("le plafond est enregistré", Number(etat.montant) === 200000,
    JSON.stringify(etat));
  check("mais le dossier reste un brouillon",
    etat.statut === "brouillon" && etat.declare_le === null,
    JSON.stringify(etat));

  const frais1 = await page("/frais");
  check("l'écran des frais dit « renseigné », pas « déclaré »",
    /Plafond renseigné/.test(frais1) && !/Plafond déclaré/.test(frais1),
    frais1.slice(frais1.indexOf("Plafond"), frais1.indexOf("Plafond") + 200));
  check("et il dit pourquoi il ne peut pas l'écrire",
    /il ne peut pas dire qu'il a été déclaré, parce que rien ne le lui a dit/.test(frais1),
    frais1.slice(frais1.indexOf("renseigné"), frais1.indexOf("renseigné") + 300));

  const cat1 = await page("/categorisation");
  check("le dossier l'annonce aussi, et propose le geste",
    /Ce dossier n'a pas été déclaré/.test(cat1)
      && /Déclarer le dossier/.test(cat1),
    cat1.slice(cat1.indexOf("pas été déclaré") - 40, cat1.indexOf("pas été déclaré") + 200));

  /* === 2. La base refuse un « declare » sans sa trace =================== */
  console.log("\nOn n'atteint pas « declare » en changeant un mot");

  let refus = null;
  try {
    await client.query(
      `update category_assessments set status = 'declare' where id = $1`, [dossierId]);
  } catch (e) { refus = String(e.message); }
  check("`update ... set status = 'declare'` est refusé par la base",
    refus !== null && /category_assessments_declaration_tracee/.test(refus),
    `${refus ?? "accepté !"}`);

  let refus2 = null;
  try {
    await client.query(
      `update category_assessments set status = 'declare', declared_on = current_date
        where id = $1`, [dossierId]);
  } catch (e) { refus2 = String(e.message); }
  check("une déclaration sans auteur l'est aussi", refus2 !== null,
    "un plafond opposable à une famille porte un nom");

  /* === 3. Le geste existe, et refuse ce qui manque ====================== */
  console.log("\nLe geste de déclaration existe, et il dit ce qui manque");

  await client.query(
    `update category_assessments set category = null where id = $1`, [dossierId]);
  const sansCat = await poste("/categorisation/declarer", {});
  check("sans catégorie, la déclaration est refusée et le dit",
    /Renseignez la catégorie/.test(sansCat),
    sansCat.slice(0, 220));
  const pasDeclare = (await client.query(
    `select statut from plafond_du_dossier()`)).rows[0];
  check("et rien n'est écrit", pasDeclare.statut === "brouillon");

  await poste("/categorisation", { categorie: "2", plafond: "200000" });
  const fait = await poste("/categorisation/declarer", {});
  const apres = (await client.query(
    `select statut, declare_le, declare_par, montant, categorie
       from plafond_du_dossier()`)).rows[0];
  check("le dossier est déclaré", apres.statut === "declare",
    JSON.stringify(apres));
  check("avec sa date", apres.declare_le !== null);
  check("et son auteur", apres.declare_par !== null, `${apres.declare_par}`);
  check("l'écran le confirme en citant la catégorie et le plafond",
    fait.includes("Dossier déclaré") && fait.includes("200 000"),
    fait.slice(0, 260));
  const jrn = (await client.query(
    `select detail from audit_log where action = 'categorisation.declare'
      order by occurred_at desc limit 1`)).rows[0];
  check("le journal garde la catégorie et le plafond déclarés",
    jrn && Number(jrn.detail.plafond) === 200000 && Number(jrn.detail.categorie) === 2,
    JSON.stringify(jrn?.detail));

  const frais2 = await page("/frais");
  check("MAINTENANT l'écran des frais peut écrire « déclaré »",
    /Plafond déclaré/.test(frais2) && /déclaré le /.test(frais2),
    frais2.slice(frais2.indexOf("Plafond"), frais2.indexOf("Plafond") + 220));

  /* === 4. Le plafond ne bouge plus sans trace =========================== */
  console.log("\nLe chiffre qui décide de la sanction ne bouge plus en silence");

  const sansMotif = await poste("/categorisation",
    { categorie: "2", plafond: "9999999" });
  check("après déclaration, changer le plafond sans motif est refusé",
    /Dites pourquoi le plafond ou la catégorie change/.test(sansMotif),
    sansMotif.slice(0, 240));
  const inchange = (await client.query(
    `select montant from plafond_du_dossier()`)).rows[0];
  check("et rien n'a bougé", Number(inchange.montant) === 200000,
    `${inchange.montant}`);

  const avecMotif = await poste("/categorisation",
    { categorie: "2", plafond: "250000",
      motif_plafond: "Nouvelle notification du ministère du 12 octobre" });
  check("avec un motif, le changement passe et l'écran le dit",
    /200 000 F → 250 000 F/.test(avecMotif),
    avecMotif.slice(avecMotif.indexOf("Plafond :"), avecMotif.indexOf("Plafond :") + 120));

  const mvts = (await client.query(
    `select cc.ancien_fcfa, cc.nouveau_fcfa, cc.motif, cc.apres_declaration,
            (select u.full_name from staff sa
               left join users u on u.id = sa.user_id
              where sa.id = cc.par) as par
       from category_ceiling_changes cc
      order by cc.quand`)).rows;
  check("chaque mouvement du plafond a laissé sa ligne",
    mvts.length >= 2, `${mvts.length} mouvement(s)`);
  const dernier = mvts[mvts.length - 1];
  check("le dernier porte l'ancien, le nouveau et le motif",
    Number(dernier.ancien_fcfa) === 200000
      && Number(dernier.nouveau_fcfa) === 250000
      && /notification du ministère/.test(dernier.motif ?? ""),
    JSON.stringify(dernier));
  check("et il est marqué comme postérieur à la déclaration",
    dernier.apres_declaration === true);
  check("il porte aussi le nom de qui l'a fait",
    dernier.par !== null, `${dernier.par}`);

  const histoire = await page("/categorisation");
  check("l'histoire du plafond est à l'écran, motif compris",
    /L'histoire de ce plafond/.test(histoire)
      && histoire.includes("notification du ministère"),
    histoire.slice(histoire.indexOf("histoire de ce plafond"),
      histoire.indexOf("histoire de ce plafond") + 200));

  /* === 5. Une grille au-dessus du plafond fait refuser l'émission ======= */
  console.log("\nL'écran nommait la sanction ; le bouton passait quand même");

  /* On descend le plafond sous la grille : 78 000 F de lignes plafonnées. */
  await poste("/categorisation", { categorie: "3", plafond: "50000",
    motif_plafond: "Épreuve : plafond abaissé sous la grille" });
  const hors = (await client.query(
    `select libelle, plafonne, plafond, ecart from grilles_hors_plafond()`)).rows;
  check("la base sait nommer la grille qui dépasse",
    hors.length === 1 && Number(hors[0].ecart) === 28000,
    JSON.stringify(hors));

  await client.query(
    `update invoices set status = 'annulee', annulee_le = now(),
        annulee_par = null, motif_annulation = 'epreuve du plafond'
      where status <> 'annulee'`);
  const refuse = await poste("/frais/emettre", { classe: classe.id });
  check("l'émission est REFUSÉE, et le refus nomme l'écart",
    /dépasse le plafond déclaré/.test(refuse) && /28 000 de trop/.test(refuse),
    refuse.slice(refuse.indexOf("dépasse le plafond"), refuse.indexOf("dépasse le plafond") + 260));
  check("et il dit qu'aucune facture n'a été émise",
    /Aucune facture n'a été émise/.test(refuse));
  const aucune = (await client.query(
    `select count(*)::int as n from invoices where status <> 'annulee'`)).rows[0];
  check("aucune facture n'a effectivement été émise", aucune.n === 0, `${aucune.n}`);

  check("le bouton qui passe outre n'apparaît qu'après le refus",
    /Émettre malgré le dépassement/.test(refuse)
      && !/Émettre malgré le dépassement/.test(frais2),
    "un mur sans porte est un défaut ; une porte toujours ouverte n'est pas un mur");

  const force = await poste("/frais/emettre", { classe: classe.id, forcer: "1" });
  check("forcé, il émet — et le dit",
    /factures émises/.test(force) && /plafond a été dépassé sciemment/.test(force),
    force.slice(force.indexOf("factures émises") - 30, force.indexOf("factures émises") + 200));
  const jrn2 = (await client.query(
    `select detail from audit_log where action = 'invoices.issue'
      order by occurred_at desc limit 1`)).rows[0];
  check("le journal garde le dépassement forcé",
    jrn2 && jrn2.detail.force && Number(jrn2.detail.force.ecart) === 28000,
    JSON.stringify(jrn2?.detail));

  /* === 6. Un POST partiel n'efface plus les deux chiffres =============== */
  console.log("\nUn champ absent veut dire « non soumis », pas « efface »");

  await poste("/categorisation", { p_inexistant: "1" });
  const survit = (await client.query(
    `select montant, categorie from plafond_du_dossier()`)).rows[0];
  check("un POST qui ne porte ni catégorie ni plafond ne les efface pas",
    Number(survit.montant) === 50000 && Number(survit.categorie) === 3,
    JSON.stringify(survit)
      + " — la règle était posée pour les points des critères et pas pour les"
      + " deux chiffres qui décident du plafond légal");

  /* === 7. Le tableau de bord nomme les deux situations ================== */
  console.log("\nLe tableau de bord nomme les deux situations");

  const bord = await page("/");
  check("il nomme la grille au-dessus du plafond",
    /dépasse le plafond du dossier de catégorisation/.test(bord),
    bord.slice(bord.indexOf("dépasse le plafond"), bord.indexOf("dépasse le plafond") + 200));
  check("en disant que l'émission est refusée",
    /l'émission des factures de ces niveaux est refusée/.test(bord));

  await client.query(
    `update category_assessments set status = 'brouillon', declared_on = null,
        declared_by = null where id = $1`, [dossierId]);
  const bord2 = await page("/");
  check("et il rappelle un plafond renseigné mais jamais déclaré",
    /renseigné mais le dossier n'a pas été déclaré/.test(bord2),
    bord2.slice(bord2.indexOf("renseigné mais"), bord2.indexOf("renseigné mais") + 200));
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
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 1500));
  process.exit(1);
}
console.log("Le mot « déclaré » n'est plus écrit sans déclaration, et la phrase "
  + "qui nomme la sanction arrête maintenant le bouton.");
