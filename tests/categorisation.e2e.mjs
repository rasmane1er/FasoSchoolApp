/**
 * Dossier de catégorisation.
 *
 * L'enjeu de cet écran n'est pas l'addition. C'est ce qu'il refuse de faire :
 * il ne déduit ni la catégorie ni le plafond de frais, parce que les tables de
 * l'arrêté n'ont pas pu être obtenues. Un écran qui les devinerait conduirait
 * un établissement à facturer un montant illégal.
 *
 *   node tests/categorisation.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4196;
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

const { rows: dos } = await client.query(`select id from category_assessments limit 1`);
const dossierId = dos[0].id;

// État de départ, restitué à la fin : la démonstration doit rester la même.
const { rows: depart } = await client.query(
  `select id, awarded_points, evidence_key from category_criteria
    where category_assessment_id = $1`, [dossierId]);
/* L'EN-TÊTE DU DOSSIER SE REND À UNE VALEUR CONNUE, PAS À LA PHOTO.
 *
 * Cette suite écrit une catégorie et un plafond, puis les rendait à ce
 * qu'elle avait relevé au départ. Si un tour précédent avait laissé une
 * catégorie, la photo l'enregistrait comme la normale et le `finally` la
 * rendait — pour toujours. La plainte est sortie deux suites plus loin, dans
 * celle du plafond déclaré, qui refuse de partir d'un dossier déjà rempli.
 *
 * Le jeu de démonstration sème un dossier VIERGE : ni catégorie, ni plafond,
 * et le statut « brouillon ». C'est cela qu'on rend, et on refuse de partir
 * d'autre chose. */
const { rows: entete } = await client.query(
  `select category, declared_ceiling_fcfa, status from category_assessments where id = $1`,
  [dossierId]);
if (entete[0].declared_ceiling_fcfa !== null
    || entete[0].status !== "brouillon") {
  console.error(
    `Le dossier de catégorisation n'est pas vierge : `
    + `${JSON.stringify(entete[0])}.\nCette suite y écrit une catégorie et un `
    + `plafond ; elle ne peut pas distinguer son propre reste du jeu semé. `
    + `Relancez « npm run demo ».`);
  await client.end();
  process.exit(1);
}

const CODE_TEST = "ZTEST";
const purge = async () => {
  await client.query(`delete from category_criteria where code = $1`, [CODE_TEST]);
};
await purge();

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
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

try {
  await connecter(page, "70000005");                    // directeur

  console.log("\nLe dossier");
  await page.goto(`${BASE}/categorisation`);
  await page.waitForSelector("table");
  const vue = await page.content();

  check("le dossier est modifiable, plus seulement consultable",
    vue.includes('name="p_') && vue.includes('name="e_'));
  check("les deux axes sont séparés",
    vue.includes("Investissement") && vue.includes("Qualité"));
  check("l'arrêté est cité", vue.includes("2026-101"));
  check("le logiciel dit ce qu'il ne sait pas",
    vue.includes("n'est pas encodée dans le logiciel")
    && vue.includes("montant illégal"),
    "deviner la catégorie ferait facturer un montant illégal");
  check("les critères non renseignés sont comptés",
    vue.includes("À renseigner") || vue.includes("À RENSEIGNER"));
  check("les points sans pièce justificative sont signalés",
    vue.includes("sans pièce"),
    "c'est ce qu'une inspection retire en premier");
  check("un critère à zéro point n'est pas présenté comme justifié",
    !vue.includes("0 point") || vue.includes(">0 point<"),
    "rien n'a été justifié : le critère vaut simplement zéro");

  /* AUCUN FORMULAIRE N'EST IMBRIQUÉ DANS UN AUTRE.
   *
   * Chaque critère porte désormais son propre formulaire d'envoi de fichier,
   * dans une cellule du tableau. Placés à l'intérieur du formulaire du
   * dossier, ils l'auraient CASSÉ : un formulaire dans un formulaire est
   * interdit en HTML, le navigateur ferme celui du dehors en rencontrant celui
   * du dedans, et le bouton « Enregistrer » se retrouve dehors, rattaché à
   * rien. Le HTML se relit sans que rien ne saute aux yeux ; seul un vrai
   * navigateur le montre. D'où cette assertion, qui interroge le DOM tel que
   * le navigateur l'a construit — et non la chaîne que le serveur a écrite. */
  const imbrication = await page.evaluate(() =>
    [...document.forms].filter((f) => f.closest("form") !== f).length);
  check("AUCUN FORMULAIRE N'EST IMBRIQUÉ DANS UN AUTRE", imbrication === 0,
    `${imbrication} formulaire(s) imbriqué(s) — le bouton « Enregistrer » `
      + `n'appartiendrait plus à rien`);
  const champsDossier = await page.evaluate(() =>
    document.getElementById("dossier")?.elements.length ?? 0);
  check("et le formulaire du dossier possède bien tous ses champs",
    champsDossier > 20, `${champsDossier} champs`);

  console.log("\nSaisie");
  // Une note hors barème doit être refusée, pas rognée en silence.
  const premier = await page.locator('input[name^="p_"]').first().getAttribute("name");
  const critId = premier.slice(2);
  const { rows: mx } = await client.query(
    `select max_points from category_criteria where id = $1`, [critId]);
  await page.fill(`[name="${premier}"]`, String(Number(mx[0].max_points) + 5));
  await envoyer(page, 'button[form="dossier"]');
  check("des points au-dessus du maximum sont refusés",
    (await page.content()).includes("pour un maximum de"));
  const apresRefus = await client.query(
    `select awarded_points from category_criteria where id = $1`, [critId]);
  check("un critère refusé n'est pas écrit",
    Number(apresRefus.rows[0].awarded_points ?? -1) !== Number(mx[0].max_points) + 5);

  // Une saisie valable, avec sa pièce.
  await page.goto(`${BASE}/categorisation`);
  await page.fill(`[name="p_${critId}"]`, String(mx[0].max_points));
  await page.fill(`[name="e_${critId}"]`, "classeur 3, pièce 12");
  await envoyer(page, 'button[form="dossier"]');
  const ok = await client.query(
    `select awarded_points, evidence_key from category_criteria where id = $1`, [critId]);
  check("les points sont enregistrés",
    Number(ok.rows[0].awarded_points) === Number(mx[0].max_points));
  check("la pièce justificative est enregistrée",
    ok.rows[0].evidence_key === "classeur 3, pièce 12");

  const totaux = await client.query(
    `select a.investment_score, a.quality_score, a.total_score,
            (select coalesce(sum(awarded_points),0) from category_criteria
              where category_assessment_id = a.id and axis = 'investissement') as calc_inv
       from category_assessments a where a.id = $1`, [dossierId]);
  check("le score par axe est recalculé depuis les critères, pas saisi",
    Number(totaux.rows[0].investment_score) ===
      Math.min(Number(totaux.rows[0].calc_inv), 50),
    `${totaux.rows[0].investment_score} vs ${totaux.rows[0].calc_inv}`);

  console.log("\nDéclaration");
  await page.goto(`${BASE}/categorisation`);
  await page.fill('[name="categorie"]', "4");
  await envoyer(page, 'button[form="dossier"]');
  check("une catégorie hors 1-2-3 est refusée",
    (await page.content()).includes("La catégorie est 1, 2 ou 3"));

  await page.goto(`${BASE}/categorisation`);
  await page.fill('[name="categorie"]', "2");
  await page.fill('[name="plafond"]', "180000");
  await envoyer(page, 'button[form="dossier"]');
  const decl = await client.query(
    `select category, declared_ceiling_fcfa from category_assessments where id = $1`,
    [dossierId]);
  check("la catégorie déclarée par un humain est enregistrée",
    decl.rows[0].category === 2, `${decl.rows[0].category}`);
  check("le plafond déclaré est enregistré",
    Number(decl.rows[0].declared_ceiling_fcfa) === 180000);
  check("le plafond est rappelé face aux lignes de frais",
    (await page.content()).includes("plafonné"));

  console.log("\nAjout d'un critère");
  await page.selectOption('[name="axe"]', "qualite");
  await page.fill('[name="code"]', CODE_TEST);
  await page.fill('[name="intitule"]', "Critère de vérification");
  await page.fill('[name="max"]', "4");
  await envoyer(page, 'form[action="/categorisation/critere"] button[type=submit]');
  check("un critère se saisit depuis l'exemplaire de l'arrêté de l'établissement",
    (await page.content()).includes(`Critère ${CODE_TEST} ajouté`));

  await page.selectOption('[name="axe"]', "qualite");
  await page.fill('[name="code"]', CODE_TEST);
  await page.fill('[name="intitule"]', "Doublon");
  await page.fill('[name="max"]', "4");
  await envoyer(page, 'form[action="/categorisation/critere"] button[type=submit]');
  check("un code déjà utilisé est refusé",
    (await page.content()).includes("existe déjà"));

  await page.screenshot({ path: "out/captures/15-categorisation.png", fullPage: true });

  // Le critère ajouté porte l'axe qualité au-delà de 50 : l'écran doit le dire.
  await page.goto(`${BASE}/categorisation`);
  check("un axe dont les critères dépassent 50 points est signalé",
    (await page.content()).includes("l'arrêté le note sur 50"),
    "le score retenu est plafonné, il faut que ça se voie");

  console.log("\nDroits");
  const eco = await browser.newContext({ locale: "fr-FR" });
  const p2 = await eco.newPage();
  await connecter(p2, "70000004");                      // économe
  const r = await p2.goto(`${BASE}/categorisation`);
  check("l'économe ne touche pas au dossier de catégorisation",
    r.status() === 403, `HTTP ${r.status()}`);
  await eco.close();

} finally {
  await browser.close();
  server.kill();
  for (const c of depart) {
    await client.query(
      `update category_criteria set awarded_points = $2, evidence_key = $3 where id = $1`,
      [c.id, c.awarded_points, c.evidence_key]).catch(() => {});
  }
  /* ON REND À LA VALEUR SEMÉE, pas à la photo prise au début : une photo
   * recopie la fuite du tour précédent et la rend éternelle. La démonstration
   * sème une catégorie 2 — lue dans l'arrêté par le chef d'établissement — et
   * aucun plafond. */
  await client.query(
    `update category_assessments
        set category = 2, declared_ceiling_fcfa = null, status = 'brouillon',
            declared_on = null, declared_by = null
      where id = $1`, [dossierId]).catch(() => {});
  await client.query(
    `delete from category_ceiling_changes where category_assessment_id = $1`,
    [dossierId]).catch(() => {});
  await purge().catch(() => {});
  await client.query(`delete from auth_rate_limits`).catch(() => {});
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  if (stderr.trim()) console.log("\nServeur :\n" + stderr.trim().slice(0, 2000));
  process.exit(1);
}
console.log("Dossier de catégorisation vérifié de bout en bout.");
