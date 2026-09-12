/**
 * « Signalé quatre fois sans que rien n'ait été fait. »
 *
 * CE QUI A ÉTÉ TROUVÉ EN LISANT CE QUE L'ÉCRAN PROMET. L'en-tête de
 * `discipline.ts` porte cette phrase depuis le premier jour :
 *
 *     « Une description est obligatoire, une sanction ne l'est pas. Beaucoup
 *       de faits se consignent sans être punis, et c'est précisément ce
 *       registre qui permet de dire, AU CONSEIL, qu'un élève a été signalé
 *       quatre fois sans qu'on ait jamais rien fait. »
 *
 * Et l'écran la répète au directeur, en sous-titre. Éprouvée, elle était
 * fausse des deux côtés :
 *
 *   * AU CONSEIL DE CLASSE, la requête ne comptait que deux choses — le
 *     nombre de faits, et le nombre d'exclusions. Un élève signalé quatre
 *     fois sans aucune suite et un élève signalé quatre fois avec quatre
 *     convocations des parents affichaient tous deux « 4 ». Mesuré sur le jeu
 *     de démonstration : deux lignes identiques, et le conseil décidait du
 *     passage de chacun sur ce chiffre-là.
 *
 *   * AU REGISTRE, cent vingt lignes chronologiques et aucun total par élève.
 *     Pour voir qu'un nom revient quatre fois, il fallait le compter à la
 *     main sur une page entière. Personne ne le fait.
 *
 * POURQUOI CELA COMPTE, ET DANS QUEL SENS. Ce sont deux dossiers OPPOSÉS.
 * « Quatre faits, quatre convocations » dit que l'établissement a réagi et que
 * la situation a persisté. « Quatre faits, aucune suite » dit que
 * l'établissement a été prévenu quatre fois et n'a rien fait : c'est une
 * phrase sur l'ÉCOLE, pas sur l'enfant. Le même « 4 » les confondait, au
 * moment précis où l'on décide de l'année de cet enfant.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. deux élèves, quatre faits chacun, l'un jamais puni, l'autre convoqué
 *      quatre fois : LE CONSEIL LES DISTINGUE — c'est le défaut exact ;
 *   2. l'élève dont tout a reçu une suite n'est PAS marqué « sans suite » ;
 *   3. la mention n'est pas en rouge : ce n'est pas une charge de plus contre
 *      l'élève, et une pastille `p-bad` serait un contresens ;
 *   4. le registre montre un total PAR ÉLÈVE, trié par ce qui est resté sans
 *      suite ;
 *   5. un fait RETIRÉ ne compte plus — ni dans le total, ni dans les sans
 *      suite : c'est déjà la règle du registre, elle doit valoir ici aussi ;
 *   6. un élève signalé une seule fois ne « revient » pas ;
 *   7. donner une suite après coup fait bouger les deux écrans.
 *
 *   node tests/recurrence.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4249;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: sc } = await client.query(
  `select school_id from auth_lookup_user('70000005')`);
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);

const MARQUE = "EPREUVE RECURRENCE";

const purger = async () => {
  await client.query(`delete from behavior_incidents where description like $1`,
    ["%" + MARQUE + "%"]);
  await client.query(`delete from sms_messages where body like '%discipline%'`);
  await client.query(`delete from sms_credit_ledger where note like '%iscipline%'`);
  await client.query(`delete from audit_log where action like 'discipline.%'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

/* La démonstration n'en sème aucun : tout `behavior_incidents` présent est un
 * résidu. On le vérifie plutôt que de le supposer — si un jour elle en sème,
 * les comptes de cette suite seraient faux sans que rien ne le dise. */
const { rows: dejaLa } = await client.query(
  `select count(*)::int as n from behavior_incidents`);
if (dejaLa[0].n > 0) {
  console.error(`REFUS : ${dejaLa[0].n} fait(s) déjà au registre. Cette épreuve `
    + `compte des faits par élève ; elle ne peut pas partir d'un registre `
    + `qu'elle n'a pas écrit.`);
  process.exit(1);
}

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });
const up = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/sante`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
})();
if (!up) { console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1200)); server.kill(); process.exit(1); }

const login = async (phone) => {
  const a = await fetch(`${BASE}/connexion`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone }).toString() });
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};

const nu = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/* Le nom d'un élève apparaît AUSSI dans le menu déroulant du formulaire, en
 * haut de page. Chercher la première occurrence lisait donc l'`<option>` et
 * non la ligne du tableau. On part d'un repère : le titre de la carte. */
const brutDe = (html, nom, largeur = 700, apres = "") => {
  const debut = apres ? html.indexOf(apres) : 0;
  if (debut < 0) return "";
  const i = html.indexOf(nom, debut);
  return i < 0 ? "" : html.slice(i, i + largeur);
};
const ligneDe = (html, nom, largeur = 700, apres = "") =>
  nu(brutDe(html, nom, largeur, apres));

try {
  const cookie = await login("70000005");   // le directeur

  const { rows: cl } = await client.query(
    `select id, label from classes order by label limit 1`);
  const CLASSE = cl[0].id;
  const { rows: els } = await client.query(
    `select st.id, st.last_name from enrolments e join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name`, [CLASSE]);

  const IGNORE = els[0];    // quatre faits, jamais rien décidé
  const SUIVI = els[1];     // quatre faits, quatre convocations
  const UNIQUE = els[2];    // un seul fait
  const RETIRE = els[3];    // deux faits, dont un retiré

  const consigner = async (eleve, sanction, jour, quoi) => {
    const r = await fetch(`${BASE}/discipline`, { method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ classe: CLASSE, eleve: eleve.id, date: jour,
        description: `${MARQUE} ${quoi}`, sanction }).toString() });
    return r.text();
  };

  console.log("\nQuatre faits chacun — l'un jamais puni, l'autre convoqué quatre fois");
  for (let i = 1; i <= 4; i += 1) {
    await consigner(IGNORE, "", `2026-11-0${i}`, `bagarre dans la cour (${i})`);
    await consigner(SUIVI, "convocation_parents", `2026-11-0${i}`,
      `bagarre dans la cour (${i})`);
  }
  await consigner(UNIQUE, "", "2026-11-05", "retard répété");
  await consigner(RETIRE, "", "2026-11-06", "a quitte le cours sans autorisation");
    /* Le produit exige une PHRASE, pas une étiquette : « Indiscipline » fait
     douze caractères et ne dit rien. On écrit donc de vrais faits — et au
     passage cette suite éprouve la règle sans le vouloir. */
  const dernier = await consigner(RETIRE, "", "2026-11-07",
    "a bouscule un camarade dans le couloir");
  check("les faits sont consignés", /consigné/i.test(dernier), nu(dernier).slice(0, 120));

  /* === 1. LE CONSEIL DE CLASSE ========================================== */
  console.log("\nAu conseil de classe");
  const conseil = await (await fetch(
    `${BASE}/conseil?classe=${CLASSE}`, { headers: { cookie } })).text();

  const ligneIgnore = ligneDe(conseil, IGNORE.last_name);
  const ligneSuivi = ligneDe(conseil, SUIVI.last_name);

  check("les deux élèves portent bien quatre faits",
    /\b4\b/.test(ligneIgnore) && /\b4\b/.test(ligneSuivi),
    `${ligneIgnore.slice(0, 90)} | ${ligneSuivi.slice(0, 90)}`);

  check("LE CONSEIL DIT QUE RIEN N'A ÉTÉ DÉCIDÉ POUR LE PREMIER",
    /aucune suite donnée/.test(ligneIgnore),
    "avant, les deux lignes affichaient « 4 » et rien d'autre : "
      + ligneIgnore.slice(0, 140));

  check("ET IL NE LE DIT PAS DU SECOND", !/aucune suite|sans suite/.test(ligneSuivi),
    "quatre convocations, c'est un établissement qui a réagi — le dire "
      + "« sans suite » serait faux : " + ligneSuivi.slice(0, 140));

  check("la mention n'est pas une charge de plus contre l'élève",
    !/p-bad[^>]*>\s*aucune suite|class="dit bad">\s*aucune suite/
      .test(brutDe(conseil, IGNORE.last_name)),
    "une pastille rouge ferait lire « quatre fautes impunies » là où il faut "
      + "lire « l'école a été prévenue quatre fois »");

  check("et l'écran explique dans quel sens le lire",
    /se lit du côté de l(?:'|&#39;)établissement/.test(conseil),
    "sans la phrase, « aucune suite » se retourne contre l'enfant");

  /* === 2. LE REGISTRE ==================================================== */
  console.log("\nAu registre");
  const registre = await (await fetch(
    `${BASE}/discipline?classe=${CLASSE}`, { headers: { cookie } })).text();

  check("UN TOTAL PAR ÉLÈVE EXISTE", /Ce qui revient/.test(registre),
    "avant : cent vingt lignes chronologiques, et il fallait compter les noms "
      + "à la main");

  const recIgnore = ligneDe(registre, IGNORE.last_name, 400, "Ce qui revient");
  const recSuivi = ligneDe(registre, SUIVI.last_name, 400, "Ce qui revient");
  check("l'élève jamais puni y est, avec « aucune »",
    /aucune/.test(recIgnore) && /4/.test(recIgnore), recIgnore.slice(0, 140));
  check("et l'écran dit ce que cela veut dire",
    /rien n(?:'|&#39;)a\s+été\s+décidé/.test(nu(registre)));
  check("l'élève suivi y est aussi, avec « toutes »",
    /toutes/.test(recSuivi), recSuivi.slice(0, 140));

  check("celui qui n'a qu'un seul fait ne « revient » pas",
    !new RegExp(`Ce qui revient[\\s\\S]{0,1800}?${UNIQUE.last_name}`).test(registre),
    "deux est un repère de lecture : en dessous, il n'y a pas de répétition "
      + "à montrer");

  check("celui qui est resté sans suite est en tête",
    registre.indexOf(IGNORE.last_name) < registre.indexOf(SUIVI.last_name),
    "c'est le dossier sur lequel l'établissement doit se prononcer");

  /* === 3. UN FAIT RETIRÉ NE COMPTE PLUS ================================= */
  console.log("\nUn fait retiré sort des comptes");
  const { rows: aRetirer } = await client.query(
    `select id from behavior_incidents where student_id = $1
       and description like $2 order by occurred_on desc limit 1`,
    [RETIRE.id, "%bouscule%"]);
  const retrait = await fetch(`${BASE}/discipline/retirer`, { method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ incident: aRetirer[0].id, classe: CLASSE,
      motif: "erreur d'élève" }).toString() });
  check("le retrait est accepté", /etir|Retir/.test(nu(await retrait.text())));

  const apres = await (await fetch(
    `${BASE}/discipline?classe=${CLASSE}`, { headers: { cookie } })).text();
  check("L'ÉLÈVE À UN SEUL FAIT RESTANT NE « REVIENT » PLUS",
    !new RegExp(`Ce qui revient[\\s\\S]{0,1800}?${RETIRE.last_name}`).test(apres),
    "un fait retiré reste écrit et barré dans le registre, mais il ne compte "
      + "plus contre l'élève — c'est déjà la règle du registre, elle vaut ici");
  check("il reste pourtant visible, barré, dans la liste",
    /<s>[^<]*bouscule/.test(apres),
    "effacer détruirait aussi ce qui pouvait servir en faveur de l'élève");

  /* === 4. DONNER UNE SUITE APRÈS COUP ==================================== */
  console.log("\nDonner une suite après coup change les deux écrans");
  await client.query(
    `update behavior_incidents set sanction = 'convocation_parents'
      where student_id = $1 and description like $2`,
    [IGNORE.id, "%" + MARQUE + "%"]);

  const conseil2 = await (await fetch(
    `${BASE}/conseil?classe=${CLASSE}`, { headers: { cookie } })).text();
  check("le conseil ne dit plus « aucune suite »",
    !/aucune suite donnée/.test(ligneDe(conseil2, IGNORE.last_name)),
    ligneDe(conseil2, IGNORE.last_name).slice(0, 140));
  const registre2 = await (await fetch(
    `${BASE}/discipline?classe=${CLASSE}`, { headers: { cookie } })).text();
  check("et le registre affiche « toutes »",
    /toutes/.test(ligneDe(registre2, IGNORE.last_name, 400, "Ce qui revient")),
    ligneDe(registre2, IGNORE.last_name, 400, "Ce qui revient").slice(0, 140));

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.end().catch(() => {});
}

{
  const c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c2.connect();
  await c2.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
  await c2.query(`delete from behavior_incidents where description like $1`,
    ["%" + MARQUE + "%"]);
  await c2.query(`delete from sms_messages where body like '%discipline%'`);
  await c2.query(`delete from sms_credit_ledger where note like '%iscipline%'`);
  await c2.query(`delete from audit_log where action like 'discipline.%'`);
  await c2.query(`delete from auth_sessions`);
  await c2.query(`delete from auth_otp_challenges`);
  await c2.query(`delete from auth_rate_limits`);
  await c2.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("« Quatre fois sans suite » et « quatre fois convoqué » ne sont "
  + "plus le même chiffre.");
