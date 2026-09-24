/**
 * Entre deux trimestres, le produit disait « Trimestre 1 ».
 *
 * CE QUI A ÉTÉ TROUVÉ EN DÉPLAÇANT LES DATES DES TRIMESTRES. Le socle de
 * presque toutes les pages était cette requête, dont le commentaire dit ce
 * qu'elle croit faire — « Année et trimestre EN COURS » :
 *
 *     order by (current_date between t.starts_on and t.ends_on) desc, t.sequence
 *     limit 1
 *
 * Le tri est juste : le trimestre qui contient aujourd'hui passe devant. Mais
 * quand AUCUN ne le contient, le `limit 1` prend la première ligne du second
 * critère — `t.sequence` — c'est-à-dire LE TRIMESTRE 1, en toute saison.
 *
 * Or une année scolaire n'est pas une suite continue de trimestres : il y a
 * des congés entre chacun, et le dernier finit des semaines avant la clôture
 * de l'année. SOIXANTE-NEUF JOURS dans le jeu de démonstration —
 * `jours_hors_trimestre()` les compte. Soit plus de deux mois par an où le
 * produit se trompait de trimestre, tous les ans, pour toutes les écoles.
 *
 * Éprouvé trois fois : pendant les congés, « trimestre 1, clôture le
 * 10/09/2026 » — une date déjà passée ; après le dernier trimestre,
 * « trimestre 1, clôture le 27/02/2026 », sept mois en arrière ; et même
 * trimestre 1 CLOS, l'écran de saisie s'ouvrait dessus, le refus n'arrivant
 * qu'à l'enregistrement.
 *
 * CE QUE CELA COÛTAIT. `period.term_id` commande la saisie des notes, les
 * évaluations, les bulletins et l'en-tête de chaque page. Une colonne de notes
 * saisie pendant les congés d'octobre entrait dans le trimestre 1 — celui dont
 * le bulletin est figé et distribué.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. la situation de l'année est NOMMÉE, aux quatre coins du calendrier ;
 *   2. hors trimestre, aucun écran n'affiche « Trimestre 1 » ;
 *   3. l'écran qui ÉCRIT dans un trimestre le fait choisir, au lieu d'en
 *      deviner un ;
 *   4. le trimestre choisi est vérifié contre l'année — une URL se fabrique ;
 *   5. le tableau de bord, lui, RAPPORTE : il parle du trimestre qui vient de
 *      finir, et le dit ;
 *   6. l'appel du matin n'a pas besoin de trimestre : il s'écrit à une date ;
 *   7. rien de tout cela ne change quand on est bien dans un trimestre.
 *
 * ELLE EMPRUNTE LES DATES DES TRIMESTRES ET LES REND, quoi qu'il arrive.
 *
 *   node tests/entre-trimestres.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4280;
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
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE : les bornes des trimestres et leur statut. On les rend
 * dans le `finally`, quoi qu'il arrive — une suite rend la base comme elle
 * l'a trouvée. */
const { rows: TERMS } = await client.query(
  `select id, sequence, starts_on::text as s, ends_on::text as e, status
     from terms order by sequence`);
const rendre = async () => {
  for (const t of TERMS) {
    await client.query(
      `update terms set starts_on = $2, ends_on = $3, status = $4 where id = $1`,
      [t.id, t.s, t.e, t.status]);
  }
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

/* Place les trimestres pour que `current_date` tombe où on veut. */
const placer = async (ou) => {
  if (ou === "dans") {
    await client.query(`update terms set starts_on = current_date - 20,
                                         ends_on = current_date + 20 where sequence = 1`);
    await client.query(`update terms set starts_on = current_date + 40,
                                         ends_on = current_date + 90 where sequence = 2`);
    await client.query(`update terms set starts_on = current_date + 100,
                                         ends_on = current_date + 150 where sequence = 3`);
  } else if (ou === "entre") {
    await client.query(`update terms set starts_on = current_date - 60,
                                         ends_on = current_date - 5 where sequence = 1`);
    await client.query(`update terms set starts_on = current_date + 10,
                                         ends_on = current_date + 60 where sequence = 2`);
    await client.query(`update terms set starts_on = current_date + 70,
                                         ends_on = current_date + 120 where sequence = 3`);
  } else if (ou === "apres") {
    await client.query(`update terms set starts_on = current_date - 300,
                                         ends_on = current_date - 200 where sequence = 1`);
    await client.query(`update terms set starts_on = current_date - 190,
                                         ends_on = current_date - 100 where sequence = 2`);
    await client.query(`update terms set starts_on = current_date - 90,
                                         ends_on = current_date - 30 where sequence = 3`);
  } else if (ou === "avant") {
    await client.query(`update terms set starts_on = current_date + 10,
                                         ends_on = current_date + 60 where sequence = 1`);
    await client.query(`update terms set starts_on = current_date + 70,
                                         ends_on = current_date + 120 where sequence = 2`);
    await client.query(`update terms set starts_on = current_date + 130,
                                         ends_on = current_date + 180 where sequence = 3`);
  }
};

try {
  const cookie = await login("70000001");
  const page = async (chemin) =>
    texte(await (await fetch(`${BASE}${chemin}`, { headers: { cookie } })).text());

  /* === 1. La situation est nommée ====================================== */
  console.log("\nLa situation de l'année est nommée, pas devinée");

  for (const [ou, attendu] of [["dans", "en_trimestre"],
                               ["entre", "entre_trimestres"],
                               ["apres", "apres_le_dernier"],
                               ["avant", "avant_le_premier"]]) {
    await placer(ou);
    const { rows } = await client.query(`select etat, term_id from situation_de_l_annee()`);
    check(`${ou} → « ${attendu} »`, rows[0].etat === attendu,
      `« ${rows[0].etat} »`);
    check(`  et le trimestre du jour est ${attendu === "en_trimestre" ? "trouvé" : "null"}`,
      (attendu === "en_trimestre") === (rows[0].term_id !== null),
      `term_id = ${rows[0].term_id}`);
  }

  const { rows: creux } = await client.query(
    `select jours_hors_trimestre(annee_en_cours()) as n`);
  check("les jours hors trimestre se comptent",
    Number(creux[0].n) > 0,
    `${creux[0].n} — c'est le nombre de jours par an où le produit affichait `
      + `« Trimestre 1 »`);

  /* === 2. Hors trimestre, aucun écran n'affiche « Trimestre 1 » ======== */
  console.log("\nHors trimestre, plus aucun écran n'annonce « Trimestre 1 »");

  await placer("entre");
  const bord = await page("/");
  const notes = await page("/notes");
  const bulletins = await page("/bulletins");

  check("l'en-tête dit « entre deux trimestres »",
    bord.includes("entre deux trimestres"),
    bord.slice(bord.indexOf("Année 2"), bord.indexOf("Année 2") + 80));
  /* On vise l'EN-TÊTE — « Année 2026-2027 — Trimestre 1 » — et pas le mot
   * « Trimestre » partout : les boutons du sélecteur le portent aussi, et
   * c'est leur rôle. */
  check("et plus aucun en-tête n'annonce un trimestre",
    !/— Trimestre \d/.test(bord) && !/— Trimestre \d/.test(notes)
      && !/— Trimestre \d/.test(bulletins),
    "c'était l'en-tête de TOUTES les pages pendant les congés");
  check("aucune échéance révolue n'est annoncée comme échéance en cours",
    !/clôture le \d{2}\/\d{2}\/20\d\d/.test(bord)
      || !bord.includes("trimestre 1, clôture"),
    `« trimestre 1, clôture le 10/09/2026 » — une date déjà passée`);
  check("le tableau de bord dit ce qui vient de finir et ce qui va commencer",
    /s'est terminé le \d{2}\/\d{2}\/\d{4}/.test(bord)
      && /commence le \d{2}\/\d{2}\/\d{4}/.test(bord),
    bord.slice(bord.indexOf("Bonjour"), bord.indexOf("Bonjour") + 190));

  /* === 3. L'écran qui écrit fait choisir =============================== */
  console.log("\nL'écran qui écrit dans un trimestre le fait choisir");

  check("la saisie des notes ne s'ouvre pas sur un trimestre deviné",
    notes.includes("Aucun trimestre en cours aujourd'hui"),
    notes.slice(0, 200));
  check("elle dit POURQUOI il faut choisir",
    /Cet écran écrit DANS un trimestre/.test(notes));
  check("elle dit ce qui se passait avant",
    /entrait dans le trimestre dont les bulletins étaient déjà chez les familles/
      .test(notes),
    "un écran qui change de comportement doit dire ce qu'il corrige");
  check("et elle propose les trois trimestres, avec leurs dates",
    (notes.match(/Trimestre \d \d{2}\/\d{2}\/\d{4} → \d{2}\/\d{2}\/\d{4}/g) ?? []).length === 3,
    notes.slice(notes.indexOf("Trimestre 1"), notes.indexOf("Trimestre 1") + 160));
  check("les bulletins font choisir eux aussi",
    bulletins.includes("Aucun trimestre en cours aujourd'hui"));

  const { rows: t2 } = await client.query(
    `select id from terms where sequence = 2`);
  const choisi = await page(`/notes?trimestre=${t2[0].id}`);
  check("un trimestre choisi rouvre l'écran",
    !choisi.includes("Aucun trimestre en cours aujourd'hui")
      && choisi.includes("Choisissez une classe"),
    choisi.slice(0, 200));
  check("et l'en-tête dit que le trimestre a été CHOISI, pas observé",
    /Trimestre 2 \(choisi\)/.test(choisi),
    "la différence entre « nous sommes au trimestre 2 » et « vous avez demandé "
      + "le trimestre 2 » n'est pas décorative");

  /* === 4. Un identifiant fabriqué à la main =========================== */
  console.log("\nUn trimestre venu de l'URL est vérifié");

  const bidon = await page(`/notes?trimestre=00000000-0000-0000-0000-000000000000`);
  check("un identifiant inconnu ne devient pas un trimestre",
    bidon.includes("Aucun trimestre en cours aujourd'hui"),
    "sinon une URL fabriquée choisirait à la place de l'utilisateur");

  /* Un trimestre d'une AUTRE année ne passe pas davantage. */
  const { rows: autre } = await client.query(
    `insert into academic_years (school_id, label, starts_on, ends_on, status)
     values (current_school_id(), 'EPREUVE entre-trimestres autre',
             current_date - 900, current_date - 800, 'close') returning id`);
  const { rows: tAutre } = await client.query(
    `insert into terms (school_id, academic_year_id, sequence, starts_on, ends_on)
     values (current_school_id(), $1, 1, current_date - 900, current_date - 800)
     returning id`, [autre[0].id]);
  const etranger = await page(`/notes?trimestre=${tAutre[0].id}`);
  check("un trimestre d'une autre année non plus",
    etranger.includes("Aucun trimestre en cours aujourd'hui"),
    "le trimestre choisi est confronté à l'année en cours");
  await client.query(`delete from terms where id = $1`, [tAutre[0].id]);
  await client.query(`delete from academic_years where id = $1`, [autre[0].id]);

  /* === 5. Le tableau de bord rapporte ================================== */
  console.log("\nLe tableau de bord rapporte sur le trimestre qui vient de finir");

  check("la carte de saisie nomme le trimestre lu, et dit qu'il est terminé",
    /Saisie des notes — trimestre 1 \(terminé\)/.test(bord),
    bord.slice(bord.indexOf("Saisie des notes"), bord.indexOf("Saisie des notes") + 60));

  await placer("apres");
  const bordApres = await page("/");
  check("après le dernier trimestre, il rapporte sur le troisième",
    /Saisie des notes — trimestre 3 \(terminé\)/.test(bordApres),
    bordApres.slice(bordApres.indexOf("Saisie des notes"),
                    bordApres.indexOf("Saisie des notes") + 60));
  check("et il dit que c'est le temps du conseil de classe",
    /temps du conseil de classe et de la clôture/.test(bordApres),
    bordApres.slice(bordApres.indexOf("Bonjour"), bordApres.indexOf("Bonjour") + 200));

  /* === 6. L'appel s'écrit à une date, pas dans un trimestre ============ */
  console.log("\nL'appel du matin n'a pas besoin qu'on choisisse un trimestre");

  const appel = await page("/absences");
  check("l'écran d'appel s'ouvre sans rien demander",
    !appel.includes("Aucun trimestre en cours aujourd'hui"),
    "une séance d'appel porte une DATE ; c'est `jourEcole()` qui décide si "
      + "l'école était ouverte, et c'est la bonne question");

  /* === 7. Dans un trimestre, rien ne change =========================== */
  console.log("\nEt dans un trimestre, rien ne change");

  await placer("dans");
  const dedans = await page("/");
  const notesDedans = await page("/notes");
  check("l'en-tête annonce de nouveau le trimestre",
    /— Trimestre 1/.test(dedans) && !/entre deux trimestres/.test(dedans),
    dedans.slice(dedans.indexOf("Année 2"), dedans.indexOf("Année 2") + 60));
  check("sans dire « choisi » : il est observé, pas demandé",
    !/\(choisi\)/.test(dedans));
  check("et la saisie des notes s'ouvre directement",
    notesDedans.includes("Choisissez une classe")
      && !notesDedans.includes("Aucun trimestre en cours aujourd'hui"));
  check("le tableau de bord annonce une clôture À VENIR",
    /clôture le \d{2}\/\d{2}\/\d{4}/.test(dedans),
    dedans.slice(dedans.indexOf("Bonjour"), dedans.indexOf("Bonjour") + 120));
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
  process.exit(1);
}
console.log("Le produit ne devine plus de trimestre : il nomme la situation, "
  + "et fait choisir quand il faut écrire.");
