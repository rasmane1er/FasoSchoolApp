/**
 * Le personnel.
 *
 * C'est le premier écran d'une installation, et il n'existait pas : seule
 * `scripts/demo.ts` créait des comptes. Un établissement réel devait ouvrir
 * psql pour inscrire son propre proviseur.
 *
 * Cette suite éprouve les quatre points où une erreur ne se rattrape pas :
 *
 *   - créer un compte, c'est donner accès à tout l'établissement : seul le
 *     chef d'établissement le peut, y compris contre un POST fabriqué ;
 *   - un numéro ouvre un seul compte, sinon l'un des deux ne se connecte
 *     jamais et personne ne comprend pourquoi ;
 *   - le dernier chef d'établissement ne peut être ni écarté ni rétrogradé —
 *     sinon l'établissement se ferme à clé, sans console de secours ;
 *   - une session ouverte ne survit pas à la désactivation de son titulaire.
 *
 *   node tests/personnel.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4211;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000005')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);

const NOUVEAU = "76554433";
const AUTRE = "76554400";

/* On retire par identifiant exact ce que cette suite a écrit : « OUEDRAOGO »
   est un nom de la démonstration, pas un marqueur de test. */
const snapshot = async () => ({
  users: new Set((await client.query(`select id from users`)).rows.map((r) => r.id)),
  staff: new Set((await client.query(`select id from staff`)).rows.map((r) => r.id)),
});
const avant = await snapshot();

const purge = async () => {
  const apres = await snapshot();
  const su = [...apres.staff].filter((id) => !avant.staff.has(id));
  const uu = [...apres.users].filter((id) => !avant.users.has(id));
  if (su.length) await client.query(`delete from staff where id = any($1::uuid[])`, [su]);
  if (uu.length) {
    await client.query(`delete from auth_sessions where user_id = any($1::uuid[])`, [uu]);
    await client.query(`delete from user_roles where user_id = any($1::uuid[])`, [uu]);
    await client.query(`delete from audit_log where actor_id = any($1::uuid[])`, [uu]);
    await client.query(`delete from users where id = any($1::uuid[])`, [uu]);
  }
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1250 }, locale: "fr-FR" });
const page = await ctx.newPage();

const connecter = async (p, tel) => {
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};
const envoyer = async (p, sel) =>
  Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click(sel)]);

const ajouter = async (nom, tel, fonction) => {
  await page.goto(`${BASE}/personnel`);
  await page.fill("#nom", nom);
  await page.fill("#telephone", tel);
  await page.selectOption("#fonction", fonction);
  await envoyer(page, 'form[action="/personnel"] button[type=submit]');
  return page.content();
};

const staffDe = async (tel) => (await client.query(
  `select st.id, st.fonction, st.is_active, u.is_active as u_actif, u.id as user_id
     from staff st join users u on u.id = st.user_id where u.phone = $1`,
  [tel])).rows[0];

try {
  await connecter(page, "70000005");                      // directeur

  console.log("\nCréer un compte");
  const cree = await ajouter("OUEDRAOGO Awa", "76 55 44 33", "enseignant");
  check("le compte est créé", cree.includes("peut se connecter"));
  check("l'écran rappelle qu'il n'y a pas de mot de passe",
    cree.includes("code à usage unique"));
  const awa = await staffDe(NOUVEAU);
  check("le membre du personnel existe en base", Boolean(awa));
  const { rows: role } = await client.query(
    `select role_code from user_roles where user_id = $1`, [awa.user_id]);
  check("la fonction porte le rôle du même nom",
    role[0]?.role_code === "enseignant",
    "sinon on est « enseignant » sans pouvoir saisir de notes");

  console.log("\nUn compte créé se connecte vraiment");
  const neuf = await browser.newContext({ locale: "fr-FR" });
  const p2 = await neuf.newPage();
  await connecter(p2, NOUVEAU);
  check("la nouvelle enseignante ouvre sa session",
    (await p2.content()).includes("OUEDRAOGO Awa"),
    "un compte qui ne se connecte pas n'est pas un compte");
  const versPersonnel = await p2.goto(`${BASE}/personnel`);
  check("mais elle ne gère pas le personnel", versPersonnel.status() === 403,
    `HTTP ${versPersonnel.status()}`);
  const postIntrus = await p2.evaluate(async () => {
    const res = await fetch("/personnel", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "nom=Intrus+Auto&telephone=76554401&fonction=proviseur" });
    return res.status;
  });
  check("ni en postant à la main un compte de proviseur", postIntrus === 403,
    `HTTP ${postIntrus}`);
  const { rows: intrus } = await client.query(
    `select count(*)::int as n from users where phone = '76554401'`);
  check("et rien n'est écrit", intrus[0].n === 0);

  console.log("\nCe qui est refusé à la création");
  check("un numéro déjà pris nomme la personne qui l'a",
    (await ajouter("Homonyme Auto", NOUVEAU, "enseignant"))
      .includes("OUEDRAOGO Awa"),
    "sinon la contrainte SQL remonte telle quelle et personne ne comprend");
  check("un numéro à 7 chiffres est refusé",
    (await ajouter("Court Auto", "7655443", "enseignant"))
      .includes("chiffres au lieu de 8"));
  check("un préfixe impossible est refusé",
    (await ajouter("Prefixe Auto", "31554433", "enseignant"))
      .includes("préfixe inhabituel"));
  check("un nom vide est refusé",
    (await ajouter("", AUTRE, "enseignant")).includes("nom complet"));
  const inventee = await page.evaluate(async () => {
    const res = await fetch("/personnel", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "nom=Fonction+Auto&telephone=76554402&fonction=ministre" });
    return await res.text();
  });
  check("une fonction inventée est refusée, même postée à la main",
    inventee.includes("existe pas dans un"));

  console.log("\nLe dernier chef d'établissement ne s'écarte pas");
  const chef = await staffDe("70000005");
  const seulChef = Number((await client.query(
    `select chefs_en_exercice() as n`)).rows[0].n);
  check("la démonstration n'a bien qu'un chef d'établissement", seulChef === 1,
    `${seulChef} — le scénario suivant suppose qu'il est seul`);

  const auto = await page.evaluate(async ({ id }) => {
    const res = await fetch("/personnel/activite", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ membre: id, actif: "0" }).toString() });
    return await res.text();
  }, { id: chef.id });
  check("il ne peut pas se désactiver lui-même",
    auto.includes("vous-même"), "l'écran se refermerait sur lui au clic suivant");

  const retro = await page.evaluate(async ({ id }) => {
    const res = await fetch("/personnel/fonction", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ membre: id, fonction: "secretaire" }).toString() });
    return await res.text();
  }, { id: chef.id });
  check("NI SE RÉTROGRADER : l'établissement se fermerait à clé",
    retro.includes("dernier chef"),
    "sans chef, plus personne ne gère le personnel et il n'y a aucune console");
  const encore = await staffDe("70000005");
  check("sa fonction n'a pas bougé", encore.fonction === chef.fonction,
    `${chef.fonction} → ${encore.fonction}`);

  console.log("\nAvec un successeur, le geste redevient possible");
  await ajouter("SANKARA Aline", AUTRE, "proviseur");
  const aline = await staffDe(AUTRE);
  check("un second chef d'établissement est nommé", aline?.fonction === "proviseur");
  const retro2 = await page.evaluate(async ({ id }) => {
    const res = await fetch("/personnel/fonction", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ membre: id, fonction: "censeur" }).toString() });
    return await res.text();
  }, { id: aline.id });
  check("le second, lui, peut être rétrogradé",
    retro2.includes("désormais censeur"), "il reste un chef en exercice");
  await client.query(`update staff set fonction = 'proviseur' where id = $1`, [aline.id]);
  await client.query(
    `insert into user_roles (user_id, role_code, school_id)
     values ($1,'proviseur',current_school_id()) on conflict do nothing`,
    [aline.user_id]);

  console.log("\nÉcarter quelqu'un ferme ses sessions ouvertes");
  const avantSession = (await client.query(
    `select count(*)::int as n from auth_sessions
      where user_id = $1 and revoked_at is null`, [awa.user_id])).rows[0].n;
  check("la session de l'enseignante est bien ouverte", avantSession >= 1);

  await page.goto(`${BASE}/personnel`);
  await envoyer(page,
    `xpath=//tr[.//td[normalize-space()="${NOUVEAU}"]]//button[normalize-space()="Écarter"]`);
  const ecartee = await page.content();
  check("l'écart est annoncé", ecartee.includes("n'a plus accès"));
  check("et dit que ce qu'elle a signé reste signé",
    ecartee.includes("reste signé"));

  const apresSession = (await client.query(
    `select count(*)::int as n from auth_sessions
      where user_id = $1 and revoked_at is null`, [awa.user_id])).rows[0].n;
  check("SES SESSIONS OUVERTES SONT RÉVOQUÉES", apresSession === 0,
    `${avantSession} → ${apresSession} : sinon elle continuerait depuis son téléphone`);

  const toujours = await p2.goto(`${BASE}/notes`);
  check("son onglet resté ouvert ne travaille plus",
    toujours.status() === 302 || toujours.url().includes("/connexion")
      || toujours.status() === 401 || toujours.status() === 403,
    `HTTP ${toujours.status()} sur ${toujours.url()}`);

  const { rows: reconnexion } = await client.query(
    `select count(*)::int as n from auth_lookup_user($1)`, [NOUVEAU]);
  check("et elle ne peut plus se reconnecter", reconnexion[0].n === 0);
  await neuf.close();

  console.log("\nRéintégrer");
  await page.goto(`${BASE}/personnel`);
  check("l'écartée reste visible, elle n'est pas effacée",
    (await page.content()).includes("OUEDRAOGO Awa"),
    "ses notes portent son nom : l'effacer arracherait la signature d'un bulletin");
  await envoyer(page,
    `xpath=//tr[.//td[normalize-space()="${NOUVEAU}"]]//button[normalize-space()="Réintégrer"]`);
  check("elle est réintégrée", (await page.content()).includes("de nouveau se connecter"));
  const revenue = await staffDe(NOUVEAU);
  check("son compte est rouvert", revenue.is_active && revenue.u_actif);
  await page.screenshot({ path: "out/captures/25-personnel.png", fullPage: true });

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select distinct action from audit_log
      where action in ('staff.create','staff.role','staff.deactivate','staff.reinstate')`);
  check("créer, changer, écarter et réintégrer sont journalisés",
    journal.length === 4, journal.map((j) => j.action).join(", "));

} finally {
  await browser.close();
  server.kill();
  await purge().catch(() => {});
  await client.query(
    `delete from audit_log where action in
       ('staff.create','staff.role','staff.deactivate','staff.reinstate')`)
    .catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("La gestion du personnel est vérifiée de bout en bout.");
