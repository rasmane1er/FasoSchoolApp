/**
 * La sauvegarde, et ce qu'elle refuse de laisser derrière elle.
 *
 * Cette suite existe à cause de deux défauts trouvés en lançant réellement le
 * script, pour la première fois depuis huit migrations :
 *
 * 1. **La sauvegarde documentée ne sauvegardait RIEN.** Le script demandait
 *    `DATABASE_URL` — la même variable que l'application. Or le rôle applicatif
 *    est soumis au row-level security : `pg_dump` échoue table par table avec
 *    « query would be affected by row-level security policy ». Un établissement
 *    qui suivait la documentation à la lettre n'avait aucune sauvegarde.
 *
 * 2. **Et il laissait un fichier pour le lui faire croire.** Le `pg_dump` qui
 *    échoue laissait derrière lui un `.dump.gpg` de soixante-dix octets, au
 *    milieu des bonnes sauvegardes, avec un nom parfaitement crédible. C'est
 *    exactement le fichier qu'on restaure un jour de panne.
 *
 * Le mode d'échec ordinaire d'une sauvegarde n'est pas son absence : c'est un
 * fichier quotidien, fidèle, vide depuis huit mois, et que personne ne relit.
 *
 *   node tests/sauvegarde.e2e.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const PASS = "epreuve-de-restauration-controle";
const dossier = await mkdtemp(join(tmpdir(), "schoolfaso-sauv-"));

/* L'URL d'administration : le propriétaire des tables, qui contourne le RLS.
   On la déduit de DATABASE_URL en changeant seulement le rôle — la suite doit
   marcher sur la base de contrôle comme sur une vraie. */
const APP = process.env.DATABASE_URL ?? "";
const ADMIN = APP.replace(/\/\/[^@/]*@/, "//postgres@");

const lancer = (env, args = [dossier]) =>
  execFileP("bash", ["scripts/sauvegarde.sh", ...args], { env: { ...process.env, ...env } })
    .then((r) => ({ ...r, code: 0 }))
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }));

const fichiers = async () => (await readdir(dossier)).sort();

try {
  console.log("\nCe que la sauvegarde refuse de faire");

  const sansPass = await lancer({ ADMIN_DATABASE_URL: ADMIN, SCHOOLFASO_PASSPHRASE: "" });
  check("sans phrase de passe, elle refuse",
    sansPass.code !== 0 && sansPass.stderr.includes("en clair"),
    "une sauvegarde en clair des données d'élèves ne doit pas exister");

  const sansAdmin = await lancer({ ADMIN_DATABASE_URL: "", SCHOOLFASO_PASSPHRASE: PASS });
  check("sans URL d'administration, elle refuse",
    sansAdmin.code !== 0 && sansAdmin.stderr.includes("row-level security"),
    "et elle DIT pourquoi : c'était le défaut, le script demandait la variable "
      + "de l'application");
  check("le message nomme la variable attendue",
    sansAdmin.stderr.includes("ADMIN_DATABASE_URL"));
  check("aucun fichier n'a été créé", (await fichiers()).length === 0,
    (await fichiers()).join(", "));

  console.log("\nQuand pg_dump échoue, RIEN ne reste");
  /* Un port mort : c'est la panne ordinaire — base arrêtée, mot de passe
     changé, disque plein. Avant le garde-fou, elle laissait un fichier. */
  const mort = await lancer({
    ADMIN_DATABASE_URL: ADMIN.replace(/port=\d+/, "port=1"),
    SCHOOLFASO_PASSPHRASE: PASS });
  check("l'échec est annoncé", mort.code !== 0);
  check("et il est annoncé comme un ÉCHEC, pas comme un avertissement",
    mort.stderr.includes("ÉCHOUÉE"), mort.stderr.slice(0, 200));
  check("le script explique ce qu'il a évité",
    mort.stderr.includes("pire que pas de fichier"));
  check("AUCUN FICHIER TRONQUÉ N'EST LAISSÉ", (await fichiers()).length === 0,
    (await fichiers()).join(", ") + " — c'est le fichier qu'on restaurerait "
      + "un jour de panne en croyant tenir ses données");

  console.log("\nUne vraie sauvegarde");
  const bonne = await lancer({ ADMIN_DATABASE_URL: ADMIN, SCHOOLFASO_PASSPHRASE: PASS });
  check("elle réussit", bonne.code === 0, bonne.stderr.slice(0, 300));
  const produits = await fichiers();
  const archive = produits.find((f) => f.endsWith(".dump.gpg"));
  const empreinte = produits.find((f) => f.endsWith(".sha256"));
  check("elle produit l'archive et son empreinte",
    Boolean(archive) && Boolean(empreinte), produits.join(", "));

  const taille = (await stat(join(dossier, archive))).size;
  check("l'archive pèse ce que pèse une base réelle", taille > 50_000,
    `${taille} octets`);

  const mode = (await stat(join(dossier, archive))).mode & 0o777;
  check("elle n'est lisible que par son propriétaire", mode === 0o600,
    `mode ${mode.toString(8)} — elle contient les noms, les dates de naissance `
      + `et les numéros des familles de tout un établissement`);

  const { stdout: entete } = await execFileP("bash", ["-c",
    `head -c 32 ${JSON.stringify(join(dossier, archive))} | strings | head -1 || true`]);
  check("elle n'est pas en clair",
    !entete.includes("PGDMP"),
    "un dump PostgreSQL en clair commence par PGDMP ; celui-ci est chiffré");

  console.log("\nL'épreuve de restauration accepte cette archive");
  const drill = await execFileP("bash",
    ["scripts/restauration-verifiee.sh", join(dossier, archive)],
    { env: { ...process.env, ADMIN_DATABASE_URL: ADMIN.replace(/\/demo\?/, "/postgres?"),
             SCHOOLFASO_PASSPHRASE: PASS } })
    .then((r) => ({ ...r, code: 0 }))
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }));
  check("la restauration d'épreuve réussit", drill.code === 0,
    (drill.stderr || drill.stdout).slice(-400));
  // psql écrit ses NOTICE sur stderr : on lit les deux flux, sinon on
  // conclurait que le contrôle n'a pas eu lieu alors qu'il a eu lieu.
  const sortie = drill.stdout + drill.stderr;
  check("et elle a compté les lignes, pas seulement les tables",
    sortie.includes("eleves restaures") && sortie.includes("notes restaurees"),
    "une sauvegarde jamais restaurée n'est pas une sauvegarde");

} finally {
  await rm(dossier, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("La sauvegarde et son épreuve de restauration sont vérifiées.");
