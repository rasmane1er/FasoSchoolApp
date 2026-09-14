/**
 * Une famille qu'on n'a pas pu prévenir doit apparaître quelque part.
 *
 * CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT L'APPEL DU MATIN. Trois élèves marqués
 * absents, dont un — SAWADOGO Boukary, qui est dans le jeu de démonstration
 * depuis le premier jour — dont aucun tuteur n'a de numéro. La réponse de
 * l'écran, mot pour mot :
 *
 *     « Appel enregistré : 3 absences, 2 SMS envoyés pour 16 F. »
 *
 * Trois absences, deux familles prévenues. La troisième n'était NULLE PART :
 * aucune ligne dans `sms_messages`, aucune tâche dans le registre, aucun nom
 * dans la confirmation. Le surveillant lit « appel enregistré » et ferme.
 *
 * C'est la deuxième des trois promesses du produit qui tombe en silence, et
 * elle tombera de nouveau demain, et tous les jours où Boukary sera absent.
 *
 * LE SECOND DÉFAUT, ÉPROUVÉ LUI AUSSI. La requête qui choisit le destinataire
 * ne filtrait pas sur le numéro — elle triait seulement par `is_primary`. Un
 * tuteur principal SANS numéro sortait donc en tête et MASQUAIT un second
 * tuteur joignable du même dossier. Le père a changé de puce, la mère est
 * inscrite en second : personne n'est prévenu, et l'écran affiche « Aucun
 * tuteur joignable » pour un élève parfaitement joignable.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. un absent sans numéro laisse une ligne `injoignable` — pas un silence ;
 *   2. cette ligne porte LE TEXTE qu'on aurait envoyé, pour que celui qui
 *      appelle la famille sache quoi lui dire ;
 *   3. elle ne coûte RIEN : rien n'a été composé, rien n'est débité ;
 *   4. la confirmation la NOMME, au lieu de la laisser dans une soustraction ;
 *   5. elle remonte au registre « à traiter » et au tableau de bord ;
 *   6. on ne propose pas « Renvoyer » sur un message sans numéro, et le POST
 *      fabriqué à la main est refusé lui aussi — l'écran n'est pas la garde ;
 *   7. « Famille appelée » reste possible : c'est le geste réel ;
 *   8. UN SECOND TUTEUR JOIGNABLE N'EST PLUS MASQUÉ par un principal sans
 *      numéro — ni à l'affichage, ni à l'envoi ;
 *   9. les absents normaux partent comme avant, et rien ne devient
 *      `injoignable` par accident.
 *
 *   node tests/injoignable.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4247;
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

const JOUR = await jourLibre(3);
const JOUR2 = await jourLibre(4);


const MARQUE_TUTEUR = "EPREUVE Tante joignable";

/* Le seul geste de cette suite qui touche le jeu de démonstration lui-même :
 * vider le numéro d'un tuteur principal pour éprouver le masquage. On retient
 * quoi remettre, et on le remet quoi qu'il arrive — une suite de tests doit
 * rendre la base exactement comme elle l'a trouvée. */
let AREMETTRE = null;   // { guardianId, phone }

const purger = async () => {
  for (const j of [JOUR, JOUR2]) {
    await client.query(
      `delete from attendance_records where attendance_session_id in
         (select id from attendance_sessions where session_date = $1)`, [j]);
    await client.query(
      `delete from attendance_sessions where session_date = $1`, [j]);
  }
  await client.query(`delete from sms_messages where body like '%absent%'`);
  await client.query(`delete from sms_credit_ledger where note like '%bsence%'`);
  await client.query(`delete from audit_log where action = 'attendance.save'`);
  await client.query(`delete from audit_log where action like 'message.%'`);
  await client.query(
    `delete from student_guardians where guardian_id in
       (select id from guardians where full_name = $1)`, [MARQUE_TUTEUR]);
  await client.query(`delete from guardians where full_name = $1`, [MARQUE_TUTEUR]);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
};
await purger();

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

const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const appeler = async (cookie, classe, date, marques) => {
  const body = new URLSearchParams();
  for (const [id, statut] of marques) body.append(`s_${id}`, statut);
  const r = await fetch(`${BASE}/absences?classe=${classe}&date=${date}`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: body.toString() });
  return r.text();
};

try {
  const cookie = await login("70000001");   // censeur

  const { rows: cl } = await client.query(
    `select id, label from classes order by label limit 1`);
  const CLASSE = cl[0].id;
  const { rows: els } = await client.query(
    `select st.id, st.last_name, st.first_names
       from enrolments e join students st on st.id = e.student_id
      where e.class_id = $1 order by st.last_name`, [CLASSE]);

  // L'élève sans aucun tuteur joignable : on le TROUVE, on ne le fabrique pas.
  // Le jeu de démonstration en contient un depuis le premier jour, et c'est
  // précisément pour cela qu'il ne se voyait pas.
  const { rows: sans } = await client.query(
    `select st.id, st.last_name, st.first_names from students st
      where not exists (
        select 1 from student_guardians sg join guardians g on g.id = sg.guardian_id
         where sg.student_id = st.id and sg.receives_sms
           and g.phone is not null and g.phone <> '')
      limit 1`);
  check("le jeu de démonstration contient un élève sans tuteur joignable",
    sans.length === 1, "il faut ce cas pour éprouver quoi que ce soit");
  const MUET = sans[0];
  const parlants = els.filter((e) => e.id !== MUET.id).slice(0, 2);

  /* === 1. L'absent sans numéro laisse une trace ========================== */
  console.log("\nUn absent sans numéro n'est plus un silence");

  const dit = await appeler(cookie, CLASSE, JOUR, [
    [MUET.id, "absent"], [parlants[0].id, "absent"], [parlants[1].id, "absent"]]);
  const confirmation = texte((dit.match(/<div class="ok">([\s\S]*?)<\/div>/) ?? [])[1] ?? "");
  console.log(`     « ${confirmation} »`);

  check("l'appel est enregistré", /Appel enregistré/.test(confirmation));
  check("deux SMS sont partis", /2 SMS envoyés/.test(confirmation), confirmation);

  check("LA CONFIRMATION NOMME LA FAMILLE SANS NUMÉRO",
    /Une famille n'a aucun numéro au dossier/.test(confirmation),
    "avant : « 3 absences, 2 SMS envoyés », et la troisième famille "
      + "disparaissait dans une soustraction que personne ne fait");
  check("elle dit le geste à faire", /corrigez le numéro dans la fiche/.test(confirmation));
  check("et où la retrouver", /suivi des messages/.test(confirmation));

  const { rows: trace } = await client.query(
    `select m.status, m.to_phone, m.body, m.cost_fcfa, m.error_detail, m.student_id
       from sms_messages m where m.status = 'injoignable'`);
  check("UNE LIGNE EST ÉCRITE POUR ELLE", trace.length === 1,
    `${trace.length} lignes — avant, il n'y en avait aucune : `
      + "ni SMS, ni tâche, ni nom nulle part");
  check("elle désigne le bon élève", trace[0]?.student_id === MUET.id);
  check("elle ne porte AUCUN numéro inventé", trace[0]?.to_phone === "",
    `« ${trace[0]?.to_phone} » — la chaîne vide se lit « il n'y en avait pas »`);
  check("ELLE PORTE LE TEXTE QU'ON AURAIT ENVOYÉ",
    (trace[0]?.body ?? "").includes(MUET.first_names)
      && /absent/.test(trace[0]?.body ?? ""),
    "celui qui appelle la famille doit savoir quoi lui dire : "
      + `« ${(trace[0]?.body ?? "").slice(0, 70)} »`);
  check("et elle dit pourquoi", /[Aa]ucun numéro/.test(trace[0]?.error_detail ?? ""));

  check("ELLE NE COÛTE RIEN", trace[0]?.cost_fcfa === 0,
    "rien n'a été composé, donc rien n'est débité");
  const { rows: credit } = await client.query(
    `select coalesce(sum(messages), 0)::int as n from sms_credit_ledger
      where direction = 'consommation' and note like '%bsence%'`);
  check("le débit ne compte que les messages réellement partis",
    credit[0].n === 2, `${credit[0].n} au lieu de 2`);

  /* === 2. Elle remonte là où on regarde ================================== */
  console.log("\nElle remonte au registre et au tableau de bord");

  const registre = await (await fetch(`${BASE}/messages`, { headers: { cookie } })).text();
  check("le registre « à traiter » la montre",
    registre.includes(MUET.last_name) || /Sans numéro/.test(registre),
    "un message qu'aucun écran ne lit vaut un message qui n'existe pas");
  check("avec son propre mot, pas « non remis »", /Sans numéro/.test(registre),
    "« non remis » ferait croire à un refus de l'opérateur, et le geste "
      + "à faire n'est pas le même");
  check("et le numéro manquant est dit, pas laissé en blanc",
    /aucun au dossier/.test(registre));

  const { rows: ligneId } = await client.query(
    `select id from sms_messages where status = 'injoignable' limit 1`);
  const ID = ligneId[0].id;
  const fragment = (() => {
    const i = registre.indexOf(ID);
    return i < 0 ? "" : registre.slice(Math.max(0, i - 1400), i + 1400);
  })();
  check("le bouton « Renvoyer » n'est pas offert pour cette ligne",
    fragment !== "" && !/messages\/renvoyer/.test(fragment),
    "un bouton qui ne peut pas marcher est pire qu'un bouton absent : "
      + "il laisse croire qu'on a réessayé");
  check("mais « Famille appelée » l'est", /Famille appelée/.test(fragment),
    "c'est le geste réel : on téléphone");

  const dash = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  check("le tableau de bord la compte",
    /n(?:'|&#39;)est pas parvenu|ne sont pas parvenus/.test(dash),
    texte(dash).slice(0, 200));

  /* === 3. L'écran n'est pas la garde ===================================== */
  console.log("\nLe POST fabriqué à la main est refusé lui aussi");

  const renvoi = await fetch(`${BASE}/messages/renvoyer`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: ID }).toString() });
  const ditRenvoi = texte(await renvoi.text());
  check("LE RENVOI FORCÉ EST REFUSÉ",
    /pas de numéro où aller/.test(ditRenvoi), ditRenvoi.slice(0, 200));
  check("et le refus dit où est le vrai geste",
    /fiche de l(?:'|&#39;)élève/.test(ditRenvoi));
  const { rows: apres } = await client.query(
    `select count(*)::int as n from sms_messages`);
  check("RIEN N'A ÉTÉ ÉCRIT PAR CE REFUS", apres[0].n === 3,
    `${apres[0].n} messages au lieu de 3`);

  /* === 4. « Famille appelée » fonctionne ================================= */
  console.log("\nLe geste réel est enregistrable");

  const resolu = await fetch(`${BASE}/messages/resoudre`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: ID, issue: "appele" }).toString() });
  const ditResolu = texte(await resolu.text());
  check("« Famille appelée » est acceptée sur un message sans numéro",
    /appelée|marqué/.test(ditResolu), ditResolu.slice(0, 200));
  const { rows: r2 } = await client.query(
    `select resolution from sms_messages where id = $1`, [ID]);
  check("et la résolution est écrite", r2[0].resolution === "appele");
  const { rows: reste } = await client.query(
    `select count(*)::int as n from sms_messages
      where status in ('echoue','injoignable') and resolution is null`);
  check("la tâche quitte alors la liste à traiter", reste[0].n === 0);

  /* === 5. Le tuteur secondaire n'est plus masqué ========================= */
  console.log("\nUn second tuteur joignable n'est plus masqué");

  const CIBLE = parlants[0];
  const { rows: princ } = await client.query(
    `select g.id, g.phone from student_guardians sg join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and sg.is_primary limit 1`, [CIBLE.id]);
  AREMETTRE = { guardianId: princ[0].id, phone: princ[0].phone };
  // Le père a changé de puce. C'est tout. Ce n'est pas un cas tordu.
  await client.query(`update guardians set phone = '' where id = $1`, [princ[0].id]);
  const { rows: tante } = await client.query(
    `insert into guardians (school_id, full_name, phone) values ($1,$2,'70999888')
     returning id`, [SCHOOL, MARQUE_TUTEUR]);
  await client.query(
    `insert into student_guardians (student_id, guardian_id, school_id, is_primary, receives_sms)
     values ($1,$2,$3,false,true)`, [CIBLE.id, tante[0].id, SCHOOL]);

  const ecran = await (await fetch(
    `${BASE}/absences?classe=${CLASSE}&date=${JOUR2}`, { headers: { cookie } })).text();
  const ligneCible = (() => {
    const i = ecran.indexOf(CIBLE.last_name);
    return i < 0 ? "" : ecran.slice(i, i + 500);
  })();
  check("L'ÉCRAN AFFICHE LE NUMÉRO DE LA TANTE", /70999888/.test(ligneCible),
    "avant, il affichait « Aucun tuteur joignable » pour un élève "
      + "parfaitement joignable : " + texte(ligneCible).slice(0, 120));

  const dit2 = await appeler(cookie, CLASSE, JOUR2, [[CIBLE.id, "absent"]]);
  const conf2 = texte((dit2.match(/<div class="ok">([\s\S]*?)<\/div>/) ?? [])[1] ?? "");
  check("un SMS part pour cet élève", /1 SMS envoyé/.test(conf2), conf2);
  check("ET IL PART CHEZ LA TANTE", Number((await client.query(
    `select count(*)::int as n from sms_messages where to_phone = '70999888'`)).rows[0].n) === 1,
    "le tuteur principal sans numéro la masquait entièrement");
  check("rien n'est devenu « injoignable » par accident",
    Number((await client.query(
      `select count(*)::int as n from sms_messages
        where status = 'injoignable' and queued_at::date = current_date
          and student_id = $1`, [CIBLE.id])).rows[0].n) === 0);

  /* === 6. Le compte du jour ============================================== */
  const { rows: f } = await client.query(
    `select familles_injoignables(current_date) as n`);
  check("familles_injoignables() compte la journée", f[0].n === 1, `${f[0].n}`);

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.end().catch(() => {});
}

/* Le nettoyage se fait sur une connexion neuve : si la suite a échoué en plein
 * milieu, la base doit quand même repartir exactement comme elle était. */
{
  const c2 = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c2.connect();
  await c2.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
  if (AREMETTRE) {
    await c2.query(`update guardians set phone = $2 where id = $1`,
      [AREMETTRE.guardianId, AREMETTRE.phone]);
  }
  // Les messages d'abord : ils référencent le tuteur, et une clé étrangère
  // ne se laisse pas contourner par l'ordre dans lequel on avait envie
  // d'écrire le nettoyage.
  await c2.query(`delete from sms_messages where body like '%absent%'`);
  await c2.query(
    `delete from student_guardians where guardian_id in
       (select id from guardians where full_name = $1)`, [MARQUE_TUTEUR]);
  await c2.query(`delete from guardians where full_name = $1`, [MARQUE_TUTEUR]);
  for (const j of [JOUR, JOUR2]) {
    await c2.query(
      `delete from attendance_records where attendance_session_id in
         (select id from attendance_sessions where session_date = $1)`, [j]);
    await c2.query(`delete from attendance_sessions where session_date = $1`, [j]);
  }
  await c2.query(`delete from sms_credit_ledger where note like '%bsence%'`);
  await c2.query(`delete from audit_log where action = 'attendance.save'`);
  await c2.query(`delete from audit_log where action like 'message.%'`);
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
console.log("Une famille qu'on n'a pas pu prévenir a désormais un nom, une "
  + "heure et une tâche.");
