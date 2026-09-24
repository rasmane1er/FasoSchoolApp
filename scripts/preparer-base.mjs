/**
 * Préparer la base — sans `psql`.
 *
 * POURQUOI CE FICHIER EXISTE, ALORS QUE `preparer-base.sh` FAIT DÉJÀ CELA.
 *
 * Le constructeur d'images de Railway n'a pas de réseau vers les miroirs
 * Debian : `apt-get install postgresql-client` y échoue en trois secondes,
 * sur un « context canceled », et trois tentatives n'y changent rien. On peut
 * s'en désoler ou en tirer la conclusion : une image de production qui a
 * besoin d'installer un paquet pour démarrer dépend d'un réseau qu'elle ne
 * contrôle pas, le jour où elle démarre.
 *
 * Or ce dont la mise en ligne a besoin, c'est d'exécuter du SQL. Le produit
 * embarque déjà `pg` — sa seule dépendance — et sait donc le faire. Ce fichier
 * fait, en Node, exactement ce que le script shell fait avec `psql` : créer la
 * base, créer le rôle applicatif, REFUSER de continuer s'il est privilégié,
 * appliquer les migrations, accorder les droits, vérifier.
 *
 * LES DEUX NE PEUVENT PAS DIVERGER SUR L'ESSENTIEL. Le script shell porte la
 * liste des migrations en dur ; celui-ci LIT LE RÉPERTOIRE. Et
 * `tests/deploiement.e2e.mjs` vérifie que la liste en dur est exactement le
 * contenu du répertoire — ce qui fait que les deux appliquent le même
 * ensemble, dans le même ordre, ou que l'épreuve tombe.
 *
 *   ADMIN_DATABASE_URL=... APP_ROLE=... APP_PASSWORD=... \
 *     node scripts/preparer-base.mjs [nom-de-la-base]
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

const BASE = process.argv[2] || process.env.FASOSCHOOL_DB || "fasoschool";
const APP_ROLE = process.env.APP_ROLE || "fasoschool_app";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const ADMIN = process.env.ADMIN_DATABASE_URL || "";

if (!ADMIN) {
  console.error(
    "ADMIN_DATABASE_URL n'est pas défini.\n"
    + "C'est la connexion d'ADMINISTRATION (superutilisateur ou propriétaire),\n"
    + "pas celle de l'application. Les migrations créent des extensions et des\n"
    + "tables : le rôle applicatif ne le peut pas, et ne doit pas le pouvoir.");
  process.exit(2);
}

/* LE NOM DU RÔLE EST INTERPOLÉ DANS DU SQL — il ne peut donc pas être
 * n'importe quoi. Un identifiant PostgreSQL non cité, c'est ce jeu de
 * caractères et rien d'autre ; tout le reste est refusé avant d'atteindre la
 * base. */
if (!/^[a-z_][a-z0-9_]*$/.test(APP_ROLE)) {
  console.error(`APP_ROLE « ${APP_ROLE} » n'est pas un identifiant PostgreSQL.`);
  process.exit(2);
}
if (!/^[a-zA-Z0-9_-]+$/.test(BASE)) {
  console.error(`Le nom de base « ${BASE} » n'est pas un identifiant.`);
  process.exit(2);
}

/** L'URL de la base cible : même hôte, même rôle, autre nom de base. */
const urlCible = (() => {
  const u = new URL(ADMIN);
  u.pathname = `/${BASE}`;
  return u.toString();
})();

const connecter = async (url) => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
};

const titre = (t) => console.log(`\n--- ${t} ---`);

// ---------------------------------------------------------------------------
titre("base");
const admin = await connecter(ADMIN);
try {
  const { rows } = await admin.query(
    `select 1 from pg_database where datname = $1`, [BASE]);
  if (rows.length === 0) {
    /* `create database` n'accepte pas de paramètre lié : d'où la validation
     * du nom plus haut, faite avant d'arriver ici. */
    await admin.query(`create database "${BASE}"`);
    console.log(`base « ${BASE} » créée`);
  } else {
    console.log(`base « ${BASE} » présente`);
  }

  // -------------------------------------------------------------------------
  titre("rôle applicatif");
  const existe = await admin.query(
    `select 1 from pg_roles where rolname = $1`, [APP_ROLE]);
  if (existe.rows.length === 0) {
    await admin.query(APP_PASSWORD
      ? `create role ${APP_ROLE} login password ${litteral(APP_PASSWORD)}`
      : `create role ${APP_ROLE} login`);
    console.log(`rôle « ${APP_ROLE} » créé`);
  } else if (APP_PASSWORD) {
    await admin.query(`alter role ${APP_ROLE} password ${litteral(APP_PASSWORD)}`);
    console.log(`rôle « ${APP_ROLE} » présent, mot de passe aligné`);
  }

  /* UN SUPERUTILISATEUR CONTOURNE ENTIÈREMENT LE ROW-LEVEL SECURITY. Si le
   * rôle applicatif en est un, le produit n'a aucune frontière entre
   * établissements, et il vaut mille fois mieux s'arrêter ici que de le
   * découvrir en production. */
  const droits = await admin.query(
    `select rolsuper, rolbypassrls from pg_roles where rolname = $1`, [APP_ROLE]);
  if (droits.rows[0]?.rolsuper || droits.rows[0]?.rolbypassrls) {
    console.error(
      `\nREFUS : ${APP_ROLE} est superutilisateur ou porte BYPASSRLS.\n`
      + "Il contournerait tout le row-level security, et un établissement\n"
      + "verrait les élèves des autres. Retirez-lui ces attributs.");
    process.exit(1);
  }
  console.log(`rôle « ${APP_ROLE} » présent, non privilégié`);
} finally {
  await admin.end();
}

// ---------------------------------------------------------------------------
titre("migrations");
const cible = await connecter(urlCible);
try {
  /* ON LIT LE RÉPERTOIRE, on ne tient pas une liste. Une liste se désynchronise
   * — c'est arrivé quatre fois dans ce dépôt, d'où le témoin qui les compare. */
  const fichiers = readdirSync("db/migrations")
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  if (fichiers.length === 0) {
    console.error("Aucune migration trouvée dans db/migrations.");
    process.exit(1);
  }
  /* LA PREMIÈRE MIGRATION EST LA SEULE QUI NE SE REJOUE PAS.
   *
   * Le dépôt affirmait, dans son propre script : « chaque migration peut être
   * rejouée sans effet de bord ». C'est vrai de vingt-neuf sur trente. La
   * fondatrice, elle, crée ses tables sans `if not exists` — et ses index sans
   * nom, ce qui interdit le `if not exists` qu'on y mettrait. Rejouée, elle
   * s'arrête sur « relation "school_groups" already exists ».
   *
   * Sans conséquence tant qu'on ne préparait une base qu'une fois à la main.
   * Fatal dès que la préparation devient la commande de RELEASE : le premier
   * déploiement passerait, et tous les suivants échoueraient.
   *
   * On ne réécrit pas la fondatrice — on constate qu'elle a déjà tourné. Si
   * `schools` existe, le schéma est en place. Et pour que ce raisonnement ne
   * repose pas sur une mesure d'un jour, `tests/deploiement.e2e.mjs` vérifie
   * que TOUTES les autres se rejouent, contre une vraie base déjà migrée. */
  const dejaLa = (await cible.query(
    `select to_regclass('public.schools') is not null as oui`)).rows[0].oui;

  let appliquees = 0, sautees = 0;
  for (const f of fichiers) {
    if (dejaLa && /^0001_/.test(f)) {
      console.log(`${f} : le schéma existe déjà, migration fondatrice ignorée`);
      sautees += 1;
      continue;
    }
    const sql = readFileSync(join("db/migrations", f), "utf8");
    try {
      await cible.query(sql);
      appliquees += 1;
    } catch (e) {
      console.error(`\nÉCHEC sur ${f} :\n${e.message}`);
      process.exit(1);
    }
  }
  console.log(`${appliquees} migrations appliquées`
    + `${sautees ? `, ${sautees} ignorée(s)` : ""}`
    + ` (${fichiers[0]} → ${fichiers[fichiers.length - 1]})`);

  // -------------------------------------------------------------------------
  titre("droits de l'application");
  /* Le rôle applicatif lit et écrit les LIGNES. Il ne possède rien, ne crée
   * rien, n'altère aucune politique — c'est ce qui fait que le RLS s'applique
   * à lui. */
  await cible.query(`
    grant connect on database "${BASE}" to ${APP_ROLE};
    grant usage on schema public to ${APP_ROLE};
    grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
    grant usage, select on all sequences in schema public to ${APP_ROLE};
    grant execute on all functions in schema public to ${APP_ROLE};
    -- Les tables ajoutées par une migration future héritent des mêmes droits,
    -- sans quoi la première d'entre elles casserait l'application en silence.
    alter default privileges in schema public
      grant select, insert, update, delete on tables to ${APP_ROLE};
    alter default privileges in schema public
      grant usage, select on sequences to ${APP_ROLE};
    alter default privileges in schema public
      grant execute on functions to ${APP_ROLE};
  `);
  console.log("droits accordés (lecture-écriture des lignes, rien de plus)");

  // -------------------------------------------------------------------------
  titre("vérifications");

  /* AUCUNE TABLE PORTANT school_id N'ÉCHAPPE AU RLS. C'est l'unique frontière
   * entre deux établissements : une seule table oubliée, et elle est percée. */
  const sansRls = await cible.query(`
    select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = c.relname
                      and column_name = 'school_id')
       and not c.relrowsecurity
     order by c.relname`);
  if (sansRls.rows.length > 0) {
    console.error("\nREFUS : ces tables portent school_id sans row-level security :\n  "
      + sansRls.rows.map((r) => r.relname).join(", "));
    process.exit(1);
  }
  console.log("aucune table portant school_id n'échappe au RLS");

  /* LE RÔLE APPLICATIF NE POSSÈDE AUCUNE TABLE. Un propriétaire peut
   * supprimer les politiques qui le contiennent. */
  const possedees = await cible.query(`
    select count(*)::int as n from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.oid = c.relowner
     where n.nspname = 'public' and c.relkind = 'r' and r.rolname = $1`,
    [APP_ROLE]);
  if (Number(possedees.rows[0].n) > 0) {
    console.error(`\nREFUS : ${APP_ROLE} possède ${possedees.rows[0].n} table(s).`
      + "\nUn propriétaire peut supprimer les politiques de row-level security"
      + "\nqui sont l'unique frontière entre deux établissements.");
    process.exit(1);
  }
  console.log(`« ${APP_ROLE} » ne possède aucune table`);
} finally {
  await cible.end();
}

console.log(`\nBase « ${BASE} » prête.`);

/** Un littéral de chaîne SQL, guillemets simples doublés. */
function litteral(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
