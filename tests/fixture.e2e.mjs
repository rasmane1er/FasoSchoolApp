/**
 * Le jeu de démonstration est-il toujours entier ?
 *
 * POURQUOI CETTE SUITE EXISTE. Deux suites mangeaient la démonstration, à
 * chaque `check:all`, sans que rien ne le dise :
 *
 *   * `calendrier.e2e.mjs` purgeait « toute séance d'appel hors de l'année
 *     scolaire OU tombant dans cette liste de dates » — dont le 5 et le
 *     10 octobre 2026. Or la démonstration sème l'assiduité tous les cinq
 *     jours À PARTIR DU 5 OCTOBRE. Deux séances et vingt-quatre présences
 *     partaient à chaque exécution ;
 *   * `pieces.e2e.mjs` purgeait `documents where category_criterion_id is
 *     not null` — c'est-à-dire aussi les deux pièces de la démonstration, la
 *     photo du bâtiment et les résultats au BEPC.
 *
 * Aucune assertion ne tombait. Un bulletin se calcule aussi bien sur dix
 * séances que sur douze, et un dossier sans pièce jointe a l'air normal. On
 * ne l'apprend qu'en comptant — ou six mois plus tard, en montrant le produit
 * à une école avec une démonstration à moitié vide.
 *
 * LA RÈGLE, POSÉE UNE FOIS POUR TOUTES : une suite ne supprime QUE ce qu'elle
 * a créé, et elle le reconnaît par une marque qu'elle a posée elle-même —
 * jamais par un prédicat qui décrit une famille de lignes (« tout ce qui
 * ressemble à une pièce », « toutes les dates de cette plage »). Un prédicat
 * attrape aussi ce qui ne lui appartient pas.
 *
 * CE QUE CETTE SUITE FAIT. Elle compte. Elle passe en DERNIER dans
 * `check:all`, après tout le reste, et compare à ce que `npm run demo`
 * produit. Un écart signifie qu'une suite a emporté quelque chose : elle dit
 * quoi, et de combien.
 *
 * ELLE N'ÉCRIT RIEN. C'est la seule suite du dépôt dont c'est vrai, et c'est
 * volontaire : un témoin qui déplace ce qu'il observe ne sert à rien.
 *
 *   node tests/fixture.e2e.mjs
 */

import pg from "pg";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

/* CE QUE `npm run demo` SÈME. Chaque nombre est une intention de
 * `scripts/demo.ts`, pas une observation recopiée : si la démonstration
 * change, c'est ici qu'on le déclare, et l'écart devient visible au lieu de
 * s'installer. */
const ATTENDU = [
  ["students",            12, "un effectif de classe"],
  ["enrolments",          12, "chaque élève inscrit une fois"],
  ["classes",              1, "la 6e B"],
  ["staff",                5, "censeur, enseignante, surveillant, économe, directeur"],
  ["evaluations",         24, "deux devoirs et une composition par discipline"],
  ["grade_entries",      288, "12 élèves × 24 évaluations"],
  ["attendance_sessions", 12, "douze appels, tous les cinq jours à partir du 5 octobre"],
  ["attendance_records", 144, "12 élèves × 12 appels"],
  ["guardians",           11, "onze tuteurs — le douzième élève n'en a aucun de joignable, "
                            + "et c'est ce cas qui fait exister le suivi des injoignables"],
  ["documents",            2, "la photo du bâtiment et les résultats au BEPC, "
                            + "de vrais PDF dans la base"],
  ["invoices",            12, "une facture par élève"],
];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

try {
  const { rows: sc } = await client.query(
    `select school_id from auth_lookup_user('70000001')`);
  if (sc.length === 0) {
    console.error("Aucun compte de démonstration : lancez `npm run demo`.");
    process.exit(1);
  }
  await client.query(
    `select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);

  console.log("Le jeu de démonstration, compté après tout le reste");

  const manques = [];
  for (const [table, attendu, quoi] of ATTENDU) {
    const n = Number((await client.query(
      `select count(*)::int as n from ${table}`)).rows[0].n);
    check(`${table} = ${attendu} (${quoi})`, n === attendu,
      n < attendu
        ? `${n} — IL EN MANQUE ${attendu - n} : une suite a emporté ce qui `
          + `n'était pas à elle`
        : `${n} — il y en a ${n - attendu} de trop : une suite a laissé des `
          + `lignes derrière elle`);
    if (n !== attendu) manques.push(`${table} ${n}/${attendu}`);
  }

  /* Les deux cas nommés plus haut, vérifiés par leur contenu et pas seulement
   * par leur nombre : c'est la forme exacte que prenait l'érosion. */
  const { rows: oct } = await client.query(
    `select session_date::text as d from attendance_sessions
      where session_date in ('2026-10-05','2026-10-10') order by session_date`);
  check("les appels du 5 et du 10 octobre sont toujours là", oct.length === 2,
    `${oct.map((x) => x.d).join(", ") || "aucun"} — c'est exactement ce que la `
      + "purge de `calendrier.e2e.mjs` emportait");

  const { rows: pj } = await client.query(
    `select label, byte_size from documents where category_criterion_id is not null
      order by label`);
  check("les deux pièces jointes du dossier sont toujours là", pj.length === 2,
    `${pj.map((x) => x.label).join(", ") || "aucune"} — c'est ce que la purge `
      + "de `pieces.e2e.mjs` emportait");
  check("et elles portent encore leurs octets",
    pj.every((x) => Number(x.byte_size) > 0),
    "une pièce sans contenu est une case cochée, ce que tout ce dossier "
      + "s'emploie à ne plus être");

  /* Ce qui ne devrait jamais rester après une suite : des lignes de travail.
   * On ne les compte pas dans ATTENDU parce que zéro est la seule valeur
   * juste, et qu'une suite qui en laisse une le fait toujours par oubli. */
  /* Pas d'assertion sur `auth_sessions`, et la raison mérite d'être écrite :
   * chaque suite ferme les sessions EN DÉMARRANT, donc elles ne s'accumulent
   * pas — mais celles de la dernière suite exécutée survivent forcément, et
   * exiger zéro ici reviendrait à affirmer quelque chose sur l'ordre de
   * `check:all` plutôt que sur la fixture. Une session est un identifiant qui
   * expire, pas une donnée de démonstration. */
  for (const [table, quoi] of [
    ["sms_messages", "un SMS d'épreuve laissé en place fausse le suivi des messages"],
    ["bulletins", "un bulletin publié par une suite fait échouer la suivante"],
  ]) {
    const n = Number((await client.query(
      `select count(*)::int as n from ${table}`)).rows[0].n);
    check(`${table} = 0`, n === 0, `${n} — ${quoi}`);
  }

  if (manques.length > 0) {
    console.log(
      `\n  La démonstration a perdu : ${manques.join(", ")}.`
      + `\n  Relancez « npm run demo » sur une base neuve, puis cherchez la `
      + `suite fautive\n  en comparant les comptes avant et après chacune.`);
  }
} finally {
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le jeu de démonstration est sorti de `check:all` exactement comme "
  + "il y est entré.");
