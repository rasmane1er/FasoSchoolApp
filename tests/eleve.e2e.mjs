/**
 * La fiche de l'élève.
 *
 * Cette suite existe parce qu'une phrase d'un autre écran était fausse : le
 * suivi des messages dit qu'un numéro erroné « se répare dans la fiche de
 * l'élève », et cette fiche n'existait pas. Elle éprouve donc d'abord la
 * boucle complète — un SMS revient en échec, on tient un numéro, on retrouve
 * l'élève par ce numéro, on corrige — puis les quatre points où une erreur
 * coûte cher :
 *
 *   - un tuteur est PARTAGÉ : corriger son numéro corrige toute la fratrie,
 *     et l'écran le dit avant, pas après ;
 *   - un numéro déjà connu rattache le tuteur existant au lieu de le
 *     dupliquer, sinon une mère de trois élèves reçoit trois communiqués ;
 *   - détacher le dernier tuteur n'est pas interdit, il est ANNONCÉ ;
 *   - voir n'est pas corriger : le surveillant lit la fiche, le secrétariat
 *     seul y écrit — y compris contre un POST fabriqué à la main.
 *
 *   node tests/eleve.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4212;
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
await client.query(`delete from auth_sessions`);

const { rows: el } = await client.query(
  `select st.id, st.last_name, st.first_names, st.matricule, st.sex,
          st.date_of_birth, st.place_of_birth
     from students st order by st.last_name limit 2`);
const eleve = el[0];
const frere = el[1];

/* L'état d'origine des deux élèves et de leurs tuteurs, restitué à la fin :
   la démonstration doit ressortir de cette suite exactement comme elle y est
   entrée. */
const rangs = {
  identites: (await client.query(
    `select id, last_name, first_names, sex, date_of_birth, place_of_birth
       from students where id = any($1::uuid[])`,
    [[eleve.id, frere.id]])).rows,
  liens: (await client.query(
    `select * from student_guardians where student_id = any($1::uuid[])`,
    [[eleve.id, frere.id]])).rows,
  tuteurs: (await client.query(
    `select g.* from guardians g
      where exists (select 1 from student_guardians sg
                     where sg.guardian_id = g.id
                       and sg.student_id = any($1::uuid[]))`,
    [[eleve.id, frere.id]])).rows,
};

const snapshotG = async () => new Set((await client.query(
  `select id from guardians`)).rows.map((r) => r.id));
const avantG = await snapshotG();

const restaurer = async () => {
  const apres = await snapshotG();
  const neufs = [...apres].filter((id) => !avantG.has(id));
  await client.query(
    `delete from emergency_contacts where student_id = any($1::uuid[])`,
    [[eleve.id, frere.id]]).catch(() => {});
  await client.query(
    `delete from student_guardians where student_id = any($1::uuid[])`,
    [[eleve.id, frere.id]]).catch(() => {});
  if (neufs.length) {
    await client.query(`delete from sms_messages where guardian_id = any($1::uuid[])`,
      [neufs]).catch(() => {});
    await client.query(`delete from guardians where id = any($1::uuid[])`,
      [neufs]).catch(() => {});
  }
  for (const g of rangs.tuteurs) {
    await client.query(
      `insert into guardians (id, school_id, full_name, phone, phone_alt)
       values ($1, current_school_id(), $2, $3, $4)
       on conflict (id) do update set full_name = excluded.full_name,
                                      phone = excluded.phone`,
      [g.id, g.full_name, g.phone, g.phone_alt]).catch(() => {});
  }
  for (const l of rangs.liens) {
    await client.query(
      `insert into student_guardians (student_id, guardian_id, school_id,
                                      relationship, is_primary, receives_sms)
       values ($1,$2,current_school_id(),$3,$4,$5) on conflict do nothing`,
      [l.student_id, l.guardian_id, l.relationship, l.is_primary,
       l.receives_sms]).catch(() => {});
  }
  for (const s of rangs.identites) {
    await client.query(
      `update students set last_name=$2, first_names=$3, sex=$4,
                           date_of_birth=$5, place_of_birth=$6 where id=$1`,
      [s.id, s.last_name, s.first_names, s.sex, s.date_of_birth,
       s.place_of_birth]).catch(() => {});
  }
  await client.query(
    `delete from audit_log where action like 'student.%'`).catch(() => {});
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 }, locale: "fr-FR" });
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

const tuteursDe = async (id) => (await client.query(
  `select g.id, g.full_name, g.phone, sg.receives_sms
     from student_guardians sg join guardians g on g.id = sg.guardian_id
    where sg.student_id = $1 order by g.full_name`, [id])).rows;

try {
  await connecter(page, "70000005");                      // directeur

  console.log("\nLa boucle que cet écran existe pour fermer");
  const tuteurs0 = await tuteursDe(eleve.id);
  const numero = tuteurs0[0]?.phone;
  check("l'élève de démonstration a bien un tuteur joignable", Boolean(numero));

  await page.goto(`${BASE}/eleves?q=${numero}`);
  await page.waitForLoadState("networkidle");
  check("ON RETROUVE L'ÉLÈVE PAR LE NUMÉRO DE SON TUTEUR",
    (await page.content()).includes(eleve.last_name),
    "un message en échec ne laisse souvent qu'un numéro");

  await page.goto(`${BASE}/eleves?q=${eleve.last_name}`);
  check("et par son nom", (await page.content()).includes(eleve.matricule));
  await page.goto(`${BASE}/eleves?q=${eleve.matricule}`);
  check("et par son matricule", (await page.content()).includes(eleve.last_name));
  await page.goto(`${BASE}/eleves?q=ZZZINCONNU`);
  check("une recherche vide le dit au lieu d'afficher une page blanche",
    (await page.content()).includes("Aucun élève"));

  console.log("\nLa fiche");
  await page.goto(`${BASE}/eleve?id=${eleve.id}`);
  await page.waitForLoadState("networkidle");
  const fiche = await page.content();
  check("elle porte le matricule et la classe", fiche.includes(eleve.matricule));
  check("elle montre les tuteurs et leurs numéros", fiche.includes(numero));
  check("elle dit que le matricule ne se corrige pas ici",
    fiche.includes("deux identités pour un enfant"));
  check("et ce qu'une correction de nom change vraiment",
    fiche.includes("réimpression"),
    "l'exemplaire papier déjà remis, lui, ne change pas");
  const inconnue = await page.goto(`${BASE}/eleve?id=00000000-0000-0000-0000-000000000000`);
  check("une fiche inexistante ne casse pas l'écran",
    (await page.content()).includes("introuvable"), `HTTP ${inconnue.status()}`);

  console.log("\nCorriger un numéro");
  await page.goto(`${BASE}/eleve?id=${eleve.id}`);
  const corr = await poster(page, "/eleve/tuteur", {
    eleve: eleve.id, tuteur: tuteurs0[0].id, nom: tuteurs0[0].full_name,
    telephone: "76 00 11 22", lien: "Père", sms: "1" });
  check("le numéro est corrigé", corr.corps.includes("enregistré")
    || corr.corps.includes("vaut pour"));
  const apres = await tuteursDe(eleve.id);
  check("la base porte le nouveau numéro",
    apres.some((t) => t.phone === "76001122"),
    apres.map((t) => t.phone).join(", "));

  const mauvais = await poster(page, "/eleve/tuteur", {
    eleve: eleve.id, tuteur: tuteurs0[0].id, nom: tuteurs0[0].full_name,
    telephone: "7600112", sms: "1" });
  check("un numéro à 7 chiffres est refusé",
    mauvais.corps.includes("chiffres au lieu de 8"));
  const sansNom = await poster(page, "/eleve/tuteur", {
    eleve: eleve.id, nom: "", telephone: "76001133" });
  check("un tuteur sans nom est refusé", sansNom.corps.includes("nom du tuteur"));

  console.log("\nUn tuteur est partagé entre ses enfants");
  await poster(page, "/eleve/tuteur", {
    eleve: frere.id, nom: "PARTAGE Auto", telephone: "76 00 44 55",
    lien: "Mère", sms: "1" });
  const rattache = await poster(page, "/eleve/tuteur", {
    eleve: eleve.id, nom: "PARTAGE Auto", telephone: "76 00 44 55",
    lien: "Mère", sms: "1" });
  check("un numéro déjà connu RATTACHE au lieu de dupliquer",
    rattache.corps.includes("suit aussi"),
    "sinon une mère de trois élèves reçoit trois communiqués");
  const { rows: doublons } = await client.query(
    `select count(*)::int as n from guardians where phone = '76004455'`);
  check("un seul tuteur existe pour ce numéro", doublons[0].n === 1,
    `${doublons[0].n} exemplaires`);

  await page.goto(`${BASE}/eleve?id=${eleve.id}`);
  check("la fiche prévient que ce tuteur suit plusieurs élèves",
    (await page.content()).includes("la correction vaut pour tous"),
    "c'est exactement ce qu'une secrétaire ne devine pas");

  const { rows: partage } = await client.query(
    `select id from guardians where phone = '76004455'`);
  await poster(page, "/eleve/tuteur", {
    eleve: eleve.id, tuteur: partage[0].id, nom: "PARTAGE Auto",
    telephone: "76 00 44 66", sms: "1" });
  const chezLeFrere = await tuteursDe(frere.id);
  check("corriger son numéro le corrige POUR LA FRATRIE",
    chezLeFrere.some((t) => t.phone === "76004466"),
    chezLeFrere.map((t) => t.phone).join(", "));

  console.log("\nDétacher");
  const det = await poster(page, "/eleve/tuteur/retirer",
    { eleve: eleve.id, tuteur: partage[0].id });
  check("le détachement dit que les autres enfants le gardent",
    det.corps.includes("autres enfants le gardent"));
  const { rows: vivant } = await client.query(
    `select count(*)::int as n from guardians where id = $1`, [partage[0].id]);
  check("le tuteur n'est pas supprimé", vivant[0].n === 1,
    "ses messages passés le référencent");

  // On détache tout le reste : le dernier retrait doit s'annoncer.
  let dernier = "";
  for (const t of await tuteursDe(eleve.id)) {
    dernier = (await poster(page, "/eleve/tuteur/retirer",
      { eleve: eleve.id, tuteur: t.id })).corps;
  }
  check("RETIRER LE DERNIER NUMÉRO N'EST PAS INTERDIT, IL EST ANNONCÉ",
    dernier.includes("AUCUN numéro joignable"),
    "un élève peut réellement n'avoir aucun téléphone ; on ne l'invente pas");
  check("et la fiche le porte en tête",
    dernier.includes("ne recevra aucun SMS d'absence"));

  console.log("\nCorriger l'identité");
  const ident = await poster(page, "/eleve/identite", {
    eleve: eleve.id, nom: "ZONGO", prenoms: "Abdoulaye Rasmane",
    sexe: "M", naissance: "2013-04-17", lieu: "Koudougou" });
  check("l'identité est corrigée", ident.corps.includes("Identité corrigée"));
  const { rows: ap } = await client.query(
    `select first_names, place_of_birth from students where id = $1`, [eleve.id]);
  check("la base porte la correction",
    ap[0].first_names === "Abdoulaye Rasmane" && ap[0].place_of_birth === "Koudougou");
  const vide = await poster(page, "/eleve/identite",
    { eleve: eleve.id, nom: "", prenoms: "Abdoulaye" });
  check("un nom vide est refusé", vide.corps.includes("ne peut rester vide"));
  const sexeFaux = await poster(page, "/eleve/identite",
    { eleve: eleve.id, nom: "ZONGO", prenoms: "Abdoulaye", sexe: "X" });
  check("un sexe hors M/F est refusé", sexeFaux.corps.includes("se note M ou F"));
  const dateFausse = await poster(page, "/eleve/identite",
    { eleve: eleve.id, nom: "ZONGO", prenoms: "Abdoulaye", naissance: "hier" });
  check("une date illisible est refusée et rappelle le format",
    dateFausse.corps.includes("le 12 mars"));

  console.log("\nContacts d'urgence");
  await poster(page, "/eleve/urgence", {
    eleve: eleve.id, nom: "OUEDRAOGO Voisin", telephone: "76 00 77 88",
    lien: "Oncle" });
  await page.goto(`${BASE}/eleve?id=${eleve.id}`);
  check("le contact d'urgence est enregistré",
    (await page.content()).includes("OUEDRAOGO Voisin"));
  await page.screenshot({ path: "out/captures/26-eleve.png", fullPage: true });

  console.log("\nDepuis le suivi des messages");
  const { rows: unMsg } = await client.query(
    `select id from sms_messages where student_id = $1 limit 1`, [eleve.id]);
  if (unMsg.length) {
    await page.goto(`${BASE}/messages?filtre=tous`);
    check("le registre mène à la fiche de l'élève concerné",
      (await page.content()).includes(`/eleve?id=${eleve.id}`),
      "c'est la seule chose que cet écran ne peut pas faire lui-même");
  }

  console.log("\nVoir n'est pas corriger");
  const vs = await browser.newContext({ locale: "fr-FR" });
  const p2 = await vs.newPage();
  await connecter(p2, "70000003");                        // surveillant général
  const lecture = await p2.goto(`${BASE}/eleve?id=${eleve.id}`);
  check("le surveillant général lit la fiche — il doit pouvoir appeler",
    lecture.status() === 200);
  check("mais aucun formulaire de correction ne lui est proposé",
    !(await p2.content()).includes('action="/eleve/identite"'));
  const ecriture = await poster(p2, "/eleve/identite",
    { eleve: eleve.id, nom: "INTRUS", prenoms: "Auto" });
  check("et l'écriture lui est refusée, même postée à la main",
    ecriture.statut === 403, `HTTP ${ecriture.statut}`);
  const { rows: intact } = await client.query(
    `select last_name from students where id = $1`, [eleve.id]);
  check("rien n'a bougé", intact[0].last_name !== "INTRUS");
  await vs.close();

  const ens = await browser.newContext({ locale: "fr-FR" });
  const p3 = await ens.newPage();
  await connecter(p3, "70000002");                        // enseignante
  const refus = await p3.goto(`${BASE}/eleve?id=${eleve.id}`);
  check("une enseignante n'accède pas aux numéros des familles",
    refus.status() === 403, `HTTP ${refus.status()}`);
  await ens.close();

  console.log("\nTraçabilité");
  const { rows: journal } = await client.query(
    `select distinct action from audit_log where action like 'student.%'`);
  check("identité, rattachement et détachement sont journalisés",
    journal.length >= 3, journal.map((j) => j.action).join(", "));

} finally {
  await browser.close();
  server.kill();
  await restaurer().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("La fiche de l'élève est vérifiée de bout en bout.");
