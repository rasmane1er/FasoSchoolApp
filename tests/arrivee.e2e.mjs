/**
 * Un élève arrivé en janvier était « en retard » depuis octobre.
 *
 * CE QUI A ÉTÉ TROUVÉ EN TIRANT LE FIL DE LA MIGRATION PRÉCÉDENTE. 0017 a donné
 * un sens au mot « en retard » : ce qui était exigible d'après l'échéancier, et
 * qui n'a pas été versé. Restait une question que personne ne posait — exigible
 * DE QUI, et depuis quand ?
 *
 * `frais.ts` émet la facture de l'année entière et pose une tranche au début de
 * chaque trimestre. Pour un élève inscrit à la rentrée, c'est juste. Pour un
 * enfant arrivé en janvier — transfert, déménagement, une famille qui a mis
 * trois mois à réunir les frais — la tranche d'octobre est exigible AVANT SON
 * ARRIVÉE. L'écran le compte « en retard », peint sa ligne en rouge, et le
 * tableau de bord réclame, pour des mois où l'enfant n'était pas là.
 *
 * ET LA DATE D'ARRIVÉE ÉTAIT FAUSSE. `enrolments.enrolled_on` existe depuis le
 * premier jour, avec `default current_date`. Aucune ligne de code ne l'écrivait
 * ni ne la lisait : c'est le jour de l'IMPORT qui s'y inscrivait. Une école qui
 * charge sa liste en novembre faisait de son effectif entier une cohorte
 * d'arrivées tardives — et depuis 0017, chacune serait annoncée en retard sur
 * les tranches d'octobre.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. un élève inscrit AVANT l'ouverture de l'année arrive AVEC l'année, et
 *      non le jour de l'import — le défaut de colonne ne décide plus ;
 *   2. `echeances_avant_arrivee` ne dit rien d'un élève présent dès la
 *      rentrée : le cas ordinaire n'appelle aucune mention ;
 *   3. pour un arrivé en cours d'année, elle compte les tranches antérieures
 *      et leur montant ;
 *   4. L'ÉCRAN DE LA SCOLARITÉ LE DIT, à côté du rouge — c'est le défaut exact ;
 *   5. LE MONTANT N'EST PAS RETIRÉ DU RETARD. Savoir si ces tranches sont dues
 *      est une règle d'établissement ; le logiciel signale et ne tranche pas ;
 *   6. la famille le lit sur son propre écran, dans ses mots ;
 *   7. un départ pose enfin une DATE, et pas seulement un statut.
 *
 *   node tests/arrivee.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4257;
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

const MARQUE = "EPREUVE ARRIVEE";

/* Ce que cette suite déplace dans le jeu de démonstration : la date d'arrivée
 * d'UN élève, et l'échéancier d'UNE facture. Les deux sont remis à la fin. */
let arriveeInitiale = null;   // { studentId, enrolledOn, leftOn, status }

const purger = async () => {
  await client.query(
    `delete from invoice_instalments where label like $1`, ["%" + MARQUE + "%"]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

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

try {
  const eco = await login("70000004");

  const { rows: an } = await client.query(
    `select id, starts_on::text as debut from academic_years
      order by (status = 'en_cours') desc, starts_on desc limit 1`);
  const ANNEE = an[0];

  /* === 1. La date d'arrivée n'est plus celle de l'import ================= */
  console.log("\nLa date d'arrivée n'est plus le jour où la ligne a été insérée");
  const { rows: toutes } = await client.query(
    `select distinct enrolled_on::text as j from enrolments
      where academic_year_id = $1`, [ANNEE.id]);
  check("le jeu de démonstration inscrit tout le monde le même jour",
    toutes.length === 1, toutes.map((x) => x.j).join(", "));
  check("ET CE JOUR N'EST PAS POSTÉRIEUR À L'OUVERTURE DE L'ANNÉE",
    toutes[0].j <= ANNEE.debut,
    `inscrits le ${toutes[0].j}, année ouverte le ${ANNEE.debut} — un import `
      + `fait en novembre inscrivait toute l'école « en novembre », et depuis `
      + `0017 chacun serait annoncé en retard sur la tranche d'octobre`);

  /* === 2. Le cas ordinaire n'appelle aucune mention ====================== */
  const { rows: factures } = await client.query(
    `select i.id, i.total_fcfa, i.student_id, st.last_name
       from invoices i join students st on st.id = i.student_id
      where i.status <> 'annulee' and montant_regle(i.id) = 0
      order by st.last_name`);
  const CIBLE = factures[0];

  /* On relève l'inscription de cet élève AVANT d'y toucher : cette suite
   * déplace sa date d'arrivée deux fois, et doit la rendre intacte. */
  const { rows: av0 } = await client.query(
    `select enrolled_on::text as j, left_on::text as sortie, status
       from enrolments where student_id = $1 and academic_year_id = $2`,
    [CIBLE.student_id, ANNEE.id]);
  arriveeInitiale = { studentId: CIBLE.student_id, enrolledOn: av0[0].j,
                      leftOn: av0[0].sortie, status: av0[0].status };

  const poser = async (invoiceId) => {
    const part = Math.floor(Number(CIBLE.total_fcfa) / 3);
    for (const [i, [montant, decalage]] of [
      [part, "-60 days"], [part, "-20 days"],
      [Number(CIBLE.total_fcfa) - 2 * part, "+90 days"]].entries()) {
      await client.query(
        `insert into invoice_instalments (school_id, invoice_id, label,
                                          amount_fcfa, due_on, sort_order)
         values ($1,$2,$3,$4, current_date + $5::interval, $6)`,
        [SCHOOL, invoiceId, `${MARQUE} Tranche ${i + 1}`, montant, decalage, i]);
    }
    return part;
  };
  const TRANCHE = await poser(CIBLE.id);

  console.log("\nUn élève présent dès la rentrée n'appelle aucune mention");
  /* On pose sa date d'arrivée AVANT la première tranche — c'est ce qu'est un
   * élève inscrit à la rentrée. Les trois tranches sont devant lui. */
  await client.query(
    `update enrolments set enrolled_on = current_date - interval '90 days'
      where student_id = $1 and academic_year_id = $2`,
    [CIBLE.student_id, ANNEE.id]);
  const { rows: rien } = await client.query(
    `select * from echeances_avant_arrivee($1)`, [CIBLE.id]);
  check("echeances_avant_arrivee() ne renvoie rien", rien.length === 0,
    "c'est le cas ordinaire : le signaler serait du bruit sur chaque ligne");

  /* === 3. L'arrivée en cours d'année ==================================== */
  console.log("\nUn élève arrivé après deux échéances");
  // Il arrive AUJOURD'HUI : les deux premières tranches sont derrière lui.
  await client.query(
    `update enrolments set enrolled_on = current_date
      where student_id = $1 and academic_year_id = $2`,
    [CIBLE.student_id, ANNEE.id]);

  const { rows: cnt } = await client.query(
    `select * from echeances_avant_arrivee($1)`, [CIBLE.id]);
  check("DEUX ÉCHÉANCES SONT ANTÉRIEURES À SON ARRIVÉE",
    cnt.length === 1 && Number(cnt[0].combien) === 2,
    JSON.stringify(cnt[0] ?? null));
  check("et leur montant est compté", Number(cnt[0]?.montant) === TRANCHE * 2,
    `${cnt[0]?.montant} au lieu de ${TRANCHE * 2}`);

  const retard = Number((await client.query(
    `select retard_de($1, current_date) as r`, [CIBLE.id])).rows[0].r);
  check("LE RETARD N'EST PAS RABOTÉ POUR AUTANT", retard === TRANCHE * 2,
    `${retard} — savoir si un arrivant de janvier doit les tranches d'octobre `
      + `est une règle d'établissement : au Burkina elle varie d'une école à `
      + `l'autre, et l'inventer ici déciderait, dans un logiciel, ce qu'une `
      + `famille doit`);

  /* === 4. L'écran de la scolarité ====================================== */
  console.log("\nSur l'écran de la scolarité");
  const sco = await (await fetch(`${BASE}/scolarite?filtre=tous`,
    { headers: { cookie: eco } })).text();
  const ligne = ligneDe(sco, CIBLE.last_name);

  check("la ligne est bien en retard", /exigible, non versé/.test(ligne),
    ligne.slice(0, 160));
  check("MAIS ELLE DIT QU'IL EST ARRIVÉ EN COURS D'ANNÉE",
    /arrivé le/.test(ligne),
    "avant, le rouge parlait seul : " + ligne.slice(0, 200));
  check("et combien d'échéances sont antérieures à son arrivée",
    /2 échéances sont antérieures/.test(ligne), ligne.slice(0, 220));

  check("une note explique que le logiciel ne tranche pas",
    /ne décide pas si ces tranches sont dues/.test(sco),
    nu(sco).slice(0, 200));
  check("et qu'il s'agit d'une règle à confirmer",
    /Règle à confirmer/.test(sco));

  /* === 5. Ce que lit la famille ======================================== */
  console.log("\nCe que lit la famille");
  const { rows: tut } = await client.query(
    `select g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and sg.receives_sms
        and coalesce(g.phone,'') <> '' limit 1`, [CIBLE.student_id]);
  if (tut.length > 0) {
    const a = await fetch(`${BASE}/famille/connexion`, { method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone: tut[0].phone }).toString() });
    const tt = await a.text();
    const codeF = ((tt.match(/id="code-demo"[^>]*>(\d{6})</) ?? [])[1])
      ?? ((tt.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1]);
    const vf = await fetch(`${BASE}/famille/verifier`, { method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone: tut[0].phone, code: codeF }).toString() });
    const cookieF = (vf.headers.get("set-cookie") ?? "").split(";")[0];
    const espace = await (await fetch(`${BASE}/famille`,
      { headers: { cookie: cookieF } })).text();

    check("LA FAMILLE LIT POURQUOI ON LUI RÉCLAME CES MOIS-LÀ",
      /est inscrit\s+depuis le/.test(nu(espace)),
      nu(espace).slice(0, 260));
    check("et qu'elle peut le demander à l'établissement",
      /demandez-le-lui/.test(espace));
  } else {
    check("un tuteur joignable pour éprouver l'écran famille", false,
      "aucun tuteur avec numéro sur cet élève");
  }

  /* === 6. Un départ pose une date ====================================== */
  console.log("\nUn départ pose enfin une date");
  const dir = await login("70000005");
  const dep = await fetch(`${BASE}/transferts`, { method: "POST",
    headers: { cookie: dir, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ sens: "sortant", eleve: CIBLE.student_id,
      etablissement: `${MARQUE} École d'accueil`,
      motif: "déménagement de la famille" }).toString() });
  const ditDep = nu(await dep.text());
  const { rows: apresDep } = await client.query(
    `select status, left_on::text as sortie from enrolments
      where student_id = $1 and academic_year_id = $2`,
    [CIBLE.student_id, ANNEE.id]);
  if (/transfert|enregistr/i.test(ditDep)) {
    check("le départ est enregistré", apresDep[0].status === "transfere_sortant",
      apresDep[0].status);
    check("ET IL PORTE UNE DATE", apresDep[0].sortie !== null,
      "un départ ne posait qu'un statut : on ne pouvait pas dire depuis quand "
        + "la place était libre");
  } else {
    console.log(`     (le transfert n'a pas été accepté : ${ditDep.slice(0, 120)})`);
    check("le départ est enregistré", false, ditDep.slice(0, 160));
  }

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
  if (arriveeInitiale) {
    await c2.query(
      `update enrolments set enrolled_on = $2::date, left_on = $3::date,
                            status = $4
        where student_id = $1`,
      [arriveeInitiale.studentId, arriveeInitiale.enrolledOn,
       arriveeInitiale.leftOn, arriveeInitiale.status]);
  }
  await c2.query(
    `delete from invoice_instalments where label like $1`, ["%" + MARQUE + "%"]);
  await c2.query(
    `delete from student_transfers where school_name like $1`, ["%" + MARQUE + "%"])
    .catch(() => {});
  await c2.query(`delete from audit_log where action like 'transfert.%'`);
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
console.log("Un enfant arrivé en janvier n'est plus réputé en retard depuis "
  + "octobre sans que personne ne le dise.");
