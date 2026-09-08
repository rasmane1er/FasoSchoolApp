/**
 * Les cookies de session, et l'adresse qu'on envoie aux familles.
 *
 * Défaut trouvé le lendemain d'avoir construit l'envoi du lien aux familles :
 * NI L'UN NI L'AUTRE des deux cookies de session ne portait `Secure`.
 *
 * `fs_session` ouvre l'application du personnel. `fs_famille` ouvre le dossier
 * d'un enfant — notes, absences, discipline, numéros de la famille. Sans
 * `Secure`, ces jetons partent en clair dès qu'une requête passe en http : une
 * adresse tapée sans « s », un lien mal formé, un portail captif de cybercafé.
 * Et le logiciel venait justement de se mettre à ENVOYER cette adresse par SMS
 * à des parents qui l'ouvriront sur un téléphone, sur un réseau partagé.
 *
 * Deux corrections, éprouvées ici :
 *
 *   - `Secure` est posé dès que la connexion est en https — directement, ou
 *     derrière un reverse proxy qui l'annonce par `x-forwarded-proto`, ou
 *     parce que l'adresse publique déclarée est en https. Il n'est PAS posé en
 *     dur : cela interdirait toute connexion en développement local ;
 *   - et prévenir les familles est REFUSÉ tant que l'adresse publique est en
 *     http. On ne demande pas à un parent d'ouvrir le dossier de son enfant en
 *     clair sur le réseau.
 *
 *   node tests/cookies.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: ecole } = await client.query(
  `select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`,
  [ecole[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);

const serveurs = [];
const lancer = async (port, env) => {
  const s = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"],
    { env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"] });
  serveurs.push(s);
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/sante`)).ok) return s; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return s;
};

/* On lit l'en-tête Set-Cookie brut : c'est le seul endroit où `Secure`
   apparaît, et un navigateur ne le rend pas visible. */
const cookieDeConnexion = async (port, entetes = {}) => {
  const base = `http://127.0.0.1:${port}`;
  const demande = await fetch(`${base}/connexion`, {
    method: "POST", redirect: "manual", headers: {
      "content-type": "application/x-www-form-urlencoded", ...entetes },
    body: new URLSearchParams({ phone: "70000001" }).toString() });
  const page = await demande.text();
  const code = (page.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  if (!code) return { code: null, cookie: null };
  const verif = await fetch(`${base}/connexion/verifier`, {
    method: "POST", redirect: "manual", headers: {
      "content-type": "application/x-www-form-urlencoded", ...entetes },
    body: new URLSearchParams({ phone: "70000001", code }).toString() });
  return { code, cookie: verif.headers.get("set-cookie") ?? "" };
};

try {
  console.log("\nEn développement local, pas de Secure — sinon on ne se connecte plus");
  await lancer(4219, { FASOSCHOOL_PUBLIC_URL: "" });
  const local = await cookieDeConnexion(4219);
  check("la connexion aboutit", Boolean(local.cookie), "aucun cookie posé");
  check("le cookie est HttpOnly", /HttpOnly/i.test(local.cookie ?? ""));
  check("et SameSite=Lax", /SameSite=Lax/i.test(local.cookie ?? ""));
  check("mais pas Secure en http local", !/;\s*Secure/i.test(local.cookie ?? ""),
    "un cookie Secure n'est pas renvoyé en http : la connexion deviendrait "
      + "impossible en développement");

  console.log("\nDerrière un reverse proxy en https, Secure est posé");
  const derriere = await cookieDeConnexion(4219, { "x-forwarded-proto": "https" });
  check("SECURE EST POSÉ", /;\s*Secure/i.test(derriere.cookie ?? ""),
    derriere.cookie ?? "aucun cookie");
  check("et le reste ne change pas",
    /HttpOnly/i.test(derriere.cookie ?? "") && /SameSite=Lax/i.test(derriere.cookie ?? ""));

  console.log("\nAvec une adresse publique en https, Secure est posé aussi");
  await lancer(4220, { FASOSCHOOL_PUBLIC_URL: "https://wend-panga.example.bf" });
  const publique = await cookieDeConnexion(4220);
  check("Secure sans même l'en-tête du proxy",
    /;\s*Secure/i.test(publique.cookie ?? ""), publique.cookie ?? "");

  console.log("\nLe cookie des familles suit la même règle");
  const { rows: g } = await client.query(
    `select g.phone from guardians g
      where g.phone is not null and g.phone <> '' limit 1`);
  const demande = await fetch(`http://127.0.0.1:4220/famille/connexion`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: g[0].phone }).toString() });
  const codeFam = ((await demande.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  if (codeFam) {
    const verif = await fetch(`http://127.0.0.1:4220/famille/verifier`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone: g[0].phone, code: codeFam }).toString() });
    const cf = verif.headers.get("set-cookie") ?? "";
    check("LE COOKIE DE LA FAMILLE EST SECURE", /;\s*Secure/i.test(cf), cf);
    check("il reste cantonné à /famille", /Path=\/famille/i.test(cf),
      "une session de tuteur ne doit jamais atteindre les écrans du personnel");
  } else {
    check("le code famille est émis", false, "aucun code");
  }

  console.log("\nOn n'invite pas une famille à ouvrir un dossier en http");
  const { previenirFamilles } = await import("../src/server/cloture.ts");
  const sc = ecole;
  const { rows: kl } = await client.query(
    `select cl.id, t.id as term_id from classes cl
       join terms t on t.academic_year_id = cl.academic_year_id
      order by cl.label, t.sequence limit 1`);
  const faux = { userId: null, schoolId: sc[0].school_id, fullName: "Contrôle",
                 roles: ["censeur"], fonction: "censeur" };

  process.env.FASOSCHOOL_PUBLIC_URL = "http://wend-panga.example.bf";
  const enClair = await previenirFamilles(faux, kl[0].id, kl[0].term_id);
  check("L'ENVOI EST REFUSÉ EN HTTP",
    (enClair.error ?? "").includes("voyagerait en clair"),
    enClair.error ?? "aucun refus");
  check("et le refus dit quoi faire", (enClair.error ?? "").includes("https"));
  check("rien n'est parti", enClair.envoyes === 0);

  process.env.FASOSCHOOL_PUBLIC_URL = "http://localhost:4180";
  const enLocal = await previenirFamilles(faux, kl[0].id, kl[0].term_id);
  check("mais localhost reste accepté : c'est le développement, pas une famille",
    !(enLocal.error ?? "").includes("voyagerait en clair"),
    enLocal.error ?? "");

} finally {
  serveurs.forEach((s) => s.kill());
  await client.query(
    `delete from sms_messages where body like '%bulletins du%trimestre sont disponibles%'`)
    .catch(() => {});
  await client.query(
    `delete from sms_credit_ledger where note = 'Avis de disponibilité des bulletins'`)
    .catch(() => {});
  await client.query(`delete from audit_log where action = 'bulletin.notify'`)
    .catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Les cookies de session et l'adresse envoyée aux familles sont vérifiés.");
