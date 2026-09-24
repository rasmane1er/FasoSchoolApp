/**
 * Accès base — avec cloisonnement multi-établissement obligatoire.
 *
 * RÈGLE ABSOLUE : toute requête applicative passe par withSchool(). Le
 * row-level security de PostgreSQL lit schoolfaso.school_id dans la session ;
 * sans lui, aucune ligne n'est visible. C'est la base de données qui refuse,
 * pas le code qui doit se souvenir.
 *
 * L'utilisateur PostgreSQL de l'application NE DOIT PAS être superutilisateur :
 * un superutilisateur contourne entièrement le RLS.
 */

import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL absent. Voir .env.example.");
}

export const pool = new Pool({
  connectionString,
  max: Number(process.env.PGPOOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
});

/**
 * Exécute une fonction dans le contexte d'un établissement.
 *
 * set_config(..., true) rend le réglage LOCAL à la transaction : il disparaît
 * au COMMIT. Sans transaction, un réglage de session survivrait au retour du
 * client dans le pool et fuiterait vers la requête suivante — d'un autre
 * établissement.
 */
export async function withSchool<T>(
  schoolId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(schoolId)) {
    throw new Error("schoolId invalide");
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('schoolfaso.school_id', $1, true)", [schoolId]);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Requêtes hors établissement : référentiel national uniquement
 * (levels, series, roles, subjects nationales). Ne jamais l'utiliser pour
 * des données d'élèves.
 */
export async function withoutSchool<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * UNE VÉRIFICATION N'EST PAS UNE CONTRAINTE, ET UN REFUS DE LA BASE N'EST PAS
 * UNE PANNE.
 *
 * Quatre écrans gardaient un doublon par une lecture — « est-ce que ça existe
 * déjà ? » — puis écrivaient. Entre les deux, une autre requête passe : dix
 * clics simultanés sur « Ajouter la classe » créaient six « 6e Z ». La
 * migration 0032 pose les contraintes d'unicité qui manquaient ; la garde en
 * lecture reste, parce qu'elle donne le bon message SANS faire échouer une
 * transaction, et celle-ci rattrape le cas où deux gestes se croisent malgré
 * elle.
 *
 * `23505` est le code que PostgreSQL rend pour « violation d'unicité ».
 * L'écran doit alors dire la même chose que la garde en lecture — « cette
 * classe existe déjà » — et surtout PAS « erreur interne » : un utilisateur à
 * qui l'on répond « erreur » ne sait pas si son geste est passé, et
 * recommence. C'est la leçon du double-clic au guichet, à l'autre bout.
 *
 * La capture se fait AUTOUR de withSchool() et jamais dedans : une erreur
 * abandonne la transaction, et toute requête qui suivrait dans le même bloc
 * échouerait à son tour.
 */
export function estDoublon(e: unknown): boolean {
  return typeof e === "object" && e !== null
    && (e as { code?: string }).code === "23505";
}

/**
 * Le tour complet : on tente, et si la base refuse pour cause de doublon, on
 * rend le message de l'écran plutôt qu'une erreur.
 */
export async function sansDoublon<T extends { error?: string }>(
  message: string, fn: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    if (estDoublon(e)) return { error: message };
    throw e;
  }
}
