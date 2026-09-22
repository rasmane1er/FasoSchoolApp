/**
 * « annulee » : un état que tout le produit respectait et ne pouvait pas
 * atteindre.
 *
 * CE QUI A ÉTÉ TROUVÉ EN CHERCHANT QUI ÉCRIT CE STATUT. Onze endroits du code
 * le LISENT — `where i.status <> 'annulee'` — dans la scolarité, l'espace
 * famille, la fiche de l'élève, les relances, les bourses, le tableau de bord,
 * les frais. Aucun ne l'ÉCRIT. Le produit honorait partout une décision
 * qu'aucun geste ne permettait de prendre.
 *
 * CE QUE CELA COÛTAIT, TOUS LES ANS. Un élève inscrit en septembre qui ne
 * revient pas en octobre laissait une facture de 78 000 F que rien ne pouvait
 * retirer. Éprouvé : on le fait partir par `/transferts`, exactement comme le
 * produit le prévoit, et le « reste à recouvrer » de l'école compte toujours
 * sa facture — dans les relances, dans les chiffres du tableau de bord, et
 * dans l'espace de sa famille.
 *
 * Les seuls contournements étaient pires : mettre le total à zéro, qu'aucun
 * écran n'offre, ou enregistrer un versement fictif, qui falsifierait le
 * registre des reçus.
 *
 * ET LA RÉÉMISSION RESSUSCITAIT. `frais.ts` testait l'existence sur
 * `status <> 'annulee'`, passait outre, puis retombait par
 * `on conflict (school_id, reference) do update` sur la référence de la
 * facture annulée : la MÊME LIGNE revenait à la vie, 78 000 F devenus 999,
 * tranches effacées et refaites, annulation disparue sans trace.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. le statut ne s'atteint plus en changeant un mot — la base refuse une
 *      annulation sans trace, et exige un motif ;
 *   2. le geste existe, demande un motif, et l'écrit avec son auteur ;
 *   3. une facture annulée sort des totaux MAIS reste à l'écran, barrée, avec
 *      son motif — la cacher ferait douter des autres ;
 *   4. elle disparaît des relances et de l'espace famille ;
 *   5. on ne peut PAS annuler une facture sur laquelle de l'argent est entré :
 *      on contre-passe d'abord, un versement à la fois ;
 *   6. réémettre crée une NOUVELLE facture, avec un rang dans sa référence —
 *      l'annulée n'est pas ressuscitée ;
 *   7. le tableau de bord nomme la situation qui rend le geste nécessaire.
 *
 *   node tests/annuler-facture.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4292;
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

/* CE QU'ON EMPRUNTE : l'état des factures et des inscriptions. Rendu dans le
 * `finally`, quoi qu'il arrive. */
const { rows: FACTURES } = await client.query(
  `select id, status, total_fcfa, reference from invoices order by reference`);
const { rows: INSCRIPTIONS } = await client.query(
  `select id, status, left_on::text as left_on from enrolments
    where academic_year_id = annee_en_cours()`);

/* ON REFUSE DE PARTIR D'UN JEU DÉJÀ SALE — et c'est cette suite qui doit le
 * dire, parce que c'est elle qui fait partir un élève.
 *
 * Photographier l'état avant de travailler ne suffit pas : si un tour
 * précédent a laissé un élève « transfere_sortant », la photo l'enregistre
 * comme la normale et le `finally` le « rend » parti, pour toujours. Une fuite
 * recopiée en référence devient la nouvelle normale, et la plainte sort trois
 * suites plus loin — `app.e2e.mjs` annonçant « 11 feuilles » au lieu de 12 —
 * avec un message qui ne parle pas d'inscription. */
const sales = INSCRIPTIONS.filter((e) => e.status !== "inscrit" || e.left_on);
if (sales.length > 0) {
  console.error(
    `Le jeu de démonstration porte déjà ${sales.length} inscription(s) non `
    + `« inscrit » : ${sales.map((e) => e.status).join(", ")}.\n`
    + `Cette suite fait partir un élève ; elle ne peut pas distinguer son `
    + `propre reste du jeu semé. Relancez « npm run demo ».`);
  await client.end();
  process.exit(1);
}

const rendre = async () => {
  /* L'ordre compte : la contrainte lie le statut à sa trace, donc on remet les
   * trois colonnes ensemble. */
  for (const f of FACTURES) {
    await client.query(
      `update invoices set status = $2, total_fcfa = $3,
                           annulee_le = null, annulee_par = null,
                           motif_annulation = null
        where id = $1`, [f.id, f.status, f.total_fcfa]);
  }
  await client.query(
    `delete from invoices where reference not in (select unnest($1::text[]))`,
    [FACTURES.map((f) => f.reference)]);
  for (const e of INSCRIPTIONS) {
    await client.query(
      `update enrolments set status = $2, left_on = $3 where id = $1`,
      [e.id, e.status, e.left_on]);
  }
  /* LE VERSEMENT QUE CETTE SUITE ENREGISTRE EST À ELLE, et à elle seule :
   * `collect()` pose une clé `guichet:…`, la démo pose `demo-N`. On ne
   * supprime que ce qu'on a créé, reconnu à une marque qu'on a posée
   * soi-même — et le reçu d'abord, il pointe vers le versement. */
  await client.query(
    `delete from receipts where payment_id in
       (select id from payments where idempotency_key like 'guichet:%')`);
  await client.query(
    `delete from payments where idempotency_key like 'guichet:%'`);
  await client.query(`delete from audit_log where action = 'invoice.cancel'`);
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
  const cookie = await login("70000004");   // économe
  const page = async (chemin) =>
    texte(await (await fetch(`${BASE}${chemin}`, { headers: { cookie } })).text());
  const annuler = async (facture, motif) => {
    const r = await fetch(`${BASE}/scolarite/facture/annuler`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ facture, motif }).toString() });
    return texte(await r.text());
  };

  /* DEUX FACTURES SUR LESQUELLES RIEN N'EST ENTRÉ. La condition est celle de
   * la démonstration : c'est le versement que cette suite enregistrera
   * elle-même, et lui seul, qui devra bloquer l'annulation de B. Prendre une
   * facture déjà réglée en partie ferait passer le test pour une raison qui
   * n'est pas celle qu'il énonce. */
  const { rows: inv } = await client.query(
    `select i.id, i.reference, i.total_fcfa, i.student_id,
            st.last_name, st.matricule
       from invoices i join students st on st.id = i.student_id
      where i.status <> 'annulee' and montant_regle(i.id) = 0
      order by i.reference limit 2`);
  const A = inv[0], B = inv[1];
  if (!A || !B) {
    console.error("Il faut deux factures sans versement : lancez `npm run demo`.");
    server.kill(); process.exit(1);
  }

  /* === 1. La base refuse une annulation sans trace ===================== */
  console.log("\nOn n'annule plus en changeant un mot");

  let refusNu = null;
  try {
    await client.query(
      `update invoices set status = 'annulee' where id = $1`, [A.id]);
  } catch (e) { refusNu = String(e.message); }
  check("`update ... set status = 'annulee'` est refusé par la base",
    refusNu !== null && /invoices_annulation_tracee/.test(refusNu),
    `${refusNu ?? "accepté !"} — c'est le geste sans trace qu'on refuse`);

  let refusSansMotif = null;
  try {
    await client.query(
      `update invoices set status = 'annulee', annulee_le = now()
        where id = $1`, [A.id]);
  } catch (e) { refusSansMotif = String(e.message); }
  check("et une annulation sans motif l'est aussi",
    refusSansMotif !== null,
    "« pourquoi » est la phrase que lira l'économe de l'an prochain");

  /* === 2. Le geste existe et laisse sa trace ========================== */
  console.log("\nLe geste existe, et il écrit qui, quand, pourquoi");

  const sansRaison = await annuler(A.id, "x");
  check("un motif trop court est refusé, avec des exemples",
    /Dites pourquoi cette facture est annulée/.test(sansRaison),
    sansRaison.slice(0, 200));
  const { rows: pasTouche } = await client.query(
    `select status from invoices where id = $1`, [A.id]);
  check("et rien n'est écrit", pasTouche[0].status !== "annulee");

  const fait = await annuler(A.id, "Élève jamais arrivé à la rentrée");
  const { rows: apres } = await client.query(
    `select i.status, i.motif_annulation, i.annulee_le,
            (select u.full_name from staff sa
               left join users u on u.id = sa.user_id
              where sa.id = i.annulee_par) as par
       from invoices i where i.id = $1`, [A.id]);
  check("la facture est annulée", apres[0].status === "annulee",
    JSON.stringify(apres[0]));
  check("avec son motif", apres[0].motif_annulation === "Élève jamais arrivé à la rentrée");
  check("son auteur", apres[0].par !== null, `${apres[0].par}`);
  check("et sa date", apres[0].annulee_le !== null);
  check("l'écran le confirme en citant le motif",
    fait.includes("Élève jamais arrivé à la rentrée")
      && /reste visible, barrée/.test(fait),
    fait.slice(0, 260));

  const { rows: journal } = await client.query(
    `select detail from audit_log where action = 'invoice.cancel'
      order by occurred_at desc limit 1`);
  check("le journal garde la référence, le total et le motif",
    journal[0] && /reference|total|motif/.test(JSON.stringify(journal[0].detail)),
    JSON.stringify(journal[0]?.detail));

  /* === 3. Hors des totaux, mais pas hors de l'écran =================== */
  console.log("\nHors des totaux, mais pas hors de l'écran");

  /* Le filtre par défaut est « Impayées » : une facture annulée n'est plus
   * une impayée, et c'est tout l'intérêt du geste. Elle reste entière sous
   * « Toutes », barrée, avec son motif. */
  const impayees = await page("/scolarite");
  const sco = await page("/scolarite?filtre=tous");
  check("la facture annulée sort de la liste des impayées",
    !impayees.includes("Élève jamais arrivé à la rentrée"),
    "c'est la raison du geste : elle ne doit plus être relancée");
  check("mais elle reste visible sous « Toutes », marquée ANNULÉE",
    /ANNULÉE/.test(sco),
    "la cacher ferait douter de celles qui restent");
  check("avec son motif à l'écran",
    sco.includes("Élève jamais arrivé à la rentrée"),
    "une somme qui disparaît d'un tableau sans explication est ce qu'un "
      + "contrôleur vient chercher");

  const espace = (n) => `${n}`.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const { rows: t } = await client.query(
    `select (coalesce(sum(i.total_fcfa),0)
             - coalesce(sum(montant_regle(i.id)),0))::int as reste
       from invoices i where i.status <> 'annulee'`);
  check("et le « reste à recouvrer » est celui des factures vivantes",
    sco.includes(`Reste à recouvrer ${espace(t[0].reste)} F`),
    `attendu ${espace(t[0].reste)} F — ${
      sco.slice(sco.indexOf("Reste à recouvrer"), sco.indexOf("Reste à recouvrer") + 40)}`);
  const { rows: avec } = await client.query(
    `select (coalesce(sum(i.total_fcfa),0)
             - coalesce(sum(montant_regle(i.id)),0))::int as reste
       from invoices i`);
  check("la somme annulée n'y est plus comptée",
    avec[0].reste - t[0].reste === A.total_fcfa
      && !sco.includes(`Reste à recouvrer ${espace(avec[0].reste)} F`),
    `avec l'annulée ce serait ${espace(avec[0].reste)} F`);

  /* === 4. Ni dans les relances, ni chez la famille ==================== */
  console.log("\nNi dans les relances, ni dans l'espace de la famille");

  const { rows: relance } = await client.query(
    `select count(*)::int as n from invoices i
      where i.status <> 'annulee' and i.student_id = $1`, [A.student_id]);
  check("l'élève n'a plus de facture vivante", relance[0].n === 0,
    `${relance[0].n}`);

  const { rows: vueFamille } = await client.query(
    `select count(*)::int as n from invoices i
      where i.student_id = $1 and i.status <> 'annulee'`, [A.student_id]);
  check("l'espace famille ne la verra pas", vueFamille[0].n === 0);

  /* === 5. Pas d'annulation par le haut quand l'argent est entré ======= */
  console.log("\nUne facture sur laquelle de l'argent est entré ne s'annule pas par le haut");

  const enc = await fetch(`${BASE}/scolarite/encaisser`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ facture: B.id, montant: "5000",
                                methode: "especes" }).toString() });
  check("un versement est enregistré sur la seconde facture",
    (enc.headers.get("location") ?? "").includes("recu="),
    enc.headers.get("location") ?? `HTTP ${enc.status}`);

  const refusPaye = await annuler(B.id, "Erreur de saisie, à réémettre");
  check("l'annulation est refusée, et la raison est donnée",
    /Des versements ont été encaissés/.test(refusPaye),
    refusPaye.slice(0, 300));
  check("et elle dit le chemin propre : contre-passer d'abord",
    /Contre-passez-les d'abord/.test(refusPaye)
      && /reçu inverse/.test(refusPaye));
  const { rows: toujours } = await client.query(
    `select status from invoices where id = $1`, [B.id]);
  check("la facture reste vivante", toujours[0].status !== "annulee");

  const { rows: verdict } = await client.query(
    `select * from facture_annulable($1)`, [B.id]);
  check("la fonction dit non, avec le montant versé",
    verdict[0].possible === false && Number(verdict[0].verse) === 5000,
    JSON.stringify(verdict[0]));

  /* L'écran de l'encaissement le dit aussi, au lieu d'offrir un bouton qui
   * refuse. */
  const ecran = await page(`/scolarite/encaisser?facture=${B.id}`);
  check("l'écran n'offre pas un bouton qui refuserait",
    /ne peut pas être annulée telle quelle/.test(ecran)
      && !/Annuler la facture/.test(ecran),
    ecran.slice(ecran.indexOf("annulée"), ecran.indexOf("annulée") + 200));

  /* === 6. Réémettre crée une nouvelle facture ======================== */
  console.log("\nRéémettre crée une NOUVELLE facture, pas une résurrection");

  /* ON RÉÉMET PAR LE PRODUIT, pas par une requête de test. C'est le chemin
   * qui ressuscitait : `/frais/emettre` teste l'existence sur
   * `status <> 'annulee'`, ne voit donc pas l'annulée, et retombait sur sa
   * référence. Éprouver la fonction SQL seule laisserait passer la
   * régression — c'est le formulaire de l'économe qu'il faut appuyer. */
  const { rows: cls } = await client.query(
    `select e.class_id from enrolments e
      where e.student_id = $1 and e.academic_year_id = annee_en_cours()`,
    [A.student_id]);
  const emettre = async () => {
    const r = await fetch(`${BASE}/frais/emettre`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ classe: cls[0].class_id }).toString() });
    return texte(await r.text());
  };
  const facturesDeA = async () => (await client.query(
    `select id, status, total_fcfa, reference from invoices
      where student_id = $1 order by reference`, [A.student_id])).rows;

  const emise1 = await emettre();
  check("réémettre pour la classe émet une facture, une seule",
    /1 facture émise/.test(emise1),
    emise1.slice(emise1.indexOf("facture émise") - 60, emise1.indexOf("facture émise") + 40));
  const deux = await facturesDeA();
  check("l'élève a maintenant DEUX factures : l'annulée et la neuve",
    deux.length === 2
      && deux.filter((x) => x.status === "annulee").length === 1,
    JSON.stringify(deux.map((x) => `${x.reference} ${x.status}`)));

  /* LE SECOND TOUR EST CELUI QUI COMPTE. La facture neuve est née du produit,
   * donc sa référence est celle que le produit recalcule : c'est là que
   * l'ancien `on conflict (school_id, reference) do update` retombait sur une
   * ligne annulée et la ramenait à la vie. Un seul tour ne le verrait pas. */
  const neuve = deux.find((x) => x.status !== "annulee");
  await annuler(neuve.id, "Double émission, à refaire proprement");
  const emise2 = await emettre();
  check("on annule la neuve, et un second tour en émet une troisième",
    /1 facture émise/.test(emise2),
    emise2.slice(emise2.indexOf("facture émise") - 60, emise2.indexOf("facture émise") + 40));

  const trois = await facturesDeA();
  check("trois lignes, trois histoires — aucune n'est ressuscitée",
    trois.length === 3 && new Set(trois.map((x) => x.reference)).size === 3,
    JSON.stringify(trois.map((x) => `${x.reference} ${x.status}`)));
  check("les deux annulations tiennent encore",
    trois.filter((x) => x.status === "annulee").length === 2,
    JSON.stringify(trois.map((x) => `${x.reference} ${x.status}`)));
  check("la référence de la dernière porte son rang",
    trois.some((x) => x.status !== "annulee" && /-3$/.test(x.reference)),
    JSON.stringify(trois.map((x) => x.reference)));
  check("et la première annulée a gardé son total, sa date et son motif",
    Number(trois.find((x) => x.id === A.id)?.total_fcfa) === A.total_fcfa,
    `${trois.find((x) => x.id === A.id)?.total_fcfa} au lieu de ${A.total_fcfa}`
      + " — l'ancienne version réécrivait le total de la ligne ressuscitée");
  const { rows: intacte } = await client.query(
    `select motif_annulation, annulee_le, status from invoices where id = $1`,
    [neuve.id]);
  check("l'annulation de la deuxième n'a pas disparu sans trace",
    intacte[0]?.status === "annulee"
      && intacte[0]?.motif_annulation === "Double émission, à refaire proprement"
      && intacte[0]?.annulee_le !== null,
    JSON.stringify(intacte[0]));

  /* === 7. Le tableau de bord nomme la situation ====================== */
  console.log("\nLe tableau de bord dit quand se servir du geste");

  await client.query(
    `update enrolments set status = 'transfere_sortant', left_on = current_date
      where student_id = $1 and academic_year_id = annee_en_cours()`,
    [B.student_id]);
  const { rows: partis } = await client.query(
    `select count(*)::int as n from factures_d_eleves_partis()`);
  check("un élève parti avec une facture ouverte est repéré",
    partis[0].n >= 1, `${partis[0].n}`);

  const bord = await page("/");
  check("et le tableau de bord le dit",
    /quitté l'établissement en gardant une facture ouverte/.test(bord),
    bord.slice(0, 300));
  check("en expliquant pourquoi cela compte",
    /pèsent sur le reste à recouvrer et partent en relance/.test(bord));

  const sco2 = await page("/scolarite");
  check("et la ligne de l'élève parti le dit aussi",
    /a quitté l'établissement/.test(sco2)
      && /sa facture court toujours/.test(sco2),
    sco2.slice(sco2.indexOf("quitté"), sco2.indexOf("quitté") + 160));
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
console.log("Une facture s'annule, avec un motif et un nom — et reste lisible, "
  + "barrée, dans le tableau.");
