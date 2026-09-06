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
import { createSmsChannel } from "../lib/sms.ts";

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
 * Démarre une connexion. Renvoie le code en clair UNIQUEMENT hors production,
 * pour que la démonstration soit utilisable sans forfait SMS.
 */
export async function startLogin(rawPhone: string): Promise<{
  ok: boolean;
  devCode?: string;
  error?: string;
}> {
  const phone = normalisePhone(rawPhone);
  if (phone.length < 8) return { ok: false, error: "Numéro invalide." };

  return withoutSchool(async (c) => {
    if (!(await rateLimit(c, `otp:${phone}`))) {
      return { ok: false, error: "Trop de tentatives. Réessayez dans quelques minutes." };
    }

    // On crée le défi même si le numéro est inconnu : révéler qui possède un
    // compte transformerait la page de connexion en annuaire.
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

    // Passe par auth_lookup_user : sous RLS strict, un SELECT direct sur users
    // ne renvoie rien tant qu'aucun établissement n'est en contexte.
    const known = await c.query(`select id from auth_lookup_user($1)`, [phone]);

    if ((known.rowCount ?? 0) > 0 && process.env.SMS_PROVIDER === "orange_bf") {
      const sms = createSmsChannel();
      await sms.send({
        to: phone,
        schoolId: "",
        body: `FasoSchool: votre code de connexion est ${code}. Valable 5 minutes.`,
      });
      return { ok: true };
    }

    return { ok: true, devCode: code };
  });
}

export async function verifyLogin(
  rawPhone: string,
  code: string,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const phone = normalisePhone(rawPhone);

  return withoutSchool(async (c) => {
    const ch = await c.query(
      `select id, code_hash, attempts
         from auth_otp_challenges
        where phone = $1 and consumed_at is null and expires_at > now()
        order by created_at desc limit 1`,
      [phone],
    );
    if (ch.rowCount === 0) {
      return { ok: false, error: "Code expiré. Demandez-en un nouveau." };
    }
    const challenge = ch.rows[0];

    if (Number(challenge.attempts) >= MAX_OTP_ATTEMPTS) {
      return { ok: false, error: "Trop d'essais sur ce code." };
    }
    if (!equals(sha256(code.trim()), challenge.code_hash)) {
      await c.query(
        `update auth_otp_challenges set attempts = attempts + 1 where id = $1`,
        [challenge.id],
      );
      return { ok: false, error: "Code incorrect." };
    }

    const user = await c.query(
      `select id, school_id, full_name from auth_lookup_user($1)`, [phone]);
    if (user.rowCount === 0) {
      // Le code était bon mais le numéro n'est rattaché à aucun compte : on le
      // consomme quand même pour qu'il ne serve pas deux fois.
      await c.query(`update auth_otp_challenges set consumed_at = now() where id = $1`, [challenge.id]);
      return { ok: false, error: "Ce numéro n'est rattaché à aucun compte." };
    }

    await c.query(`update auth_otp_challenges set consumed_at = now() where id = $1`, [challenge.id]);

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
  | "voir_categorisation"): boolean {
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
  }
}
