/**
 * La règle de passage est datée. L'écran qui décide de l'année d'un enfant
 * doit lire la date.
 *
 * CE QUI A ÉTÉ TROUVÉ EN SONDANT LE CONSEIL DE CLASSE. La première règle
 * d'ingénierie de ce dépôt, écrite dans le README depuis le premier jour :
 * « les règles pédagogiques sont des données datées ». `repository.ts`
 * l'applique à la lettre pour les coefficients et pour la politique de
 * notation — `where effective_from <= $1`, et une erreur quand il n'y a rien.
 * `conseil.ts` lisait `promotion_rules` sans borne de date et sans erreur :
 *
 *     where (level_code = $1 or level_code is null)
 *     order by level_code nulls last, effective_from desc limit 1
 *     ...
 *     const redoublementAllowed = ctx.rule?.redoublement_allowed ?? true;
 *
 * Quatre défauts sortent de ces deux lignes, tous éprouvés :
 *
 *   1. UNE RÈGLE DE L'AN PROCHAIN GOUVERNE AUJOURD'HUI. Une réforme saisie
 *      d'avance, à effet dans trois cents jours, faisait basculer la
 *      délibération EN COURS : les douze options « redouble » disparaissaient
 *      et la barre d'admission passait de 10 à 12.
 *
 *   2. ET L'ÉCRAN L'EXPLIQUAIT PAR UN TEXTE QUI NE S'APPLIQUE PAS. Mot pour
 *      mot, devant une classe de 6e : « Le redoublement est interdit en
 *      première année de chaque sous-cycle du primaire (arrêté 2019). » La 6e
 *      n'est pas au primaire. Le produit inventait une justification légale,
 *      et c'est elle qu'un chef d'établissement répète à une famille.
 *
 *   3. LA PROVENANCE N'ÉTAIT PAS AFFICHÉE. `source_note` était calculée,
 *      portée jusqu'à l'objet `Deliberation`, et jamais rendue.
 *
 *   4. L'ABSENCE DE RÈGLE VALAIT PERMISSION. Supprimez la ligne du CP1 — un
 *      niveau où l'arrêté de 2019 INTERDIT le redoublement — et les douze
 *      options réapparaissaient, le POST était accepté, la base portait
 *      `redouble` pour un élève de CP1, et l'écran annonçait « 1 décision
 *      enregistrée ».
 *
 * CETTE SUITE EMPRUNTE ET REND. Elle touche `promotion_rules` et le niveau de
 * la classe de démonstration — c'est le seul moyen d'éprouver tout cela — et
 * elle remet l'état exact qu'elle a trouvé, quoi qu'il arrive.
 *
 *   node tests/regle-passage.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4262;
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
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE. Les règles de l'établissement et le niveau de la classe.
 * On retient l'état exact, on le remet dans le `finally` — une suite rend la
 * base comme elle l'a trouvée. */
const { rows: REGLES } = await client.query(
  `select level_code, effective_from::text as effective_from, redoublement_allowed,
          min_average_to_pass, source_note from promotion_rules order by level_code`);
const { rows: CLASSES } = await client.query(
  `select id, label, level_code from classes order by label`);
const CLASSE = CLASSES[0];

const MARQUE = "EPREUVE regle-passage";

const rendre = async () => {
  await client.query(`delete from promotion_rules`);
  for (const r of REGLES) {
    await client.query(
      `insert into promotion_rules (school_id, level_code, effective_from,
          redoublement_allowed, min_average_to_pass, source_note)
       values (current_school_id(), $1, $2, $3, $4, $5)`,
      [r.level_code, r.effective_from, r.redoublement_allowed,
       r.min_average_to_pass, r.source_note]);
  }
  for (const k of CLASSES) {
    await client.query(`update classes set level_code = $2 where id = $1`,
      [k.id, k.level_code]);
  }
  await client.query(`delete from conseil_decisions`);
  await client.query(`delete from livret_entries where not is_external`);
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
  const cookie = await login("70000005");   // directeur

  const conseil = async () => {
    const r = await fetch(`${BASE}/conseil?classe=${CLASSE.id}`, { headers: { cookie } });
    const brut = await r.text();
    return { brut, txt: texte(brut),
      redouble: (brut.match(/value="redouble"/g) ?? []).length,
      selects: (brut.match(/<select name="d_/g) ?? []).length };
  };
  const prononcer = async (studentId, decision) => {
    const b = new URLSearchParams(); b.append(`d_${studentId}`, decision);
    const r = await fetch(`${BASE}/conseil?classe=${CLASSE.id}`, {
      method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: b.toString() });
    return texte(await r.text());
  };
  const { rows: el } = await client.query(
    `select student_id from enrolments where class_id = $1 order by student_id limit 1`,
    [CLASSE.id]);
  const ELEVE = el[0].student_id;

  /* === 1. La règle en vigueur, et elle seule ============================ */
  console.log("\nUne règle saisie pour l'an prochain ne gouverne pas cette année");

  const base = await conseil();
  check("l'état normal offre le redoublement en " + CLASSE.level_code,
    base.redouble > 0, `${base.redouble} options`);

  await client.query(
    `insert into promotion_rules (school_id, level_code, effective_from,
        redoublement_allowed, min_average_to_pass, source_note)
     values (current_school_id(), $1, current_date + 300, false, 12.00, $2)`,
    [CLASSE.level_code, MARQUE + " — reforme annoncee pour l an prochain"]);

  const futur = await conseil();
  check("une règle à effet dans 300 jours NE change PAS la délibération du jour",
    futur.redouble === base.redouble,
    `${base.redouble} → ${futur.redouble} options « redouble » — sans borne de `
      + `date, un censeur qui prépare l'année suivante changeait l'année en cours`);
  check("la barre d'admission reste celle de la règle en vigueur",
    futur.txt.includes("Admission à partir de 10,00/20"),
    "la réforme saisie la portait à 12/20, tout de suite");

  check("et l'écran ANNONCE la règle à venir au lieu de la taire",
    /Une autre règle prend effet le \d{2}\/\d{2}\/\d{4}/.test(futur.txt),
    "saisir la réforme d'avance est une bonne pratique ; la cacher était le défaut");
  check("il dit aussi qu'elle ne s'applique pas à cette délibération",
    /ne s'applique pas à cette délibération/.test(futur.txt));
  check("et ce qu'elle changera",
    /admission à partir de 12,00\/20/i.test(futur.txt)
      && /redoublement interdit/i.test(futur.txt),
    futur.txt.slice(futur.txt.indexOf("Une autre règle"),
                    futur.txt.indexOf("Une autre règle") + 260));

  await client.query(`delete from promotion_rules where source_note like $1`,
    [MARQUE + "%"]);

  /* === 2. La provenance s'affiche ======================================= */
  console.log("\nLa règle appliquée dit d'où elle sort");

  await client.query(
    `update promotion_rules set source_note = $2 where level_code = $1`,
    [CLASSE.level_code, MARQUE + " — provenance de la regle appliquee"]);
  const avecNote = await conseil();
  check("la note de provenance est AFFICHÉE sur l'écran qui s'en sert",
    avecNote.txt.includes(MARQUE + " — provenance de la regle appliquee"),
    "`source_note` était calculée, portée jusqu'à l'objet Deliberation, et "
      + "jamais rendue");
  check("l'écran dit depuis quand la règle est en vigueur",
    /en vigueur depuis le \d{2}\/\d{2}\/\d{4}/.test(avecNote.txt),
    avecNote.txt.slice(avecNote.txt.indexOf("La règle appliquée"),
                       avecNote.txt.indexOf("La règle appliquée") + 200));

  await client.query(
    `update promotion_rules set source_note = null where level_code = $1`,
    [CLASSE.level_code]);
  const sansNote = await conseil();
  check("et quand elle n'en porte aucune, il le dit au lieu de se taire",
    /ne porte aucune note de provenance/.test(sansNote.txt),
    "une règle qui décide de l'année d'un enfant doit dire d'où elle sort");

  /* === 3. Le bon texte devant le bon niveau ============================= */
  console.log("\nOn ne cite pas l'arrêté de 2019 devant une classe de 6e");

  await client.query(
    `update promotion_rules set redoublement_allowed = false where level_code = $1`,
    [CLASSE.level_code]);
  const interdit6e = await conseil();
  check("le redoublement interdit par la règle d'école retire bien l'option",
    interdit6e.redouble === 0);
  /* L'ANCIENNE PHRASE, mot pour mot, est ce qu'on traque : « Le redoublement
   * est interdit en première année de chaque sous-cycle du primaire (arrêté
   * 2019) », servie devant une classe de 6e. L'écran cite bien l'arrêté
   * aujourd'hui — mais pour dire qu'il NE s'applique PAS ici, ce qui est le
   * contraire. On vérifie donc l'absence de la justification, pas l'absence
   * du mot. */
  check("mais l'écran n'invoque PAS l'arrêté de 2019 pour justifier l'interdiction",
    !/est interdit en première année de chaque sous-cycle du primaire \(arrêté 2019\)/
      .test(interdit6e.txt)
      && /Ce n'est PAS l'arrêté de 2019/.test(interdit6e.txt),
    `« ${interdit6e.txt.slice(interdit6e.txt.indexOf("Passage automatique"),
      interdit6e.txt.indexOf("Passage automatique") + 240)} » — la 6e n'est pas `
      + `au primaire, et cette phrase est celle qu'un chef d'établissement `
      + `répète à une famille qui conteste`);
  check("il nomme la vraie source : la règle de l'établissement, et sa date",
    /règle en vigueur dans cet établissement depuis le \d{2}\/\d{2}\/\d{4}/
      .test(interdit6e.txt),
    interdit6e.txt.slice(interdit6e.txt.indexOf("Passage automatique"),
                         interdit6e.txt.indexOf("Passage automatique") + 300));

  const refus6e = await prononcer(ELEVE, "redouble");
  check("et le POST fabriqué à la main est refusé en citant la règle, pas l'arrêté",
    /le redoublement est interdit en 6E par la règle en vigueur depuis le \d{2}\/\d{2}\/\d{4}/
      .test(refus6e),
    refus6e.slice(Math.max(0, refus6e.indexOf("redoublement est interdit") - 60),
                  refus6e.indexOf("redoublement est interdit") + 200));

  /* Et au primaire, l'arrêté est bien cité — parce qu'il s'applique. */
  await client.query(`update classes set level_code = 'CP1' where id = $1`, [CLASSE.id]);
  const cp1 = await conseil();
  check("en CP1, l'arrêté de 2019 est cité — parce qu'il s'y applique",
    /arrêté 2019/.test(cp1.txt) && cp1.redouble === 0);

  /* === 4. Sans règle, on ne délibère pas =============================== */
  console.log("\nL'absence de règle n'est pas une permission");

  await client.query(`delete from promotion_rules`);
  const vide = await conseil();
  check("aucune option « redouble » n'apparaît en CP1 sans règle",
    vide.redouble === 0,
    `${vide.redouble} — avant, les douze options réapparaissaient sur un niveau `
      + `où l'arrêté de 2019 interdit le redoublement`);
  check("aucune liste de décision n'est offerte du tout",
    vide.selects === 0,
    `${vide.selects} listes — choisir dans un formulaire qui n'existe pas est `
      + `la pire des deux situations`);
  check("l'écran dit qu'aucune règle n'est en vigueur, et à quelle date",
    /Aucune règle de passage en vigueur au \d{2}\/\d{2}\/\d{4} pour le niveau CP1/
      .test(vide.txt), vide.txt.slice(0, 300));
  check("il dit que ce niveau est justement de ceux que l'arrêté protège",
    /Ce niveau est justement de ceux-là/.test(vide.txt));
  check("et il dit où installer la règle",
    /promotion_rules/.test(vide.txt) && /date d'effet/.test(vide.txt));

  const refusVide = await prononcer(ELEVE, "redouble");
  check("le POST fabriqué à la main est refusé lui aussi",
    /Aucune règle de passage n'est en vigueur/.test(refusVide),
    refusVide.slice(0, 260));
  const { rows: rien } = await client.query(
    `select decision from conseil_decisions where student_id = $1`, [ELEVE]);
  check("RIEN n'est écrit en base", rien.length === 0,
    JSON.stringify(rien) + " — avant, `redouble` partait pour un élève de CP1 "
      + "et l'écran annonçait « 1 décision enregistrée »");
  const { rows: livret } = await client.query(
    `select id from livret_entries where student_id = $1 and not is_external`,
    [ELEVE]);
  check("ni dans le livret scolaire, qui suit l'élève d'une école à l'autre",
    livret.length === 0);

  /* Et « admis » non plus : ce n'est pas le redoublement qu'on bloque, c'est
   * la délibération. Une barre d'admission inconnue rend « admis » aussi peu
   * fondé que « redouble ». */
  const refusAdmis = await prononcer(ELEVE, "admis");
  check("même « admis » est refusé : c'est la délibération qui est impossible",
    /Aucune règle de passage n'est en vigueur/.test(refusAdmis),
    "la barre d'admission est inconnue elle aussi");

  /* === 5. Ce que le tableau de bord en dit ============================= */
  console.log("\nLe tableau de bord le dit AVANT la séance");

  const accueil = texte(await (await fetch(`${BASE}/`, { headers: { cookie } })).text());
  check("un niveau sans règle de passage remonte au tableau de bord",
    /aucune règle de passage en vigueur/i.test(accueil),
    "mieux vaut le savoir avant le conseil que pendant");

  const { rows: niv } = await client.query(
    `select level_code, classes from niveaux_sans_regle_de_passage()`);
  check("et la fonction ne liste que les niveaux RÉELLEMENT enseignés",
    niv.length === 1 && niv[0].level_code === "CP1",
    JSON.stringify(niv) + " — signaler un problème sur un niveau que l'école "
      + "n'enseigne pas apprend à ne plus lire les tableaux de bord");

  /* === 6. Les deux écritures du même arrêté ============================ */
  console.log("\nL'arrêté de 2019 est encodé deux fois : elles sont comparées");

  const { rows: inc1 } = await client.query(`select * from ban_redoublement_incoherent()`);
  check("sans règle, le CP1 est signalé comme incohérent avec le texte",
    inc1.length === 1 && inc1[0].level_code === "CP1",
    JSON.stringify(inc1));

  await client.query(
    `insert into promotion_rules (school_id, level_code, effective_from,
        redoublement_allowed, min_average_to_pass, source_note)
     values (current_school_id(), 'CP1', current_date, true, 10.00, $1)`,
    [MARQUE + " — regle d ecole contraire au texte"]);
  const { rows: inc2 } = await client.query(`select * from ban_redoublement_incoherent()`);
  check("une règle d'école qui AUTORISE le redoublement en CP1 l'est aussi",
    inc2.length === 1 && inc2[0].autorise_par_la_regle === true,
    JSON.stringify(inc2) + " — deux écritures du même texte, et rien ne les "
      + "comparait");
  const accueil2 = texte(await (await fetch(`${BASE}/`, { headers: { cookie } })).text());
  check("et le tableau de bord le dit",
    /l'arrêté de 2019 l'interdit/i.test(accueil2),
    accueil2.slice(0, 400));

  await client.query(
    `update promotion_rules set redoublement_allowed = false where level_code = 'CP1'`);
  const { rows: inc3 } = await client.query(`select * from ban_redoublement_incoherent()`);
  check("une fois les deux d'accord, plus rien n'est signalé", inc3.length === 0,
    JSON.stringify(inc3));

  /* === 7. La règle du niveau l'emporte sur la règle générale =========== */
  console.log("\nLa règle du niveau l'emporte, à date égale comme à date différente");

  await client.query(
    `insert into promotion_rules (school_id, level_code, effective_from,
        redoublement_allowed, min_average_to_pass, source_note)
     values (current_school_id(), null, current_date, true, 8.00, $1)`,
    [MARQUE + " — regle generale"]);
  const { rows: choisie } = await client.query(
    `select level_code, min_average_to_pass from regle_de_passage('CP1')`);
  check("la règle du niveau gagne sur la règle générale",
    choisie[0].level_code === "CP1",
    JSON.stringify(choisie));
  const { rows: autre } = await client.query(
    `select level_code, min_average_to_pass from regle_de_passage('TLE')`);
  check("et un niveau sans règle propre retombe sur la règle générale",
    autre[0].level_code === null && Number(autre[0].min_average_to_pass) === 8,
    JSON.stringify(autre));
  const { rows: hier } = await client.query(
    `select count(*)::int as n from regle_de_passage('TLE', current_date - 1)`);
  check("demandée la veille de son effet, elle ne rend rien", hier[0].n === 0,
    "c'est la borne de date, éprouvée à l'envers");
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
console.log("La règle de passage est datée, elle dit d'où elle sort, et son "
  + "absence n'autorise rien.");
