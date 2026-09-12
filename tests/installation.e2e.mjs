/**
 * L'installation, du disque nu à la première connexion.
 *
 * Cette suite existe parce que le chemin le plus important du projet — celui
 * que suit un établissement le premier jour — n'avait JAMAIS été exécuté en
 * entier. Il ne marchait pas, et il échouait de trois façons :
 *
 *   1. `npm run db:migrate` lancé avec le rôle applicatif, comme le README le
 *      disait, s'arrête à la première ligne : « permission denied to create
 *      extension "uuid-ossp" » ;
 *   2. si on lui donnait ce droit, il deviendrait PROPRIÉTAIRE des tables — et
 *      un propriétaire peut supprimer les politiques de row-level security qui
 *      sont l'unique frontière entre deux établissements ;
 *   3. et rien, dans le chemin documenté, n'accordait au rôle applicatif le
 *      moindre droit sur les tables. La première requête aurait échoué.
 *
 * En écrivant les vérifications de `preparer-base.sh`, une quatrième chose est
 * apparue : `auth_sessions` — les sessions de TOUT le personnel, tous
 * établissements confondus — n'avait aucune politique RLS. Sa jumelle
 * `guardian_sessions` en avait une depuis la migration 0003.
 *
 * La suite refait donc le parcours complet, sur une base créée pour elle et
 * supprimée après : préparer, installer un établissement, se connecter, et
 * ouvrir chaque écran.
 *
 *   node tests/installation.e2e.mjs
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import pg from "pg";

const execFileP = promisify(execFile);
const PORT = 4218;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const NOM_BASE = "fasoschool_installation_controle";
const ROLE = "fasoschool_controle_app";
const TEL = "76998877";

/* On dérive les URL depuis DATABASE_URL : même hôte, même socket, rôle et base
   changés. La suite doit donc marcher partout où le reste tourne. */
const APP = process.env.DATABASE_URL ?? "";
const hote = APP.replace(/^postgres:\/\/[^@]*@[^/]*\/[^?]*/, "");
const adminSur = (base) => `postgres://postgres@/${base}${hote}`;

const sql = (base, texte) =>
  execFileP("psql", [adminSur(base), "-v", "ON_ERROR_STOP=1", "-tAc", texte])
    .then((r) => r.stdout.trim());

const nettoyer = async () => {
  await execFileP("psql", [adminSur("postgres"), "-c",
    `drop database if exists ${NOM_BASE}`]).catch(() => {});
  await execFileP("psql", [adminSur("postgres"), "-c",
    `drop role if exists ${ROLE}`]).catch(() => {});
};
await nettoyer();

let server = null;
let browser = null;

try {
  console.log("\nCe que la préparation refuse");
  const sansAdmin = await execFileP("bash", ["scripts/preparer-base.sh", NOM_BASE],
    { env: { ...process.env, ADMIN_DATABASE_URL: "", APP_ROLE: ROLE } })
    .then(() => ({ code: 0, stderr: "" }))
    .catch((e) => ({ code: e.code, stderr: e.stderr ?? "" }));
  check("sans URL d'administration, elle refuse",
    sansAdmin.code !== 0 && sansAdmin.stderr.includes("rôle applicatif ne le peut pas"),
    "les migrations créent des extensions et des tables");

  /* Un rôle applicatif superutilisateur contourne TOUT le row-level security.
     La préparation doit s'arrêter là plutôt que de livrer une base où chaque
     école voit les élèves des autres. */
  await execFileP("psql", [adminSur("postgres"), "-c",
    `create role ${ROLE} login superuser`]);
  const superu = await execFileP("bash", ["scripts/preparer-base.sh", NOM_BASE],
    { env: { ...process.env, ADMIN_DATABASE_URL: adminSur("postgres"), APP_ROLE: ROLE } })
    .then(() => ({ code: 0, stderr: "" }))
    .catch((e) => ({ code: e.code, stderr: e.stderr ?? "" }));
  check("UN RÔLE APPLICATIF SUPERUTILISATEUR EST REFUSÉ",
    superu.code !== 0 && superu.stderr.includes("contournerait"),
    "il verrait les élèves de tous les établissements à la fois");
  await execFileP("psql", [adminSur("postgres"), "-c",
    `alter role ${ROLE} nosuperuser`]);

  console.log("\nLa préparation d'une base neuve");
  const prep = await execFileP("bash", ["scripts/preparer-base.sh", NOM_BASE],
    { env: { ...process.env, ADMIN_DATABASE_URL: adminSur("postgres"), APP_ROLE: ROLE } });
  check("elle réussit", prep.stdout.includes("base prête"), prep.stderr.slice(-300));
  check("et elle a compté les politiques RLS elle-même",
    (prep.stdout + prep.stderr).includes("politiques RLS"),
    "une base livrée sans cloisonnement est pire qu'aucune base");

  const politiques = Number(await sql(NOM_BASE,
    "select count(*) from pg_policies where schemaname='public'"));
  check("le cloisonnement est complet", politiques >= 60, `${politiques} politiques`);

  const sansRls = Number(await sql(NOM_BASE, `
    select count(*) from information_schema.columns c
      join pg_class t on t.relname = c.table_name
      join pg_namespace n on n.oid = t.relnamespace and n.nspname='public'
     where c.table_schema='public' and c.column_name='school_id'
       and (not t.relrowsecurity or not t.relforcerowsecurity)`));
  check("AUCUNE TABLE PORTANT school_id N'ÉCHAPPE AU RLS", sansRls === 0,
    `${sansRls} table(s) — c'est ainsi qu'auth_sessions est restée ouverte`);

  const sessionsProtegees = await sql(NOM_BASE,
    "select relrowsecurity and relforcerowsecurity from pg_class where relname='auth_sessions'");
  check("les sessions du personnel sont protégées comme celles des familles",
    sessionsProtegees === "t",
    "elles portent l'empreinte du jeton de chaque agent, tous établissements confondus");

  const possedees = Number(await sql(NOM_BASE, `
    select count(*) from pg_class t
      join pg_namespace n on n.oid = t.relnamespace and n.nspname='public'
      join pg_roles r on r.oid = t.relowner
     where t.relkind='r' and r.rolname='${ROLE}'`));
  check("LE RÔLE APPLICATIF NE POSSÈDE AUCUNE TABLE", possedees === 0,
    "un propriétaire peut supprimer les politiques qui séparent les écoles");

  console.log("\nLe rôle applicatif peut travailler, et rien de plus");
  const appUrl = `postgres://${ROLE}@/${NOM_BASE}${hote}`;
  const c = new pg.Client({ connectionString: appUrl });
  await c.connect();
  const lecture = await c.query(`select count(*)::int as n from students`);
  check("il lit les tables", lecture.rows[0].n === 0, "base neuve : zéro élève");
  const creation = await c.query(`create table intrusion_controle (x int)`)
    .then(() => "acceptée").catch((e) => e.code);
  check("mais il ne crée pas de table", creation !== "acceptée", String(creation));
  await c.end();

  console.log("\nInstaller un établissement, puis s'en servir");
  const inst = await execFileP(process.execPath,
    ["--experimental-strip-types", "scripts/installer.ts",
     "--nom", "Lycée de contrôle", "--secteur", "public", "--zone", "rural",
     "--commune", "Ziniaré", "--chef", "TAPSOBA Salif",
     "--telephone", TEL, "--fonction", "proviseur", "--effet", "2026-10-01"],
    { env: { ...process.env, DATABASE_URL: appUrl } });
  check("l'installateur réussit avec le rôle applicatif",
    inst.stdout.includes("Établissement installé"),
    "il n'a besoin d'aucun privilège particulier, et il vaut mieux qu'il n'en ait pas");

  server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"],
    { env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock", DATABASE_URL: appUrl },
      stdio: ["ignore", "pipe", "pipe"] });
  let stderrSrv = ""; server.stderr.on("data", (d) => { stderrSrv += d.toString(); });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }

  browser = await chromium.launch({ executablePath: CHROME });
  const p = await (await browser.newContext({
    viewport: { width: 1440, height: 1100 }, locale: "fr-FR" })).newPage();
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", TEL);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");

  const accueil = await p.content();
  check("LE CHEF D'ÉTABLISSEMENT SE CONNECTE", accueil.includes("TAPSOBA Salif"),
    "c'est la seule preuve qui compte : la base livrée est utilisable");
  check("l'école installée porte son nom", accueil.includes("Lycée de contrôle"));
  check("et le tableau de bord dit quoi faire en premier",
    accueil.includes("Aucune année scolaire"),
    "une école neuve doit être guidée, pas laissée devant un écran vide");

  const liens = await p.$$eval(".side nav a",
    (as) => as.map((a) => a.getAttribute("href")));
  const casses = [];
  for (const h of liens) {
    if (h === "/deconnexion") continue;
    const r = await p.goto(`${BASE}${h}`);
    if (r.status() >= 400) casses.push(`${h} → ${r.status()}`);
  }
  check("AUCUN ÉCRAN NE CASSE SUR UNE BASE SANS DONNÉES",
    casses.length === 0 && liens.length >= 15,
    `${liens.length} écrans, cassés : ${casses.join(", ") || "aucun"}`);
  check("et le serveur n'a rien écrit sur sa sortie d'erreur",
    !/\berror\b/i.test(stderrSrv), stderrSrv.slice(0, 300));

  console.log("\nLe cloisonnement, entre la base neuve et la base de travail");
  const cDemo = new pg.Client({ connectionString: APP });
  await cDemo.connect();
  const { rows: ecoleNeuve } = await cDemo.query(
    `select count(*)::int as n from auth_lookup_user($1)`, [TEL]);
  check("le compte de la base neuve n'existe pas dans l'autre base",
    ecoleNeuve[0].n === 0,
    "deux bases distinctes, et rien ne traverse");
  await cDemo.end();

} finally {
  if (browser) await browser.close();
  if (server) server.kill();
  await nettoyer().catch(() => {});
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("L'installation complète est vérifiée, du disque nu à la première connexion.");
