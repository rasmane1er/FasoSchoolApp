/**
 * Parcours complet dans un vrai navigateur.
 *
 * Démarre le serveur, se connecte par OTP, saisit une note, vérifie que la
 * moyenne bouge, fait un appel, vérifie qu'un SMS est bien mis en file, et
 * contrôle qu'un rôle sans droit se voit refuser l'accès.
 *
 *   node tests/app.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import pg from "pg";

const PORT = 4188;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

async function connecter(page, phone) {
  await page.goto(`${BASE}/connexion`);
  await page.fill("#phone", phone);
  await page.click("button[type=submit]");
  await page.waitForSelector("#code");
  const code = (await page.textContent(".note.warn b")).trim();
  await page.fill("#code", code);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");
}

// Le parcours modifie des données : on remet à zéro ce qu'il touche, sinon la
// deuxième exécution échoue sur l'état laissé par la première. Le contexte
// d'établissement doit être posé, sinon le RLS bloque la suppression.
{
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const { rows } = await client.query(`select school_id from auth_lookup_user('70000001')`);
  if (rows[0]) {
    await client.query(`select set_config('fasoschool.school_id', $1, false)`, [rows[0].school_id]);
    await client.query(`delete from attendance_sessions where session_date = current_date`);
    await client.query(`delete from sms_messages where queued_at::date = current_date`);
  }
  // Le limiteur de connexions est volontairement strict (6 par quart d'heure).
  // Sans purge, le parcours n'est jouable qu'une fois par fenêtre.
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.end();
}

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

const up = await (async () => {
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch(`${BASE}/sante`); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
})();

if (!up) { console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1500)); server.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR" });
const page = await ctx.newPage();
mkdirSync("out/captures", { recursive: true });

try {
  console.log("\nAccès et authentification");
  await page.goto(`${BASE}/`);
  check("une page protégée renvoie vers la connexion", page.url().endsWith("/connexion"));

  await page.goto(`${BASE}/connexion`);
  await page.fill("#phone", "70000001");
  await page.click("button[type=submit]");
  await page.waitForSelector("#code");
  check("le formulaire de code apparaît", await page.isVisible("#code"));

  await page.fill("#code", "000000");
  await page.click("button[type=submit]");
  await page.waitForSelector(".err");
  check("un mauvais code est refusé", (await page.textContent(".err")).includes("incorrect"));

  await connecter(page, "70000001");
  check("connexion du censeur réussie", page.url() === `${BASE}/`, page.url());
  check("le nom apparaît dans l'en-tête", (await page.content()).includes("OUÉDRAOGO Séraphin"));
  check("la fonction est affichée en français", (await page.content()).includes("Censeur"));

  console.log("\nTableau de bord");
  await page.screenshot({ path: "out/captures/01-tableau-de-bord.png", fullPage: true });
  const dash = await page.content();
  check("la classe 6e B est listée", dash.includes("6e B"));
  check("le crédit SMS est affiché", dash.includes("Crédit SMS"));
  check("le score de catégorisation remonte", dash.includes("68"));

  console.log("\nBulletins");
  await page.click("text=Bulletins");
  await page.waitForLoadState("networkidle");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.selectOption("select[name=classe]", { label: "6e B" }),
  ]);
  await page.waitForSelector("h1");
  const bul = await page.content();
  check("le classement s'affiche", bul.includes("Classement"));
  check("les règles non vérifiées sont signalées", bul.includes("confirmer avec le censeur")
    || bul.includes("Règles à confirmer"));
  check("la moyenne de NIKIÉMA est 13,60", bul.includes("13,60"), "élève non modifié par le parcours");
  await page.screenshot({ path: "out/captures/02-bulletins.png", fullPage: true });

  const url = page.url();
  const classe = new URL(url).searchParams.get("classe");
  const print = await ctx.newPage();
  await print.goto(`${BASE}/bulletins/imprimer?classe=${classe}`);
  const sheets = await print.locator(".sheet").count();
  check("12 bulletins imprimables sont produits", sheets === 12, `${sheets} feuilles`);
  await print.close();

  console.log("\nSaisie des notes");
  await page.goto(`${BASE}/notes?classe=${classe}`);
  await page.waitForLoadState("networkidle");
  const before = await page.inputValue("input.note-cell >> nth=0");
  await page.fill("input.note-cell >> nth=0", "19,50");
  await page.click("button[type=submit]");
  await page.waitForSelector(".ok");
  check("l'enregistrement confirme", (await page.textContent(".ok")).includes("enregistrée"));
  const after = await page.inputValue("input.note-cell >> nth=0");
  check("la note saisie est relue depuis la base", after.startsWith("19,5"), `lu « ${after} », avant « ${before} »`);
  await page.screenshot({ path: "out/captures/03-notes.png", fullPage: true });

  await page.fill("input.note-cell >> nth=0", "99");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);
  await page.waitForSelector("input.note-cell");
  const rejected = await page.inputValue("input.note-cell >> nth=0");
  check("une note hors barème est rejetée", !rejected.startsWith("99"), `lu « ${rejected} »`);

  console.log("\nAppel et SMS");
  await page.goto(`${BASE}/absences?classe=${classe}`);
  await page.waitForLoadState("networkidle");
  check("le cas « aucun tuteur joignable » est visible",
    (await page.content()).includes("Aucun tuteur joignable"));
  await page.check("tr:nth-child(1) input[value=absent]");
  await page.check("tr:nth-child(2) input[value=retard]");
  await page.click("button[type=submit]");
  await page.waitForSelector(".ok");
  const flash = await page.textContent(".ok");
  check("l'appel est enregistré", flash.includes("Appel enregistré"), flash);
  check("un SMS est parti pour l'absence", /1 SMS/.test(flash), flash);
  await page.screenshot({ path: "out/captures/04-absences.png", fullPage: true });

  await page.reload();
  check("le statut absent est conservé après rechargement",
    await page.isChecked("tr:nth-child(1) input[value=absent]"));

  await page.click("button[type=submit]");
  await page.waitForSelector(".ok");
  check("un second envoi ne redouble pas le SMS",
    /0 SMS/.test(await page.textContent(".ok")), await page.textContent(".ok"));

  console.log("\nCloisonnement des rôles");
  const eco = await ctx.browser().newContext({ locale: "fr-FR" });
  const p2 = await eco.newPage();
  await connecter(p2, "70000004");           // économe
  await p2.goto(`${BASE}/scolarite`);
  check("l'économe accède à la scolarité", (await p2.content()).includes("Scolarité"));
  await p2.screenshot({ path: "out/captures/05-scolarite.png", fullPage: true });
  const r1 = await p2.goto(`${BASE}/categorisation`);
  check("l'économe est refusé sur la catégorisation", r1.status() === 403, `HTTP ${r1.status()}`);
  await eco.close();

  const dir = await ctx.browser().newContext({ locale: "fr-FR" });
  const p3 = await dir.newPage();
  await connecter(p3, "70000005");           // directeur
  await p3.goto(`${BASE}/categorisation`);
  const cat = await p3.content();
  check("le directeur voit le dossier de catégorisation", cat.includes("Catégorisation"));
  check("le score 68/100 est affiché", cat.includes("68"));
  check("une pièce manquante est signalée", cat.includes("PIÈCE MANQUANTE"));
  await p3.screenshot({ path: "out/captures/06-categorisation.png", fullPage: true });
  await dir.close();

  console.log("\nDéconnexion");
  await page.goto(`${BASE}/deconnexion`);
  await page.goto(`${BASE}/`);
  check("la session est bien révoquée", page.url().endsWith("/connexion"));

} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("Parcours complet vérifié dans le navigateur.");
