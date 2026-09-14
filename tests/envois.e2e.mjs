/**
 * Les deux gardes sur les envois en masse.
 *
 * CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT L'ENVOI. Le même communiqué, envoyé deux
 * fois de suite, PARTAIT DEUX FOIS : 11 familles × 2, 22 messages, 176 FCFA,
 * et chaque parent recevait le texte identique en double. Les deux envois
 * annonçaient « 11 familles prévenues » — le directeur ne voyait rien.
 *
 * Ce n'est pas un cas tordu, c'est le double-clic. Sur une connexion lente —
 * la connexion visée — la page met plusieurs secondes à répondre, et cliquer
 * une seconde fois est le comportement humain normal.
 *
 * Le coût est double : le crédit, et la crédibilité du canal. Une famille qui
 * reçoit deux fois le même message cesse de les lire, et c'est le SMS
 * d'absence qui meurt avec.
 *
 * SECONDE GARDE : L'HEURE. Rien n'empêchait un envoi en masse à 23 h.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. le doublon est refusé, et RIEN ne part — compté dans la base ;
 *   2. le refus est TOUJOURS forçable : une école peut vouloir renvoyer le
 *      même texte demain, et un mur sans porte est un défaut ;
 *   3. un texte différent part normalement — la garde ne bloque pas tout ;
 *   4. les heures de silence, y compris la fenêtre qui traverse minuit ;
 *   5. UN SMS D'ABSENCE N'EST PAS RETENU. Il répond à un geste qui vient
 *      d'avoir lieu ; le garder jusqu'à 6 h le rendrait faux ;
 *   6. un refus ne laisse aucun communiqué « publié » derrière lui.
 *
 *   node tests/envois.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4243;
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
  `select school_id from auth_lookup_user('70000001')`);
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
/* UN JOUR D'ÉCOLE CHOISI DANS L'ANNÉE, PAS ÉCRIT EN DUR.
 *
 * Ces dates étaient fixées sur l'année 2026-2027 du jeu de démonstration, qui
 * était elle-même écrite en dur. La démonstration se place désormais sur une
 * vraie année scolaire relative à aujourd'hui : une date d'octobre 2026 en dur
 * tomberait hors année, et le produit refuserait l'appel — à juste titre.
 *
 * On demande donc à la base un jour qui soit : dans l'année, ouvert selon la
 * semaine de l'école, hors congés, et SANS séance d'appel déjà semée. Le
 * décalage (`offset`) diffère d'une suite à l'autre pour qu'elles ne se
 * marchent pas dessus — c'est la même règle que pour les purges : un jour
 * n'est à soi que si personne d'autre ne le prend. */
const jourLibre = async (rang) => {
  const { rows } = await client.query(
    `select d::date::text as j
       from academic_years ay,
            lateral generate_series(ay.starts_on + 8, ay.starts_on + 60,
                                    interval '1 day') d
      where extract(isodow from d)::smallint = any(
              (select school_days from schools limit 1)::smallint[])
        and not exists (
              select 1 from calendar_events ce
               where ce.closes_school
                 and d::date between ce.starts_on
                                 and coalesce(ce.ends_on, ce.starts_on))
        and not exists (
              select 1 from attendance_sessions s where s.session_date = d::date)
      order by d offset $1 limit 1`, [rang]);
  if (!rows[0]) {
    console.error("Aucun jour d'école libre dans l'année de démonstration.");
    process.exit(1);
  }
  return rows[0].j;
};

const JOUR_ECOLE = await jourLibre(2);


const MARQUE = "EPREUVE ENVOIS";
const { rows: fenetre } = await client.query(
  `select sms_quiet_from, sms_quiet_to from schools limit 1`);

const purger = async () => {
  await client.query(`delete from sms_messages where body like $1`, ["%" + MARQUE + "%"]);
  await client.query(`delete from sms_credit_ledger where note like $1`, ["%" + MARQUE + "%"]);
  await client.query(`delete from announcements where title like $1`, ["%" + MARQUE + "%"]);
  await client.query(`delete from audit_log where action = 'communique.send'`);
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions where session_date = $1)`, [JOUR_ECOLE]);
  await client.query(`delete from attendance_sessions where session_date = $1`,
    [JOUR_ECOLE]);
  await client.query(`update schools set sms_quiet_from = $1, sms_quiet_to = $2`,
    [fenetre[0].sms_quiet_from, fenetre[0].sms_quiet_to]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

/* CETTE SUITE NE DOIT PAS DÉPENDRE DE L'HEURE QU'IL EST.
 *
 * Elle affirme qu'un premier communiqué PART. Or la garde des heures de
 * silence — 21 h → 6 h par défaut, heure de Ouagadougou — refuse les envois en
 * masse la nuit. La suite passait donc en journée et échouait le soir, avec
 * sept assertions rouges et un message qui ne parlait pas du tout d'horaire.
 * Trouvé en la lançant à 21 h 27.
 *
 * Une suite possède les réglages dont dépendent ses assertions. On pose donc
 * une fenêtre de silence CALCULÉE pour exclure l'instant présent — deux heures
 * plus tard, pendant une heure — et c'est PostgreSQL qui la calcule, dans le
 * fuseau de l'école, puisque c'est lui qui l'évaluera ensuite. La section qui
 * éprouve le silence pose ensuite sa propre fenêtre, comme avant. */
await client.query(
  `update schools
      set sms_quiet_from = (timezone('Africa/Ouagadougou', now())
                            + interval '2 hours')::time,
          sms_quiet_to   = (timezone('Africa/Ouagadougou', now())
                            + interval '3 hours')::time`);
const { rows: verif } = await client.query(
  `select heures_de_silence(now()) as s`);
if (verif[0].s) {
  console.error("La fenêtre de silence posée couvre encore l'instant présent.");
  process.exit(1);
}

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
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

/** Un POST fabriqué à la main : c'est ce que fait un double-clic, et c'est
 *  aussi ce que ferait quelqu'un qui contourne l'écran. */
const communiquer = async (cookie, texte, extra = {}) => {
  const r = await fetch(`${BASE}/communiques`, { method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ titre: MARQUE, corps: texte,
                               cible: "tous", ...extra }).toString() });
  return r.text();
};

const partis = async (texte) => Number((await client.query(
  `select count(*)::int as n from sms_messages where body = $1`, [texte])).rows[0].n);
const consomme = async () => Number((await client.query(
  `select coalesce(sum(messages), 0)::int as n from sms_credit_ledger
    where direction = 'consommation'`)).rows[0].n);

const TEXTE = `${MARQUE} - reunion des parents samedi a 9h.`;
const AUTRE = `${MARQUE} - le portail ouvre a 7h a partir de lundi.`;

try {
  const cookie = await login("70000001");   // censeur

  /* === 1. Le doublon ===================================================== */
  console.log("\nLe même texte ne part pas deux fois");
  const un = await communiquer(cookie, TEXTE);
  check("le premier envoi part", /familles prévenues/.test(un), un.slice(0, 120));
  const apresUn = await partis(TEXTE);
  const creditUn = await consomme();
  check("onze familles l'ont reçu", apresUn === 11, `${apresUn}`);

  const deux = await communiquer(cookie, TEXTE);
  check("LE SECOND ENVOI IDENTIQUE EST REFUSÉ",
    /déjà parti/.test(deux),
    "avant, il repartait : 22 messages, 176 FCFA, et chaque parent le "
      + "recevait deux fois");
  check("RIEN N'EST PARTI", (await partis(TEXTE)) === apresUn,
    `${await partis(TEXTE)} messages au lieu de ${apresUn}`);
  check("ET RIEN N'A ÉTÉ DÉBITÉ", (await consomme()) === creditUn);
  check("le refus dit que les familles l'ont bien reçu",
    /les\s*\n?\s*familles l(?:'|&#39;)ont reçu|familles l(?:'|&#39;)ont reçu/.test(deux),
    "un double-clic n'est pas une erreur de l'utilisateur : il faut le "
      + "rassurer, pas l'inquiéter");
  check("et il propose d'envoyer quand même", /name="forcer"/.test(deux),
    "une école peut vouloir renvoyer le même texte demain ; un mur sans "
      + "porte est un défaut");

  const { rows: ann } = await client.query(
    `select count(*)::int as n from announcements where title = $1`, [MARQUE]);
  check("AUCUN COMMUNIQUÉ « PUBLIÉ » N'EST RESTÉ DERRIÈRE LE REFUS", ann[0].n === 1,
    `${ann[0].n} annonces pour un seul envoi réussi — l'historique mentirait`);

  console.log("\nMais le refus se lève");
  const force = await communiquer(cookie, TEXTE, { forcer: "1" });
  check("forcé, l'envoi part", /familles prévenues/.test(force));
  check("et les messages sont bien partis cette fois",
    (await partis(TEXTE)) === apresUn * 2);

  console.log("\nUn texte différent part normalement");
  const autre = await communiquer(cookie, AUTRE);
  check("la garde ne bloque pas tout", /familles prévenues/.test(autre),
    autre.slice(0, 120));

  /* === 2. Les heures de silence ========================================== */
  console.log("\nLes heures de silence");
  const heure = async (h) => Boolean((await client.query(
    `select heures_de_silence($1::timestamptz) as s`,
    [`2026-09-11 ${h}:00:00+00`])).rows[0].s);

  await client.query(
    `update schools set sms_quiet_from = '21:00', sms_quiet_to = '06:00'`);
  check("21 h est dans le silence", await heure("21"));
  check("23 h aussi", await heure("23"));
  check("5 h aussi — LA FENÊTRE TRAVERSE MINUIT", await heure("05"),
    "une fenêtre 21:00→06:00 qui se lit comme un intervalle simple ne "
      + "couvrirait aucune heure");
  check("6 h n'y est plus", !(await heure("06")));
  check("11 h non plus", !(await heure("11")));

  await client.query(
    `update schools set sms_quiet_from = '00:00', sms_quiet_to = '23:59'`);
  const nuit = await communiquer(cookie, `${MARQUE} - message nocturne.`);
  check("EN HEURES DE SILENCE, L'ENVOI EN MASSE EST REFUSÉ",
    /ne texte pas les familles/.test(nuit), nuit.slice(0, 140));
  check("le refus nomme l'heure de Ouagadougou", /à Ouagadougou/.test(nuit),
    "le serveur peut tourner ailleurs : c'est l'heure de l'école qui compte");
  check("rien n'est parti", (await partis(`${MARQUE} - message nocturne.`)) === 0);
  check("et il est forçable lui aussi", /name="forcer"/.test(nuit));

  /* === 3. Un SMS d'absence n'est pas retenu ============================== */
  console.log("\nUn SMS d'absence n'est PAS retenu par les heures de silence");
  const { rows: cl } = await client.query(
    `select id from classes order by label limit 1`);
  const { rows: el } = await client.query(
    `select st.id from enrolments e join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name limit 1`, [cl[0].id]);

  const appel = await fetch(
    `${BASE}/absences?classe=${cl[0].id}&date=${JOUR_ECOLE}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [`s_${el[0].id}`]: "absent" }).toString() });
  const ditAppel = await appel.text();
  check("l'appel est enregistré malgré les heures de silence",
    /Appel enregistré/.test(ditAppel),
    ditAppel.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 140));
  const { rows: smsAbs } = await client.query(
    `select count(*)::int as n from sms_messages
      where queued_at::date = current_date and body like '%absent%'`);
  check("ET LE SMS D'ABSENCE EST PARTI", smsAbs[0].n > 0,
    "il répond à un geste qui vient d'avoir lieu ; le retenir jusqu'à 6 h "
      + "le rendrait faux");

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL])
    .catch(() => {});
  await client.query(
    `delete from sms_messages where queued_at::date = current_date
       and body like '%absent%'`).catch(() => {});
  await client.query(
    `delete from sms_credit_ledger where note like '%bsence%'`).catch(() => {});
  await purger().catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Un double-clic ne coûte plus 88 FCFA et la confiance des familles.");
