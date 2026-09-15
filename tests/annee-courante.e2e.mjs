/**
 * « Assiduité et conduite DE L'ANNÉE ». Ce n'était l'année de personne.
 *
 * CE QUI A ÉTÉ TROUVÉ EN DONNANT UN PASSÉ À UN ÉLÈVE. On ajoute au jeu de
 * démonstration une année scolaire close — l'élève avait redoublé — avec six
 * absences et deux faits de discipline, tous vieux de deux ans. Puis on relit
 * les écrans d'aujourd'hui, sans rien toucher d'autre :
 *
 *   * LE CONSEIL DE CLASSE passait de « 0 0 0 » à « 6 dont 6 non justifiées /
 *     0 / 2 aucune suite donnée ». Au-delà de dix jours, le chiffre passe en
 *     laterite pour que le conseil le regarde ;
 *   * LA FICHE DE L'ÉLÈVE affichait « Absences relevées : 6 » pour un élève
 *     sans aucune absence cette année ;
 *   * L'ESPACE FAMILLE affichait l'enfant dans la classe de l'an dernier, sous
 *     le libellé du trimestre en cours, avec les six absences.
 *
 * POURQUOI LE FILTRE NE FILTRAIT PAS. Il était là, pourtant :
 *
 *     left join attendance_sessions ses on ses.id = ar.attendance_session_id
 *                                      and ses.class_id = e.class_id
 *
 * Dans le ON d'une jointure EXTERNE. Un tel ON ne retire aucune ligne : il met
 * `ses` à NULL quand il n'est pas satisfait, et la ligne de
 * `attendance_records` reste — puis le `count(*) filter` la compte. Le filtre
 * avait l'apparence d'un filtre et le comportement d'un commentaire.
 *
 * ET DANS LA MÊME FONCTION QUE LA FICHE : `loadFiche` choisit la classe avec
 * un soin visible — « l'inscription de l'année en cours, sinon la plus
 * récente » — puis compte les absences et lit les bulletins sans borne, trente
 * lignes plus bas. Un redoublant y voyait DEUX tuiles « 1er trimestre ».
 *
 * QUI CELA TOUCHE : le redoublant. C'est-à-dire précisément l'élève dont on
 * délibère le cas, et dans le sens qui l'accable.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. une année close n'entre plus dans l'assiduité du conseil de classe ;
 *   2. ni dans sa conduite ;
 *   3. ni dans la fiche de l'élève, ni dans ses tuiles de trimestre ;
 *   4. ni dans l'espace famille, qui montrait en outre la classe de l'an
 *      dernier comme la classe du jour ;
 *   5. le passé n'est pas jeté pour autant : la fiche le montre DATÉ, année
 *      par année ;
 *   6. un enfant sans inscription cette année est dit tel, pas effacé ;
 *   7. les fonctions elles-mêmes tiennent la borne, éprouvée des deux côtés.
 *
 *   node tests/annee-courante.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4268;
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
  `select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);

/* CE QUE CETTE SUITE CRÉE PORTE SA MARQUE, et c'est par elle qu'elle le
 * retire — jamais par un prédicat décrivant une famille de lignes. */
const MARQUE = "EPREUVE annee-courante";

const purger = async () => {
  await client.query(`delete from behavior_incidents where description like $1`,
    [MARQUE + "%"]);
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions where class_id in
          (select id from classes where label like $1))`, [MARQUE + "%"]);
  await client.query(
    `delete from attendance_sessions where class_id in
       (select id from classes where label like $1)`, [MARQUE + "%"]);
  await client.query(
    `delete from enrolments where class_id in
       (select id from classes where label like $1)`, [MARQUE + "%"]);
  await client.query(`delete from classes where label like $1`, [MARQUE + "%"]);
  await client.query(
    `delete from bulletins where term_id in
       (select t.id from terms t join academic_years ay on ay.id = t.academic_year_id
         where ay.label like $1)`, [MARQUE + "%"]);
  await client.query(
    `delete from terms where academic_year_id in
       (select id from academic_years where label like $1)`, [MARQUE + "%"]);
  await client.query(`delete from academic_years where label like $1`, [MARQUE + "%"]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

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

const connecter = async (chemin, phone) => {
  const a = await fetch(`${BASE}${chemin}`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone }).toString() });
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${BASE}${chemin === "/connexion" ? "/connexion/verifier" : "/famille/verifier"}`,
    { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};
const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/<sup>/g, "").replace(/\s+/g, " ").trim();

try {
  const cookie = await connecter("/connexion", "70000001");

  const { rows: cl } = await client.query(
    `select id, label, level_code, academic_year_id from classes
      where academic_year_id = annee_en_cours() order by label limit 1`);
  const CLASSE = cl[0];
  const { rows: el } = await client.query(
    `select st.id, st.last_name, st.first_names from enrolments e
       join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name limit 1`, [CLASSE.id]);
  const A = el[0];

  const ligneConseil = async () => {
    const t = texte(await (await fetch(`${BASE}/conseil?classe=${CLASSE.id}`,
      { headers: { cookie } })).text());
    const i = t.indexOf(A.last_name);
    return i >= 0 ? t.slice(i, i + 190) : "(élève absent de l'écran)";
  };
  const fiche = async () => texte(await (await fetch(`${BASE}/eleve?id=${A.id}`,
    { headers: { cookie } })).text());

  /* === 0. L'état de départ ============================================= */
  console.log("\nAvant toute histoire");

  const avantConseil = await ligneConseil();
  const avantFiche = await fiche();
  check("le conseil ne montre aucune absence pour cet élève",
    / 0 0 0 /.test(avantConseil), avantConseil.slice(0, 120));
  check("la fiche non plus",
    /Absences cette année 0/.test(avantFiche),
    avantFiche.slice(avantFiche.indexOf("Absences"), avantFiche.indexOf("Absences") + 60));
  check("et elle ne montre aucune année précédente",
    !/années précédentes dans cet établissement/.test(avantFiche));

  /* === 1. On lui donne un passé ======================================== */
  console.log("\nOn lui donne une année close : six absences, deux faits");

  const { rows: ay } = await client.query(
    `insert into academic_years (school_id, label, starts_on, ends_on, status)
     values (current_school_id(), $1, current_date - 700, current_date - 400, 'close')
     returning id`, [MARQUE + " annee close"]);
  const AN = ay[0].id;
  const { rows: kl } = await client.query(
    `insert into classes (school_id, academic_year_id, label, level_code)
     values (current_school_id(), $1, $2, $3) returning id`,
    [AN, MARQUE + " classe close", CLASSE.level_code]);
  const KL = kl[0].id;
  await client.query(
    `insert into enrolments (school_id, academic_year_id, class_id, student_id,
                             status, enrolled_on)
     values (current_school_id(), $1, $2, $3, 'inscrit', current_date - 700)`,
    [AN, KL, A.id]);
  for (let n = 0; n < 6; n += 1) {
    const { rows: s } = await client.query(
      `insert into attendance_sessions (school_id, class_id, session_date, session_slot)
       values (current_school_id(), $1, current_date - ($2)::int, 'matin') returning id`,
      [KL, 690 - n]);
    await client.query(
      `insert into attendance_records (school_id, attendance_session_id, student_id, status)
       values (current_school_id(), $1, $2, 'absent')`, [s[0].id, A.id]);
  }
  for (let n = 0; n < 2; n += 1) {
    await client.query(
      `insert into behavior_incidents (school_id, student_id, occurred_on, description)
       values (current_school_id(), $1, current_date - ($2)::int, $3)`,
      [A.id, 680 - n, MARQUE + " fait de l annee close"]);
  }

  const apresConseil = await ligneConseil();
  check("le conseil de classe ne compte PAS les absences d'une année close",
    apresConseil === avantConseil,
    `« ${apresConseil.slice(0, 150)} » — avant, la ligne passait de « 0 0 0 » à `
      + `« 6 dont 6 non justifiées / 0 / 2 aucune suite donnée », et le 6 `
      + `serait passé en laterite au-delà de dix jours`);
  check("ni les faits de discipline de cette année-là",
    !/aucune suite donnée/.test(apresConseil)
      && !/dont \d+ sans suite/.test(apresConseil),
    apresConseil.slice(0, 150));

  const apresFiche = await fiche();
  check("la fiche de l'élève reste à zéro pour l'année en cours",
    /Absences cette année 0/.test(apresFiche),
    apresFiche.slice(apresFiche.indexOf("Absences"), apresFiche.indexOf("Absences") + 60));

  /* === 2. Mais le passé n'est pas jeté : il est daté =================== */
  console.log("\nLe passé n'est pas jeté — il est daté");

  check("la fiche montre l'année précédente, nommée",
    /années précédentes dans cet établissement/.test(apresFiche)
      && apresFiche.includes(MARQUE + " annee close"),
    "le passé d'un élève n'est pas à jeter, il est à dater");
  check("avec sa classe, ses absences et ses faits",
    apresFiche.includes(MARQUE + " classe close")
      && /6 2/.test(apresFiche.slice(apresFiche.indexOf("années précédentes"))),
    apresFiche.slice(apresFiche.indexOf("années précédentes"),
                     apresFiche.indexOf("années précédentes") + 260));
  check("et l'écran dit ce qui se passait avant",
    /étaient auparavant AJOUTÉS/.test(apresFiche));

  /* === 3. L'espace famille ============================================= */
  console.log("\nCe que voit la famille");

  const { rows: g } = await client.query(
    `select g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and g.phone is not null and g.phone <> '' limit 1`,
    [A.id]);
  const fcookie = await connecter("/famille/connexion", g[0].phone);
  const espace = texte(await (await fetch(`${BASE}/famille`,
    { headers: { cookie: fcookie } })).text());

  check("l'enfant est montré dans la classe de CETTE année",
    espace.includes(CLASSE.label) && !espace.includes(MARQUE + " classe close"),
    `la classe affichée était celle de l'an dernier, surmontée du libellé du `
      + `trimestre en cours`);
  check("il n'y figure qu'une fois",
    (espace.match(new RegExp(A.first_names, "g")) ?? []).length
      <= (espace.match(new RegExp(CLASSE.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length + 1,
    "toutes les inscriptions étaient jointes, sans borne ni ordre");
  check("et ses absences sont celles de cette année",
    /Absences 0/.test(espace),
    espace.slice(espace.indexOf("Absences"), espace.indexOf("Absences") + 40));

  /* === 4. Un enfant sans inscription cette année ======================= */
  console.log("\nUn enfant sans inscription cette année est dit tel, pas effacé");

  /* On RETIRE l'inscription de l'année en cours, et on la remet ensuite à
   * l'identique — l'élève a déjà une inscription dans l'année close, et la
   * contrainte d'unicité (élève, année) interdit de l'y déplacer. */
  const { rows: ins } = await client.query(
    `select class_id, status, enrolled_on::text as enrolled_on
       from enrolments
      where student_id = $1 and academic_year_id = annee_en_cours()`, [A.id]);
  const ANNEE_COURANTE = (await client.query(
    `select annee_en_cours() as id`)).rows[0].id;
  await client.query(
    `delete from enrolments where student_id = $1 and academic_year_id = $2`,
    [A.id, ANNEE_COURANTE]);
  const orphelin = texte(await (await fetch(`${BASE}/famille`,
    { headers: { cookie: fcookie } })).text());
  check("l'enfant reste listé", orphelin.includes(A.first_names),
    "un parent qui ne voit plus son enfant conclut que l'école l'a perdu");
  check("et l'écran dit qu'il n'est pas inscrit cette année",
    /Pas inscrit\(e\) cette année/.test(orphelin),
    `« pas inscrit cette année » se dit ; la classe de l'an dernier est la `
      + `seule réponse pire que rien`);
  await client.query(
    `insert into enrolments (school_id, academic_year_id, class_id, student_id,
                             status, enrolled_on)
     values (current_school_id(), $1, $2, $3, $4, $5)`,
    [ANNEE_COURANTE, ins[0].class_id, A.id, ins[0].status, ins[0].enrolled_on]);

  /* === 5. Les fonctions tiennent la borne des deux côtés =============== */
  console.log("\nLes fonctions, éprouvées des deux côtés");

  const { rows: cette } = await client.query(
    `select * from assiduite_de_l_annee($1, annee_en_cours())`, [A.id]);
  const { rows: close } = await client.query(
    `select * from assiduite_de_l_annee($1, $2)`, [A.id, AN]);
  check("l'année en cours ne voit pas les absences de l'année close",
    cette[0].absences === 0, JSON.stringify(cette[0]));
  check("et l'année close les voit toutes", close[0].absences === 6,
    JSON.stringify(close[0]) + " — la borne coupe, elle n'efface pas");

  const { rows: cond } = await client.query(
    `select * from conduite_de_l_annee($1, $2)`, [A.id, AN]);
  check("la conduite se borne par `occurred_on`, jamais nul",
    cond[0].incidents === 2 && cond[0].sans_suite === 2,
    JSON.stringify(cond[0]) + " — `term_id` est souvent nul, la date ne l'est jamais");
  const { rows: condCette } = await client.query(
    `select * from conduite_de_l_annee($1, annee_en_cours())`, [A.id]);
  check("et l'année en cours n'en voit aucun", condCette[0].incidents === 0,
    JSON.stringify(condCette[0]));

  const { rows: anterieures } = await client.query(
    `select * from annees_anterieures($1, annee_en_cours())`, [A.id]);
  check("`annees_anterieures()` rend l'année close, et elle seule",
    anterieures.length === 1 && anterieures[0].absences === 6
      && anterieures[0].incidents === 2,
    JSON.stringify(anterieures));
  const { rows: vues } = await client.query(
    `select count(*)::int as n from annees_anterieures($1, $2)`, [A.id, AN]);
  check("et rien quand on la demande depuis elle-même", vues[0].n === 1,
    `${vues[0].n} — vue depuis l'année close, l'année en cours est « l'autre »`);

  const { rows: insc } = await client.query(
    `select classe from inscription_de_l_annee($1, annee_en_cours())`, [A.id]);
  check("`inscription_de_l_annee()` rend la classe de l'année demandée",
    insc.length === 1 && insc[0].classe === CLASSE.label,
    JSON.stringify(insc));
} catch (e) {
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
  await purger();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Les écrans d'aujourd'hui ne comptent plus les années d'hier, et "
  + "le passé est daté au lieu d'être additionné.");
