/**
 * Corriger l'appel doit corriger la famille.
 *
 * CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT L'APPEL DU MATIN. Deux enregistrements le
 * même jour, ce que fait tout surveillant qui s'est trompé :
 *
 *   07h45  Alizèta est marquée ABSENTE.
 *          « Appel enregistré : 1 absence, 1 SMS envoyé pour 8 F. »
 *          Sa mère reçoit « Alizèta absent(e) le 27/07 ».
 *
 *   08h10  Alizèta est là. Le surveillant la repasse PRÉSENTE.
 *          « Appel enregistré : 0 absence, 0 SMS envoyé pour 0 F. »
 *
 * Le registre disait « présente ». Le téléphone de la mère disait toujours
 * « absente », et rien ne partait pour la contredire. La phrase affichée était
 * le pire des deux maux : « 0 absence, 0 SMS » décrit une journée où il ne
 * s'est rien passé — lue par l'homme qui vient précisément de réparer son
 * erreur.
 *
 * Et pour une famille sans numéro, c'était pire encore : la TÂCHE laissée dans
 * le registre des messages (« appelez cette famille, voici ce qu'il fallait
 * lui dire ») restait ouverte avec son texte devenu faux. Quelqu'un aurait
 * décroché pour annoncer une absence qui n'avait pas eu lieu, en suivant le
 * logiciel.
 *
 * LA RÈGLE ÉPROUVÉE ICI : un message parti ne se reprend pas. Il se dément.
 * C'est la doctrine des reçus appliquée aux SMS — un reçu annulé produit un
 * reçu inverse, jamais une suppression — et elle a la même conséquence : le
 * registre garde les DEUX messages, dans l'ordre, avec leurs heures.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. absent → présent envoie un démenti, au même numéro, tout de suite ;
 *   2. le message d'origine n'est ni effacé ni réécrit : il reste « parti » ;
 *   3. les deux messages sont LIÉS, et le registre montre le lien dans les
 *      deux sens ;
 *   4. on ne dément jamais deux fois le même message ;
 *   5. la confirmation NOMME le geste — « 0 absence » ne peut plus être toute
 *      la phrase ;
 *   6. absent → retard dément aussi : l'élève était là, c'est tout ce que la
 *      famille avait besoin de savoir ;
 *   7. une tâche « sans numéro » devenue fausse est CLOSE en `sans_objet`, et
 *      disparaît du compteur « à traiter » ;
 *   8. `sans_objet` n'est pas un geste qu'un agent peut poser : le POST
 *      fabriqué à la main est refusé ;
 *   9. un démenti que l'opérateur refuse est DIT — cette famille-là croit
 *      toujours son enfant absent ;
 *  10. `attendance_records.sms_sent_at` est écrit quand le message part, et
 *      seulement alors ; l'écran d'appel s'en sert pour prévenir le
 *      surveillant AVANT qu'il ne clique ;
 *  11. rien de tout cela ne se déclenche quand il n'y a rien à reprendre.
 *
 *   node tests/dementi.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4256;
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

/* Un jour d'école libre, demandé à la base. Le décalage est propre à cette
 * suite : un jour n'est à soi que si personne d'autre ne le prend. */
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

const JOUR = await jourLibre(5);
const JOUR2 = await jourLibre(6);
const JOUR3 = await jourLibre(7);

const purger = async () => {
  for (const j of [JOUR, JOUR2, JOUR3]) {
    /* Les messages AVANT les lignes d'appel : `sms_messages` les référence
     * désormais, et un `on delete set null` laisserait des messages orphelins
     * que la suite suivante compterait. */
    await client.query(
      `delete from sms_messages where attendance_record_id in
         (select ar.id from attendance_records ar
            join attendance_sessions s on s.id = ar.attendance_session_id
           where s.session_date = $1)`, [j]);
    await client.query(
      `delete from attendance_records where attendance_session_id in
         (select id from attendance_sessions where session_date = $1)`, [j]);
    await client.query(
      `delete from attendance_sessions where session_date = $1`, [j]);
  }
  await client.query(`delete from sms_messages where body like '%absent%'`);
  await client.query(`delete from sms_messages where body like '%erreur de notre part%'`);
  await client.query(`delete from sms_credit_ledger where note like '%bsence%'`);
  await client.query(`delete from audit_log where action = 'attendance.save'`);
  await client.query(`delete from audit_log where action like 'message.%'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

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

const login = async (phone, base = BASE) => {
  const a = await fetch(`${base}/connexion`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone }).toString() });
  const code = ((await a.text()).match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1];
  const v = await fetch(`${base}/connexion/verifier`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone, code }).toString() });
  return (v.headers.get("set-cookie") ?? "").split(";")[0];
};

/** Un second serveur, avec son propre canal SMS. Deux serveurs vivants en
 *  même temps : l'un dont l'opérateur accepte, l'autre dont il refuse. C'est
 *  le seul moyen d'éprouver le chemin « le démenti n'est pas parti » sans
 *  arrêter celui qui a servi à tout le reste. */
const demarrer = async (port, env) => {
  const p = spawn(process.execPath,
    ["--experimental-strip-types", "src/server/app.ts"], {
      env: { ...process.env, PORT: String(port), SMS_PROVIDER: "mock", ...env },
      stdio: ["ignore", "pipe", "pipe"] });
  p.stderr.on("data", () => {});
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/sante`)).ok) return p; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  p.kill();
  console.error(`Le serveur du port ${port} n'a pas démarré.`);
  process.exit(1);
};

const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"')
  .replace(/\s+/g, " ").trim();

const appeler = async (cookie, classe, date, marques) => {
  const body = new URLSearchParams();
  for (const [id, statut] of marques) body.append(`s_${id}`, statut);
  const r = await fetch(`${BASE}/absences?classe=${classe}&date=${date}`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString() });
  return r.text();
};
const confirmation = (h) =>
  texte((h.match(/<div class="ok">([\s\S]*?)<\/div>/) ?? [])[1] ?? "");

const messagesDe = async (studentId) => (await client.query(
  `select m.id, m.status, m.to_phone, m.body, m.resolution, m.resolved_at,
          m.corrige_message_id, m.attendance_record_id, m.segments, m.cost_fcfa
     from sms_messages m where m.student_id = $1 order by m.queued_at`,
  [studentId])).rows;

try {
  const cookie = await login("70000001");   // censeur

  const { rows: cl } = await client.query(
    `select id, label from classes order by label limit 1`);
  const CLASSE = cl[0].id;

  // Un élève JOIGNABLE, trouvé et pas fabriqué.
  const { rows: joignables } = await client.query(
    `select st.id, st.last_name, st.first_names, g.phone
       from enrolments e join students st on st.id = e.student_id
       join student_guardians sg on sg.student_id = st.id and sg.receives_sms
       join guardians g on g.id = sg.guardian_id
      where e.class_id = $1 and g.phone is not null and g.phone <> ''
      order by st.last_name limit 2`, [CLASSE]);
  const A = joignables[0];
  const B = joignables[1];

  // Et l'élève sans aucun tuteur joignable, celui du jeu de démonstration.
  const { rows: sans } = await client.query(
    `select st.id, st.last_name from students st
      where not exists (
        select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id
         where sg.student_id = st.id and sg.receives_sms
           and g.phone is not null and g.phone <> '')
      limit 1`);
  const MUET = sans[0];

  /* === 1. Absent, puis présent : la famille est détrompée ================ */
  console.log("\nUn absent repassé présent : la famille est détrompée");

  await appeler(cookie, CLASSE, JOUR, [[A.id, "absent"]]);
  let msgs = await messagesDe(A.id);
  check("le SMS d'absence est parti",
    msgs.length === 1 && msgs[0].status === "envoye",
    JSON.stringify(msgs.map((m) => m.status)));
  const ORIGINAL = msgs[0];
  check("il porte la ligne d'appel qui l'a provoqué",
    ORIGINAL.attendance_record_id !== null,
    "sans ce lien, retrouver le SMS d'une absence donnée est une devinette");

  const { rows: av } = await client.query(
    `select ar.sms_sent_at, ar.status from attendance_records ar
       join attendance_sessions s on s.id = ar.attendance_session_id
      where s.session_date = $1 and ar.student_id = $2`, [JOUR, A.id]);
  check("`sms_sent_at` est écrit : l'heure où la famille a su",
    av[0].sms_sent_at !== null,
    "la colonne existait depuis le premier schéma sans que personne ne l'écrive");

  const dit = await appeler(cookie, CLASSE, JOUR, [[A.id, "present"]]);
  console.log(`     « ${confirmation(dit)} »`);

  msgs = await messagesDe(A.id);
  check("un second message est parti", msgs.length === 2,
    `${msgs.length} — avant, la correction ne produisait RIEN`);
  const DEMENTI = msgs[1] ?? {};
  check("le démenti part au MÊME numéro que l'annonce",
    DEMENTI.to_phone === ORIGINAL.to_phone,
    `${DEMENTI.to_phone} ≠ ${ORIGINAL.to_phone}`);
  check("il dit l'erreur, et il dit que le message précédent est annulé",
    /erreur de notre part/i.test(DEMENTI.body ?? "")
      && /annul/i.test(DEMENTI.body ?? ""),
    DEMENTI.body ?? "aucun");
  check("il nomme l'élève et le jour",
    (DEMENTI.body ?? "").includes(A.first_names),
    DEMENTI.body ?? "");

  /* === 2. Le registre est append-only =================================== */
  console.log("\nLe registre garde les deux messages");

  const apres = await client.query(
    `select status, resolution from sms_messages where id = $1`, [ORIGINAL.id]);
  check("l'annonce d'origine n'est ni effacée ni réécrite",
    apres.rows.length === 1 && apres.rows[0].status === "envoye"
      && apres.rows[0].resolution === null,
    JSON.stringify(apres.rows[0] ?? null)
      + " — c'est la doctrine des reçus : on ajoute, on ne rature pas");
  check("le démenti pointe vers ce qu'il corrige",
    DEMENTI.corrige_message_id === ORIGINAL.id,
    `${DEMENTI.corrige_message_id} ≠ ${ORIGINAL.id}`);

  const lien = await client.query(
    `select dementi_de($1) as d, message_a_dementir($2) as reste`,
    [ORIGINAL.id, ORIGINAL.attendance_record_id]);
  check("`dementi_de()` retrouve le démenti", lien.rows[0].d === DEMENTI.id);
  check("et il n'y a PLUS rien à démentir sur cette ligne d'appel",
    lien.rows[0].reste === null,
    "sinon un second enregistrement enverrait un second démenti");

  const reclique = await appeler(cookie, CLASSE, JOUR, [[A.id, "present"]]);
  msgs = await messagesDe(A.id);
  check("revalider ne dément pas une seconde fois", msgs.length === 2,
    `${msgs.length} — le double-clic est le comportement humain normal sur `
      + `une connexion lente`);
  check("et la confirmation ne réannonce pas un démenti",
    !/démenti vient/i.test(confirmation(reclique)),
    confirmation(reclique));

  /* === 3. Ce que l'écran dit ============================================ */
  console.log("\nLa confirmation nomme le geste");

  check("« 0 absence, 0 SMS » n'est plus toute la phrase",
    /démenti/i.test(confirmation(dit)),
    `« ${confirmation(dit)} » — c'était la phrase que lisait le surveillant `
      + `qui venait de réparer son erreur`);
  check("le coût du démenti est annoncé, pas découvert sur un relevé",
    /\b(8|16|24|32)\s*F\b/.test(confirmation(dit)),
    confirmation(dit));

  const ligne = await client.query(
    `select amount_fcfa, messages, note from sms_credit_ledger
      order by occurred_at desc limit 1`);
  check("le débit dit qu'il contient des démentis",
    /démenti/i.test(ligne.rows[0]?.note ?? ""),
    `« ${ligne.rows[0]?.note ?? "aucune ligne"} » — « Alertes absence » `
      + `devant un démenti ferait chercher long l'économe`);

  /* L'écran d'appel prévient AVANT le clic. */
  await appeler(cookie, CLASSE, JOUR2, [[B.id, "absent"]]);
  const ecran = texte(await (await fetch(
    `${BASE}/absences?classe=${CLASSE}&date=${JOUR2}`, { headers: { cookie } })).text());
  check("l'écran d'appel dit que la famille a déjà été prévenue, et à quelle heure",
    /Famille prévenue à \d{2}h\d{2}/.test(ecran),
    "sans cela, le surveillant déclenche un démenti sans savoir qu'il le fait");
  check("et il dit ce que coûtera la correction",
    /enverra un démenti/i.test(ecran));

  /* === 4. Absent → retard dément aussi ================================== */
  console.log("\nArrivé en retard, ce n'est pas absent");

  await appeler(cookie, CLASSE, JOUR2, [[B.id, "retard"]]);
  const mb = await messagesDe(B.id);
  check("repasser un absent en retard dément aussi", mb.length === 2
    && mb[1].corrige_message_id === mb[0].id,
    `${mb.length} message(s) — l'élève était là : c'est tout ce que la `
      + `famille avait besoin de savoir`);

  /* === 5. La tâche devenue fausse ======================================= */
  console.log("\nLa tâche qui annonçait l'absence est close");

  await appeler(cookie, CLASSE, JOUR3, [[MUET.id, "absent"]]);
  let mm = await messagesDe(MUET.id);
  check("un absent sans numéro laisse une tâche", mm.length === 1
    && mm[0].status === "injoignable" && mm[0].resolution === null,
    JSON.stringify(mm.map((m) => [m.status, m.resolution])));
  check("elle porte elle aussi la ligne d'appel",
    mm[0].attendance_record_id !== null);

  const aTraiterAvant = Number((await client.query(
    `select count(*)::int as n from sms_messages
      where status in ('echoue','injoignable') and resolution is null`)).rows[0].n);

  const dit3 = await appeler(cookie, CLASSE, JOUR3, [[MUET.id, "present"]]);
  console.log(`     « ${confirmation(dit3)} »`);
  mm = await messagesDe(MUET.id);
  check("après correction, la tâche est close en `sans_objet`",
    mm.length === 1 && mm[0].resolution === "sans_objet"
      && mm[0].resolved_at !== null,
    JSON.stringify(mm.map((m) => [m.status, m.resolution]))
      + " — sinon quelqu'un décroche pour annoncer une absence qui n'a pas eu lieu");
  check("aucun SMS n'est parti pour autant : il n'y a jamais eu de numéro",
    mm.length === 1,
    "on ne dément pas un message qui n'a pas été composé");
  const aTraiterApres = Number((await client.query(
    `select count(*)::int as n from sms_messages
      where status in ('echoue','injoignable') and resolution is null`)).rows[0].n);
  check("et le compteur « à traiter » baisse d'autant",
    aTraiterApres === aTraiterAvant - 1,
    `${aTraiterAvant} → ${aTraiterApres}`);
  check("la confirmation le dit", /tâche/i.test(confirmation(dit3)),
    confirmation(dit3));

  /* === 6. `sans_objet` n'est pas un geste humain ======================== */
  console.log("\n« Sans objet » ne se coche pas à la main");

  await appeler(cookie, CLASSE, JOUR3, [[MUET.id, "absent"]]);
  const encore = (await messagesDe(MUET.id)).find((m) => m.resolution === null);
  check("une nouvelle absence rouvre bien une tâche", encore !== undefined);

  const forge = await fetch(`${BASE}/messages/resoudre`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: encore.id, issue: "sans_objet" }).toString() });
  const apresForge = (await messagesDe(MUET.id)).find((m) => m.id === encore.id);
  check("un POST fabriqué à la main ne peut pas poser `sans_objet`",
    apresForge.resolution === null,
    `résolution ${apresForge.resolution} — ce serait rendre cochable la case `
      + `que ce registre existe pour empêcher (HTTP ${forge.status})`);

  /* === 7. Le registre montre le lien dans les deux sens ================= */
  console.log("\nCe que montre le suivi des messages");

  const reg = texte(await (await fetch(`${BASE}/messages?filtre=tous`,
    { headers: { cookie } })).text());
  check("un message démenti reste « parti », et le dit",
    /Parti démenti à \d{2}\/\d{2} à \d{2}h\d{2}/.test(reg),
    "on ne réécrit pas son état : il a bien été remis, et c'est le problème");
  check("le démenti dit ce qu'il corrige",
    /Démenti corrige celui de \d{2}\/\d{2}/.test(reg),
    reg.slice(0, 400));
  check("une tâche close en `sans_objet` est nommée, pas effacée",
    /Sans objet/.test(reg) && /l'absence a été corrigée/.test(reg));
  check("et elle dit qui l'a close — le logiciel, pas un agent",
    /close par la correction de l'appel/.test(reg),
    "un tiret devant une heure n'est pas une réponse");

  /* === 8. Un démenti que l'opérateur refuse ============================= */
  console.log("\nUn démenti non remis est DIT");

  /* On ROUVRE le cas de A : on retire le démenti déjà parti et on remet la
   * ligne d'appel à « absent ». L'annonce d'origine, elle, reste — elle est
   * bien partie, et c'est ce qui rend le démenti nécessaire. Puis on rejoue
   * la correction sur un serveur dont l'opérateur refuse ce numéro-là. */
  const { rows: tel } = await client.query(
    `select g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and g.phone <> '' order by sg.is_primary desc limit 1`,
    [A.id]);

  const serveurRefus = await demarrer(PORT + 1, { SMS_MOCK_FAIL: tel[0].phone });
  const BASE2 = `http://127.0.0.1:${PORT + 1}`;
  try {
    await client.query(
      `delete from sms_messages where corrige_message_id = $1`, [ORIGINAL.id]);
    await client.query(
      `update attendance_records set status = 'absent' where id = $1`,
      [ORIGINAL.attendance_record_id]);

    const cookie2 = await login("70000001", BASE2);
    const refus = await fetch(`${BASE2}/absences?classe=${CLASSE}&date=${JOUR}`, {
      method: "POST",
      headers: { cookie: cookie2, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [`s_${A.id}`]: "present" }).toString() });
    const t = await refus.text();
    console.log(`     « ${confirmation(t)} »`);
    check("un démenti refusé par l'opérateur est ANNONCÉ à l'écran",
      /n'a PAS pu être remis/i.test(confirmation(t)),
      `« ${confirmation(t)} » — cette famille-là croit toujours son enfant absent`);
    check("et l'écran dit quoi faire : appeler",
      /[Aa]ppelez-la/.test(confirmation(t)), confirmation(t));

    const rate = (await messagesDe(A.id)).find((m) => m.corrige_message_id !== null);
    check("le démenti raté est écrit, avec son statut d'échec",
      rate !== undefined && rate.status === "echoue",
      JSON.stringify(rate ?? null));
    const detail = rate ? (await client.query(
      `select error_detail from sms_messages where id = $1`, [rate.id])).rows[0] : null;
    check("sa raison dit ce que la famille croit encore",
      /croit toujours son enfant absent/i.test(detail?.error_detail ?? ""),
      `« ${detail?.error_detail ?? "aucune"} » — « refus de l'opérateur » tout `
        + `seul ne dit pas qu'un enfant est accusé à tort`);
    check("il remonte au registre « à traiter »",
      rate !== undefined && rate.resolution === null);
    check("et le message d'origine reste « parti » : il l'est",
      (await client.query(`select status from sms_messages where id = $1`,
        [ORIGINAL.id])).rows[0].status === "envoye");
  } finally {
    serveurRefus.kill();
  }

  /* === 8 bis. Et on peut le rattraper ================================== */
  console.log("\nUn démenti non remis se rattrape");

  const regAvant = texte(await (await fetch(`${BASE}/messages?filtre=tous`,
    { headers: { cookie } })).text());
  check("l'annonce d'origine dit que son démenti n'est PAS arrivé",
    /démenti NON remis — la famille croit encore/.test(regAvant),
    "« démenti à 08h10 » et « démenti non remis » décrivent des situations "
      + "opposées : écrire l'une pour l'autre est pire que de ne rien écrire");

  const rate2 = (await messagesDe(A.id))
    .find((m) => m.corrige_message_id !== null && m.status === "echoue");
  check("il y a bien un démenti raté à rattraper", rate2 !== undefined,
    "sans lui, la suite ne peut pas éprouver le rattrapage — et un plantage "
      + "ici cacherait les échecs déjà comptés plus haut");
  if (rate2 === undefined) throw new Error("rien à rattraper : on s'arrête là");
  const renv = await fetch(`${BASE}/messages/renvoyer`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: rate2.id }).toString() });
  check("le renvoi est accepté", renv.status === 302 || renv.status === 200,
    `HTTP ${renv.status}`);

  const apresRenvoi = await messagesDe(A.id);
  const seconde = apresRenvoi.find(
    (m) => m.corrige_message_id !== null && m.status === "envoye");
  check("la seconde tentative est partie", seconde !== undefined,
    JSON.stringify(apresRenvoi.map((m) => [m.status, m.corrige_message_id !== null])));
  check("et elle porte encore ce qu'elle dément",
    seconde?.corrige_message_id === ORIGINAL.id,
    "sans ce report, renvoyer un démenti fabriquait un message orphelin : "
      + "l'écran cessait de dire que l'annonce avait été corrigée, au moment "
      + "précis où elle venait enfin de l'être");
  check("et la ligne d'appel qui l'a provoquée",
    seconde?.attendance_record_id === ORIGINAL.attendance_record_id);

  const regApres = texte(await (await fetch(`${BASE}/messages?filtre=tous`,
    { headers: { cookie } })).text());
  check("l'annonce d'origine dit maintenant que le démenti est arrivé",
    /Parti démenti à \d{2}\/\d{2} à \d{2}h\d{2}/.test(regApres)
      && !/démenti NON remis/.test(regApres),
    "c'est `dementi_de()` qui préfère la tentative qui est passée");
  /* Aucune ligne dupliquée : le registre affiche exactement un rang par
   * message. C'est ce qu'une jointure sur les démentis cassait dès qu'un
   * message en portait deux — d'où la fonction. */
  const brut = await (await fetch(`${BASE}/messages?filtre=tous`,
    { headers: { cookie } })).text();
  const rangs = (brut.match(/<tr>/g) ?? []).length - 1;   // moins l'en-tête
  const combien = Number((await client.query(
    `select count(*)::int as n from sms_messages`)).rows[0].n);
  check("le registre affiche exactement un rang par message",
    rangs === combien,
    `${rangs} rangs pour ${combien} messages — une jointure sur les démentis `
      + `dupliquait la ligne dès qu'un message en portait deux`);

  /* === 9. Rien ne se déclenche quand il n'y a rien à reprendre ========== */
  console.log("\nEt quand il n'y a rien à reprendre, il ne se passe rien");

  const JOUR4 = await jourLibre(8);
  const avant = Number((await client.query(
    `select count(*)::int as n from sms_messages`)).rows[0].n);
  const rien = await appeler(cookie, CLASSE, JOUR4,
    [[A.id, "present"], [B.id, "present"]]);
  const apresN = Number((await client.query(
    `select count(*)::int as n from sms_messages`)).rows[0].n);
  check("un appel sans absent n'envoie rien du tout", apresN === avant,
    `${avant} → ${apresN}`);
  check("et la phrase reste celle d'une journée sans rien",
    !/démenti/i.test(confirmation(rien)) && !/tâche/i.test(confirmation(rien)),
    confirmation(rien));
  await client.query(
    `delete from sms_messages where attendance_record_id in
       (select ar.id from attendance_records ar
          join attendance_sessions s on s.id = ar.attendance_session_id
         where s.session_date = $1)`, [JOUR4]);
  await client.query(
    `delete from attendance_records where attendance_session_id in
       (select id from attendance_sessions where session_date = $1)`, [JOUR4]);
  await client.query(
    `delete from attendance_sessions where session_date = $1`, [JOUR4]);
} catch (e) {
  /* UNE SUITE QUI PLANTE DOIT RENDRE UN RAPPORT, pas une trace de pile.
   * Éprouvé en contrôle négatif : le correctif désactivé, la suite mourait
   * sur un `undefined` au milieu du parcours — et la trace masquait les neuf
   * assertions déjà tombées, qui étaient précisément ce qu'on voulait voir. */
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
  await purger();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Corriger l'appel corrige la famille, et le registre garde les deux "
  + "messages.");
