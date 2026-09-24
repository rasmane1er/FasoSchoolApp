/**
 * Import de la liste des élèves : le scénario de rentrée.
 *
 * Le fichier envoyé est un vrai export d'Excel francophone — Windows-1252,
 * séparateur point-virgule — parce que c'est ce que les établissements
 * possèdent, et parce qu'un accent cassé à cette étape se retrouve ensuite sur
 * chaque bulletin de l'année.
 *
 *   node tests/import.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4190;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

/* Le fichier tel qu'Excel l'écrit sous Windows : Windows-1252, pas UTF-8. */
function win1252(text) {
  const out = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i);
    out[i] = c < 256 ? c : 0x3f;   // hors table : « ? », comme Excel
  }
  return out;
}

const LISTE = [
  "Matricule;NOM;Prénom(s);Sexe;Né(e) le;Classe;Nom du tuteur;Téléphone;Redoublant",
  // 1. propre, avec accent — ne doit rien déclencher
  ";SAWADOGO;Adiara;F;14/05/2014;6e B;SAWADOGO Boukaré;70 45 67 89;non",
  // 2. déjà en base : réinscription, jamais un doublon
  "WP-2026-0001;BAMBARA;Alizèta;F;11/02/2014;6e B;;;non",
  // 3. date impossible : bloquée tant qu'elle n'est pas corrigée
  ";TRAORÉ;Moussa;M;31/02/2013;6e B;TRAORÉ Ali;+226 76 11 22 33;oui",
  // 4. numéro trop court : signalé, mais la ligne passe
  ";ZONGO;Fatimata;F;02/09/2013;6e B;ZONGO Awa;7612;non",
  // 5. doublon de la ligne 2 du fichier : bloqué
  ";SAWADOGO;Adiara;F;14/05/2014;6e B;;;non",
  // 6. aucun nom : bloqué
  ";;Inconnu;M;01/01/2014;6e B;;;non",
].join("\r\n");

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000001')`);
const schoolId = sc[0].school_id;
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [schoolId]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

/*
 * Le test doit pouvoir tourner deux fois de suite, et surtout ne pas abîmer
 * l'établissement de démonstration : plusieurs de ses élèves portent les mêmes
 * NOMS que la liste importée ici — SAWADOGO, TRAORÉ, ZONGO sont des patronymes
 * courants. Effacer « par nom de famille » emporterait de vrais élèves.
 *
 * On relève donc les identifiants présents AVANT l'import, et on ne retire
 * ensuite que ce qui n'y était pas.
 */
const NOMS_DU_TEST = [["SAWADOGO", "Adiara"], ["TRAORÉ", "Moussa"], ["ZONGO", "Fatimata"]];

const ceuxDuTest = async () => (await client.query(
  `select id from students where (last_name, first_names) in
     (($1,$2),($3,$4),($5,$6)) and id <> all($7::uuid[])`,
  [...NOMS_DU_TEST.flat(), avantImport])).rows.map((r) => r.id);

const purge = async () => {
  const ids = await ceuxDuTest();
  if (ids.length > 0) {
    await client.query(`delete from student_guardians where student_id = any($1::uuid[])`, [ids]);
    await client.query(`delete from enrolments where student_id = any($1::uuid[])`, [ids]);
    await client.query(`delete from students where id = any($1::uuid[])`, [ids]);
    await client.query(`delete from guardians where phone in ('70456789','76112233')`);
  }
  await rendreLesInscriptions();
};

/* CE QUE L'IMPORT MODIFIE SANS CRÉER : L'INSCRIPTION D'UN ÉLÈVE DÉJÀ CONNU.
 *
 * La liste importée contient volontairement le matricule `WP-2026-0001`, qui
 * existe déjà : c'est l'assertion « l'élève déjà connu est marqué réinscrit ».
 * `roster.ts` fait alors un upsert sur son inscription et passe son statut de
 * `inscrit` à `reinscrit`.
 *
 * La purge ci-dessus ne rendait que ce qu'elle avait CRÉÉ. Le statut de cet
 * élève-là restait donc `reinscrit` après chaque `check:all`, définitivement.
 * Une suite possède ce qu'elle emprunte autant que ce qu'elle crée — sinon la
 * plainte sort ailleurs : ici, une autre suite refusant de partir d'un jeu
 * qu'elle ne reconnaissait plus. */
const INSCRIPTIONS_AVANT = (await client.query(
  `select id, status, class_id, is_redoublant from enrolments`)).rows;
const rendreLesInscriptions = async () => {
  for (const e of INSCRIPTIONS_AVANT) {
    await client.query(
      `update enrolments set status = $2, class_id = $3, is_redoublant = $4
        where id = $1 and (status, class_id, is_redoublant)
                       is distinct from ($2, $3, $4)`,
      [e.id, e.status, e.class_id, e.is_redoublant]);
  }
};

// Instantané de départ : tout ce qui existe déjà est intouchable.
const avantImport = (await client.query(`select id from students`)).rows.map((r) => r.id);
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "fr-FR" });
const page = await ctx.newPage();

const compte = async (p, tel) => {
  await p.goto(`${BASE}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};

try {
  await compte(page, "70000001");        // censeur

  console.log("\nDépôt du fichier");
  await page.goto(`${BASE}/inscriptions`);
  await page.waitForSelector("input[type=file]");
  check("l'écran d'inscription est accessible au censeur",
    (await page.content()).includes("Inscrire des élèves"));

  const classeId = await page.$eval("select[name=classe] option:nth-child(2)", (o) => o.value);
  await page.selectOption("select[name=classe]", classeId);
  await page.setInputFiles("input[type=file]", {
    name: "eleves.csv", mimeType: "text/csv", buffer: win1252(LISTE),
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);

  console.log("\nAperçu");
  const apercu = await page.content();
  check("l'encodage d'Excel est reconnu", apercu.includes("windows-1252"), "encodage annoncé");
  check("les accents sont intacts", apercu.includes("Alizèta") && apercu.includes("TRAOR"),
    "un « Ã¨ » ici et l'année entière est fausse");
  check("aucun accent cassé", !apercu.includes("Ã"), "mojibake détecté");

  const tuile = async (label) => Number(await page.$eval(
    `xpath=//div[@class="tile"][.//div[@class="k"][normalize-space()="${label}"]]//div[@class="v"]`,
    (el) => el.textContent.trim()));

  check("quatre lignes sont retenues", await tuile("À inscrire") === 4, `${await tuile("À inscrire")}`);
  check("deux lignes sont bloquées", await tuile("Bloquées") === 2, `${await tuile("Bloquées")}`);
  check("la réinscription est reconnue", await tuile("Réinscriptions") === 1,
    "BAMBARA Alizèta est déjà en base");

  check("la date impossible est signalée", apercu.includes("impossible"));
  check("le numéro trop court est signalé", apercu.includes("4 chiffres"));
  check("le doublon interne est signalé", apercu.includes("même nom et même date"));
  check("la ligne sans nom est bloquée", apercu.includes("aucun nom"));
  check("rien n'est encore enregistré",
    apercu.includes("Rien n'est encore enregistré"));

  const avant = await client.query(`select count(*)::int as n from students`);

  console.log("\nCorrection dans l'aperçu");
  // La date impossible se corrige ici, pas dans Excel.
  const champDate = page.locator('input[name$="_dateOfBirth"]').first();
  check("la ligne fautive est modifiable sur place", await champDate.count() === 1);
  await champDate.fill("28/02/2013");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);

  console.log("\nAprès import");
  const bilan = await page.content();
  check("l'import est confirmé", bilan.includes("Inscription terminée"));

  const cree = await client.query(
    `select st.id, st.matricule, st.last_name, st.first_names, st.sex,
            to_char(st.date_of_birth,'YYYY-MM-DD') as dn, cl.label as classe
       from students st
       left join enrolments e on e.student_id = st.id
       left join classes cl on cl.id = e.class_id
      where st.id = any($1::uuid[]) order by st.last_name`, [await ceuxDuTest()]);

  check("trois nouveaux élèves sont créés", cree.rowCount === 3,
    cree.rows.map((r) => r.last_name).join(", "));
  check("l'accent est en base, pas du mojibake",
    cree.rows.some((r) => r.last_name === "TRAORÉ"),
    cree.rows.map((r) => r.last_name).join(", "));
  check("la correction de l'aperçu est celle qui est enregistrée",
    cree.rows.find((r) => r.last_name === "TRAORÉ")?.dn === "2013-02-28",
    cree.rows.find((r) => r.last_name === "TRAORÉ")?.dn);
  check("un matricule est attribué quand le fichier n'en donne pas",
    cree.rows.every((r) => !!r.matricule));
  check("les matricules attribués sont distincts",
    new Set(cree.rows.map((r) => r.matricule)).size === 3);
  check("la classe est affectée", cree.rows.every((r) => r.classe));

  const dupli = await client.query(
    `select count(*)::int as n from students where matricule = 'WP-2026-0001'`);
  check("l'élève déjà connu n'est pas dupliqué", dupli.rows[0].n === 1);

  const reins = await client.query(
    `select status from enrolments e join students st on st.id = e.student_id
      where st.matricule = 'WP-2026-0001'`);
  check("l'élève déjà connu est marqué réinscrit",
    reins.rows[0]?.status === "reinscrit", reins.rows[0]?.status);

  const tut = await client.query(
    `select g.phone, g.full_name from guardians g
       join student_guardians sg on sg.guardian_id = g.id
       join students st on st.id = sg.student_id
      where st.last_name = 'SAWADOGO' and st.first_names = 'Adiara'`);
  check("le numéro du tuteur est ramené à huit chiffres",
    tut.rows[0]?.phone === "70456789", tut.rows[0]?.phone);
  check("le tuteur porte son nom", tut.rows[0]?.full_name === "SAWADOGO Boukaré");

  const zongo = await client.query(
    `select count(*)::int as n from student_guardians sg
       join students st on st.id = sg.student_id
      where st.last_name = 'ZONGO' and st.first_names = 'Fatimata'`);
  check("un numéro illisible ne crée pas de faux tuteur", zongo.rows[0].n === 0,
    "mieux vaut pas de numéro qu'un mauvais numéro");

  const apres = await client.query(`select count(*)::int as n from students`);
  check("seules les lignes valides sont écrites",
    apres.rows[0].n - avant.rows[0].n === 3,
    `${apres.rows[0].n - avant.rows[0].n} créations`);

  await page.goto(`${BASE}/inscriptions`);
  await page.screenshot({ path: "out/captures/10-inscriptions.png", fullPage: true });

  console.log("\nRejeu du même fichier");
  // Le secrétaire renvoie le fichier par erreur. Aucun élève ne doit doubler.
  await page.setInputFiles("input[type=file]", {
    name: "eleves.csv", mimeType: "text/csv", buffer: win1252(LISTE),
  });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);
  await page.screenshot({ path: "out/captures/11-apercu-import.png", fullPage: true });
  check("au second dépôt, tout est reconnu comme réinscription",
    await tuile("Réinscriptions") === 4, `${await tuile("Réinscriptions")}`);
  check("le rejeu ne propose aucune création",
    await tuile("À inscrire") === 4 && await tuile("Bloquées") === 2,
    "les mêmes lignes restent bloquées");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);
  const total = await client.query(
    `select count(*)::int as n from students where id = any($1::uuid[])`, [await ceuxDuTest()]);
  check("le rejeu ne crée aucun doublon", total.rows[0].n === 3, `${total.rows[0].n} fiches`);

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await compte(p2, "70000002");                       // enseignante
  const r = await p2.goto(`${BASE}/inscriptions`);
  check("une enseignante ne peut pas inscrire", r.status() === 403, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await browser.close();
  server.kill();
  // On rend la base comme on l'a trouvée : sans cela, chaque exécution
  // grossit l'établissement de démonstration et la suite suivante travaille
  // sur des effectifs qui ne sont pas ceux qu'elle attend.
  await purge().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2000));
  process.exit(1);
}
console.log("Import de la liste des élèves vérifié de bout en bout.");
