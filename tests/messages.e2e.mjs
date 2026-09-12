/**
 * Suivi des messages non remis.
 *
 * La deuxième promesse du logiciel est « la famille est prévenue le jour même
 * de l'absence ». Cette suite éprouve le cas où l'opérateur refuse — celui qui
 * décide si la promesse est tenue ou seulement affichée :
 *
 *   - un refus est enregistré AVEC sa raison, pas comme un envoi ;
 *   - il remonte au tableau de bord tant que personne ne s'en occupe ;
 *   - un renvoi n'efface pas la tentative ratée ;
 *   - un renvoi qui échoue reparaît, il ne disparaît pas parce qu'on a cliqué ;
 *   - un message parti ne se « traite » pas — sinon une case cochée
 *     prouverait un appel qui n'a jamais eu lieu ;
 *   - un échec ne débite pas le crédit.
 *
 *   node tests/messages.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4210;
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
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000003')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

/* On choisit un tuteur réel de la base de démonstration et on demande à
   l'adaptateur simulé de refuser SON numéro : sans un moyen de provoquer un
   échec, le chemin d'échec ne serait jamais parcouru — et c'est celui-là qui
   décide si une famille est prévenue. */
const { rows: gd } = await client.query(
  `select g.id, g.phone, g.full_name, sg.student_id
     from guardians g join student_guardians sg on sg.guardian_id = g.id
    where sg.receives_sms and g.phone is not null and g.phone <> ''
    order by g.full_name limit 1`);
const tuteur = gd[0];

const { rows: an } = await client.query(
  `select id from academic_years order by (status='en_cours') desc limit 1`);
const { rows: kl } = await client.query(
  `select cl.id from classes cl where cl.academic_year_id = $1 order by cl.label limit 1`,
  [an[0].id]);
const classe = kl[0].id;

/* Cette suite fait l'appel sur SA PROPRE journée. Réutiliser celle du jour
   rendrait le second passage muet : l'élève étant déjà marqué absent, aucun
   nouveau SMS ne partirait et la suite passerait au vert sans rien éprouver. */
/* Le 4 septembre 2026 était AVANT le 1er octobre, début de l'année scolaire de
   la démonstration : cette suite faisait l'appel un jour où il n'y avait pas
   école, et envoyait de vrais SMS pour l'éprouver. Le mercredi 14 octobre est
   un jour ouvert, sans séance de démonstration. */
const JOUR = "2026-10-14";
const purgeAppel = async () => {
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions
         where class_id = $1 and session_date = $2)`, [classe, JOUR]);
  await client.query(
    `delete from attendance_sessions where class_id = $1 and session_date = $2`,
    [classe, JOUR]);
};
await purgeAppel();

// Les messages posés par cette suite, retirés à la fin par leur identifiant
// exact : « SAWADOGO » est un nom de la démonstration, pas un marqueur de test.
const snapshot = async () => new Set((await client.query(
  `select id from sms_messages`)).rows.map((r) => r.id));
const avant = await snapshot();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock", SMS_MOCK_FAIL: tuteur.phone },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1150 }, locale: "fr-FR" });
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

const tuile = async (label) => Number((await page.$eval(
  `xpath=//div[@class="tile"][.//div[@class="k"][normalize-space()="${label}"]]//div[@class="v"]`,
  (el) => el.textContent.trim())).replace(/[^\d]/g, ""));

const creditActuel = async () => Number((await client.query(
  `select coalesce(sum(case when direction='achat' then messages
                            else -messages end),0)::int as n
     from sms_credit_ledger`)).rows[0].n);

try {
  await connecter(page, "70000003");                      // surveillant général

  console.log("\nUn refus de l'opérateur est enregistré comme tel");
  const creditAvant = await creditActuel();

  await page.goto(`${BASE}/absences?classe=${classe}&date=${JOUR}`);
  await page.waitForLoadState("networkidle");
  // On marque absent l'élève dont le tuteur porte le numéro refusé.
  const coche = await page.evaluate((sid) => {
    const inputs = [...document.querySelectorAll('input[value="absent"]')];
    const cible = inputs.find((i) => (i.name ?? "").includes(sid));
    (cible ?? inputs[0]).checked = true;
    return Boolean(cible);
  }, tuteur.student_id);
  check("l'élève dont le tuteur est injoignable est identifié dans l'appel",
    coche, "sinon la suite éprouverait un autre élève que celui qu'elle croit");
  await envoyer(page, "button[type=submit]");

  const { rows: msg } = await client.query(
    `select id, status, error_detail, cost_fcfa, resolution from sms_messages
      where to_phone = $1 order by queued_at desc limit 1`, [tuteur.phone]);
  check("le message refusé n'est pas compté comme envoyé",
    msg[0]?.status === "echoue", msg[0]?.status ?? "aucun message");
  check("la raison du refus est enregistrée",
    (msg[0]?.error_detail ?? "").includes("inconnu de l'opérateur"),
    msg[0]?.error_detail ?? "vide — « échoué » ne dit alors pas quoi faire");
  check("un message non parti ne coûte rien",
    Number(msg[0]?.cost_fcfa ?? -1) === 0, `${msg[0]?.cost_fcfa} FCFA débités`);
  check("le crédit SMS n'a pas bougé", (await creditActuel()) === creditAvant,
    `${creditAvant} → ${await creditActuel()}`);

  console.log("\nL'échec remonte, il ne dort pas dans une table");
  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");
  const dash = await page.content();
  check("le tableau de bord signale la famille non prévenue",
    dash.includes("n'est pas parvenu") || dash.includes("ne sont pas parvenus"),
    "sinon l'établissement croit avoir prévenu");
  check("et propose d'aller le traiter",
    /href="\/messages"/.test(dash));

  console.log("\nLe registre");
  await page.goto(`${BASE}/messages`);
  await page.waitForLoadState("networkidle");
  check("le message non remis y figure",
    (await page.content()).includes(tuteur.phone));
  check("le compteur « à traiter » n'est pas nul", (await tuile("À traiter")) >= 1);
  check("l'écran nomme la famille, pas seulement un numéro",
    (await page.content()).includes(tuteur.full_name));
  check("le texte du message est montré, pas seulement « non remis »",
    (await page.content()).includes("absent"),
    "une absence d'hier et une réunion demain n'appellent pas la même urgence");
  check("l'écran dit ce qu'il ne fait pas",
    (await page.content()).includes("ne corrige pas les numéros"),
    "un numéro faux se répare dans la fiche de l'élève, pas ici");
  await page.screenshot({ path: "out/captures/24-messages.png", fullPage: true });

  console.log("\nUn renvoi qui échoue encore reparaît");
  const avantRenvoi = (await client.query(
    `select count(*)::int as n from sms_messages where to_phone = $1`,
    [tuteur.phone])).rows[0].n;
  await envoyer(page, 'form[action="/messages/renvoyer"] button[type=submit]');
  const apresRenvoi = await page.content();
  check("le second échec est annoncé, pas masqué",
    apresRenvoi.includes("Le renvoi a échoué lui aussi"));
  check("il dit quoi faire ensuite",
    apresRenvoi.includes("appelez la famille"));

  const { rows: deux } = await client.query(
    `select status, resolution, error_detail from sms_messages
      where to_phone = $1 order by queued_at`, [tuteur.phone]);
  check("la tentative ratée n'est pas écrasée : une NOUVELLE ligne est écrite",
    deux.length === avantRenvoi + 1, `${avantRenvoi} → ${deux.length}`);
  check("la première garde sa raison",
    deux.some((d) => d.resolution === "reessaye" && d.error_detail),
    "un établissement doit pouvoir montrer ce qu'il a essayé");
  check("la seconde est à traiter à son tour",
    deux.some((d) => d.status === "echoue" && d.resolution === null));
  check("le crédit n'a toujours pas bougé", (await creditActuel()) === creditAvant);

  console.log("\n« Famille appelée » est une issue de plein droit");
  await page.goto(`${BASE}/messages`);
  await envoyer(page,
    'form[action="/messages/resoudre"] input[value="appele"] + button, '
    + 'form[action="/messages/resoudre"] button[type=submit]');
  check("l'issue est enregistrée",
    (await page.content()).includes("Message marqué"));
  const { rows: traite } = await client.query(
    `select resolution, resolved_by from sms_messages
      where to_phone = $1 and resolution is not null
        and resolution <> 'reessaye' limit 1`, [tuteur.phone]);
  check("elle porte le nom de qui l'a déclarée",
    traite[0]?.resolved_by !== null,
    "sans auteur, une case cochée ne prouve rien");

  console.log("\nCe qui est refusé");
  const partis = (await client.query(
    `select id from sms_messages where status = 'envoye' limit 1`)).rows[0];
  if (partis) {
    const r = await page.evaluate(async ({ id }) => {
      const body = new URLSearchParams({ message: id, issue: "appele" });
      const res = await fetch("/messages/resoudre", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString() });
      return await res.text();
    }, { id: partis.id });
    // L'apostrophe est échappée à l'affichage : on cherche ce que la page
    // contient réellement, pas ce qu'on a tapé dans le code.
    check("un message PARTI ne se « traite » pas, même en postant à la main",
      r.includes("rien à traiter"),
      "sinon une case cochée prouverait un appel qui n'a pas eu lieu");
  }

  const dejaTraite = (await client.query(
    `select id from sms_messages where resolution is not null limit 1`)).rows[0];
  const r2 = await page.evaluate(async ({ id }) => {
    const body = new URLSearchParams({ message: id, issue: "abandonne" });
    const res = await fetch("/messages/resoudre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString() });
    return await res.text();
  }, { id: dejaTraite.id });
  check("une issue déjà déclarée ne se réécrit pas",
    r2.includes("déjà été traité"), "l'historique n'est pas un brouillon");

  const r3 = await page.evaluate(async () => {
    const body = new URLSearchParams({
      message: "00000000-0000-0000-0000-000000000000", issue: "vacances" });
    const res = await fetch("/messages/resoudre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString() });
    return await res.text();
  });
  check("une issue inventée est refusée", r3.includes("Issue inconnue"));

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select action from audit_log where action in ('message.retry','message.resolve')`);
  check("renvoi et issue sont journalisés", journal.length >= 2,
    journal.map((j) => j.action).join(", "));

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                        // enseignante
  const acces = await p2.goto(`${BASE}/messages`);
  check("une enseignante ne tient pas le registre des messages",
    acces.status() === 403, `HTTP ${acces.status()}`);
  const post = await p2.evaluate(async () => {
    const res = await fetch("/messages/resoudre", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "message=x&issue=appele" });
    return res.status;
  });
  check("et pas davantage en postant à la main", post === 403, `HTTP ${post}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  // On ne retire que ce que cette suite a écrit, par identifiant exact.
  const apres = await snapshot();
  const nouveaux = [...apres].filter((id) => !avant.has(id));
  if (nouveaux.length) {
    await client.query(`delete from sms_messages where id = any($1::uuid[])`,
      [nouveaux]).catch(() => {});
  }
  await client.query(
    `update sms_messages set resolution = null, resolved_at = null,
                             resolved_by = null
      where id = any($1::uuid[])`, [[...avant]]).catch(() => {});
  await client.query(
    `delete from audit_log where action in ('message.retry','message.resolve')`)
    .catch(() => {});
  await purgeAppel().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Le suivi des messages non remis est vérifié de bout en bout.");
