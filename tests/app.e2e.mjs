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

/* UN JOUR OÙ L'ÉCOLE EST VRAIMENT OUVERTE.
 *
 * Ce parcours faisait l'appel « aujourd'hui », sans date. Aujourd'hui, dans le
 * conteneur, est le 9 septembre 2026 : AVANT le 1er octobre où commence
 * l'année scolaire de la démonstration. Le parcours enregistrait donc des
 * absences et envoyait des SMS un jour où l'établissement n'existait pas
 * encore — et cela passait, parce que rien ne regardait le calendrier.
 *
 * Le mardi 13 octobre 2026 est dans l'année, dans la semaine de travail, hors
 * fête légale, et ne porte aucune séance de la démonstration (elle en pose les
 * 5, 10, 15, 20 et 25 octobre). */
const JOUR_ECOLE = "2026-10-13";

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
    await client.query(`delete from attendance_sessions where session_date = $1`, [JOUR_ECOLE]);
    await client.query(`delete from sms_messages where queued_at::date = current_date`);
    // Le parcours confirme les règles et modifie la pondération : on remet
    // l'établissement dans l'état où seed_school_defaults() le laisse.
    await client.query(`update grading_policies
                           set devoir_weight = 1, composition_weight = 2,
                               interrogation_weight = 0,
                               source_note = 'DÉFAUT NON VÉRIFIÉ — convention régionale.'`);
    await client.query(`update coefficient_sets
                           set source_note = 'DÉFAUT NON VÉRIFIÉ — réforme 2026.'`);
    // Les encaissements du parcours s'accumuleraient jusqu'à solder la facture.
    await client.query(`delete from receipts where payment_id in
                          (select id from payments where idempotency_key like 'guichet:%')`);
    await client.query(`delete from payments where idempotency_key like 'guichet:%'`);
    await client.query(`update invoices set status = 'ouverte' where status <> 'annulee'`);
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
  /* Le censeur n'a pas de droit sur la comptabilité ni sur le dossier de
     catégorisation : les chiffres correspondants ne lui sont pas montrés
     non plus. Un tableau de bord qui affiche ce qu'on ne peut pas ouvrir
     invite à demander pourquoi. */
  check("un chiffre sans écran n'est pas affiché",
    !dash.includes("Reste à recouvrer") && !dash.includes("Catégorisation"),
    "le censeur n'a ni voir_scolarite ni voir_categorisation");

  /* Le tableau de bord doit remonter ce qui demande une ACTION, pas seulement
     des indicateurs verts. Personne ne descend jusqu'aux tableaux. */
  check("ce qui demande une action est en haut de page",
    dash.includes("À traiter") || dash.includes("Rien à signaler"));
  check("les règles non confirmées sont rappelées ici aussi",
    dash.includes("n'ont pas été confirmées"),
    "toutes les moyennes en dépendent");
  check("le nombre n'est pas répété dans une même phrase",
    !/\b(\d+)\s[^.<]*?:\s\1\s/.test(dash),
    "« 1 élève ... : 1 sa famille » — accord sans le nombre");
  check("on ne signale que ce que l'on peut traiter",
    !dash.includes("catégorisation portent des points"),
    "annoncer au censeur un dossier qu'il ne peut pas ouvrir, "
    + "c'est lui donner une inquiétude sans moyen d'agir");
  check("chaque point d'attention mène à l'écran où le traiter",
    !dash.includes("À traiter") || /href="\/(parametres|conflits|inscriptions|annee|categorisation|conseil|absences)"/.test(dash));

  /* La barre ne doit proposer que ce que l'on peut ouvrir : un lien qui rend
     « Accès refusé » fait conclure que le logiciel est cassé. */
  const liens = await page.$$eval(".side nav a", (as) => as.map((a) => a.getAttribute("href")));
  const refuses = [];
  for (const h of liens) {
    if (h === "/deconnexion") continue;
    const r = await page.goto(`${BASE}${h}`);
    if (r.status() === 403) refuses.push(h);
  }
  check("aucun lien de la barre ne mène à un refus", refuses.length === 0,
    refuses.join(", "));
  check("la barre est regroupée, pas une liste de quinze liens à plat",
    (await page.$$eval(".navgroupe", (d) => d.length)) >= 3);
  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");

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
  // Une valeur différente de celle qui s'y trouve déjà : sinon il n'y a rien à
  // enregistrer, et l'écran a raison de ne rien confirmer.
  const saisie = before.startsWith("19,5") ? "18,25" : "19,50";
  await page.fill("input.note-cell >> nth=0", saisie);
  await page.click("button[type=submit]");

  /* La saisie passe par la file hors-ligne dès que JavaScript est actif : le
     navigateur ne recharge donc pas la page, et la confirmation arrive dans le
     bandeau d'état. C'est le chemin qu'emprunte un vrai enseignant. */
  await page.waitForFunction(
    () => document.getElementById("etat-file")?.textContent?.includes("synchronisée"),
    null, { timeout: 8000 });
  check("l'enregistrement confirme",
    (await page.textContent("#etat-file")).includes("synchronisée"));

  await page.reload();
  await page.waitForSelector("input.note-cell");
  const after = await page.inputValue("input.note-cell >> nth=0");
  check("la note saisie est relue depuis la base", after.startsWith(saisie.slice(0, 4)),
    `lu « ${after} », saisi « ${saisie} », avant « ${before} »`);
  await page.screenshot({ path: "out/captures/03-notes.png", fullPage: true });

  /* Hors barème. Autrefois la valeur disparaissait sans un mot — le code
     disait lui-même « saisie rejetée en silence ». Le refus est maintenant
     annoncé, et sur ce chemin il l'est SANS aller-retour serveur : la page ne
     navigue plus, elle explique. */
  await page.fill("input.note-cell >> nth=0", "99");
  await page.click("button[type=submit]");
  await page.waitForFunction(
    () => (document.getElementById("etat-file")?.textContent ?? "").includes("refusée"),
    null, { timeout: 5000 });
  const refus = await page.textContent("#etat-file");
  check("une note hors barème est refusée ET DITE", refus.includes("refusée"), refus);
  check("le refus rappelle le barème", refus.includes("sur 20"), refus);
  check("et la valeur refusée est citée", refus.includes("99"), refus);

  await page.reload();
  await page.waitForSelector("input.note-cell");
  const rejected = await page.inputValue("input.note-cell >> nth=0");
  check("elle n'est pas enregistrée", !rejected.startsWith("99"), `lu « ${rejected} »`);

  console.log("\nAppel et SMS");
  await page.goto(`${BASE}/absences?classe=${classe}&date=${JOUR_ECOLE}`);
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

  console.log("\nRègles de notation");
  await page.goto(`${BASE}/parametres`);
  await page.waitForSelector("h1");
  const par = await page.content();
  check("les règles non confirmées sont signalées", par.includes("non confirmée"));
  check("la formule courante est affichée", par.includes("composition × 2"));
  check("l'effet sur une classe réelle est montré", par.includes("Effet sur la"));
  await page.screenshot({ path: "out/captures/07-parametres.png", fullPage: true });

  // Le censeur corrige la pondération : devoirs et composition à parts égales.
  const avant = await page.textContent("#apercu tbody tr:nth-child(1) td:nth-child(3)");
  await page.fill("input[name=w_compo]", "1");
  await page.check("input[name=confirme]");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);
  await page.waitForSelector(".ok");
  const apres = await page.textContent("#apercu tbody tr:nth-child(1) td:nth-child(3)");
  check("la correction est confirmée", (await page.textContent(".ok")).includes("confirmées"));
  check("les moyennes changent immédiatement", avant !== apres, `${avant} -> ${apres}`);
  check("l'avertissement disparaît une fois confirmé",
    (await page.content()).includes("Règles confirmées par l'établissement"));

  // Remise en état pour que le parcours reste rejouable.
  await page.fill("input[name=w_compo]", "2");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load" }),
    page.click("button[type=submit]"),
  ]);

  console.log("\nCloisonnement des rôles");
  const eco = await ctx.browser().newContext({ locale: "fr-FR" });
  const p2 = await eco.newPage();
  await connecter(p2, "70000004");           // économe
  await p2.goto(`${BASE}/scolarite`);
  check("l'économe accède à la scolarité", (await p2.content()).includes("Scolarité"));
  await p2.screenshot({ path: "out/captures/05-scolarite.png", fullPage: true });

  // Encaissement d'un paiement en espèces au guichet.
  const resteAvant = await p2.textContent("tbody tr:nth-child(1) td:nth-child(5)");
  await p2.click("tbody tr:nth-child(1) a:has-text('Encaisser')");
  await p2.waitForSelector("#montant");
  const du = await p2.inputValue("#montant");
  check("le formulaire propose le reste à payer", Number(du) > 0, du);

  await p2.fill("#montant", "999999999");
  await Promise.all([p2.waitForNavigation({ waitUntil: "load" }), p2.click("button[type=submit]")]);
  check("un montant supérieur au reste est refusé",
    (await p2.content()).includes("dépasse le reste"));

  await p2.fill("#montant", "10000");
  await Promise.all([p2.waitForNavigation({ waitUntil: "load" }), p2.click("button[type=submit]")]);
  await p2.waitForSelector(".ok");
  const conf = await p2.textContent(".ok");
  check("le paiement est enregistré", conf.includes("Paiement enregistré"), conf);
  check("un numéro de reçu est attribué", /R-\d{4}-\d{4}/.test(conf), conf);

  const resteApres = await p2.textContent("tbody tr:nth-child(1) td:nth-child(5)");
  check("le reste à payer diminue", resteAvant !== resteApres, `${resteAvant} -> ${resteApres}`);

  const numero = conf.match(/R-\d{4}-\d{4}/)[0];
  const recu = await eco.newPage();   // l échéance : le censeur n a pas accès à la scolarité
  await recu.goto(`${BASE}/recus/${numero}`);
  const rc = await recu.content();
  check("le reçu s'ouvre et porte le numéro", rc.includes(numero));
  check("le reçu montre le montant reçu", rc.includes("10 000"));
  check("le reçu porte l'en-tête officiel", rc.includes("Unité — Progrès — Justice"));
  await recu.screenshot({ path: "out/captures/08-recu.png", fullPage: true });
  await recu.close();
  const r1 = await p2.goto(`${BASE}/categorisation`);
  check("l'économe est refusé sur la catégorisation", r1.status() === 403, `HTTP ${r1.status()}`);
  const r2 = await p2.goto(`${BASE}/parametres`);
  check("l'économe est refusé sur les règles de notation", r2.status() === 403, `HTTP ${r2.status()}`);
  await eco.close();

  const dir = await ctx.browser().newContext({ locale: "fr-FR" });
  const p3 = await dir.newPage();
  await connecter(p3, "70000005");           // directeur
  await p3.goto(`${BASE}/categorisation`);
  const cat = await p3.content();
  check("le directeur voit le dossier de catégorisation", cat.includes("Catégorisation"));
  check("le score 68/100 est affiché", cat.includes("68"));
  check("un critère sans pièce justificative est signalé", cat.includes("sans pièce"),
    "c'est ce qu'une inspection retire en premier");
  check("le dossier est saisissable, pas seulement consultable",
    cat.includes('name="p_'));
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
