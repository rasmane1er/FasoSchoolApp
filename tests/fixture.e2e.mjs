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
  ["invoice_instalments", 36, "trois tranches par facture, aux débuts de "
                            + "trimestre — sans elles, l'écran de la scolarité "
                            + "annonce « 12 factures n'ont pas d'échéancier »"],
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
   * par leur nombre : c'est la forme exacte que prenait l'érosion.
   *
   * Les DEUX PREMIERS appels de la démonstration sont ceux que la purge de
   * `calendrier.e2e.mjs` emportait. On les désigne par leur rang et non par
   * leur date : l'année de démonstration se place désormais par rapport à
   * aujourd'hui, et une date écrite ici retomberait dans le défaut même que ce
   * témoin surveille. */
  const { rows: oct } = await client.query(
    `select s.session_date::text as d, ay.starts_on::text as debut
       from attendance_sessions s, academic_years ay
      order by s.session_date limit 2`);
  check("les deux premiers appels de la démonstration sont toujours là",
    oct.length === 2 && oct[0].d > oct[0].debut,
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

  /* ---------------------------------------------------------------------
   * LA DÉMONSTRATION DÉMONTRE-T-ELLE ENCORE ?
   *
   * Compter les lignes ne suffit pas. Deux fonctionnalités ont été construites
   * et la démonstration ne les montrait pas — non parce qu'il lui manquait des
   * lignes, mais parce que les siennes étaient dans le mauvais état :
   *
   *   * ses factures n'avaient pas d'échéancier, alors l'écran de la scolarité
   *     affichait « 12 factures n'ont pas d'échéancier » et l'espace famille
   *     retombait sur « vous devez 78 000 F » ;
   *   * ses reçus ne portaient pas l'état figé de la facture, alors chacun
   *     s'imprimait « Solde non restituable » — la branche dégradée, sur le
   *     document le plus soigné du produit.
   *
   * Un témoin qui ne compte que des lignes ne voit pas cela. Celui-ci vérifie
   * donc aussi que la démonstration EXERCE ce qu'elle est censée montrer. */
  console.log("\nEt démontre-t-elle encore ?");

  const { rows: figes } = await client.query(
    `select count(*) filter (where total_du_fcfa is not null)::int as figes,
            count(*)::int as total from receipts`);
  check("chaque reçu porte l'état figé de sa facture",
    figes[0].total > 0 && figes[0].figes === figes[0].total,
    `${figes[0].figes}/${figes[0].total} — sans ces nombres, la démonstration `
      + `imprime « Solde non restituable » sur tous ses reçus`);

  const { rows: ech } = await client.query(
    `select count(*) filter (where n = 3)::int as ok, count(*)::int as total
       from (select invoice_id, count(*)::int as n
               from invoice_instalments group by invoice_id) x`);
  check("chaque facture porte ses trois tranches",
    ech[0].total > 0 && ech[0].ok === ech[0].total,
    `${ech[0].ok}/${ech[0].total}`);

  const { rows: an } = await client.query(
    `select starts_on::text as debut, ends_on::text as fin,
            (select min(enrolled_on)::text from enrolments) as premiere_arrivee
       from academic_years order by (status = 'en_cours') desc, starts_on desc
      limit 1`);
  check("aucun élève n'arrive après l'ouverture de l'année",
    an[0].premiere_arrivee <= an[0].debut,
    `premier inscrit le ${an[0].premiere_arrivee}, année ouverte le `
      + `${an[0].debut} — une démonstration semée en novembre inscrivait `
      + `toute l'école « en novembre », et l'écran annonçait douze arrivées `
      + `tardives`);

  /* LA DÉMONSTRATION EST-ELLE ENCORE DANS UN TRIMESTRE ?
   *
   * Elle était ancrée au 75ᵉ jour d'un premier trimestre qui en comptait 80 :
   * cinq jours de validité. Semée un lundi, montrée le lundi suivant, elle
   * tombait hors trimestre — et le produit, qui refuse désormais de deviner
   * (voir 0025), commençait par demander lequel. Une démonstration qui
   * s'ouvre sur une question ne démontre rien. */
  const { rows: sit } = await client.query(
    `select s.etat,
            (select t.ends_on - current_date from terms t where t.id = s.term_id)
              as jours_restants
       from situation_de_l_annee() s`);
  check("aujourd'hui tombe dans un trimestre de la démonstration",
    sit[0].etat === "en_trimestre",
    `« ${sit[0].etat} » — relancez « npm run demo » : le jeu a glissé hors de `
      + `son propre trimestre, et la saisie des notes commence par une question`);
  check("et il reste de la marge avant la fin de ce trimestre",
    Number(sit[0].jours_restants ?? 0) >= 14,
    `${sit[0].jours_restants} jours — une démonstration se sème une fois et se `
      + `montre des semaines plus tard ; sous quinze jours de marge, elle est `
      + `déjà en sursis`);

  const { rows: fetes } = await client.query(
    `select annee_sans_fetes_legales(ay.id) as vide
       from academic_years ay
      order by (ay.status = 'en_cours') desc, ay.starts_on desc limit 1`);
  check("l'année de démonstration porte ses fêtes nationales",
    fetes[0].vide === false,
    "sans elles, l'appel du matin s'ouvre le 25 décembre");

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
