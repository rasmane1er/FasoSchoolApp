/**
 * Le registre de discipline.
 *
 * `behavior_incidents` dormait dans le schéma depuis le premier jour. Cette
 * suite éprouve les quatre points où un logiciel de discipline peut faire du
 * tort à un enfant :
 *
 *   - l'EXCLUSION DÉFINITIVE relève du conseil de discipline : la mettre dans
 *     la même liste que « avertissement » déplacerait un pouvoir réel, en
 *     silence. Elle est refusée à qui n'est pas chef d'établissement, y compris
 *     contre un POST fabriqué ;
 *   - une description vague est refusée : « indiscipline » ne dit rien à celui
 *     qui lira le registre au conseil, ni à l'élève à qui on l'oppose ;
 *   - on n'efface pas un incident, on le retire en le disant — il reste écrit,
 *     barré, avec le nom de qui l'a retiré et son motif ;
 *   - la famille est prévenue par le MÊME tuyau que les absences, donc avec le
 *     même suivi : un refus de l'opérateur remonte dans les messages à traiter
 *     au lieu de disparaître.
 *
 *   node tests/discipline.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4215;
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

const { rows: el } = await client.query(
  `select st.id, st.last_name, st.first_names from students st
    order by st.last_name limit 1`);
const eleve = el[0];

/* Le tuteur dont on fera refuser le numéro : le SMS de discipline doit
   emprunter le même tuyau que celui des absences, donc échouer pareil et se
   retrouver dans les messages à traiter. */
const { rows: gd } = await client.query(
  `select g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
    where sg.student_id = $1 and sg.receives_sms and g.phone <> '' limit 1`,
  [eleve.id]);
const telRefuse = gd[0]?.phone ?? "";

/* Les faits que cette suite écrit, énumérés : la purge les retire par leur
   texte EXACT, en plus des identifiants apparus pendant le passage. Sans cela,
   un passage qui meurt avant son `finally` — un port resté pris, par exemple —
   laisse des lignes qui font passer le suivant au vert pour de mauvaises
   raisons. C'est arrivé, et c'est ainsi qu'on croit tenir une règle. */
const FAITS = [
  "Indiscipline",
  "Insolence répétée envers la surveillante",
  "Insolence répétée en classe",
  "A quitté le cours sans autorisation aucune.",
  "A quitté le cours de mathématiques sans autorisation.",
  "Bavardages répétés signalés par trois professeurs.",
  "Exclusion de trois jours après bagarre dans la cour.",
  "Tentative de prononcer une exclusion définitive sans droit.",
  "Conseil de discipline du 12 juin : exclusion définitive.",
  "Écriture forcée depuis un compte enseignant.",
];

const snapshot = async () => ({
  incidents: new Set((await client.query(
    `select id from behavior_incidents`)).rows.map((r) => r.id)),
  sms: new Set((await client.query(`select id from sms_messages`)).rows.map((r) => r.id)),
});
const avant = await snapshot();

const purge = async () => {
  const apres = await snapshot();
  const ii = [...apres.incidents].filter((id) => !avant.incidents.has(id));
  const ss = [...apres.sms].filter((id) => !avant.sms.has(id));
  if (ii.length) await client.query(
    `delete from behavior_incidents where id = any($1::uuid[])`, [ii]);
  await client.query(
    `delete from behavior_incidents where description = any($1::text[])`,
    [FAITS]);
  if (ss.length) await client.query(
    `delete from sms_messages where id = any($1::uuid[])`, [ss]);
  await client.query(
    `delete from audit_log where action like 'discipline.%'`);
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock", SMS_MOCK_FAIL: telRefuse },
  stdio: ["ignore", "pipe", "pipe"],
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
const poster = (p, action, champs) => p.evaluate(async ({ action, champs }) => {
  const res = await fetch(action, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(champs).toString() });
  return { statut: res.status, corps: await res.text() };
}, { action, champs });

const incidents = async () => (await client.query(
  `select id, description, sanction, retracted_at, retraction_reason
     from behavior_incidents where student_id = $1
    order by created_at`, [eleve.id])).rows;

try {
  await connecter(page, "70000003");                      // surveillant général

  console.log("\nCe qui est refusé");
  /* On vérifie le REFUS, pas la présence de la phrase d'aide : celle-ci est
     sur l'écran en permanence, et l'y chercher ferait passer le test quoi qu'il
     arrive. C'est ainsi qu'on croit tenir une règle qu'on ne tient pas. */
  const vague = await poster(page, "/discipline",
    { eleve: eleve.id, description: "Indiscipline" });
  check("une étiquette d'un mot est refusée",
    vague.corps.includes('class="note bad"'),
    "au conseil, « indiscipline » n'est opposable à personne");
  check("et elle n'est pas écrite",
    (await incidents()).every((i) => i.description !== "Indiscipline"),
    "une longueur minimale ne suffit pas : « Indiscipline » fait 12 caractères");
  /* En revanche on n'exige pas une rédaction : un surveillant écrit vite,
     entre deux cours. Quatre mots qui décrivent un fait suffisent, et exiger
     davantage ferait écrire n'importe quoi pour passer le contrôle. */
  const bref = await poster(page, "/discipline",
    { eleve: eleve.id, description: "Insolence répétée envers la surveillante" });
  check("mais une phrase brève et réelle passe",
    bref.corps.includes("Fait consigné"),
    "exiger une rédaction ferait écrire n'importe quoi pour passer le contrôle");
  const sansEleve = await poster(page, "/discipline",
    { eleve: "", description: "A quitté le cours sans autorisation aucune." });
  // L'apostrophe est échappée à l'affichage : on cherche ce que la page
  // contient réellement, pas ce qu'on a tapé dans le code.
  check("un incident sans élève est refusé",
    sansEleve.corps.includes("Choisissez l&#39;élève"));

  console.log("\nL'EXCLUSION DÉFINITIVE N'APPARTIENT PAS AU SURVEILLANT");
  await page.goto(`${BASE}/discipline`);
  const vue = await page.content();
  check("elle n'est pas dans sa liste", !vue.includes("Exclusion définitive"));
  check("et l'écran dit pourquoi",
    vue.includes("relève du conseil de discipline"));
  const force = await poster(page, "/discipline", {
    eleve: eleve.id, sanction: "exclusion_definitive",
    description: "Tentative de prononcer une exclusion définitive sans droit." });
  check("LE REFUS EST SUR LE CHEMIN D'ÉCRITURE, PAS DANS LA LISTE",
    force.corps.includes("conseil de discipline"),
    "une liste déroulante filtrée ne protège personne");
  check("rien n'est écrit",
    (await incidents()).every((i) => i.sanction !== "exclusion_definitive"));

  console.log("\nConsigner");
  const ok = await poster(page, "/discipline", {
    eleve: eleve.id, sanction: "avertissement",
    description: "A quitté le cours de mathématiques sans autorisation." });
  check("le fait est consigné", ok.corps.includes("Fait consigné"));
  const posés = await incidents();
  check("il est en base avec sa sanction",
    posés.some((i) => i.sanction === "avertissement"), JSON.stringify(posés));

  const sansSanction = await poster(page, "/discipline", {
    eleve: eleve.id, sanction: "",
    description: "Bavardages répétés signalés par trois professeurs." });
  check("un fait peut être consigné SANS sanction",
    sansSanction.corps.includes("Fait consigné"),
    "c'est ce qui permet de dire au conseil qu'on a signalé sans jamais agir");

  console.log("\nLa famille est prévenue par le même tuyau que les absences");
  const avecSms = await poster(page, "/discipline", {
    eleve: eleve.id, sanction: "exclusion_temporaire", sms: "1",
    description: "Exclusion de trois jours après bagarre dans la cour." });
  check("le refus de l'opérateur est annoncé, pas masqué",
    avecSms.corps.includes("n&#39;est PAS parti"),
    "sinon la vie scolaire croit la famille prévenue");
  check("et il dit d'appeler", avecSms.corps.includes("Appelez-la"));

  const { rows: msg } = await client.query(
    `select status, resolution, error_detail from sms_messages
      where student_id = $1 order by queued_at desc limit 1`, [eleve.id]);
  check("le message échoué rejoint LE MÊME registre que les absences",
    msg[0]?.status === "echoue" && msg[0]?.resolution === null,
    JSON.stringify(msg[0] ?? {}));
  await page.goto(`${BASE}/messages`);
  check("et il apparaît dans les messages à traiter",
    (await page.content()).includes("mesure de discipline"),
    "un enfant exclu dont les parents ignorent tout est le cas à éviter");

  console.log("\nOn n'efface pas, on retire en le disant");
  await page.goto(`${BASE}/discipline`);
  const cible = (await incidents()).find((i) => i.sanction === "avertissement");
  const sansMotif = await poster(page, "/discipline/retirer",
    { incident: cible.id, motif: "" });
  check("un retrait sans motif est refusé", sansMotif.corps.includes("Dites pourquoi"));

  const MOTIF = "Erreur d'élève : il s'agissait de son homonyme de 6e A";
  const retrait = await poster(page, "/discipline/retirer",
    { incident: cible.id, motif: MOTIF });
  check("le retrait est accepté", retrait.corps.includes("Incident retiré"));
  const apres = (await incidents()).find((i) => i.id === cible.id);
  check("L'INCIDENT EXISTE TOUJOURS", Boolean(apres),
    "effacer détruit aussi ce qui pouvait servir en faveur de l'élève");
  check("il est marqué retiré avec son motif",
    apres.retracted_at !== null && apres.retraction_reason === MOTIF);

  await page.goto(`${BASE}/discipline`);
  const registre = await page.content();
  check("le registre le montre barré, pas disparu",
    registre.includes("<s>A quitté le cours de mathématiques"));
  check("avec le nom de qui l'a retiré",
    registre.includes("ZOUNGRANA Issa") && registre.includes("homonyme"));
  check("et il explique pourquoi on n'efface pas",
    registre.includes("ne prouve plus rien à personne"));
  await page.screenshot({ path: "out/captures/28-discipline.png", fullPage: true });

  const deuxFois = await poster(page, "/discipline/retirer",
    { incident: cible.id, motif: "Deuxième retrait pour voir ce qui se passe" });
  check("un incident déjà retiré ne se retire pas deux fois",
    deuxFois.corps.includes("déjà retiré"));

  console.log("\nLe chef d'établissement, lui, peut prononcer l'exclusion définitive");
  const chef = await browser.newContext({ locale: "fr-FR" });
  const p2 = await chef.newPage();
  await connecter(p2, "70000005");                        // directeur
  await p2.goto(`${BASE}/discipline`);
  check("elle est dans SA liste",
    (await p2.content()).includes("Exclusion définitive"));
  const prononce = await poster(p2, "/discipline", {
    eleve: eleve.id, sanction: "exclusion_definitive",
    description: "Conseil de discipline du 12 juin : exclusion définitive." });
  check("et il peut la prononcer", prononce.corps.includes("Fait consigné"));
  check("la base l'a acceptée",
    (await incidents()).some((i) => i.sanction === "exclusion_definitive"));
  await chef.close();

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p3 = await ens.newPage();
  await connecter(p3, "70000002");                        // enseignante
  const refus = await p3.goto(`${BASE}/discipline`);
  check("une enseignante ne tient pas le registre de discipline",
    refus.status() === 403, `HTTP ${refus.status()}`);
  const post = await poster(p3, "/discipline", {
    eleve: eleve.id, description: "Écriture forcée depuis un compte enseignant." });
  check("et n'y écrit pas davantage à la main", post.statut === 403,
    `HTTP ${post.statut}`);
  await ens.close();

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select distinct action from audit_log where action like 'discipline.%'`);
  check("consigner et retirer sont journalisés", journal.length === 2,
    journal.map((j) => j.action).join(", "));

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
console.log("Le registre de discipline est vérifié de bout en bout.");
