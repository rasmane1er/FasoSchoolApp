/**
 * Un chiffre affiché porte toujours sa période. Cette suite le vérifie dans le
 * code source, parce que deux fois ne suffisaient pas.
 *
 * POURQUOI ELLE EXISTE. Le même défaut a été trouvé deux fois, dans deux
 * modules, à deux jours d'intervalle :
 *
 *   * `conseil.ts` comptait les absences et les faits de discipline de TOUTES
 *     les années sur l'écran qui décide de l'année d'un élève ;
 *   * `discipline.ts` intitulait sa carte « signalé plusieurs fois CETTE
 *     ANNÉE » et imprimait « dernier le 16/10/2024 » sur la même ligne.
 *
 * Et dans les deux cas la borne d'année ÉTAIT ÉCRITE — dans le ON d'une
 * jointure EXTERNE :
 *
 *     left join enrolments e on e.student_id = st.id
 *                           and e.academic_year_id = $1
 *
 * Un tel ON ne retire aucune ligne. Il met la table jointe à NULL quand il
 * n'est pas satisfait, et la ligne de gauche reste — puis le `count(*) filter`
 * la compte. Le filtre a l'apparence d'un filtre et le comportement d'un
 * commentaire, et c'est pourquoi il survit à une relecture attentive : l'œil
 * voit `academic_year_id = $1` et passe.
 *
 * Un défaut qu'on corrige deux fois reviendra une troisième. Cette suite ne
 * lit pas la base : elle lit LE CODE, et refuse les deux formes.
 *
 * ELLE N'ÉCRIT RIEN et ne démarre aucun serveur. Comme `fixture.e2e.mjs`, elle
 * est un témoin.
 *
 * COMMENT LEVER UN SIGNALEMENT LÉGITIME. Une requête qui doit VRAIMENT porter
 * sur toutes les années — l'historique d'un élève, un livret cumulatif — le
 * déclare dans le SQL lui-même :
 *
 *     -- borne: volontairement toutes les années, <pourquoi>
 *
 * La phrase est obligatoire. Un `-- borne:` sans raison ne lève rien : le but
 * n'est pas d'avoir un moyen de se taire, c'est d'obliger à écrire pourquoi.
 *
 *   node tests/bornes.e2e.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const sources = [];
const parcourir = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) parcourir(p);
    else if (e.name.endsWith(".ts")) sources.push(p);
  }
};
parcourir("src");
sources.sort();

/* Le texte de chaque littéral de gabarit, avec le fichier et la ligne où il
 * commence. On ne cherche pas à analyser le SQL : on cherche deux formes
 * précises, chacune déjà rencontrée en vrai. */
const litteraux = [];
for (const f of sources) {
  const src = readFileSync(f, "utf-8");
  const re = /`([^`]*)`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const avant = src.slice(0, m.index);
    litteraux.push({
      fichier: f,
      ligne: avant.split("\n").length,
      sql: m[1],
    });
  }
}

console.log(`${sources.length} fichiers, ${litteraux.length} littéraux lus.\n`);

/* --------------------------------------------------------------------------
 * I. LA BORNE D'ANNÉE DANS LE ON D'UNE JOINTURE EXTERNE
 *
 * On isole chaque `left join` (ou `right join`, `full join`) et son ON, qui
 * court jusqu'au prochain mot-clé de niveau supérieur. Si cet ON contient une
 * égalité sur `academic_year_id`, c'est le défaut : la borne ne borne rien.
 * -------------------------------------------------------------------------- */
console.log("Une borne d'année ne se met pas dans le ON d'une jointure externe");

const DECLARATION = /--\s*borne\s*:\s*\S+[\s\S]{8,}/i;

const MOTS = /\b(left|right|full|inner|cross)\s+join\b|\bjoin\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\bunion\b|\breturning\b|\bfrom\b|\)\s*$/i;

/* CE QU'ON CHERCHE EXACTEMENT, et pourquoi la règle n'est pas « jamais
 * d'année dans un ON externe ».
 *
 * Une jointure externe qui CORRÉLE est parfaitement juste, et le dépôt en
 * compte plusieurs : « la classe de cet élève POUR L'ANNÉE DE CETTE FACTURE »,
 * « son inscription POUR L'ANNÉE EN COURS ». La borne y choisit quelle ligne
 * afficher, elle ne prétend pas en exclure.
 *
 * Le défaut, c'est de COMPTER la table de gauche en croyant que ce ON la
 * filtre. La signature est donc double : un ON externe portant l'année, ET un
 * agrégat, ET aucune borne ailleurs. C'est exactement la forme des deux cas
 * trouvés en vrai. */
const ON_EXTERNE = (sql) => {
  const bas = sql.toLowerCase();
  const trouves = [];
  let i = 0;
  while (true) {
    const j = bas.indexOf("left join", i);
    if (j < 0) break;
    const k = bas.indexOf(" on ", j);
    if (k < 0) { i = j + 9; continue; }
    const reste = sql.slice(k + 4);
    const stop = reste.search(MOTS);
    const on = stop >= 0 ? reste.slice(0, stop) : reste;
    if (/academic_year_id\s*(=|is not distinct from)/i.test(on)) trouves.push(on);
    i = j + 9;
  }
  return trouves;
};
const AGREGE = /\b(count|sum|avg|min|max)\s*\(/i;
/** La borne est-elle AUSSI ailleurs que dans le ON externe ? */
const BORNE_AILLEURS = (sql) => {
  let reste = sql;
  for (const on of ON_EXTERNE(sql)) reste = reste.replace(on, " ");
  return /academic_year_id\s*=|dans_l_annee\s*\(|_de_l_annee\s*\(|annee_en_cours\s*\(/i
    .test(reste);
};

const externes = [];
for (const l of litteraux) {
  const ons = ON_EXTERNE(l.sql);
  if (ons.length === 0) continue;
  if (!AGREGE.test(l.sql)) continue;        // rien n'est compté : rien à fausser
  if (BORNE_AILLEURS(l.sql)) continue;      // la borne est aussi au bon endroit
  if (DECLARATION.test(l.sql)) continue;
  externes.push({ ...l, on: ons[0].replace(/\s+/g, " ").trim().slice(0, 120) });
}

check("aucun agrégat ne prend un ON de jointure externe pour une borne",
  externes.length === 0,
  externes.map((x) => `\n        ${x.fichier}:${x.ligne} — « ${x.on} »`).join("")
    + "\n        Un ON de jointure externe ne retire aucune ligne : il met la "
    + "table jointe à NULL\n        et laisse passer celle de gauche. "
    + "Déplacez la borne dans le WHERE, ou joignez en interne.");

/* --------------------------------------------------------------------------
 * II. LES TABLES DATÉES, INTERROGÉES SANS PÉRIODE
 *
 * Trois tables portent des faits qui appartiennent à une année scolaire et à
 * une seule. Toute requête qui les lit doit dire laquelle — par la table, par
 * une fonction bornée, ou par la classe (une classe appartient à une année).
 * -------------------------------------------------------------------------- */
console.log("\nLes tables datées disent toujours de quelle année elles parlent");

const DATEES = ["attendance_records", "behavior_incidents", "grade_entries"];

/* Ce qui compte comme une borne. La liste est explicite et se relit : chaque
 * entrée est une façon réelle, présente dans ce dépôt, de désigner une année. */
const BORNES = [
  /dans_l_annee\s*\(/i,
  /assiduite_de_l_annee\s*\(/i,
  /conduite_de_l_annee\s*\(/i,
  /absences_evaluation_a_justifier\s*\(/i,
  /academic_year_id\s*=/i,
  /annee_en_cours\s*\(/i,
  // Une classe appartient à une année : filtrer sur une classe borne l'année.
  /\bclass_id\s*=\s*\$/i,
  /\bev\.class_id\s*=/i,
  /\bses\.class_id\s*=/i,
  /\be\.class_id\s*=\s*\$/i,
  // Une évaluation appartient à un trimestre, un trimestre à une année.
  /\bterm_id\s*=\s*\$/i,
  /\bev\.term_id\s*=/i,
  // Une évaluation appartient à une classe, donc à une année.
  /evaluation_id\s*=/i,
  // Une séance d'appel appartient à une classe, donc à une année.
  /attendance_session_id\s*=\s*\$/i,
  // Un jour précis est une période, la plus courte qui soit.
  /session_date\s*=\s*(current_date|\$)/i,
  /occurred_on\s*=\s*(current_date|\$)/i,
  // Une ligne précise, désignée par son identifiant, n'a pas de période.
  /\b(ar|bi|ge)\.id\s*=\s*\$/i,
  /\bwhere\s+id\s*=\s*\$/i,
];

const nus = [];
for (const l of litteraux) {
  const bas = l.sql.toLowerCase();
  const touchees = DATEES.filter((t) =>
    new RegExp(`\\b(from|join|into|update)\\s+${t}\\b`).test(bas));
  if (touchees.length === 0) continue;
  // Une écriture (insert/update/delete) ne présente pas un chiffre : on ne
  // borne que ce qui se LIT et s'affiche.
  if (/^\s*(insert|update|delete)\b/i.test(l.sql.trim())) continue;
  if (BORNES.some((r) => r.test(l.sql))) continue;
  if (DECLARATION.test(l.sql)) continue;
  nus.push({ ...l, tables: touchees.join(", "),
    extrait: l.sql.replace(/\s+/g, " ").trim().slice(0, 110) });
}

check("aucune lecture d'une table datée sans période",
  nus.length === 0,
  nus.map((x) => `\n        ${x.fichier}:${x.ligne} (${x.tables}) — « ${
    x.extrait} »`).join("")
    + "\n        Bornez la requête, ou déclarez l'intention dans le SQL :"
    + "\n        `-- borne: volontairement toutes les années, <pourquoi>`");

/* --------------------------------------------------------------------------
 * III. LES RÈGLES DATÉES SE LISENT À UNE DATE
 *
 * Quatre tables portent `effective_from`. Une lecture sans borne applique une
 * réforme saisie d'avance à l'année en cours — ce qui est arrivé, sur l'écran
 * du conseil de classe, et faisait passer la barre d'admission de 10 à 12.
 * -------------------------------------------------------------------------- */
console.log("\nLes règles datées se lisent à une date");

const REGLES = ["grading_policies", "coefficient_sets", "promotion_rules"];
const BORNES_DATE = [
  /effective_from\s*<=/i,
  /regle_de_passage\w*\s*\(/i,
  /regle_notation_a_confirmer\s*\(/i,
  /coefficients_a_confirmer\s*\(/i,
  /absence_non_justifiee_compte_zero\s*\(/i,
];

const sansDate = [];
for (const l of litteraux) {
  const bas = l.sql.toLowerCase();
  const touchees = REGLES.filter((t) =>
    new RegExp(`\\b(from|join)\\s+${t}\\b`).test(bas));
  if (touchees.length === 0) continue;
  if (/^\s*(insert|update|delete)\b/i.test(l.sql.trim())) continue;
  if (BORNES_DATE.some((r) => r.test(l.sql))) continue;
  if (DECLARATION.test(l.sql)) continue;
  sansDate.push({ ...l, tables: touchees.join(", "),
    extrait: l.sql.replace(/\s+/g, " ").trim().slice(0, 110) });
}

check("aucune lecture d'une règle datée sans borne de date",
  sansDate.length === 0,
  sansDate.map((x) => `\n        ${x.fichier}:${x.ligne} (${x.tables}) — « ${
    x.extrait} »`).join("")
    + "\n        Sans `effective_from <= <date>`, une réforme saisie d'avance "
    + "gouverne l'année en cours.");

/* --------------------------------------------------------------------------
 * IV. LA SUITE SAIT-ELLE ENCORE MORDRE ?
 *
 * Un témoin qui ne peut plus échouer ne sert à rien. On lui donne les deux
 * formes fautives, écrites ici, et on vérifie qu'il les attrape — sinon une
 * refonte des expressions régulières rendrait la suite verte et muette.
 * -------------------------------------------------------------------------- */
console.log("\nEt la suite sait-elle encore mordre ?");

const FAUTIF_ON = `select x from t
   left join enrolments e on e.student_id = st.id
                         and e.academic_year_id = $1
  where 1 = 1`;
const onDetecte = (() => {
  const bas = FAUTIF_ON.toLowerCase();
  const j = bas.indexOf("left join");
  const k = bas.indexOf(" on ", j);
  const reste = FAUTIF_ON.slice(k + 4);
  const stop = reste.search(MOTS);
  const on = stop >= 0 ? reste.slice(0, stop) : reste;
  return /academic_year_id\s*(=|is not distinct from)/i.test(on);
})();
check("la forme fautive du ON est bien attrapée", onDetecte,
  "sans cela, la suite passerait au vert sans rien vérifier");

const FAUTIF_NU = `select count(*) from behavior_incidents bi
  where bi.student_id = $1`;
check("une lecture non bornée est bien attrapée",
  !BORNES.some((r) => r.test(FAUTIF_NU)) && !DECLARATION.test(FAUTIF_NU));

const LEGITIME = `select count(*) from attendance_records ar
  -- borne: volontairement toutes les années, c'est l'historique complet
  where ar.student_id = $1`;
check("et une intention DÉCLARÉE est bien levée",
  DECLARATION.test(LEGITIME),
  "une requête qui doit porter sur toutes les années doit pouvoir le dire");

const MUET = `select count(*) from attendance_records -- borne:`;
check("mais un `-- borne:` sans raison ne lève rien",
  !DECLARATION.test(MUET),
  "le but n'est pas d'avoir un moyen de se taire, c'est d'obliger à écrire "
    + "pourquoi");

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Chaque chiffre affiché porte sa période, et chaque règle datée se "
  + "lit à une date.");
