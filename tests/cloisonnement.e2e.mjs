/**
 * L'épreuve de cloisonnement, et la preuve qu'elle sait échouer.
 *
 * Le cloisonnement multi-locataire est la promesse la plus lourde du produit :
 * une fuite, c'est le dossier d'un enfant dans les mains d'une autre école. Le
 * dépôt avait bien un test d'isolation depuis le premier jour. Deux choses
 * n'allaient pas.
 *
 * 1. **On ne pouvait pas le lancer.** Le README prescrivait
 *    `npm run db:test:rls` « avant tout développement ». Sur une machine où le
 *    produit est installé, le fichier SQL commençait par
 *    `drop role if exists schoolfaso_app` — le compte de l'application — et
 *    échouait parce qu'il porte des droits. Le test de sûreté ne pouvait donc
 *    pas être lancé là où il servirait.
 *
 * 2. **S'il avait réussi, c'eût été pire.** Il aurait supprimé le compte de
 *    l'application EN SERVICE pour le recréer avec le mot de passe « test ».
 *
 * Et l'épreuve elle-même avait un angle mort : elle regardait les sessions des
 * familles, pas celles du personnel — la table qui n'avait aucune politique.
 * Une assertion n'existe que pour ce qu'on a pensé à regarder.
 *
 * Cette suite vérifie donc les deux choses qui comptent : l'épreuve passe sur
 * un schéma complet, ET ELLE ÉCHOUE sur un schéma auquel il manque la
 * migration 0009. Un test de sûreté qui ne sait pas échouer ne prouve rien.
 *
 *   node tests/cloisonnement.e2e.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const APP = process.env.DATABASE_URL ?? "";
const hote = APP.replace(/^postgres:\/\/[^@]*@[^/]*\/[^?]*/, "");
const adminSur = (base) => `postgres://postgres@/${base}${hote}`;
const ADMIN = adminSur("postgres");

const psql = (url, ...args) => execFileP("psql", [url, ...args])
  .then((r) => ({ ...r, code: 0 }))
  .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }));

const MIGRATIONS = [
  "0001_initial", "0002_reference_data", "0003_guardian_access",
  "0004_message_suivi", "0005_personnel", "0006_annulation_paiement",
  "0007_discipline", "0008_justifications", "0009_auth_sessions_rls",
  "0010_calendrier", "0011_pieces_justificatives",
  "0012_bulletin_conseil", "0013_examens", "0014_garde_envois",
  "0015_bulletin_complet", "0016_famille_injoignable",
  "0017_echeancier", "0018_recu_fige", "0019_arrivee_en_cours_annee", "0020_fetes_au_dela_de_2028",
  "0021_dementi_absence", "0022_regle_de_passage_datee", "0023_assiduite_de_l_annee", "0024_ce_qui_est_clos_est_clos", "0025_entre_deux_trimestres", "0026_double_clic_au_guichet",
  "0027_annuler_une_facture", "0028_le_plafond_declare", "0029_l_histoire_d_une_note", "0030_le_credit_qui_ne_retient_rien", "0031_le_produit_change_de_nom",
];

const BASE_SANS_0009 = `schoolfaso_sans_0009_${process.pid}`;

const nettoyer = async () => {
  await psql(ADMIN, "-q", "-c", `drop database if exists ${BASE_SANS_0009}`);
  await psql(ADMIN, "-q", "-c", "drop role if exists schoolfaso_rls_probe");
};
await nettoyer();

try {
  console.log("\nL'épreuve passe sur un schéma complet");
  const bonne = await execFileP("bash", ["scripts/epreuve-cloisonnement.sh"],
    { env: { ...process.env, ADMIN_DATABASE_URL: ADMIN } })
    .then((r) => ({ ...r, code: 0 }))
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }));
  const sortie = bonne.stdout + bonne.stderr;
  check("elle réussit", bonne.code === 0, sortie.slice(-400));
  check("les lectures sont isolées", sortie.includes("lectures isolées"));
  check("une écriture croisée est refusée", sortie.includes("écriture croisée refusée"));
  check("un update croisé ne touche rien", sortie.includes("update croisé sans effet"));
  check("un delete croisé ne touche rien", sortie.includes("delete croisé sans effet"));
  check("LE CALENDRIER D'UNE ÉCOLE NE FERME PAS CELLE DU VOISIN",
    sortie.includes("ne ferment pas celle du voisin"),
    "sinon B ne travaille pas, ses familles ne reçoivent aucun SMS, "
      + "et personne ne sait pourquoi");
  check("mais les fêtes nationales restent visibles de tous",
    sortie.includes("fêtes nationales restent visibles"),
    "elles portent school_id null : c'est le seul cas où la politique de "
      + "lecture laisse passer deux choses");
  check("LES SESSIONS DU PERSONNEL SONT ISOLÉES",
    sortie.includes("sessions du personnel isolées"),
    "c'est l'assertion qui manquait : la table qui n'avait aucune politique");
  check("sans contexte, on ne voit rien du tout",
    sortie.includes("aucun contexte = aucune ligne"),
    "une requête qui oublie withSchool() ne doit pas voir tout le pays");

  console.log("\nElle ne touche à aucune base réelle");
  check("elle fabrique et supprime sa propre base",
    sortie.includes("base jetable") && sortie.includes("Aucune base réelle"),
    "elle supprimait le compte de l'application en service");
  const restes = (await psql(ADMIN, "-tAc",
    "select count(*) from pg_database where datname like 'schoolfaso_cloisonnement_%'")).stdout.trim();
  check("aucune base jetable ne survit", restes === "0", restes);
  const roleReste = (await psql(ADMIN, "-tAc",
    "select count(*) from pg_roles where rolname = 'schoolfaso_rls_probe'")).stdout.trim();
  check("ni le rôle jetable", roleReste === "0", roleReste);

  const appIntact = (await psql(ADMIN, "-tAc",
    "select count(*) from pg_roles where rolname = 'schoolfaso_app'")).stdout.trim();
  check("LE COMPTE DE L'APPLICATION EST INTACT", appIntact === "1",
    "l'ancien test le supprimait pour le recréer avec le mot de passe « test »");

  /* LE PRODUIT A CHANGÉ DE NOM, ET LE NOM PORTAIT LA FRONTIÈRE.
   *
   * `current_setting('fasoschool.school_id')` est le réglage de session que
   * lit `current_school_id()`, dont dépend CHAQUE politique de row-level
   * security. Renommer le produit sans y penser aurait fait qu'une base en
   * service, après un déploiement passé avant l'autre, ne montre plus une
   * seule ligne — bruyant plutôt que silencieux, ce qui est la bonne façon
   * d'échouer, mais il n'y a aucune raison de l'infliger à une école un mardi
   * matin. La migration 0031 fait retomber la lecture sur l'ancien nom.
   *
   * Le jour où l'on retirera cette retombée, c'est ici qu'on l'apprendra. */
  console.log("\nL'ANCIEN NOM DU RÉGLAGE DE SESSION FONCTIONNE ENCORE");
  {
    /* L'identifiant vient d'`auth_lookup_user`, une fonction `security
     * definer` — le seul trou nommé par lequel le rôle applicatif peut
     * apprendre à quel établissement il appartient AVANT d'avoir posé son
     * contexte. `ADMIN` pointe sur la base `postgres`, où il n'y a pas
     * d'école : c'est ce qui rendait cette mesure nulle. */
    const uneEcole = (await psql(APP, "-tAc",
      "select school_id from auth_lookup_user('70000001')")).stdout.trim();
    const parAncien = (await psql(APP, "-tAc",
      `select set_config('fasoschool.school_id', '${uneEcole}', false);`
      + ` select count(*) from students`)).stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    const parNouveau = (await psql(APP, "-tAc",
      `select set_config('schoolfaso.school_id', '${uneEcole}', false);`
      + ` select count(*) from students`)).stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    check("l'ancien nom montre autant d'élèves que le nouveau",
      parAncien === parNouveau && Number(parNouveau) > 0,
      `ancien ${parAncien}, nouveau ${parNouveau} — une base en service ne doit`
        + ` pas cesser de répondre parce qu'un déploiement est passé avant l'autre`);
    const sansRien = (await psql(APP, "-tAc",
      "select set_config('fasoschool.school_id', '', false);"
      + " select set_config('schoolfaso.school_id', '', false);"
      + " select count(*) from students")).stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop();
    check("et sans aucun des deux, toujours AUCUNE ligne",
      sansRien === "0", `${sansRien} — c'est la frontière elle-même`);
  }

  console.log("\nET ELLE SAIT ÉCHOUER : sans la migration 0009");
  /* Un test de sûreté qui n'échoue jamais ne prouve rien. On rejoue l'épreuve
     sur un schéma auquel il manque exactement la politique ajoutée par 0009. */
  await psql(ADMIN, "-q", "-c", `create database ${BASE_SANS_0009}`);
  const cible = adminSur(BASE_SANS_0009);
  const fichiers = MIGRATIONS.filter((m) => m !== "0009_auth_sessions_rls")
    .flatMap((m) => ["-f", `db/migrations/${m}.sql`]);
  const schema = await psql(cible, "-q", "-v", "ON_ERROR_STOP=1", ...fichiers);
  check("le schéma incomplet s'applique", schema.code === 0, schema.stderr.slice(-300));

  const sansPolitique = (await psql(cible, "-tAc",
    "select relrowsecurity from pg_class where relname = 'auth_sessions'")).stdout.trim();
  check("auth_sessions y est bien sans row-level security", sansPolitique === "f",
    `relrowsecurity = ${sansPolitique}`);

  const epreuve = await psql(cible, "-v", "ON_ERROR_STOP=1",
    "-f", "db/tests/rls_isolation.sql");
  const dit = epreuve.stdout + epreuve.stderr;
  check("L'ÉPREUVE ÉCHOUE, comme elle le doit", epreuve.code !== 0,
    `code ${epreuve.code}`);
  check("et elle nomme la fuite exacte",
    dit.includes("FUITE auth_sessions"),
    "elle voit les deux sessions au lieu d'une");
  check("les autres assertions passaient pourtant",
    dit.includes("lectures isolées"),
    "c'est pour cela que le trou avait survécu : tout le reste allait bien");

} finally {
  await nettoyer().catch(() => {});
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le cloisonnement est vérifié, et l'épreuve sait échouer.");
