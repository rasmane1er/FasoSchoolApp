/**
 * Les résultats aux examens, et les chiffres du dossier de catégorisation.
 *
 * CE QUI EXISTAIT SANS SERVIR. `students.cep_result` et
 * `students.concours_6e_result` étaient dans le schéma depuis la première
 * migration, avec leurs contraintes de valeur. Aucune ligne de code ne les
 * lisait ni ne les écrivait, et aucun écran ne permettait de les renseigner.
 *
 * POURQUOI CE N'EST PAS UN DÉTAIL. « Résultats aux examens » est le critère le
 * plus lourd de la moitié qualité de l'arrêté n°2026-101, celle qui décide du
 * plafond légal des frais. C'est aussi l'argument central pour lequel un
 * établissement achète un logiciel plutôt qu'un tableur : la grille réclame
 * des chiffres qu'un système produit comme sous-produit. Un logiciel qui ne
 * sait pas dire son taux de réussite au BEPC ne soutient pas cet argument.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. « NON PRÉSENTÉ » N'EST PAS « REFUSÉ ». Le dénominateur est le nombre de
 *      présentés. Les confondre ferait baisser un chiffre qui part au
 *      ministère — on l'éprouve avec les deux calculs côte à côte ;
 *   2. on ne propose que les examens que l'établissement présente vraiment ;
 *   3. un envoi partiel n'efface pas les résultats qu'il ne mentionne pas ;
 *   4. le dossier de catégorisation affiche le chiffre ET refuse de le
 *      convertir en points, faute d'avoir la grille de l'arrêté.
 *
 *   node tests/examens.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4241;
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
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
const { rows: an } = await client.query(
  `select id, label from academic_years order by starts_on desc limit 1`);
const ANNEE = an[0];

const MARQUE = "ZZ-ÉPREUVE";
const purger = async () => {
  await client.query(
    `delete from enrolments where student_id in
       (select id from students where last_name like $1)`, [MARQUE + "%"]);
  await client.query(`delete from students where last_name like $1`, [MARQUE + "%"]);
  await client.query(`delete from classes where label = $1`, ["ZZ 3e"]);
  await client.query(`delete from audit_log where action = 'examens.saisie'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
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
const lire = async (chemin, cookie) =>
  (await fetch(BASE + chemin, { headers: { cookie } })).text();

try {
  const cookie = await login("70000005");   // directeur

  /* === 1. Un collège sans classe d'examen ne se voit rien proposer ======= */
  console.log("\nOn ne propose que les examens réellement présentés");
  const vide = await lire("/examens", cookie);
  check("sans classe d'examen, l'écran le dit",
    /Aucune classe d(?:'|&#39;)examen/.test(vide),
    "proposer une colonne CEP à un collège, c'est lui faire chercher quoi y mettre");

  /* Une troisième, avec quatre élèves : la démonstration est un collège qui
     s'arrête en sixième, et sans classe d'examen il n'y a rien à éprouver. */
  const classe = (await client.query(
    `insert into classes (school_id, academic_year_id, level_code, letter, label)
     values (current_school_id(), $1, '3E', 'Z', 'ZZ 3e') returning id`,
    [ANNEE.id])).rows[0].id;

  const eleves = [];
  for (const [i, prenom] of ["Awa", "Boureima", "Céline", "Daouda"].entries()) {
    const st = (await client.query(
      `insert into students (school_id, matricule, last_name, first_names, sex)
       values (current_school_id(), $1, $2, $3, 'M') returning id`,
      [`${MARQUE}-${i}`, `${MARQUE} ${i}`, prenom])).rows[0].id;
    await client.query(
      `insert into enrolments (school_id, student_id, academic_year_id, class_id, status)
       values (current_school_id(), $1, $2, $3, 'inscrit')`, [st, ANNEE.id, classe]);
    eleves.push(st);
  }

  const ecran = await lire("/examens", cookie);
  check("LE BEPC EST PROPOSÉ", /BEPC/.test(ecran));
  check("le CEP ne l'est pas — un collège n'a pas de CM2", !/>CEP</.test(ecran),
    "le CEP et le concours d'entrée en 6e se passent en CM2");
  check("les quatre élèves y sont",
    eleves.every((_, i) => ecran.includes(`${MARQUE} ${i}`)));

  /* === 2. « Non présenté » n'est pas « refusé » ========================== */
  console.log("\n« Non présenté » n'est pas « refusé »");
  const envoi = {};
  envoi[`r_bepc_${eleves[0]}`] = "admis";
  envoi[`r_bepc_${eleves[1]}`] = "admis";
  envoi[`r_bepc_${eleves[2]}`] = "refuse";
  envoi[`r_bepc_${eleves[3]}`] = "non_presente";
  const saisi = await poster("/examens", cookie, envoi);
  const ditSaisi = await saisi.text();
  check("les quatre résultats sont enregistrés",
    /4 résultats enregistrés/.test(ditSaisi),
    ditSaisi.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120));

  const { rows: t } = await client.query(
    `select presentes, admis, taux from taux_reussite('bepc', $1)`, [ANNEE.id]);
  check("le dénominateur est le nombre de PRÉSENTÉS", Number(t[0].presentes) === 3,
    `${t[0].presentes} présentés — le quatrième ne s'est pas présenté`);
  check("deux admis", Number(t[0].admis) === 2);
  check("LE TAUX EST 66,7 % ET NON 50 %", Number(t[0].taux) === 66.7,
    `taux = ${t[0].taux} — 50 % serait le chiffre obtenu en comptant `
      + `l'absent comme un échec, et il partirait au ministère`);
  check("l'écran affiche le même chiffre",
    /66,7\s*%/.test(await lire("/examens", cookie)));

  /* === 3. Un envoi partiel n'efface rien ================================= */
  console.log("\nUn envoi partiel n'efface pas les autres résultats");
  const partiel = {};
  partiel[`r_bepc_${eleves[0]}`] = "admis";     // le seul mentionné
  await poster("/examens", cookie, partiel);
  const { rows: apres } = await client.query(
    `select count(*)::int as n from students
      where last_name like $1 and bepc_result is not null`, [MARQUE + "%"]);
  check("LES QUATRE RÉSULTATS SONT TOUJOURS LÀ", apres[0].n === 4,
    `${apres[0].n} — un champ absent veut dire « non soumis », pas « efface »`);

  console.log("\nUne valeur inventée est refusée");
  const faux = {};
  faux[`r_bepc_${eleves[2]}`] = "mention_bien";
  const refus = await poster("/examens", cookie, faux);
  check("le refus est nommé", /n(?:'|&#39;)est pas un résultat/.test(await refus.text()));
  const { rows: intact } = await client.query(
    `select bepc_result from students where id = $1`, [eleves[2]]);
  check("et l'ancienne valeur n'a pas bougé", intact[0].bepc_result === "refuse");

  /* Et la base refuse aussi, si quelque chose passait par-dessus l'écran. */
  let baseRefuse = false;
  try {
    await client.query(
      `update students set bepc_result = 'mention_bien' where id = $1`, [eleves[2]]);
  } catch { baseRefuse = true; }
  check("la contrainte de la base refuse la même chose", baseRefuse,
    "l'écran n'est jamais la seule protection");

  /* === 4. Le dossier de catégorisation ================================== */
  console.log("\nLe dossier affiche le chiffre et refuse de le noter");
  const dossier = await lire("/categorisation", cookie);
  check("le panneau des chiffres est là",
    /Ce que le logiciel établit déjà/.test(dossier));
  check("LE TAUX DU BEPC Y FIGURE", /66,7/.test(dossier),
    "c'est le chiffre que la grille qualité réclame");
  check("les effectifs par classe aussi", /Effectif par classe/.test(dossier));
  check("IL DIT QU'IL NE LES CONVERTIT PAS EN POINTS",
    /convertit pas en points/.test(dossier),
    "la grille de l'arrêté n'a pas pu être obtenue ; l'inventer conduirait "
      + "à facturer un montant illégal");
  check("et il renvoie vers l'écran de saisie",
    /href="\/examens"/.test(dossier));

  /* === 5. Qui a le droit ================================================ */
  console.log("\nUn enseignant n'enregistre pas un résultat d'examen");
  const prof = await login("70000002");
  const refuse = await fetch(`${BASE}/examens`, { headers: { cookie: prof } });
  check("l'accès lui est refusé", refuse.status === 403,
    "le résultat vient de la liste publiée par le ministère, pas d'une "
      + "saisie d'enseignant");

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL])
    .catch(() => {});
  await purger().catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le taux de réussite est juste, et le logiciel ne le note pas.");
