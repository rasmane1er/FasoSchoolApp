/**
 * L'installation d'un établissement.
 *
 * C'est le geste zéro : avant lui il n'existe ni compte ni base pour cette
 * école. Il ne peut pas se faire depuis l'application — il faut être connecté
 * pour ouvrir un écran, et il n'existe encore aucun compte à connecter.
 *
 * Cette suite installe un VRAI second établissement dans la même base, puis
 * vérifie les deux choses qui décident si le logiciel est utilisable et sûr :
 *
 *   - le chef d'établissement installé se connecte réellement, et l'école est
 *     immédiatement utilisable (référentiel national posé, écrans ouverts) ;
 *   - le CLOISONNEMENT tient : cette école ne voit pas un seul élève, une
 *     seule note, un seul franc de l'autre. C'est la promesse la plus lourde
 *     du produit, et elle est éprouvée ici sur deux établissements réels, pas
 *     sur un jeu d'essai.
 *
 * L'établissement installé est intégralement supprimé à la fin.
 *
 *   node tests/installer.e2e.mjs
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium } from "playwright";
import pg from "pg";

const execFileP = promisify(execFile);
const PORT = 4214;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const NOM = "Lycée Municipal de Koudougou (installation automatique)";
const TEL = "76900011";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

const { rows: demo } = await client.query(
  `select school_id from auth_lookup_user('70000005')`);
const ecoleDemo = demo[0].school_id;

const installer = (args) => execFileP(process.execPath,
  ["--experimental-strip-types", "scripts/installer.ts", ...args],
  { env: process.env }).then((r) => ({ ...r, code: 0 }))
  .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 }));

/* `schools` est sous RLS : sans contexte on ne voit rien, y compris ce qu'on
   vient de créer. On retrouve donc l'établissement par son unique compte, dont
   la recherche passe par auth_lookup_user (security definer). */
const purge = async () => {
  const { rows } = await client.query(
    `select school_id from auth_lookup_user($1)`, [TEL]);
  for (const s of rows) {
    await client.query(`select set_config('fasoschool.school_id', $1, false)`,
      [s.school_id]);
    // ON DELETE CASCADE emporte tout ce qui pend à l'établissement.
    await client.query(`delete from schools where id = $1`, [s.school_id])
      .catch(() => {});
  }
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const connecter = async (p, tel) => {
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent(".note.warn b")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};

try {
  console.log("\nCe que l'installation refuse");
  const sansChef = await installer(["--nom", NOM, "--secteur", "public",
    "--zone", "chef_lieu"]);
  check("un établissement SANS CHEF est refusé",
    sansChef.code !== 0 && sansChef.stderr.includes("ne peut plus jamais être ouvert"),
    "un établissement sans compte est inaccessible pour toujours");
  const { rows: rien } = await client.query(
    `select count(*)::int as n from schools where name = $1`, [NOM]);
  check("et rien n'est écrit", rien[0].n === 0, `${rien[0].n} créés`);

  const secteurFaux = await installer(["--nom", NOM, "--secteur", "prive",
    "--chef", "X Y", "--telephone", TEL]);
  check("un secteur inconnu est refusé",
    secteurFaux.stderr.includes("secteur inconnu"));

  const telCourt = await installer(["--nom", NOM, "--secteur", "public",
    "--chef", "OUEDRAOGO Awa", "--telephone", "7690001"]);
  check("un numéro à 7 chiffres est refusé",
    telCourt.stderr.includes("chiffres au lieu de 8"));

  const telPris = await installer(["--nom", NOM, "--secteur", "public",
    "--chef", "OUEDRAOGO Awa", "--telephone", "70000005"]);
  check("un numéro DÉJÀ pris est refusé, en nommant son titulaire",
    telPris.stderr.includes("déjà l'identifiant"),
    "auth_lookup_user s'arrête au premier trouvé : le second ne se connecterait jamais");

  const pasChef = await installer(["--nom", NOM, "--secteur", "public",
    "--chef", "OUEDRAOGO Awa", "--telephone", TEL, "--fonction", "enseignant"]);
  check("le premier compte doit être un chef d'établissement",
    pasChef.stderr.includes("chef d'établissement"),
    "c'est lui qui crée ensuite tous les autres");

  const { rows: toujours } = await client.query(
    `select count(*)::int as n from schools where name = $1`, [NOM]);
  check("aucun de ces refus n'a laissé de trace", toujours[0].n === 0);

  console.log("\nL'installation");
  const ok = await installer(["--nom", NOM, "--secteur", "public",
    "--zone", "chef_lieu", "--commune", "Koudougou", "--region", "Centre-Ouest",
    "--chef", "SAWADOGO Rasmane", "--telephone", TEL,
    "--fonction", "proviseur", "--effet", "2026-10-01"]);
  check("elle réussit", ok.code === 0, ok.stderr.slice(0, 300));
  check("elle dit la suite à faire depuis l'application",
    ok.stdout.includes("Année scolaire") && ok.stdout.includes("Personnel"));
  check("et rappelle que les règles de notation restent à confirmer",
    ok.stdout.includes("restent indicatives"),
    "sinon un établissement croit ses moyennes définitives dès le premier jour");

  /* On retrouve l'établissement par l'identifiant que l'installateur imprime :
     `schools` est sous RLS comme le reste, et sans contexte posé la table ne
     renvoie rien — y compris à cette suite. C'est exactement ce qu'on veut. */
  const ecole = (ok.stdout.match(
    /identifiant interne : ([0-9a-f-]{36})/) ?? [])[1];
  check("l'installateur imprime l'identifiant de l'établissement",
    Boolean(ecole), "sans lui, une école installée est introuvable en base");
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [ecole]);

  const { rows: ec } = await client.query(
    `select id, sector, fee_zone, commune from schools where id = $1`, [ecole]);
  check("l'établissement existe", ec.length === 1);
  check("avec sa zone tarifaire", ec[0].fee_zone === "chef_lieu",
    "c'est elle qui décide du plafond de frais applicable");
  const { rows: seed } = await client.query(
    `select (select count(*)::int from grading_policies) as regles,
            (select count(*)::int from coefficient_sets) as coefficients,
            (select count(*)::int from mention_bands) as mentions`);
  check("le référentiel national est posé",
    seed[0].regles > 0 && seed[0].coefficients > 0 && seed[0].mentions > 0,
    JSON.stringify(seed[0]));
  const { rows: staff } = await client.query(
    `select st.fonction, u.phone from staff st join users u on u.id = st.user_id`);
  check("le chef d'établissement est le seul compte",
    staff.length === 1 && staff[0].fonction === "proviseur" && staff[0].phone === TEL,
    JSON.stringify(staff));

  console.log("\nIl se connecte, et l'école est utilisable");
  const neuf = await browser.newContext({ locale: "fr-FR" });
  const p1 = await neuf.newPage();
  await connecter(p1, TEL);
  const accueil = await p1.content();
  check("LE COMPTE INSTALLÉ OUVRE VRAIMENT UNE SESSION",
    accueil.includes("SAWADOGO Rasmane"),
    "un compte qui ne se connecte pas n'est pas un compte");
  check("l'école installée porte son nom", accueil.includes("Koudougou"));

  const liens = await p1.$$eval(".side nav a", (as) => as.map((a) => a.getAttribute("href")));
  const refuses = [];
  for (const h of liens) {
    if (h === "/deconnexion") continue;
    const r = await p1.goto(`${BASE}${h}`);
    if (r.status() === 403 || r.status() >= 500) refuses.push(`${h} → ${r.status()}`);
  }
  check("aucun écran de la barre ne casse dans une école toute neuve",
    refuses.length === 0, refuses.join(", "));

  console.log("\nLe cloisonnement, sur deux établissements réels");
  await p1.goto(`${BASE}/eleves?q=ZONGO`);
  check("il ne trouve AUCUN élève de l'autre établissement",
    (await p1.content()).includes("Aucun élève"),
    "c'est la promesse la plus lourde du produit");

  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [ecole]);
  const { rows: vus } = await client.query(
    `select (select count(*)::int from students) as eleves,
            (select count(*)::int from grade_entries) as notes,
            (select count(*)::int from invoices) as factures,
            (select count(*)::int from payments) as paiements`);
  check("et la base ne lui montre ni élève, ni note, ni facture, ni paiement",
    vus[0].eleves === 0 && vus[0].notes === 0
      && vus[0].factures === 0 && vus[0].paiements === 0,
    JSON.stringify(vus[0]));

  // Et dans l'autre sens : la démonstration n'a rien gagné.
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [ecoleDemo]);
  const { rows: dem } = await client.query(
    `select count(*)::int as n from staff where full_name = 'SAWADOGO Rasmane'`);
  check("l'établissement de démonstration ne voit pas le nouveau personnel",
    dem[0].n === 0);
  const { rows: comptes } = await client.query(
    `select count(*)::int as n from users`);
  check("ni le nouveau compte", comptes[0].n === 5,
    `${comptes[0].n} comptes visibles depuis la démonstration`);

  console.log("\nUne seconde installation du même numéro est refusée");
  const doublon = await installer(["--nom", NOM + " bis", "--secteur", "public",
    "--chef", "AUTRE Personne", "--telephone", TEL]);
  check("le numéro déjà installé ne se réutilise pas",
    doublon.stderr.includes("déjà l'identifiant"), doublon.stderr.slice(0, 200));
  const { rows: bis } = await client.query(
    `select count(*)::int as n from schools where name = $1`, [NOM + " bis"]);
  check("et l'établissement refusé n'existe pas — tout ou rien", bis[0].n === 0,
    "un établissement à demi installé est pire qu'aucun");

  await neuf.close();

} finally {
  await browser.close();
  server.kill();
  await purge().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("L'installation d'un établissement est vérifiée de bout en bout.");
