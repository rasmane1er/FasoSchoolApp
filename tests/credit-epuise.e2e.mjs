/**
 * « Le crédit SMS est épuisé : plus aucune famille n'est prévenue. »
 * Et l'appel suivant en prévenait trois.
 *
 * CE QUI A ÉTÉ TROUVÉ. Le tableau de bord porte ce point, en rouge, marqué
 * BLOQUANT, dès que le solde tombe à zéro. On vide le crédit, on fait l'appel
 * avec trois absents, et le produit répond :
 *
 *     « Appel enregistré : 3 absences, 3 SMS envoyés pour 24 F. »
 *
 * Trois familles prévenues, vingt-quatre francs dépensés, et le solde à MOINS
 * TROIS. La phrase du tableau de bord était fausse au moment où elle
 * s'affichait.
 *
 * C'est l'image inversée du dépassement de plafond : là, l'écran nommait une
 * sanction et le bouton passait quand même ; ici, l'écran annonce une
 * conséquence qui n'arrive pas. Les deux enseignent la même chose à celui qui
 * lit — que le rouge ne veut rien dire — et c'est ce qui les rend graves, bien
 * plus que le franc dépensé.
 *
 * TROIS DÉFAUTS DANS UN :
 *
 *   1. un solde qui descend sous zéro n'est pas un solde. Rien ne lisait le
 *      crédit avant de composer, et avec le canal simulé, où tout
 *      « réussit », la divergence avec la comptabilité de l'opérateur ne se
 *      voyait qu'au premier vrai matin ;
 *   2. l'écran de l'appel ne disait RIEN du crédit — alors que celui qui fait
 *      l'appel est la seule personne qui le dépense ;
 *   3. et rien ne disait QUELLES familles n'avaient pas été prévenues, alors
 *      que la doctrine existait déjà, mot pour mot, pour la famille sans
 *      numéro : « un message non remis n'est pas une ligne de journal, c'est
 *      une tâche ».
 *
 * CE QU'ON NE FAIT PAS : refuser l'appel. Une absence se consigne même sans
 * crédit — le registre est le document, le SMS est la politesse.
 *
 *   node tests/credit-epuise.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4296;
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
  `select school_id from auth_lookup_user('70000003')`);
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE. Les lignes du grand livre et les messages d'avant,
 * reconnus par leurs identifiants — pas par une date : les lignes semées par
 * `npm run demo` partagent toutes le même `now()`. */
const LEDGER = (await client.query(`select id from sms_credit_ledger`)).rows.map((r) => r.id);
const SMS = (await client.query(`select id from sms_messages`)).rows.map((r) => r.id);
const JOUR = new Date().toISOString().slice(0, 10);

const solde = async () => Number((await client.query(
  `select solde from credit_sms()`)).rows[0].solde);

const rendre = async () => {
  await client.query(
    `delete from sms_messages where id <> all($1::uuid[])`, [SMS]);
  await client.query(
    `delete from sms_credit_ledger where id <> all($1::uuid[])`, [LEDGER]);
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions where session_date = $1)`, [JOUR]);
  await client.query(
    `delete from attendance_sessions where session_date = $1`, [JOUR]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await rendre();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" },
  stdio: ["ignore", "pipe", "pipe"] });
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
const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

try {
  const cookie = await login("70000003");            // le surveillant général
  const page = async (chemin) =>
    texte(await (await fetch(`${BASE}${chemin}`, { headers: { cookie } })).text());

  const classe = (await client.query(
    `select id from classes limit 1`)).rows[0].id;
  /* Des élèves AVEC un tuteur joignable : le cas « sans numéro » est déjà
   * éprouvé ailleurs, et le confondre avec celui-ci ferait passer la suite
   * pour une raison qui n'est pas la sienne. */
  const eleves = (await client.query(
    `select distinct e.student_id, st.last_name
       from enrolments e
       join students st on st.id = e.student_id
       join student_guardians sg on sg.student_id = e.student_id
       join guardians g on g.id = sg.guardian_id
      where e.class_id = $1 and sg.receives_sms
        and g.phone is not null and g.phone <> ''
      order by st.last_name limit 3`, [classe])).rows;
  if (eleves.length < 3) {
    console.error("Il faut trois élèves avec un tuteur joignable : « npm run demo ».");
    server.kill(); await client.end(); process.exit(1);
  }

  const appel = async (n) => {
    const corps = new URLSearchParams();
    for (const e of eleves.slice(0, n)) corps.append(`s_${e.student_id}`, "absent");
    for (const e of eleves.slice(n)) corps.append(`s_${e.student_id}`, "present");
    const r = await fetch(`${BASE}/absences?classe=${classe}&date=${JOUR}`, {
      method: "POST", headers: { cookie,
        "content-type": "application/x-www-form-urlencoded" },
      body: corps.toString() });
    return texte(await r.text());
  };
  const viderLeCredit = async () => client.query(
    `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
     values (current_school_id(), 'consommation', $1, 0, 'épreuve : on vide le crédit')`,
    [await solde()]);

  /* === 1. Le solde ne descend plus sous zéro ========================== */
  console.log("\nUn solde qui descend sous zéro n'est pas un solde");

  await viderLeCredit();
  check("le crédit est à zéro", (await solde()) === 0, `${await solde()}`);

  const sansRien = await appel(3);
  check("l'appel est quand même enregistré",
    /Appel enregistré : 3 absences/.test(sansRien),
    sansRien.slice(sansRien.indexOf("Appel enregistré"), sansRien.indexOf("Appel enregistré") + 120)
      + " — une absence se consigne même sans crédit : le registre est le"
      + " document, le SMS est la politesse");
  check("mais AUCUN SMS n'est parti",
    /0 SMS envoyé pour 0 F/.test(sansRien),
    sansRien.slice(sansRien.indexOf("absences,"), sansRien.indexOf("absences,") + 60));
  check("et le solde n'est pas passé sous zéro", (await solde()) === 0,
    `${await solde()} — l'école a acheté N messages à l'opérateur ; au-delà,`
      + ` c'est lui qui refuse, et la comptabilité du produit divergeait de la`
      + ` sienne en silence`);

  const partis = Number((await client.query(
    `select count(*)::int as n from sms_messages
      where id <> all($1::uuid[]) and status in ('envoye','livre')`, [SMS])).rows[0].n);
  check("rien n'a été composé", partis === 0, `${partis}`);

  /* === 2. Les familles sont NOMMÉES ================================== */
  console.log("\nLes familles laissées sans nouvelle sont nommées");

  check("la confirmation les nomme, au lieu de les compter",
    /familles n'ont PAS été prévenues/.test(sansRien)
      && eleves.slice(0, 2).every((e) => sansRien.includes(e.last_name)),
    sansRien.slice(sansRien.indexOf("PAS été prévenues") - 40,
                   sansRien.indexOf("PAS été prévenues") + 220)
      + " — « 2 familles » envoie chercher lesquelles dans une liste de quarante");
  check("elle dit que ces familles sont JOIGNABLES",
    /Elles sont joignables/.test(sansRien),
    "à ne pas confondre avec « aucun numéro au dossier » : les deux appellent"
      + " des gestes opposés");

  const marques = (await client.query(
    `select status, error_detail, to_phone from sms_messages
      where id <> all($1::uuid[]) order by queued_at`, [SMS])).rows;
  check("chaque message porte l'état « sans_credit »",
    marques.length === 3 && marques.every((m) => m.status === "sans_credit"),
    JSON.stringify(marques.map((m) => m.status)));
  check("et il garde le numéro qu'on aurait composé",
    marques.every((m) => (m.to_phone ?? "") !== ""),
    "celui qui appellera la famille doit savoir où appeler");
  check("le texte qu'on aurait envoyé est conservé",
    marques.every((m) => /absent/.test(m.error_detail ?? "") === false),
    "l'explication est dans error_detail, le message dans body");

  /* === 3. Le registre des messages les distingue ===================== */
  console.log("\nLe registre distingue « sans crédit » de « sans numéro »");

  const registre = await page("/messages");
  check("elles apparaissent dans les messages à traiter",
    /Crédit épuisé/.test(registre),
    registre.slice(0, 200) + " — trois mots différents pour trois gestes"
      + " différents : corriger un numéro, rappeler l'opérateur, recharger");
  check("et le suivi ne les confond pas avec « Sans numéro »",
    !/Sans numéro/.test(registre)
      || registre.indexOf("Crédit épuisé") !== registre.indexOf("Sans numéro"));

  /* === 4. Le tableau de bord dit enfin vrai ========================== */
  console.log("\nLe tableau de bord dit enfin ce qui se passe");

  const bord = await page("/");
  check("il annonce que l'appel sera enregistré mais que personne ne sera prévenu",
    /l'appel sera enregistré, mais plus aucune famille ne sera prévenue/.test(bord),
    bord.slice(bord.indexOf("crédit SMS"), bord.indexOf("crédit SMS") + 180)
      + " — l'ancienne phrase, « plus aucune famille n'est prévenue », était"
      + " fausse au moment où elle s'affichait");
  check("et il nomme les familles restées sans nouvelle",
    /croient son enfant présent|croit son enfant présent/.test(bord),
    bord.slice(bord.indexOf("enfant présent") - 120, bord.indexOf("enfant présent") + 100));

  /* === 5. L'écran de l'appel le dit à celui qui dépense ============== */
  console.log("\nLe crédit se dit à celui qui le dépense");

  const ecran = await page(`/absences?classe=${classe}&date=${JOUR}`);
  check("l'écran de l'appel annonce le crédit épuisé",
    /Crédit SMS épuisé/.test(ecran),
    ecran.slice(ecran.indexOf("Crédit"), ecran.indexOf("Crédit") + 200)
      + " — le point d'attention vivait sur l'écran d'accueil, que celui qui"
      + " fait l'appel n'ouvre pas");
  check("et il dit ce qui se passera quand même",
    /L'appel sera enregistré/.test(ecran) && /aucune famille ne sera prévenue/.test(ecran));

  /* === 6. Le crédit rechargé, tout repart =========================== */
  console.log("\nLe crédit rechargé, l'appel repart");

  await client.query(
    `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
     values (current_school_id(), 'achat', 50, 400, 'épreuve : recharge')`);
  check("le solde est remonté", (await solde()) === 50, `${await solde()}`);

  const ecran2 = await page(`/absences?classe=${classe}&date=${JOUR}`);
  check("l'écran ne crie plus", !/Crédit SMS épuisé/.test(ecran2));

  /* On repasse les trois en présent puis de nouveau absents : une nouvelle
   * absence, donc un nouveau message — le produit ne renvoie jamais un SMS
   * pour une absence déjà signalée. */
  await appel(0);
  const apres = await appel(3);
  check("les SMS partent maintenant",
    /3 SMS envoyés/.test(apres),
    apres.slice(apres.indexOf("Appel enregistré"), apres.indexOf("Appel enregistré") + 110));
  check("et le solde est débité de trois", (await solde()) === 47, `${await solde()}`);

  /* === 7. Le point d'attention s'éteint quand le message part ======= */
  console.log("\nUn point d'attention doit pouvoir s'éteindre");

  const restantes = Number((await client.query(
    `select count(*)::int as n from familles_sans_credit()`)).rows[0].n);
  check("les familles rattrapées sortent du décompte",
    restantes === 0, `${restantes} — un point qu'aucun geste ne peut éteindre`
      + ` apprend à ne plus lire le rouge`);
  const bord2 = await page("/");
  check("et le tableau de bord ne les réclame plus",
    !/croient son enfant présent/.test(bord2),
    bord2.slice(bord2.indexOf("enfant présent") - 100, bord2.indexOf("enfant présent") + 60));
} catch (e) {
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
  await rendre();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 1500));
  process.exit(1);
}
console.log("Le crédit épuisé arrête l'envoi au lieu de le nier, et les "
  + "familles restées sans nouvelle ont un nom.");
