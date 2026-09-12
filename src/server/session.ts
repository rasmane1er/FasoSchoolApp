/**
 * Authentification par téléphone et code à usage unique.
 *
 * Pas de mot de passe : au Burkina Faso l'identifiant d'une personne est son
 * numéro, pas une adresse e-mail. Le canal SMS existe déjà pour les absences,
 * donc l'OTP ne coûte rien de plus à mettre en place.
 *
 * Les jetons ne sont jamais stockés en clair : seul leur SHA-256 est en base.
 * Un vol de la table de sessions ne donne aucune session utilisable.
 */

import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { withoutSchool } from "../lib/db.ts";
import { createSmsChannel, verdictCanal } from "../lib/sms.ts";

const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const MAX_OTP_ATTEMPTS = 5;
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_HITS = 6;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

/** Comparaison à temps constant, pour ne pas fuiter le code par la durée. */
function equals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Normalise un numéro burkinabè : on ne garde que les chiffres. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.startsWith("226") ? digits.slice(3) : digits;
}

export interface SessionUser {
  userId: string;
  schoolId: string | null;
  fullName: string;
  roles: string[];
  fonction: string | null;
}

async function rateLimit(c: PoolClient, key: string): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / RATE_WINDOW_MS) * RATE_WINDOW_MS);
  const r = await c.query(
    `insert into auth_rate_limits (bucket_key, window_start, hits)
     values ($1, $2, 1)
     on conflict (bucket_key, window_start)
       do update set hits = auth_rate_limits.hits + 1
     returning hits`,
    [key, windowStart],
  );
  return Number(r.rows[0].hits) <= RATE_MAX_HITS;
}

/**
 * Émet un code à usage unique pour ce numéro.
 *
 * Le défi est créé MÊME si le numéro est inconnu : répondre différemment
 * transformerait la page de connexion en annuaire — on saurait qui possède un
 * compte en essayant des numéros.
 *
 * `known` dit seulement s'il faut réellement envoyer un SMS. Le code en clair
 * n'est renvoyé qu'à défaut d'envoi, pour que la démonstration soit utilisable
 * sans forfait.
 *
 * Partagé par le personnel et par les familles : deux portes, un seul mécanisme
 * de code, une seule limitation de débit.
 */
export async function issueOtp(
  rawPhone: string,
  isKnown: (phone: string, c: PoolClient) => Promise<boolean>,
): Promise<{ ok: boolean; devCode?: string; error?: string }> {
  const phone = normalisePhone(rawPhone);
  if (phone.length < 8) return { ok: false, error: "Numéro invalide." };

  return withoutSchool(async (c) => {
    if (!(await rateLimit(c, `otp:${phone}`))) {
      return { ok: false, error: "Trop de tentatives. Réessayez dans quelques minutes." };
    }

    const code = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, "0");

    await c.query(
      `insert into auth_otp_challenges (phone, code_hash, expires_at)
       values ($1, $2, now() + interval '5 minutes')`,
      [phone, sha256(code)],
    );
    await c.query(
      `delete from auth_otp_challenges
        where expires_at < now() - interval '1 hour'`,
    );

    const connu = await isKnown(phone, c);
    const canal = verdictCanal();

    /* LE CODE NE S'AFFICHE QUE SI RIEN NE PART — ET SEULEMENT LÀ.
     *
     * Avant, la condition était `process.env.SMS_PROVIDER === "orange_bf"` :
     * toute autre valeur, y compris l'absence de valeur, renvoyait le code en
     * clair, que la page affiche. Il suffisait de connaître le numéro d'un
     * censeur. Le serveur refuse désormais de démarrer sans canal déclaré, et
     * ce test-ci ne regarde plus une chaîne d'environnement mais le verdict :
     * le code n'est rendu QUE par l'adaptateur de démonstration. */
    if (canal.simule) return { ok: true, devCode: code };

    // Numéro inconnu : on ne l'a pas dit plus haut pour ne pas faire de cette
    // page un annuaire, et on ne le dit pas ici non plus. Rien ne part.
    if (!connu) return { ok: true };

    const sms = createSmsChannel();
    const corps = `FasoSchool: votre code de connexion est ${code}. `
      + `Valable 5 minutes.`;
    const envoi = await sms.send({ to: phone, schoolId: "", body: corps });

    /* UN ENVOI RATÉ N'EST PAS UN ENVOI.
     *
     * Le résultat était ignoré : crédit épuisé, ligne résiliée, panne
     * d'opérateur — la page répondait « un code vous a été envoyé », personne
     * ne recevait rien, l'utilisateur réessayait, et au bout de cinq essais la
     * limitation de débit le mettait dehors de son propre logiciel. Sans un
     * seul mot pour dire pourquoi.
     *
     * On le dit, avec la raison de l'opérateur, et on ANNULE le défi : le
     * garder ouvert n'a pas de sens quand personne n'a le code, et le laisser
     * consommer un essai punirait l'utilisateur d'une panne qui n'est pas la
     * sienne. */
    if (!envoi.ok) {
      await c.query(`delete from auth_otp_challenges
                      where phone = $1 and consumed_at is null`, [phone]);
      await c.query(`delete from auth_rate_limits where bucket_key = $1`,
        [`otp:${phone}`]);
      return { ok: false, error:
        `Le code n'a pas pu être envoyé : ${envoi.error ?? "refus de l'opérateur"}. `
        + `Prévenez l'établissement — ce n'est pas votre numéro qui est en cause.` };
    }

    return { ok: true };
  });
}

/**
 * Consomme un code. Un code juste est consommé même si le numéro ne mène à
 * rien : il ne doit jamais pouvoir servir deux fois.
 */
export async function consumeOtp(
  c: PoolClient, rawPhone: string, code: string,
): Promise<{ ok: boolean; error?: string }> {
  const phone = normalisePhone(rawPhone);
  const ch = await c.query(
    `select id, code_hash, attempts
       from auth_otp_challenges
      where phone = $1 and consumed_at is null and expires_at > now()
      order by created_at desc limit 1`,
    [phone],
  );
  if (ch.rowCount === 0) return { ok: false, error: "Code expiré. Demandez-en un nouveau." };
  const challenge = ch.rows[0];

  if (Number(challenge.attempts) >= MAX_OTP_ATTEMPTS) {
    return { ok: false, error: "Trop d'essais sur ce code." };
  }
  if (!equals(sha256(code.trim()), challenge.code_hash)) {
    await c.query(
      `update auth_otp_challenges set attempts = attempts + 1 where id = $1`,
      [challenge.id]);
    return { ok: false, error: "Code incorrect." };
  }
  await c.query(`update auth_otp_challenges set consumed_at = now() where id = $1`,
    [challenge.id]);
  return { ok: true };
}

/** Démarre une connexion du personnel. */
export async function startLogin(rawPhone: string): Promise<{
  ok: boolean;
  devCode?: string;
  error?: string;
}> {
  // Passe par auth_lookup_user : sous RLS strict, un SELECT direct sur users
  // ne renvoie rien tant qu'aucun établissement n'est en contexte.
  return issueOtp(rawPhone, async (phone, c) =>
    ((await c.query(`select id from auth_lookup_user($1)`, [phone])).rowCount ?? 0) > 0);
}

export async function verifyLogin(
  rawPhone: string,
  code: string,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const phone = normalisePhone(rawPhone);

  return withoutSchool(async (c) => {
    const otp = await consumeOtp(c, phone, code);
    if (!otp.ok) return { ok: false, error: otp.error };

    const user = await c.query(
      `select id, school_id, full_name from auth_lookup_user($1)`, [phone]);
    if (user.rowCount === 0) {
      return { ok: false, error: "Ce numéro n'est rattaché à aucun compte." };
    }

    const token = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    await c.query(`select auth_create_session($1,$2,$3,$4)`,
      [user.rows[0].id, user.rows[0].school_id, sha256(token), sha256(refresh)]);

    return { ok: true, token };
  });
}

export async function resolveSession(token: string | null): Promise<SessionUser | null> {
  if (!token) return null;

  return withoutSchool(async (c) => {
    const r = await c.query(
      `select user_id, school_id, full_name, fonction, roles from auth_resolve($1)`,
      [sha256(token)]);
    if (r.rowCount === 0) return null;

    return {
      userId: r.rows[0].user_id,
      schoolId: r.rows[0].school_id,
      fullName: r.rows[0].full_name,
      roles: r.rows[0].roles ?? [],
      fonction: r.rows[0].fonction ?? null,
    };
  });
}

export async function revokeSession(token: string): Promise<void> {
  await withoutSchool(async (c) => {
    await c.query(`select auth_revoke($1)`, [sha256(token)]);
  });
}

/** Le censeur publie, le surveillant général fait l'appel, l'économe encaisse. */
export function can(user: SessionUser, action:
  | "voir_notes" | "saisir_notes" | "publier_bulletins"
  | "faire_appel" | "voir_scolarite" | "encaisser"
  | "voir_categorisation" | "parametrer" | "inscrire"
  | "suivre_messages" | "gerer_personnel" | "voir_eleve"
  | "tenir_discipline"): boolean {
  const r = new Set([...user.roles, user.fonction ?? ""]);
  const any = (...codes: string[]) => codes.some((x) => r.has(x));

  switch (action) {
    case "voir_notes":
      return any("proviseur", "directeur", "censeur", "enseignant", "surveillant_general");
    case "saisir_notes":
      return any("enseignant", "censeur", "proviseur", "directeur");
    case "publier_bulletins":
      return any("censeur", "proviseur", "directeur");
    case "faire_appel":
      return any("surveillant_general", "enseignant", "censeur", "proviseur", "directeur");
    case "voir_scolarite":
      return any("intendant", "econome", "proviseur", "directeur");
    case "encaisser":
      return any("intendant", "econome");
    case "voir_categorisation":
      return any("proviseur", "directeur");
    // Le censeur possède les règles de notation : c'est lui qui les connaît.
    case "parametrer":
      return any("censeur", "proviseur", "directeur");
    // L'inscription se fait au secrétariat, sous l'autorité du chef
    // d'établissement. Le censeur en est, parce qu'il constitue les classes.
    case "inscrire":
      return any("secretaire", "censeur", "proviseur", "directeur");
    // Un message d'absence non remis est une tâche de vie scolaire : c'est le
    // surveillant général qui rappelle la famille. Le secrétariat en est parce
    // que c'est lui qui corrige un numéro faux.
    case "suivre_messages":
      return any("surveillant_general", "secretaire", "econome", "intendant",
                 "censeur", "proviseur", "directeur");
    // Créer un compte, c'est donner accès à tout l'établissement. Le geste
    // appartient au chef d'établissement seul : un censeur qui pourrait
    // ajouter du personnel pourrait se nommer proviseur.
    case "gerer_personnel":
      return any("proviseur", "directeur");
    // La fiche porte les numéros de téléphone d'une famille. Un enseignant n'en
    // a pas besoin pour faire cours : quand il faut joindre des parents, cela
    // passe par la vie scolaire, qui elle en répond. Modifier reste réservé à
    // « inscrire » — voir n'est pas corriger.
    case "voir_eleve":
      return any("secretaire", "surveillant_general", "econome", "intendant",
                 "censeur", "proviseur", "directeur");
    // Le cahier de discipline est celui du surveillant général. Le censeur et
    // le chef y ont accès parce qu'ils le lisent au conseil de classe et au
    // conseil de discipline ; l'exclusion définitive, elle, reste au chef seul
    // (voir discipline.ts).
    case "tenir_discipline":
      return any("surveillant_general", "censeur", "proviseur", "directeur");
  }
}
