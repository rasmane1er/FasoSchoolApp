/**
 * Installer un établissement.
 *
 *   npm run installer -- --nom "Collège Privé Wend-Panga" \
 *                        --secteur prive_laic --zone ouaga_bobo \
 *                        --commune Ouagadougou --region Centre \
 *                        --chef "KABORÉ Paul" --telephone 70112233 \
 *                        --fonction directeur
 *
 * POURQUOI UN SCRIPT ET PAS UN ÉCRAN.
 *
 * Créer un établissement est le seul geste qui ne peut PAS se faire depuis
 * l'application : il faut être connecté pour ouvrir un écran, et il n'existe
 * encore aucun compte à connecter. Un écran public qui créerait des
 * établissements serait par construction ouvert à tout le monde.
 *
 * C'est aussi, honnêtement, une opération de plateforme et non d'école : c'est
 * l'éditeur qui installe, une fois, avec le contrat signé sous les yeux. Le
 * reste — année scolaire, classes, personnel, élèves — se fait ensuite depuis
 * l'application, par l'établissement lui-même et sans qu'on touche à sa base.
 *
 * CE QUE CE SCRIPT REFUSE DE FAIRE :
 *
 *   - créer un établissement sans chef d'établissement. Un établissement sans
 *     compte est inaccessible pour toujours : personne ne peut s'y connecter,
 *     et personne ne peut y créer le premier compte. Les deux vont ensemble ou
 *     rien ne se fait ;
 *   - réutiliser un numéro déjà connu. Le numéro est l'identifiant de
 *     connexion, et `auth_lookup_user` s'arrête au premier trouvé : le second
 *     titulaire ne se connecterait jamais ;
 *   - écrire quoi que ce soit à moitié. Tout se fait dans UNE transaction —
 *     un établissement à demi installé est pire qu'aucun.
 */

import pg from "pg";
import { normalizePhone } from "../src/lib/roster.ts";

const SECTEURS = ["public", "prive_laic", "prive_catholique",
                  "prive_protestant", "prive_franco_arabe"];
const ZONES = ["ouaga_bobo", "chef_lieu", "rural"];
const CHEFS = ["directeur", "proviseur"];

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (!a[i].startsWith("--")) continue;
    const clef = a[i].slice(2);
    const val = a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : "";
    out[clef] = val;
    if (val) i += 1;
  }
  return out;
}

const USAGE = `
Installer un établissement.

  npm run installer -- --nom "Collège Privé Wend-Panga" \\
                       --secteur prive_laic \\
                       --zone ouaga_bobo \\
                       --commune Ouagadougou \\
                       --region Centre \\
                       --chef "KABORÉ Paul" \\
                       --telephone 70112233 \\
                       --fonction directeur

  --nom         obligatoire
  --secteur     ${SECTEURS.join(" | ")}
  --zone        ${ZONES.join(" | ")}   (décide du plafond de frais applicable)
  --commune     facultatif mais attendu sur les documents officiels
  --region      facultatif
  --chef        nom du chef d'établissement, obligatoire
  --telephone   son numéro à 8 chiffres — c'est son identifiant de connexion
  --fonction    ${CHEFS.join(" | ")}   (défaut : directeur)
  --effet       date d'effet des règles nationales (défaut : aujourd'hui)

L'année scolaire, les classes, le reste du personnel et les élèves se créent
ensuite depuis l'application, par l'établissement lui-même.
`;

function refuser(message: string): never {
  console.error(`\nRefusé : ${message}\n`);
  process.exit(1);
}

async function main() {
  const a = args();
  if (a.aide !== undefined || a.help !== undefined || process.argv.length <= 2) {
    console.log(USAGE);
    process.exit(process.argv.length <= 2 ? 1 : 0);
  }

  const nom = (a.nom ?? "").trim();
  const secteur = (a.secteur ?? "").trim();
  const zone = (a.zone ?? "").trim();
  const chef = (a.chef ?? "").trim().replace(/\s+/g, " ");
  const fonction = (a.fonction ?? "directeur").trim();
  const effet = (a.effet ?? new Date().toISOString().slice(0, 10)).trim();

  if (nom.length < 3) refuser("donnez le nom de l'établissement (--nom).");
  if (!SECTEURS.includes(secteur)) {
    refuser(`secteur inconnu. Attendu : ${SECTEURS.join(", ")}.`);
  }
  if (zone && !ZONES.includes(zone)) {
    refuser(`zone inconnue. Attendu : ${ZONES.join(", ")}. C'est elle qui `
      + `décide du plafond de frais applicable.`);
  }
  if (chef.length < 3) {
    // Un établissement sans compte est inaccessible pour toujours.
    refuser("donnez le nom du chef d'établissement (--chef). Un établissement "
      + "sans compte ne peut plus jamais être ouvert : personne ne peut s'y "
      + "connecter, et personne ne peut y créer le premier compte.");
  }
  if (!CHEFS.includes(fonction)) {
    refuser(`--fonction doit être ${CHEFS.join(" ou ")} : c'est le chef `
      + `d'établissement qui crée ensuite tous les autres comptes.`);
  }
  const tel = normalizePhone(a.telephone ?? "");
  if (!tel.phone) {
    refuser(tel.problem
      ? `${tel.problem}. C'est ce numéro qui servira à se connecter.`
      : "donnez le numéro du chef d'établissement (--telephone) : c'est son "
        + "identifiant de connexion, il n'y a pas de mot de passe.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effet)) {
    refuser("--effet attend une date ISO, par exemple 2026-10-01.");
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Le numéro est vérifié AVANT d'ouvrir la transaction : `auth_lookup_user`
    // s'arrête au premier trouvé, donc un doublon condamnerait silencieusement
    // l'un des deux comptes.
    const pris = await client.query(
      `select full_name from auth_lookup_user($1)`, [tel.phone]);
    if (pris.rowCount) {
      refuser(`le ${tel.phone} est déjà l'identifiant de ${
        pris.rows[0].full_name}. Un numéro ouvre un seul compte.`);
    }

    // Tout ou rien : un établissement à demi installé est pire qu'aucun.
    await client.query("begin");

    const s = await client.query(
      `select provision_school($1,$2,$3,$4,$5,$6) as id`,
      [nom, secteur, zone || null, (a.commune ?? "").trim() || null,
       (a.region ?? "").trim() || null, effet]);
    const schoolId = s.rows[0].id as string;

    // provision_school() a posé le contexte pour sa propre transaction ; on le
    // repose explicitement, parce que rien ne garantit qu'il soit encore là.
    await client.query(`select set_config('schoolfaso.school_id', $1, true)`,
      [schoolId]);

    const u = await client.query(
      `insert into users (school_id, full_name, phone)
       values ($1, $2, $3) returning id`, [schoolId, chef, tel.phone]);
    await client.query(
      `insert into staff (school_id, user_id, full_name, fonction)
       values ($1, $2, $3, $4)`, [schoolId, u.rows[0].id, chef, fonction]);
    await client.query(
      `insert into user_roles (user_id, role_code, school_id)
       values ($1, $2, $3)`, [u.rows[0].id, fonction, schoolId]);
    await client.query(
      `insert into audit_log (school_id, actor_id, action, target_type,
                              target_id, detail)
       values ($1, $2, 'school.provision', 'school', $1, $3)`,
      [schoolId, u.rows[0].id,
       JSON.stringify({ nom, secteur, zone: zone || null, chef,
                        fonction, effet })]);

    await client.query("commit");

    console.log(`
Établissement installé.

  ${nom}
  ${[secteur, zone, (a.commune ?? "").trim()].filter(Boolean).join(" · ")}
  identifiant interne : ${schoolId}

Premier compte :

  ${chef} — ${fonction}
  connexion avec le ${tel.phone}, sans mot de passe : un code à usage unique
  arrive par SMS à chaque ouverture de session.

Ce qui reste à faire DEPUIS L'APPLICATION, par l'établissement lui-même :

  1. « Année scolaire »  — ouvrir l'année, poser les trimestres, créer les classes
  2. « Personnel »       — inscrire le censeur, les enseignants, l'économe
  3. « Services »        — dire qui enseigne quoi, à quelle classe
  4. « Inscriptions »    — importer la liste des élèves
  5. « Règles de notation » — les CONFIRMER : tant qu'elles ne le sont pas,
                            toutes les moyennes calculées restent indicatives
  6. « Frais »           — la grille, puis l'émission des factures

Les règles nationales ont été posées avec effet au ${effet}.
`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    console.error(`\nRien n'a été installé : ${
      e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
