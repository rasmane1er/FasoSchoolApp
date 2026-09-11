/**
 * Ce que le conseil de classe décide, et ce que le bulletin imprime.
 *
 * CE QUI ÉTAIT PERDU. L'écran du conseil fait saisir, élève par élève, une
 * DÉCISION et une APPRÉCIATION ; le censeur y passe la séance entière. Les
 * deux partaient dans `conseil_decisions` et s'y arrêtaient.
 *
 * Le bulletin, lui, imprimait un cadre « Appréciation du conseil de classe »
 * contenant DEUX LIGNES POINTILLÉES VIDES. Le logiciel recueillait donc
 * quarante appréciations, puis imprimait quarante cadres vides que quelqu'un
 * devait recopier à la main — exactement le travail que ce produit prétend
 * supprimer, sur le document par lequel il sera jugé.
 *
 * Même chose pour le professeur principal : le bulletin portait une ligne de
 * signature sans nom, et `classes.professeur_principal_id` existait depuis le
 * premier schéma sans clé étrangère et sans aucun écran pour la renseigner.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. ce que le conseil saisit arrive sur le bulletin imprimé ;
 *   2. la décision y est EN TOUTES LETTRES — `admis_par_compensation` n'a rien
 *      à faire sur un document remis à une famille ;
 *   3. un élève sans décision garde ses lignes pointillées : on n'invente rien ;
 *   4. LA PUBLICATION FIGE. Corriger l'appréciation après coup ne doit pas
 *      changer le papier déjà remis aux parents — c'est le double qui ferait
 *      foi dans un dossier de transfert ;
 *   5. le professeur principal se désigne, et son nom est figé lui aussi.
 *
 *   node tests/conseil-bulletin.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4239;
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
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);

const { rows: cl } = await client.query(
  `select id, label, academic_year_id from classes order by label limit 1`);
const CLASSE = cl[0];

/* État de départ, restitué à la fin : la démonstration doit rester la même.
   La démonstration ne publie AUCUN bulletin ; cette suite en publie douze pour
   éprouver le figeage, et doit donc les SUPPRIMER — pas seulement remettre
   leur statut. La première version se contentait de restaurer les lignes
   qu'elle connaissait, laissait les nouvelles publiées, et c'est la suite de
   l'espace famille qui échouait plus loin : une fois le bulletin publié, elle
   ne voyait plus l'avertissement sur les règles non confirmées. */
const { rows: bullDepart } = await client.query(
  `select id, status, appreciation_generale, decision_conseil, professeur_principal
     from bulletins where class_id = $1`, [CLASSE.id]);
const IDS_DEPART = bullDepart.map((b) => b.id);
const { rows: ppDepart } = await client.query(
  `select professeur_principal_id from classes where id = $1`, [CLASSE.id]);

const purger = async () => {
  await client.query(`delete from conseil_decisions where academic_year_id = $1`,
    [CLASSE.academic_year_id]);
  await client.query(`update classes set professeur_principal_id = $2 where id = $1`,
    [CLASSE.id, ppDepart[0].professeur_principal_id]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
  await client.query(`delete from audit_log where action = 'classe.professeur_principal'`);
};
await purger();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
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
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};
const poster = (chemin, cookie, corps) =>
  fetch(BASE + chemin, { method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(corps).toString() });
const imprimer = async (cookie) => (await fetch(
  `${BASE}/bulletins/imprimer?classe=${CLASSE.id}`, { headers: { cookie } })).text();

const APPRECIATION = "Élève sérieux, doit soigner la rédaction.";
const CORRIGEE = "APPRÉCIATION CORRIGÉE APRÈS COUP";

try {
  const cookie = await login("70000001");        // censeur
  const { rows: eleves } = await client.query(
    `select st.id, st.last_name, st.first_names from enrolments e
       join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name limit 2`, [CLASSE.id]);
  const [premier, second] = eleves;
  const { rows: ens } = await client.query(
    `select s.id, u.full_name from staff s join users u on u.id = s.user_id
      where s.fonction = 'enseignant' and u.is_active limit 1`);

  /* === 1. Le professeur principal ======================================== */
  console.log("\nLe professeur principal se désigne — il n'y avait aucun écran");
  const ecran = await (await fetch(`${BASE}/services`, { headers: { cookie } })).text();
  check("l'écran des services le propose", /Professeurs principaux/.test(ecran));
  check("et signale les classes sans professeur principal",
    /non désigné/.test(ecran));

  const nomme = await poster("/services/principal", cookie,
    { classe_pp: CLASSE.id, staff: ens[0].id });
  check("la désignation est acceptée", /est professeur principal/.test(await nomme.text()));

  const inconnu = await poster("/services/principal", cookie,
    { classe_pp: CLASSE.id, staff: "99999999-9999-9999-9999-999999999999" });
  check("un identifiant inconnu est refusé",
    /pas au personnel/.test(await inconnu.text()));

  /* La clé étrangère manquait : la colonne acceptait n'importe quel uuid, y
     compris celui du personnel d'un AUTRE établissement — que le RLS aurait
     ensuite rendu invisible, laissant une classe dont le professeur principal
     n'existe pas. On l'éprouve en base, sous le rôle de l'application. */
  let refusee = false;
  try {
    await client.query(
      `update classes set professeur_principal_id = '11111111-1111-1111-1111-111111111111'
        where id = $1`, [CLASSE.id]);
  } catch { refusee = true; }
  check("LA BASE REFUSE UN PROFESSEUR PRINCIPAL QUI N'EXISTE PAS", refusee,
    "la colonne portait « FK ajoutée plus bas » en commentaire depuis le "
      + "premier schéma, et elle ne l'avait jamais été");

  /* === 2. L'appréciation arrive sur le bulletin ========================== */
  console.log("\nCe que le conseil saisit arrive sur le bulletin");
  const avant = await imprimer(cookie);
  check("sans décision, le bulletin garde ses lignes à remplir à la main",
    /border-bottom:1px dotted/.test(avant),
    "on n'invente pas une appréciation que personne n'a écrite");
  check("et il n'affiche aucune décision", !/Décision du conseil/.test(avant));

  await client.query(
    `insert into conseil_decisions (school_id, student_id, academic_year_id,
                                    decision, appreciation)
     values ($1, $2, $3, 'admis_par_compensation', $4)`,
    [SCHOOL, premier.id, CLASSE.academic_year_id, APPRECIATION]);

  const apres = await imprimer(cookie);
  check("L'APPRÉCIATION EST IMPRIMÉE", apres.includes(APPRECIATION),
    "elle était saisie au conseil et le bulletin imprimait un cadre vide");
  check("LA DÉCISION AUSSI", /Décision du conseil/.test(apres));
  check("et elle est EN TOUTES LETTRES",
    /Admis\(e\) par compensation/.test(apres),
    "« admis_par_compensation » n'a rien à faire sur un document remis "
      + "à une famille");
  check("le code brut n'apparaît nulle part",
    !apres.includes("admis_par_compensation"));
  check("le professeur principal est nommé sous sa ligne de signature",
    apres.includes(ens[0].full_name));
  check("les élèves SANS décision gardent leurs lignes pointillées",
    /border-bottom:1px dotted/.test(apres),
    `${eleves.length > 1 ? second.last_name : "?"} n'a pas été délibéré`);

  /* === 3. La publication fige ============================================ */
  console.log("\nLa publication fige — un double doit être la feuille remise");
  /* La classe se passe dans l'URL, pas dans le corps : la première version de
     ce test la mettait dans le corps et la route repartait vers /bulletins
     sans rien publier — sept assertions échouaient d'un coup pour cette seule
     raison. */
  const pub = await poster(`/bulletins/publier?classe=${CLASSE.id}`, cookie, {});
  const ditPub = await pub.text();
  check("la publication aboutit", /bulletins? figés?/.test(ditPub),
    ditPub.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));

  const { rows: fige } = await client.query(
    `select appreciation_generale, decision_conseil, professeur_principal
       from bulletins where student_id = $1 and status = 'publie'`, [premier.id]);
  check("L'APPRÉCIATION EST COPIÉE DANS LE BULLETIN PUBLIÉ",
    fige[0]?.appreciation_generale === APPRECIATION,
    "sans copie, le bulletin serait une vue en direct sur une source modifiable");
  check("la décision aussi", fige[0]?.decision_conseil === "admis_par_compensation");
  check("et le NOM du professeur principal, pas son identifiant",
    fige[0]?.professeur_principal === ens[0].full_name,
    "s'il quitte l'établissement, le bulletin déjà remis doit continuer de "
      + "porter celui qui l'a signé");

  // On corrige la source APRÈS la publication.
  await client.query(
    `update conseil_decisions set appreciation = $2 where student_id = $1`,
    [premier.id, CORRIGEE]);
  await client.query(
    `update classes set professeur_principal_id = null where id = $1`, [CLASSE.id]);

  const reimprime = await imprimer(cookie);
  check("LE DOUBLE PORTE TOUJOURS LE TEXTE D'ORIGINE",
    reimprime.includes(APPRECIATION),
    "le parent détient un papier ; le double qui en diffère ferait mentir l'école");
  check("et pas la correction faite depuis", !reimprime.includes(CORRIGEE));
  check("le professeur principal figé y est encore",
    reimprime.includes(ens[0].full_name),
    "la classe n'en a plus, mais le bulletin publié garde le sien");

  console.log("\nErreurs serveur :",
    stderr.split("\n").filter((l) => /error/i.test(l)).slice(0, 2).join(" | ") || "(aucune)");
  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL])
    .catch(() => {});
  await purger().catch(() => {});
  /* Les bulletins retrouvent l'état où la démonstration les laisse : ceux que
     cette suite a créés disparaissent, les autres reprennent leurs valeurs.
     `bulletin_lines` part avec eux (cascade). */
  await client.query(
    `delete from bulletin_lines where bulletin_id in (
       select id from bulletins where class_id = $1 and not (id = any($2::uuid[])))`,
    [CLASSE.id, IDS_DEPART]).catch(() => {});
  await client.query(
    `delete from bulletins where class_id = $1 and not (id = any($2::uuid[]))`,
    [CLASSE.id, IDS_DEPART]).catch(() => {});
  for (const b of bullDepart) {
    await client.query(
      `update bulletins set status = $2, appreciation_generale = $3,
              decision_conseil = $4, professeur_principal = $5 where id = $1`,
      [b.id, b.status, b.appreciation_generale, b.decision_conseil,
       b.professeur_principal]).catch(() => {});
  }
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le bulletin porte ce que le conseil a décidé, et le double ne ment pas.");
