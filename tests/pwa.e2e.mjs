/**
 * L'installation sur l'écran d'accueil, éprouvée dans un vrai navigateur.
 *
 * CE QUI MANQUAIT. Le dépôt avait un service worker et une file d'attente hors
 * ligne depuis le premier jour, et l'application était annoncée comme
 * « installable ». Elle ne l'était pas : il n'y avait aucun manifeste. Sans
 * manifeste, aucun navigateur ne propose « Ajouter à l'écran d'accueil ». Un
 * enseignant devait retaper une adresse, dans une cour, sur un téléphone.
 *
 * Et le service worker n'était enregistré que par `offline.js`, chargé par le
 * seul écran de saisie des notes. Le directeur — celui à qui on veut laisser
 * une icône — n'ouvre jamais un cahier de notes. Il n'avait donc jamais de
 * service worker.
 *
 * Cette suite vérifie les cinq choses qui font qu'une application s'installe et
 * s'ouvre, plutôt que les cinq choses qui sont faciles à affirmer :
 *
 *   1. le manifeste existe, se sert avec le bon type et remplit CHAQUE critère
 *      d'installation, un par un ;
 *   2. les icônes déclarées existent, arrivent intactes, et FONT VRAIMENT la
 *      taille annoncée — un manifeste qui ment sur une dimension est refusé en
 *      silence ;
 *   3. la marque de l'icône masquable tient dans la zone sûre d'Android, sans
 *      quoi le lanceur en coupe un morceau ;
 *   4. le service worker s'enregistre sur une page qui N'EST PAS la saisie des
 *      notes — c'est exactement le défaut corrigé ;
 *   5. lancée sans réseau, l'application ouvre une page honnête et NON des
 *      chiffres périmés servis depuis le cache.
 *
 *   node tests/pwa.e2e.mjs
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import pg from "pg";

const PORT = 4221;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

/* --- Lecture d'un PNG, sans dépendance -------------------------------------
 *
 * On ne croit pas le manifeste sur parole : on ouvre l'image et on regarde.
 * Huit bits par canal, sans entrelacement — ce que produit `dessiner-icones.py`.
 */
function lirePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("ce n'est pas un PNG");
  let i = 8, ihdr = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4),
               profondeur: data[8], typeCouleur: data[9], entrelace: data[12] };
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (!ihdr) throw new Error("IHDR absent");
  if (ihdr.profondeur !== 8 || ihdr.entrelace !== 0) {
    return { ...ihdr, pixels: null };  // dimensions seules
  }
  const canaux = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.typeCouleur];
  if (!canaux) return { ...ihdr, pixels: null };

  const brut = inflateSync(Buffer.concat(idat));
  const parLigne = ihdr.w * canaux;
  const out = Buffer.alloc(ihdr.h * parLigne);
  let prev = Buffer.alloc(parLigne);
  for (let y = 0; y < ihdr.h; y += 1) {
    const filtre = brut[y * (parLigne + 1)];
    const ligne = brut.subarray(y * (parLigne + 1) + 1, (y + 1) * (parLigne + 1));
    const cur = Buffer.alloc(parLigne);
    for (let x = 0; x < parLigne; x += 1) {
      const a = x >= canaux ? cur[x - canaux] : 0;
      const b = prev[x];
      const c = x >= canaux ? prev[x - canaux] : 0;
      let v = ligne[x];
      if (filtre === 1) v += a;
      else if (filtre === 2) v += b;
      else if (filtre === 3) v += (a + b) >> 1;
      else if (filtre === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * parLigne);
    prev = cur;
  }
  return { ...ihdr, canaux, pixels: out };
}

/* --- Serveur ---------------------------------------------------------------*/
{
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
  await client.end();
}

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
server.stderr.on("data", (d) => { stderr += d.toString(); });

const up = await (async () => {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/sante`)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
})();
if (!up) { console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1200)); server.kill(); process.exit(1); }

const browser = await chromium.launch({ executablePath: CHROME });

try {
  /* === 1. Le manifeste ==================================================== */
  console.log("\nLe manifeste est servi, et il est valide");
  const rep = await fetch(`${BASE}/manifest.webmanifest`);
  check("il répond 200", rep.status === 200, String(rep.status));
  check("AVEC LE TYPE application/manifest+json",
    (rep.headers.get("content-type") ?? "").includes("application/manifest+json"),
    rep.headers.get("content-type") ?? "aucun");

  let m = null;
  try { m = JSON.parse(await rep.text()); } catch (e) { /* signalé juste après */ }
  check("et c'est du JSON valide", m !== null);

  console.log("\nChaque critère d'installation, un par un");
  check("un nom", typeof m?.name === "string" && m.name.length > 0);
  check("un nom court d'au plus 12 caractères",
    typeof m?.short_name === "string" && m.short_name.length > 0 && m.short_name.length <= 12,
    `« ${m?.short_name} » — au-delà, Android le tronque sous l'icône`);
  check("start_url", typeof m?.start_url === "string");
  check("une portée qui contient start_url",
    typeof m?.scope === "string" && String(m?.start_url).startsWith(m.scope),
    `scope ${m?.scope}, start_url ${m?.start_url}`);
  check("display: standalone", m?.display === "standalone", String(m?.display));
  check("une couleur de thème", /^#[0-9a-f]{6}$/i.test(m?.theme_color ?? ""));
  check("une couleur de fond pour l'écran de démarrage",
    /^#[0-9a-f]{6}$/i.test(m?.background_color ?? ""));
  check("la langue est le français", m?.lang === "fr");

  const icones = m?.icons ?? [];
  const aTaille = (t) => icones.some((i) => i.sizes === t);
  check("une icône 192×192 déclarée", aTaille("192x192"));
  check("une icône 512×512 déclarée", aTaille("512x512"));
  check("UNE ICÔNE MASQUABLE",
    icones.some((i) => (i.purpose ?? "").split(/\s+/).includes("maskable")),
    "sans elle, Android pose l'icône carrée dans un cercle blanc");

  /* La couleur du thème doit être celle de la barre latérale. Deux bleus
     presque identiques — le manifeste et l'application — se remarquent. */
  const css = await readFile("src/server/html.ts", "utf-8");
  const navy = (css.match(/--navy:\s*(#[0-9A-Fa-f]{6})/) ?? [])[1];
  check("LA COULEUR DU THÈME EST EXACTEMENT --navy",
    navy && m?.theme_color?.toLowerCase() === navy.toLowerCase(),
    `manifeste ${m?.theme_color}, feuille de style ${navy}`);

  /* === 2. Les icônes existent et ne mentent pas =========================== */
  console.log("\nLes icônes arrivent intactes et font la taille annoncée");
  for (const ic of icones) {
    const r = await fetch(BASE + ic.src);
    const octets = Buffer.from(await r.arrayBuffer());
    check(`${ic.src} répond 200`, r.status === 200, String(r.status));
    check(`${ic.src} est servi en image/png`,
      (r.headers.get("content-type") ?? "").startsWith("image/png"),
      r.headers.get("content-type") ?? "aucun");

    /* Le piège : l'ancien chemin statique lisait TOUT en utf-8. Un PNG relu en
       utf-8 revient corrompu sans la moindre erreur, et le navigateur affiche
       une image cassée. On compare donc octet pour octet avec le disque. */
    const disque = await readFile("public" + ic.src);
    check(`${ic.src} arrive octet pour octet identique au fichier`,
      octets.equals(disque),
      `${octets.length} octets reçus, ${disque.length} sur le disque`);

    const png = lirePng(octets);
    const [wDit, hDit] = ic.sizes.split("x").map(Number);
    check(`${ic.src} FAIT VRAIMENT ${ic.sizes}`,
      png.w === wDit && png.h === hDit,
      `le fichier fait ${png.w}×${png.h}`);
  }

  /* === 3. La zone sûre d'Android ========================================== */
  console.log("\nLa marque masquable tient dans la zone sûre");

  /* Android découpe l'icône masquable en cercle, en goutte ou en écusson selon
     le constructeur. La seule garantie est le cercle central de 80 % du côté :
     tout ce qui en sort peut disparaître. On repère le fond par le pixel du
     coin, puis on compte les pixels de marque au-delà du rayon. */
  const debordement = (png) => {
    const px = (x, y) => {
      const o = (y * png.w + x) * png.canaux;
      return [png.pixels[o], png.pixels[o + 1], png.pixels[o + 2]];
    };
    const fond = px(0, 0);
    const r = png.w * 0.40, c = png.w / 2;
    let dehors = 0, dedans = 0;
    for (let y = 0; y < png.h; y += 1) {
      for (let x = 0; x < png.w; x += 1) {
        const p = px(x, y);
        if (Math.abs(p[0] - fond[0]) + Math.abs(p[1] - fond[1])
            + Math.abs(p[2] - fond[2]) <= 40) continue;
        if (Math.hypot(x - c, y - c) > r) dehors += 1; else dedans += 1;
      }
    }
    return { dedans, dehors };
  };

  const mask = icones.find((i) => (i.purpose ?? "").includes("maskable"));
  const mesure = debordement(lirePng(await readFile("public" + mask.src)));
  check("il y a bien une marque à découper", mesure.dedans > 500,
    `${mesure.dedans} pixels`);
  check("AUCUN PIXEL DE MARQUE HORS DU CERCLE DES 80 %", mesure.dehors === 0,
    `${mesure.dehors} pixels déborderaient — le lanceur les couperait`);

  /* Témoin. Une mesure qui ne trouve jamais rien passe aussi bien sur une
     image vide, et on ne saurait pas qu'elle est aveugle. On lui donne donc
     une image dont on SAIT qu'elle déborde : la même, avec quelques pixels
     blancs posés près d'un coin, loin du cercle. Si elle ne les voit pas,
     l'assertion du dessus ne prouve rien.

     (Premier témoin essayé : l'icône d'iOS, à fond perdu. Elle ne débordait
     pas non plus — même à fond perdu, la marque reste dans le cercle. Un
     témoin qui ne déclenche pas n'est pas un témoin.) */
  const abime = lirePng(await readFile("public" + mask.src));
  for (let y = 4; y < 9; y += 1) {
    for (let x = 4; x < 9; x += 1) {
      const o = (y * abime.w + x) * abime.canaux;
      abime.pixels[o] = 255; abime.pixels[o + 1] = 255; abime.pixels[o + 2] = 255;
    }
  }
  check("LA MESURE SAIT VOIR UN DÉBORDEMENT", debordement(abime).dehors > 0,
    "on lui montre 25 pixels blancs dans un coin et elle ne les voit pas");

  /* === 4. Les en-têtes, et qui les reçoit ================================= */
  console.log("\nLes pages du personnel se déclarent installables");
  const ctx = await browser.newContext({ locale: "fr-FR" });
  const page = await ctx.newPage();

  await page.goto(`${BASE}/connexion`);
  const lienManifeste = await page.getAttribute('link[rel="manifest"]', "href");
  check("l'écran de connexion porte le manifeste", lienManifeste === "/manifest.webmanifest",
    String(lienManifeste));
  check("et l'icône d'iOS, que le manifeste ne couvre pas",
    Boolean(await page.getAttribute('link[rel="apple-touch-icon"]', "href")),
    "sans elle, iPhone met une capture d'écran sur l'écran d'accueil");
  check("et la balise qui retire la barre d'adresse sur iPhone",
    (await page.getAttribute('meta[name="apple-mobile-web-app-capable"]', "content")) === "yes");
  check("et la couleur de la barre d'état",
    (await page.getAttribute('meta[name="theme-color"]', "content"))?.toLowerCase()
      === m.theme_color.toLowerCase());

  // Connexion, pour atteindre une page interne.
  await page.fill("#phone", "70000001");
  await page.click("button[type=submit]");
  await page.waitForSelector("#code");
  await page.fill("#code", (await page.textContent(".note.warn b")).trim());
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  check("une page interne aussi",
    (await page.getAttribute('link[rel="manifest"]', "href")) === "/manifest.webmanifest");

  /* === 5. Le service worker, hors de l'écran des notes ==================== */
  console.log("\nLe service worker s'enregistre AILLEURS que sur la saisie des notes");
  check("on n'est pas sur /notes", !page.url().includes("/notes"), page.url());
  const scope = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.scope;
  });
  check("IL EST ENREGISTRÉ", Boolean(scope),
    "c'est le défaut : un directeur qui n'ouvre jamais un cahier de notes "
      + "n'avait pas d'application installable");
  check("et il contrôle toute l'origine", scope.endsWith("/"), scope);
  const controle = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  check("et il contrôle déjà cette page", controle,
    "sans clients.claim(), il faudrait recharger avant qu'il serve à quelque chose");

  /* === 6. L'espace famille reste en dehors =============================== */
  console.log("\nL'espace famille n'est pas embarqué là-dedans");
  const fam = await ctx.newPage();
  await fam.goto(`${BASE}/famille`);
  check("il ne porte PAS de manifeste",
    (await fam.locator('link[rel="manifest"]').count()) === 0,
    "un parent qui installerait l'application atterrirait sur l'écran de "
      + "connexion du personnel — et la décision arrêtée est « SMS d'abord »");
  check("mais il a une icône d'onglet",
    (await fam.locator('link[rel="icon"]').count()) > 0);
  // On la garde ouverte : elle sert de témoin une fois le serveur arrêté.

  /* === 7. Sans réseau : une page honnête, pas des chiffres périmés ========
   *
   * ON ARRÊTE LE SERVEUR, on n'émule pas la coupure.
   *
   * La première version de ce test appelait `context.setOffline(true)`. Elle
   * donnait des résultats qui changeaient d'une navigation à l'autre : la
   * première tombait bien sur la page hors-ligne, les suivantes ramenaient de
   * vraies pages. L'émulation de Chromium s'applique à la cible réseau vivante
   * au moment de l'appel ; quand le navigateur arrête puis relance le service
   * worker — ce qu'il fait dès qu'il est inactif — le nouveau ne l'hérite pas,
   * et ses requêtes repassent.
   *
   * Un test dont le résultat dépend de la survie d'un processus interne au
   * navigateur ne prouve rien. On coupe donc pour de bon : serveur arrêté, la
   * requête du service worker échoue parce qu'il n'y a réellement personne au
   * bout. C'est d'ailleurs plus proche de la vérité du terrain — pour un
   * téléphone dans une cour, « pas de réseau » et « le serveur ne répond pas »
   * sont le même événement.
   */
  console.log("\nLancée sans réseau, l'application dit la vérité");

  // D'abord AVEC réseau : le tableau de bord est la page de démarrage, et il
  // est plein de chiffres. Si quelque chose devait être resservi périmé, ce
  // serait celle-là.
  await page.goto(`${BASE}${m.start_url}`);
  await page.waitForLoadState("networkidle");
  const avecReseau = await page.textContent("body");
  check("le tableau de bord affiche des chiffres quand il y a du réseau",
    /\d/.test(avecReseau), avecReseau.slice(0, 120));

  server.kill();
  await new Promise((r) => setTimeout(r, 400));
  let debout = true;
  try { await fetch(`${BASE}/sante`); } catch { debout = false; }
  check("le serveur est bien arrêté", !debout, "la suite ne prouverait rien");

  await page.goto(`${BASE}${m.start_url}`).catch(() => {});
  const lancement = await page.textContent("body");
  check("LE LANCEMENT DEPUIS L'ICÔNE OUVRE QUELQUE CHOSE",
    lancement.includes("Pas de réseau"),
    "sinon l'utilisateur touche l'icône et obtient une page blanche, sans "
      + "onglet ni barre d'adresse pour comprendre — " + lancement.slice(0, 120));
  check("ET NON LE TABLEAU DE BORD RESSERVI DEPUIS LE CACHE",
    !lancement.includes("Tableau de bord"),
    "un effectif d'avant-hier s'affiche avec l'aplomb d'un chiffre juste");
  check("elle dit ce qui marche encore", lancement.includes("saisie des notes"));
  check("elle dit ce qui ne marche pas", lancement.includes("Ce qui ne marche pas"));
  check("et elle explique pourquoi", lancement.includes("périmé"));

  // Une page interne quelconque, pas seulement la page de démarrage.
  await page.goto(`${BASE}/bulletins`).catch(() => {});
  const interne = await page.textContent("body");
  check("une page interne aussi ouvre la page hors-ligne",
    interne.includes("Pas de réseau"), interne.slice(0, 120));
  check("et ne montre aucun bulletin périmé", !interne.includes("Moyenne générale"));

  /* Témoin. Si le navigateur affichait sa propre page d'erreur partout, ou si
     quelque chose d'autre que notre service worker répondait, les assertions
     du dessus passeraient sans rien prouver. `/famille` est explicitement
     exclu du repli : il doit donc échouer AUTREMENT. Deux comportements
     différents sur le même serveur mort, c'est la preuve que le repli vient
     bien de nous. */
  await fam.goto(`${BASE}/famille`).catch(() => {});
  const famHors = await fam.textContent("body").catch(() => "");
  check("LE REPLI EST BIEN LE NÔTRE : /famille échoue autrement",
    !famHors.includes("Ce qui ne marche pas"),
    "l'espace famille est exclu du repli — s'il l'obtient quand même, "
      + "c'est que la page hors-ligne vient d'ailleurs que de notre worker");

  await ctx.close();

} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("L'application s'installe, et s'ouvre sans réseau sans mentir.");
