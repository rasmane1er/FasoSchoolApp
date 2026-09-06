/**
 * Accès base — avec cloisonnement multi-établissement obligatoire.
 *
 * RÈGLE ABSOLUE : toute requête applicative passe par withSchool(). Le
 * row-level security de PostgreSQL lit fasoschool.school_id dans la session ;
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
    await client.query("select set_config('fasoschool.school_id', $1, true)", [schoolId]);
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
