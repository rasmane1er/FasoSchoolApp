/**
 * Saisie hors ligne : le scénario réel.
 *
 * Une enseignante ouvre sa classe avec du réseau, le perd, saisit ses notes,
 * ferme l'onglet, le rouvre, retrouve le réseau. Rien ne doit être perdu.
 *
 * Vérifie aussi le chemin de divergence : une note modifiée sur le serveur
 * pendant que l'appareil était hors ligne ne doit PAS être écrasée en silence.
 *
 *   node tests/offline.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import pg from "pg";

const PORT = 4189;
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
const { rows: sc } = await client.query(`select school_id from auth_lookup_user('70000002')`);
const schoolId = sc[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [schoolId]);
await client.query(`delete from auth_rate_limits`);
await client.query(`delete from auth_otp_challenges`);
await client.query(`delete from auth_sessions`);
await client.query(`delete from sync_conflicts`);
await client.query(`delete from sync_mutations`);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT), SMS_PROVIDER: "mock" }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = ""; server.stderr.on("data", (d) => { stderr += d.toString(); });
for (let i = 0; i < 50; i += 1) {
  try { if ((await fetch(`${BASE}/sante`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR" });
const page = await ctx.newPage();

try {
  // Connexion de l'enseignante.
  await page.goto(`${BASE}/connexion`);
  await page.fill("#phone", "70000002");
  await page.click("button[type=submit]");
  await page.waitForSelector("#code");
  await page.fill("#code", (await page.textContent("#code-demo")).trim());
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  const { rows: cl } = await client.query(
    `select cl.id from classes cl join evaluations ev on ev.class_id = cl.id limit 1`);
  const classe = cl[0].id;

  console.log("\nAvec réseau");
  await page.goto(`${BASE}/notes?classe=${classe}`);
  await page.waitForSelector("input.note-cell");
  check("le script hors ligne est chargé",
    await page.evaluate(() => !!document.querySelector('script[src="/offline.js"]')));
  check("les cellules portent leur identité", await page.evaluate(
    () => !!document.querySelector("input.note-cell[data-eval][data-student]")));

  const cible = page.locator("input.note-cell").first();
  const evalId = await cible.getAttribute("data-eval");
  const studentId = await cible.getAttribute("data-student");

  console.log("\nSans réseau");
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await cible.fill("17,25");
  await page.click("button[type=submit]");
  await page.waitForFunction(
    () => document.getElementById("etat-file")?.textContent?.includes("attente"),
    null, { timeout: 8000 });
  check("la saisie est mise en file, pas perdue",
    (await page.textContent("#etat-file")).includes("attente"));
  check("la page n'a pas navigué", page.url().includes("/notes"));

  const enBase = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, studentId]);
  check("rien n'est encore parti au serveur",
    Number(enBase.rows[0]?.score ?? 0) !== 17.25,
    `serveur = ${enBase.rows[0]?.score}`);

  // Fermeture et réouverture de l'onglet, toujours sans réseau.
  const page2 = await ctx.newPage();
  await page.close();
  await page2.goto(`${BASE}/notes?classe=${classe}`).catch(() => {});
  await page2.waitForTimeout(1500);
  const survit = await page2.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open("fasoschool", 1);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("outbox")) return resolve(0);
      const q = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
      q.onsuccess = () => resolve(q.result.length);
      q.onerror = () => resolve(-1);
    };
    r.onerror = () => resolve(-1);
  }));
  check("la file survit à la fermeture de l'onglet", survit >= 1, `${survit} en file`);

  console.log("\nRetour du réseau");
  await ctx.setOffline(false);
  await page2.goto(`${BASE}/notes?classe=${classe}`);
  await page2.waitForSelector("input.note-cell");
  await page2.waitForFunction(
    () => !document.getElementById("etat-file")?.textContent?.includes("attente"),
    null, { timeout: 10000 });

  const apres = await client.query(
    `select score, device_id from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, studentId]);
  check("la note est arrivée au serveur", Number(apres.rows[0]?.score) === 17.25,
    `serveur = ${apres.rows[0]?.score}`);
  check("l'appareil d'origine est enregistré", !!apres.rows[0]?.device_id);

  const rev = await client.query(
    `select count(*) as n from grade_entry_revisions r
       join grade_entries g on g.id = r.grade_entry_id
      where g.evaluation_id = $1 and g.student_id = $2 and r.source = 'offline'`,
    [evalId, studentId]);
  check("une révision hors-ligne est journalisée", Number(rev.rows[0].n) >= 1);

  const mut = await client.query(
    `select outcome from sync_mutations where entity_type = 'grade_entry'`);
  check("la mutation est marquée appliquée",
    mut.rows.some((r) => r.outcome === "applique"));

  console.log("\nRejeu : la file ne doit rien casser");
  const rejeu = await page2.evaluate(async ([e, s]) => {
    const body = { mutations: [{
      mutationId: crypto.randomUUID(), deviceId: "test-rejeu",
      evaluationId: e, studentId: s, score: 17.25, isAbsent: false,
      capturedAt: new Date().toISOString(), baseUpdatedAt: null }] };
    const r1 = await fetch("/api/sync/notes", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = await r1.json();
    const r2 = await fetch("/api/sync/notes", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const b = await r2.json();
    return [a.results[0].outcome, b.results[0].outcome];
  }, [evalId, studentId]);
  check("le premier envoi applique", rejeu[0] === "applique", rejeu.join(" / "));
  check("le rejeu du même identifiant ne refait rien", rejeu[1] === "deja_applique", rejeu.join(" / "));

  console.log("\nDivergence");
  // Le serveur a bougé pendant que l'appareil était hors ligne.
  await client.query(
    `update grade_entries set score = 9, updated_at = now()
      where evaluation_id = $1 and student_id = $2`, [evalId, studentId]);

  const conflit = await page2.evaluate(async ([e, s]) => {
    const r = await fetch("/api/sync/notes", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutations: [{
        mutationId: crypto.randomUUID(), deviceId: "tablette-prof",
        evaluationId: e, studentId: s, score: 15, isAbsent: false,
        capturedAt: new Date().toISOString(),
        baseUpdatedAt: new Date(Date.now() - 3600e3).toISOString() }] }) });
    return (await r.json()).results[0].outcome;
  }, [evalId, studentId]);
  check("une saisie périmée est signalée, pas appliquée", conflit === "conflit", conflit);

  const garde = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, studentId]);
  check("la valeur du serveur n'est pas écrasée", Number(garde.rows[0].score) === 9,
    `serveur = ${garde.rows[0].score}`);

  // Le censeur arbitre.
  const cens = await browser.newContext({ locale: "fr-FR" });
  const p3 = await cens.newPage();
  await p3.goto(`${BASE}/connexion`);
  await p3.fill("#phone", "70000001");
  await p3.click("button[type=submit]");
  await p3.waitForSelector("#code");
  await p3.fill("#code", (await p3.textContent("#code-demo")).trim());
  await p3.click("button[type=submit]");
  await p3.waitForLoadState("networkidle");

  await p3.goto(`${BASE}/conflits`);
  await p3.waitForSelector("h1");
  const cnt = await p3.content();
  check("le censeur voit la divergence", cnt.includes("divergentes") && cnt.includes("15,00"),
    "les deux valeurs doivent être visibles");
  check("les deux versions sont montrées côte à côte", cnt.includes("9,00") && cnt.includes("15,00"));
  await p3.screenshot({ path: "out/captures/09-conflits.png", fullPage: true });

  await Promise.all([
    p3.waitForNavigation({ waitUntil: "load" }),
    p3.click("button[value=appareil]"),
  ]);
  const arbitre = await client.query(
    `select score from grade_entries where evaluation_id = $1 and student_id = $2`,
    [evalId, studentId]);
  check("l'arbitrage du censeur est appliqué", Number(arbitre.rows[0].score) === 15,
    `serveur = ${arbitre.rows[0].score}`);
  check("plus aucune divergence en attente",
    (await p3.content()).includes("Aucune divergence"));
  await cens.close();

} finally {
  await browser.close();
  server.kill();
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) { failures.forEach((f) => console.log("  - " + f)); process.exit(1); }
console.log("Saisie hors ligne vérifiée de bout en bout.");
