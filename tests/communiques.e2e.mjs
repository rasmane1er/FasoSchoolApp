/**
 * Communiqués aux familles.
 *
 * Le SMS coûte de l'argent réel à un établissement qui en a peu. Ce test
 * vérifie donc surtout les trois décisions qui protègent sa trésorerie et sa
 * parole :
 *
 *   - le coût est annoncé AVANT l'envoi ;
 *   - un tuteur de plusieurs enfants reçoit UN message ;
 *   - un crédit insuffisant refuse l'envoi EN BLOC, jamais à moitié.
 *
 *   node tests/communiques.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4201;
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
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

const OBJET = "Objet de vérification";
const purge = async () => {
  await client.query(`delete from sms_messages where body like '%verification%'`);
  await client.query(`delete from announcements where title = $1`, [OBJET]);
  await client.query(`delete from sms_credit_ledger where note like $1`, [`%${OBJET}%`]);
  await client.query(
    `delete from sms_credit_ledger where note = 'Recharge de vérification'`);
};
await purge();

/* Un tuteur reçoit DEUX enfants le temps du test : son numéro ne doit
   apparaître qu'une fois dans la liste des destinataires. */
const { rows: deuxEnfants } = await client.query(
  `select sg.guardian_id, g.phone, sg.student_id from student_guardians sg
     join guardians g on g.id = sg.guardian_id
    where g.phone is not null and g.phone <> '' limit 1`);
const { rows: orphelin } = await client.query(
  `select st.id from students st
    where not exists (select 1 from student_guardians x where x.student_id = st.id)
    limit 1`);
let rattachementTemporaire = false;
if (orphelin[0]) {
  await client.query(
    `insert into student_guardians (student_id, guardian_id, school_id, receives_sms)
     values ($1, $2, current_school_id(), true) on conflict do nothing`,
    [orphelin[0].id, deuxEnfants[0].guardian_id]);
  rattachementTemporaire = true;
}


/* CETTE SUITE NE DOIT PAS DÉPENDRE DE L'HEURE QU'IL EST.
 *
 * Elle affirme que des messages PARTENT. Or la garde des heures de silence —
 * 21 h → 6 h par défaut, heure de Ouagadougou — refuse les envois en masse la
 * nuit. La suite passait donc en journée et échouait le soir, sur des
 * assertions dont le message ne parlait pas du tout d'horaire.
 *
 * Une suite possède les réglages dont dépendent ses assertions. On pose une
 * fenêtre de silence CALCULÉE pour exclure l'instant présent, et c'est
 * PostgreSQL qui la calcule, dans le fuseau de l'école, puisque c'est lui qui
 * l'évaluera. L'ancienne est remise à la fin. */
const { rows: fenetreInitiale } = await client.query(
  `select sms_quiet_from, sms_quiet_to from schools limit 1`);
await client.query(
  `update schools
      set sms_quiet_from = (timezone('Africa/Ouagadougou', now())
                            + interval '2 hours')::time,
          sms_quiet_to   = (timezone('Africa/Ouagadougou', now())
                            + interval '3 hours')::time`);
const rendreLaFenetre = async () => {
  await client.query(`update schools set sms_quiet_from = $1, sms_quiet_to = $2`,
    [fenetreInitiale[0].sms_quiet_from, fenetreInitiale[0].sms_quiet_to]);
};

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: "fr-FR" });
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

/* Deux fois le même message, l'un sans accents, l'autre avec. Plus de 70 mais
   moins de 160 caractères : c'est exactement la plage où les accents font
   basculer d'un segment à deux, et donc doublent la facture. */
const COURT = "Reunion des parents samedi 12 septembre a 9h dans la cour du "
  + "college. Presence des deux parents souhaitee. verification";
const ACCENTUE = "Réunion des parents samedi 12 septembre à 9h dans la cour du "
  + "collège. Présence des deux parents souhaitée. verification";

const composer = async (corps, cible = "tous") => {
  const u = new URL(`${BASE}/communiques`);
  u.searchParams.set("titre", OBJET);
  u.searchParams.set("corps", corps);
  u.searchParams.set("cible", cible);
  await page.goto(u.toString());
  await page.waitForSelector(".tiles");
  return page.content();
};

const tuile = async (label) => Number(await page.$eval(
  `xpath=//div[@class="tile"][.//div[@class="k"][normalize-space()="${label}"]]//div[@class="v"]`,
  (el) => el.textContent.trim().replace(/[^\d-]/g, "")));

try {
  await connecter(page, "70000001");                      // censeur

  console.log("\nLe coût est annoncé avant l'envoi");
  const vue = await composer(COURT);
  check("le nombre de destinataires est affiché", (await tuile("Destinataires")) > 0);
  check("un message court tient en un segment", (await tuile("Segments")) === 1);
  const cout = await tuile("Coût");
  const dest = await tuile("Destinataires");
  check("le coût est le produit destinataires × segments × 8 F", cout === dest * 8,
    `${cout} pour ${dest} destinataires`);
  check("le crédit restant après envoi est montré", vue.includes("Crédit après envoi"));

  console.log("\nLes accents coûtent le double");
  await composer(ACCENTUE);
  check("un message accentué passe à deux segments",
    (await tuile("Segments")) === 2,
    "les accents font tomber la limite de 160 à 70 caractères");
  check("le surcoût est expliqué, pas seulement subi",
    (await page.content()).includes("retirer les"));

  console.log("\nUn tuteur, un message");
  await composer(COURT);
  const { rows: tuteurs } = await client.query(
    `select count(distinct g.phone)::int as n from enrolments e
       join student_guardians sg on sg.student_id = e.student_id
       join guardians g on g.id = sg.guardian_id
      where sg.receives_sms and g.phone is not null and g.phone <> ''`);
  check("les destinataires sont dédoublonnés par numéro",
    (await tuile("Destinataires")) === tuteurs[0].n,
    `${await tuile("Destinataires")} affichés pour ${tuteurs[0].n} numéros distincts`);
  await page.screenshot({ path: "out/captures/20-communiques.png", fullPage: true });

  console.log("\nEnvoi");
  const { rows: avant } = await client.query(
    `select coalesce(sum(case when direction='achat' then messages else -messages end),0)::int as n
       from sms_credit_ledger`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click('form[action="/communiques"][method="post"] button[type=submit]'),
  ]);
  check("l'envoi est confirmé avec son coût",
    (await page.content()).includes("familles prévenues")
    || (await page.content()).includes("famille prévenue"));

  const { rows: envoyes } = await client.query(
    `select count(*)::int as n, count(distinct to_phone)::int as num
       from sms_messages where body = $1`, [COURT]);
  check("un message par tuteur, pas un par élève",
    envoyes[0].n === envoyes[0].num && envoyes[0].n === dest,
    `${envoyes[0].n} messages pour ${envoyes[0].num} numéros`);

  const { rows: apres } = await client.query(
    `select coalesce(sum(case when direction='achat' then messages else -messages end),0)::int as n
       from sms_credit_ledger`);
  check("le crédit est débité du montant annoncé",
    avant[0].n - apres[0].n === dest, `${avant[0].n} → ${apres[0].n} pour ${dest} messages`);

  const { rows: trace } = await client.query(
    `select title, status from announcements where title = $1`, [OBJET]);
  check("le communiqué est conservé, pas seulement envoyé",
    trace[0]?.status === "publie");
  check("il apparaît dans l'historique",
    (await page.content()).includes(OBJET));

  console.log("\nCrédit insuffisant");
  // On vide le crédit, puis on tente un envoi.
  await client.query(
    `insert into sms_credit_ledger (school_id, direction, messages, note)
     values (current_school_id(), 'consommation', $1, 'Recharge de vérification')`,
    [apres[0].n]);

  const sansCredit = await composer(COURT);
  check("l'insuffisance est annoncée avant l'envoi",
    sansCredit.includes("Crédit insuffisant"));

  const refus = await page.evaluate(async ([titre, corps]) => {
    const body = new URLSearchParams();
    body.set("titre", titre); body.set("corps", corps); body.set("cible", "tous");
    const r = await fetch("/communiques", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    return await r.text();
  }, [OBJET, COURT + " bis"]);
  // Le texte est échappé dans la page : on cherche la partie sans apostrophe.
  check("l'envoi est refusé EN BLOC",
    refus.includes("Crédit insuffisant") && refus.includes("a été envoyé"),
    "mieux vaut aucun communiqué qu'un communiqué reçu par la moitié des familles");
  const { rows: rien } = await client.query(
    `select count(*)::int as n from sms_messages where body = $1`, [COURT + " bis"]);
  check("aucun message partiel n'est parti", rien[0].n === 0, `${rien[0].n} partis`);
  check("le message saisi n'est pas perdu après un refus", refus.includes(COURT + " bis"));

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");                        // enseignante
  const r = await p2.goto(`${BASE}/communiques`);
  check("une enseignante n'écrit pas aux familles au nom de l'établissement",
    r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  if (rattachementTemporaire && orphelin[0]) {
    await client.query(
      `delete from student_guardians where student_id = $1 and guardian_id = $2`,
      [orphelin[0].id, deuxEnfants[0].guardian_id]).catch(() => {});
  }
  await purge().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await rendreLaFenetre().catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Communiqués vérifiés de bout en bout.");
