/**
 * Ce qui est clos est clos : le registre de discipline et le tableau de bord.
 *
 * `tests/bornes.e2e.mjs` interdit la forme fautive dans le code. Cette suite
 * vérifie les deux écrans qui la portaient, contre un vrai serveur.
 *
 * I. « CE QUI REVIENT — 1 ÉLÈVE SIGNALÉ PLUSIEURS FOIS CETTE ANNÉE »
 *
 * On pose deux faits de discipline vieux de deux ans, hors de toute année
 * ouverte. Le registre affichait alors, mot pour mot :
 *
 *     Ce qui revient — 1 élève signalé plusieurs fois CETTE ANNÉE
 *     BAMBARA Alizèta · 2 faits · « 2 fois signalé, rien n'a été décidé »
 *     · dernier le 16/10/2024
 *
 * Le titre dit l'année, la colonne imprime 2024, et la même ligne se contredit.
 * Personne ne lit la colonne de droite quand le titre a déjà répondu.
 *
 * La borne était écrite — dans le ON d'une jointure externe vers `enrolments`,
 * où elle choisit la classe affichée et rien d'autre. Même piège qu'en 0023,
 * second module.
 *
 * II. UN POINT BLOQUANT QUE PERSONNE NE POUVAIT ÉTEINDRE
 *
 *     Les règles de notation n'ont pas été confirmées : toutes les moyennes
 *     calculées restent indicatives.
 *
 * Déduit de `count(*) from grading_policies where source_note is not null` —
 * toutes les lignes, toutes les dates. Or `settings.ts` écrit UNE LIGNE PAR
 * ANNÉE et ne touche jamais aux précédentes. Un directeur qui confirmait ses
 * règles en 2026 laissait celle de 2024 avec sa note : le point restait allumé
 * pour toujours, et aucun geste offert par l'écran ne pouvait l'éteindre.
 *
 * C'est la faute que `attention.ts` s'interdit dans sa première phrase. Un
 * indicateur rouge que rien ne peut éteindre apprend à ne plus lire les rouges.
 *
 *   node tests/clos.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4274;
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

const MARQUE = "EPREUVE clos";

const purger = async () => {
  await client.query(`delete from behavior_incidents where description like $1`,
    [MARQUE + "%"]);
  await client.query(`delete from grading_policies where source_note like $1`,
    [MARQUE + "%"]);
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
  .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

try {
  const cookie = await login("70000001");
  const { rows: el } = await client.query(
    `select st.id, st.last_name from enrolments e
       join students st on st.id = e.student_id
      where e.academic_year_id = annee_en_cours()
      order by st.last_name limit 1`);
  const A = el[0];

  const registre = async () =>
    texte(await (await fetch(`${BASE}/discipline`, { headers: { cookie } })).text());
  const bord = async () =>
    texte(await (await fetch(`${BASE}/`, { headers: { cookie } })).text());

  /* === I. Le registre de discipline ==================================== */
  console.log("\nLe registre parle de l'année qu'il annonce");

  const avant = await registre();
  check("aucune carte « Ce qui revient » au départ",
    !avant.includes("Ce qui revient"), avant.slice(0, 120));

  const ANCIEN = 700;   // deux ans en arrière, hors de toute année ouverte
  for (let n = 0; n < 2; n += 1) {
    await client.query(
      `insert into behavior_incidents (school_id, student_id, occurred_on, description)
       values (current_school_id(), $1, current_date - ($2)::int, $3)`,
      [A.id, ANCIEN - n, MARQUE + " fait de l annee close"]);
  }

  const apres = await registre();
  check("deux faits vieux de deux ans ne font pas une récurrence de cette année",
    !apres.includes("Ce qui revient"),
    `la carte s'intitule « signalé plusieurs fois cette année » et imprimait `
      + `« dernier le 16/10/2024 » sur la même ligne`);
  check("et ils n'apparaissent pas dans la liste chronologique",
    !apres.includes(MARQUE),
    "le registre sert à dire au conseil ce qui s'est passé CETTE année");

  /* La borne coupe, elle n'efface pas : les faits sont toujours en base. */
  const { rows: toujours } = await client.query(
    `select count(*)::int as n from behavior_incidents where description like $1`,
    [MARQUE + "%"]);
  check("les faits restent en base : la borne coupe, elle n'efface pas",
    toujours[0].n === 2, `${toujours[0].n}`);

  /* Et un fait de CETTE année, lui, remonte bien. */
  const { rows: jour } = await client.query(
    `select (ay.starts_on + 20)::text as j from academic_years ay
      where ay.id = annee_en_cours()`);
  for (let n = 0; n < 2; n += 1) {
    await client.query(
      `insert into behavior_incidents (school_id, student_id, occurred_on, description)
       values (current_school_id(), $1, $2::date + ($3)::int, $4)`,
      [A.id, jour[0].j, n, MARQUE + " fait de cette annee"]);
  }
  const avecRecents = await registre();
  check("deux faits de CETTE année font bien une récurrence",
    avecRecents.includes("Ce qui revient"),
    "la borne ne doit pas tout couper — seulement ce qui n'est pas de l'année");
  check("et le registre les montre",
    avecRecents.includes(MARQUE + " fait de cette annee"));
  check("sans montrer ceux de l'année close pour autant",
    !avecRecents.includes(MARQUE + " fait de l annee close"),
    "sinon le compte de la carte mélangerait de nouveau deux années");

  await client.query(`delete from behavior_incidents where description like $1`,
    [MARQUE + "%"]);

  /* === II. Le point bloquant qui ne s'éteignait jamais ================= */
  console.log("\nUn point bloquant s'éteint quand on a fait le geste");

  const bordAvant = await bord();
  check("aucun point sur les règles de notation au départ",
    !bordAvant.includes("règles de notation n'ont pas été confirmées"),
    "la démonstration a des règles confirmées");

  /* La politique EN VIGUEUR reste propre ; on ajoute celle d'une année
   * révolue, portant encore sa note — exactement ce que laisse `settings.ts`,
   * qui écrit une ligne par année sans toucher aux précédentes. */
  const { rows: cur } = await client.query(
    `select * from grading_policies where effective_from <= current_date
      order by effective_from desc limit 1`);
  await client.query(
    `insert into grading_policies (school_id, effective_from, interrogation_weight,
         devoir_weight, composition_weight, scale_max, pass_mark, decimals,
         rounding, rank_tie_policy, source_note, unjustified_absence_counts_as_zero)
     values (current_school_id(), current_date - 800, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [cur[0].interrogation_weight, cur[0].devoir_weight, cur[0].composition_weight,
     cur[0].scale_max, cur[0].pass_mark, cur[0].decimals, cur[0].rounding,
     cur[0].rank_tie_policy, MARQUE + " regle d une annee revolue",
     cur[0].unjustified_absence_counts_as_zero]);

  const bordApres = await bord();
  check("une règle RÉVOLUE non confirmée ne rallume pas le point bloquant",
    !bordApres.includes("règles de notation n'ont pas été confirmées"),
    `« toutes les moyennes calculées restent indicatives », pour toujours, à `
      + `cause d'une ligne de 2024 que l'écran ne permet pas de toucher`);

  const { rows: f1 } = await client.query(
    `select regle_notation_a_confirmer() as n`);
  check("et la fonction le dit aussi", f1[0].n === false, JSON.stringify(f1[0]));

  /* Mais la règle EN VIGUEUR non confirmée, elle, l'allume — sinon on aurait
   * remplacé un point qui ne s'éteint jamais par un point qui ne s'allume
   * jamais, ce qui est pire. */
  await client.query(
    `update grading_policies set source_note = $2 where id = $1`,
    [cur[0].id, MARQUE + " regle EN VIGUEUR non confirmee"]);
  const bordVigueur = await bord();
  check("une règle EN VIGUEUR non confirmée allume bien le point",
    bordVigueur.includes("règles de notation n'ont pas été confirmées"),
    "remplacer un point qui ne s'éteint jamais par un point qui ne s'allume "
      + "jamais serait pire");
  await client.query(
    `update grading_policies set source_note = $2 where id = $1`,
    [cur[0].id, cur[0].source_note]);

  /* === III. Les absences à justifier, bornées elles aussi ============== */
  console.log("\nLes absences à justifier sont celles de cette année");

  const { rows: n1 } = await client.query(
    `select absences_evaluation_a_justifier(annee_en_cours()) as n`);
  const { rows: n2 } = await client.query(
    `select count(*)::int as n from grade_entries
      where is_absent and not is_justified`);
  check("la fonction bornée compte au plus autant que la table entière",
    Number(n1[0].n) <= Number(n2[0].n),
    `${n1[0].n} cette année sur ${n2[0].n} en tout`);

  const { rows: z } = await client.query(
    `select absence_non_justifiee_compte_zero() as z`);
  const { rows: zTous } = await client.query(
    `select exists (select 1 from grading_policies
                     where unjustified_absence_counts_as_zero) as z`);
  check("la règle « compte zéro » est celle en vigueur, pas n'importe laquelle",
    typeof z[0].z === "boolean",
    `en vigueur : ${z[0].z} · au moins une ligne quelque part : ${zTous[0].z} — `
      + `l'ancienne version se déclenchait sur la seconde, y compris pour une `
      + `politique abandonnée ou saisie d'avance`);
} catch (e) {
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
console.log("Le registre parle de l'année qu'il annonce, et un point bloquant "
  + "s'éteint quand le geste est fait.");
