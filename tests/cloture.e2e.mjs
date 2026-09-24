/**
 * Publication des bulletins et clôture du trimestre.
 *
 * Ce que ce test vérifie tient en une phrase : le document remis à une famille
 * ne change pas tout seul.
 *
 * Le scénario est celui qui fait perdre la confiance d'un parent — un bulletin
 * distribué en décembre, une note corrigée en février, et deux documents qui
 * ne disent plus la même chose sans que personne ne l'ait décidé.
 *
 *   node tests/cloture.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";
import { emprunterLesNotes } from "./notes-epreuve.mjs";
import { emprunterCalendrier } from "./calendrier-epreuve.mjs";

const PORT = 4199;
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

/* CETTE SUITE A BESOIN D'ÊTRE DANS UN TRIMESTRE.
 *
 * Le produit refuse de deviner un trimestre quand aujourd'hui n'en désigne
 * aucun (voir 0025) : il demande lequel. Une suite qui clique sans avoir
 * répondu meurt sur un délai d'attente qui ne parle pas du calendrier —
 * c'est arrivé à quatre suites le même jour. Elle pose donc elle-même le
 * réglage dont ses assertions dépendent, et le rend. */
const calendrier = await emprunterCalendrier(client);
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);

/* L'HISTOIRE DES NOTES EST ÉCRITE PAR LA BASE (0029) : écrire une note
 * pour éprouver un écran, puis la remettre, laisse deux lignes derrière
 * soi. On les emprunte, on les rend. */
const notesEmpruntees = await emprunterLesNotes(client);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);

const { rows: kl } = await client.query(
  `select cl.id, cl.label from classes cl
     join evaluations ev on ev.class_id = cl.id limit 1`);
const classe = kl[0];
const { rows: tr } = await client.query(
  `select t.id from terms t join evaluations ev on ev.term_id = t.id limit 1`);
const termId = tr[0].id;

// La note qu'on fera bouger après publication, et sa valeur de départ.
const { rows: cible } = await client.query(
  `select ge.id, ge.score, ge.student_id, st.last_name
     from grade_entries ge
     join students st on st.id = ge.student_id
     join evaluations ev on ev.id = ge.evaluation_id
    where ev.class_id = $1 and ge.score is not null
    order by st.last_name limit 1`, [classe.id]);
const noteInitiale = Number(cible[0].score);
const cibleEleve = cible[0].last_name;

const remettreEnEtat = async () => {
  await client.query(`update grade_entries set score = $2 where id = $1`,
    [cible[0].id, noteInitiale]);
  await client.query(`update terms set status = 'ouvert'`);
  await client.query(`delete from bulletin_lines`);
  await client.query(`delete from bulletins`);
  // Les conflits référencent les mutations : l'ordre compte.
  await client.query(`delete from sync_conflicts`);
  await client.query(`delete from sync_mutations`);
  // Les SMS d'avis de disponibilité posés par cette suite.
  await client.query(
    `delete from sms_messages where body like '%espace des familles%'
        or body like '%bulletins du%trimestre sont disponibles%'`);
  await client.query(
    `delete from sms_credit_ledger where note = 'Avis de disponibilité des bulletins'`);
  await client.query(`delete from audit_log where action = 'bulletin.notify'`);
};
await remettreEnEtat();

/* L'adresse publique : sans elle, prévenir les familles est refusé — et c'est
   précisément l'un des deux cas que cette suite éprouve. On lance donc le
   serveur AVEC, et on relancera un second serveur SANS pour vérifier le refus. */
const ADRESSE = "https://wend-panga.example.bf";

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
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock", FASOSCHOOL_PUBLIC_URL: ADRESSE },
  stdio: ["ignore", "pipe", "pipe"],
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
const envoyer = async (p, sel) =>
  Promise.all([p.waitForNavigation({ waitUntil: "load" }), p.click(sel)]);
/* Connexion sur un autre port : le second serveur, lancé sans adresse
   publique, sert à vérifier le refus. */
const connecter2 = async (p, tel, port) => {
  await p.goto(`http://127.0.0.1:${port}/connexion`);
  await p.fill("#phone", tel);
  await p.click("button[type=submit]");
  await p.waitForSelector("#code");
  await p.fill("#code", (await p.textContent("#code-demo")).trim());
  await p.click("button[type=submit]");
  await p.waitForLoadState("networkidle");
};

try {
  await connecter(page, "70000001");                      // censeur

  console.log("\nAvant publication");
  await page.goto(`${BASE}/bulletins?classe=${classe.id}`);
  await page.waitForSelector("table");
  check("les bulletins ne sont pas publiés au départ",
    (await page.content()).includes("non publié"));

  console.log("\nPublication");
  await envoyer(page, 'form[action^="/bulletins/publier"] button[type=submit]');
  const apres = await page.content();
  check("la publication est confirmée", apres.includes("bulletins figés"));
  check("l'état de chaque élève passe à publié", apres.includes(">publié<"));

  const { rows: figes } = await client.query(
    `select count(*)::int as n from bulletins where status = 'publie' and term_id = $1`,
    [termId]);
  check("un bulletin est figé par élève", figes[0].n >= 10, `${figes[0].n} bulletins`);

  const { rows: lignes } = await client.query(
    `select count(*)::int as n from bulletin_lines`);
  check("chaque discipline est figée ligne par ligne", lignes[0].n >= 80,
    `${lignes[0].n} lignes`);

  const { rows: unBulletin } = await client.query(
    `select moyenne_generale, rang, effectif, mention from bulletins
      where student_id = $1 and term_id = $2`, [cible[0].student_id, termId]);
  const moyennePubliee = Number(unBulletin[0].moyenne_generale);
  check("la moyenne, le rang et la mention sont figés ensemble",
    unBulletin[0].rang !== null && unBulletin[0].effectif !== null,
    `rang ${unBulletin[0].rang}/${unBulletin[0].effectif}`);

  console.log("\nCe que voit la famille");
  const fam = await browser.newContext({
    viewport: { width: 360, height: 740 }, locale: "fr-FR", isMobile: true, hasTouch: true });
  const parent = await fam.newPage();
  const { rows: tuteur } = await client.query(
    `select g.phone from guardians g join student_guardians sg on sg.guardian_id = g.id
      where sg.student_id = $1 limit 1`, [cible[0].student_id]);

  const ouvrirEspaceFamille = async () => {
    await parent.goto(`${BASE}/famille`);
    if ((await parent.content()).includes("Numéro de téléphone")) {
      await parent.fill("#phone", tuteur[0].phone);
      await Promise.all([parent.waitForNavigation(), parent.click("button[type=submit]")]);
      await parent.fill("#code", (await parent.textContent("#code-demo")).trim());
      await Promise.all([parent.waitForNavigation(), parent.click("button[type=submit]")]);
    }
    return parent.content();
  };

  const vueFamille = await ouvrirEspaceFamille();
  check("la famille voit la date de remise du bulletin",
    vueFamille.includes("bulletin remis le"), "sinon elle ne sait pas ce qu'elle lit");
  const affichee = vueFamille.match(/class="v">(\d+,\d+)</)?.[1];
  check("la famille lit la moyenne publiée",
    affichee === moyennePubliee.toFixed(2).replace(".", ","),
    `affiché ${affichee}, publié ${moyennePubliee}`);

  console.log("\nUne note bouge après la remise");
  /* On fait CHUTER la note du premier de la classe : il perd sa place, et tous
     ceux qui étaient derrière lui remontent d'un rang. C'est le cas important —
     leur moyenne n'a pas bougé d'un centième, et pourtant leur bulletin porte
     désormais un rang faux. */
  await client.query(`update grade_entries set score = $2, updated_at = now() where id = $1`,
    [cible[0].id, noteInitiale <= 2 ? 20 : 1]);

  const encore = await ouvrirEspaceFamille();
  const toujours = encore.match(/class="v">(\d+,\d+)</)?.[1];
  check("la famille lit TOUJOURS le bulletin remis, pas un recalcul",
    toujours === affichee, `avant ${affichee}, maintenant ${toujours}`);
  await parent.screenshot({ path: "out/captures/17-famille-publie.png", fullPage: true });
  await fam.close();

  await page.goto(`${BASE}/bulletins?classe=${classe.id}`);
  const alerte = await page.content();
  check("le censeur voit l'écart, il n'est pas corrigé en silence",
    alerte.includes("ne correspond plus") || alerte.includes("ne correspondent plus"));
  check("l'écart nomme l'élève et les deux valeurs",
    alerte.includes(cible[0].last_name) && alerte.includes("moyenne remise"));
  check("un reclassement est signalé, pas seulement la moyenne qui a bougé",
    alerte.includes("rang remis"),
    "corriger une note reclasse toute la classe : les autres bulletins portent un rang périmé");
  const combien = Number((alerte.match(/(\d+) bulletins? déjà remis/) ?? [])[1] ?? 0);
  check("les élèves reclassés sont comptés eux aussi", combien >= 2,
    `${combien} bulletins signalés, alors qu'un reclassement en touche plusieurs`);

  // La réimpression doit rendre la feuille REMISE, pas un recalcul.
  const impression = await ctx.newPage();
  await impression.goto(`${BASE}/bulletins/imprimer?classe=${classe.id}`);
  const feuille = await impression.content();
  check("réimprimer rend la copie publiée, pas le calcul du jour",
    feuille.includes(moyennePubliee.toFixed(2).replace(".", ",")),
    `la feuille doit porter ${moyennePubliee}`);
  await impression.close();
  await page.screenshot({ path: "out/captures/18-bulletins-ecart.png", fullPage: true });

  console.log("\nRepublication");
  await envoyer(page, 'form[action^="/bulletins/publier"] button[type=submit]');
  const republie = await page.content();
  check("republier remplace la copie et fait disparaître l'écart",
    !republie.includes("ne correspond plus") && !republie.includes("ne correspondent plus"));
  const { rows: maj } = await client.query(
    `select moyenne_generale from bulletins where student_id = $1 and term_id = $2`,
    [cible[0].student_id, termId]);
  check("la copie figée porte la nouvelle valeur",
    Number(maj[0].moyenne_generale) !== moyennePubliee,
    `${maj[0].moyenne_generale} vs ${moyennePubliee}`);

  console.log("\nClôture du trimestre");
  await envoyer(page, 'form[action^="/bulletins/trimestre"] button[type=submit]');
  check("la clôture est confirmée", (await page.content()).includes("clôturé"));

  // Voie normale : le formulaire de saisie.
  const { rows: avantSaisie } = await client.query(
    `select score from grade_entries where id = $1`, [cible[0].id]);
  const { rows: ev } = await client.query(
    `select evaluation_id from grade_entries where id = $1`, [cible[0].id]);
  await page.evaluate(async ([classeId, evaluation, st]) => {
    const body = new URLSearchParams();
    body.set(`n_${evaluation}_${st}`, "7,50");
    await fetch(`/notes?classe=${classeId}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }, [classe.id, ev[0].evaluation_id, cible[0].student_id]);
  const { rows: apresSaisie } = await client.query(
    `select score from grade_entries where id = $1`, [cible[0].id]);
  check("aucune note ne peut plus être saisie dans un trimestre clos",
    Number(apresSaisie[0].score) === Number(avantSaisie[0].score),
    `${avantSaisie[0].score} → ${apresSaisie[0].score}`);

  // Voie hors ligne : la tablette restée trois semaines sans réseau.
  const rejet = await page.evaluate(async ([evaluation, st]) => {
    const r = await fetch("/api/sync/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutations: [{
        mutationId: crypto.randomUUID(), deviceId: "tablette-en-retard",
        evaluationId: evaluation, studentId: st, score: 6, isAbsent: false,
        capturedAt: new Date().toISOString(), baseUpdatedAt: null }] }),
    });
    return (await r.json()).results[0];
  }, [ev[0].evaluation_id, cible[0].student_id]);
  check("une note arrivée hors ligne après la clôture est refusée",
    rejet.outcome === "rejete", rejet.outcome);
  check("et le motif du refus est dit à l'enseignant",
    (rejet.reason ?? "").includes("clôturé"), rejet.reason);

  const { rows: intact } = await client.query(
    `select score from grade_entries where id = $1`, [cible[0].id]);
  check("la note en place n'a pas bougé", Number(intact[0].score) === Number(apresSaisie[0].score));

  console.log("\nRéouverture");
  await page.goto(`${BASE}/bulletins?classe=${classe.id}`);
  await envoyer(page, 'form[action^="/bulletins/trimestre"] button[type=submit]');
  const rouvert = await page.content();
  check("rouvrir est possible", rouvert.includes("rouvert"));
  check("et prévient que des bulletins circulent",
    rouvert.includes("ne changent pas d'eux-mêmes"));

  const { rows: journal } = await client.query(
    `select action from audit_log where action in ('term.close','term.open','term.reopen',
      'bulletins.publish') order by occurred_at`);
  check("clôture, réouverture et publication sont journalisées",
    journal.length >= 4, journal.map((j) => j.action).join(", "));

  console.log("\nPrévenir les familles que le bulletin est disponible");
  /* L'espace des familles existait depuis des semaines et RIEN ne disait à une
     famille qu'il existait : un parent aurait dû l'apprendre de bouche à
     oreille puis taper une adresse sur un téléphone bon marché. */
  await page.goto(`${BASE}/bulletins?classe=${classe.id}`);
  const avantAvis = await page.content();
  check("le geste n'est offert qu'une fois les bulletins publiés",
    avantAvis.includes("Prévenir les familles"),
    "sinon on annonce un document qui n'existe pas");

  const { rows: creditAvant } = await client.query(
    `select coalesce(sum(case when direction='achat' then messages
                              else -messages end),0)::int as n
       from sms_credit_ledger`);
  await envoyer(page,
    `form[action="/bulletins/prevenir?classe=${classe.id}"] button[type=submit]`);
  const apresAvis = await page.content();
  check("les familles sont prévenues", apresAvis.includes("prévenue"),
    apresAvis.includes("Crédit insuffisant") ? "crédit insuffisant" : "");

  const { rows: envoyes } = await client.query(
    `select to_phone, body from sms_messages
      where body like '%bulletins du%trimestre sont disponibles%'`);
  check("LE MESSAGE PORTE L'ADRESSE DE L'ESPACE DES FAMILLES",
    envoyes.every((m) => m.body.includes(ADRESSE + "/famille")),
    "un avis sans adresse ne sert à rien");
  check("il ne nomme pas l'enfant",
    envoyes.every((m) => !m.body.includes(cibleEleve)),
    "les destinataires sont dédoublonnés par numéro : nommer l'enfant "
      + "obligerait à envoyer trois messages, ou à mentir");
  const numeros = new Set(envoyes.map((m) => m.to_phone));
  check("un numéro ne reçoit qu'un message", numeros.size === envoyes.length,
    `${envoyes.length} messages pour ${numeros.size} numéros`);
  const { rows: creditApres } = await client.query(
    `select coalesce(sum(case when direction='achat' then messages
                              else -messages end),0)::int as n
       from sms_credit_ledger`);
  check("le crédit est débité de ce qui est parti",
    creditApres[0].n < creditAvant[0].n);

  console.log("\nSans adresse publique, on refuse d'envoyer");
  const PORT2 = PORT + 40;
  const muet = spawn(process.execPath,
    ["--experimental-strip-types", "src/server/app.ts"],
    { env: { ...process.env, PORT: String(PORT2), FASOSCHOOL_PUBLIC_URL: "" },
      stdio: ["ignore", "pipe", "pipe"] });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT2}/sante`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const p3 = await (await browser.newContext({ locale: "fr-FR" })).newPage();
  await connecter2(p3, "70000001", PORT2);
  const refusAdresse = await p3.evaluate(async (classe) => {
    const res = await fetch(`/bulletins/prevenir?classe=${classe}`, { method: "POST" });
    return await res.text();
  }, classe.id);
  check("UN SMS PAYÉ NE PART PAS VERS UNE ADRESSE INEXISTANTE",
    refusAdresse.includes("Aucune adresse publique"),
    "cela coûterait de l'argent et de la crédibilité");
  muet.kill();

  console.log("\nDroits");
  const ens = await browser.newContext({ locale: "fr-FR" });
  const p2 = await ens.newPage();
  await connecter(p2, "70000002");
  const r = await p2.goto(`${BASE}/bulletins`);
  const peut = (await p2.content()).includes("/bulletins/publier");
  check("une enseignante ne publie pas les bulletins", !peut, `HTTP ${r.status()}`);
  await ens.close();

} finally {
  await calendrier.rendre();
  await browser.close();
  server.kill();
  await remettreEnEtat().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await rendreLaFenetre().catch(() => {});
  await notesEmpruntees.rendre().catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2500));
  process.exit(1);
}
console.log("Publication et clôture vérifiées de bout en bout.");
