/**
 * Le canal SMS, et ce qui se passait quand personne ne l'avait déclaré.
 *
 * CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT CE QUE L'ÉCRAN DU PERSONNEL PROMET :
 *
 *     « Un compte se crée avec un numéro de téléphone : il n'y a pas de mot
 *       de passe, un code à usage unique arrive par SMS à chaque connexion. »
 *
 * La fabrique de canal se lisait :
 *
 *     return process.env.SMS_PROVIDER === "orange_bf"
 *       ? new OrangeBfSmsChannel() : new MockSmsChannel();
 *
 * Toute valeur autre que la chaîne exacte `orange_bf` — l'absence de variable,
 * une faute de frappe, `orange`, `ORANGE_BF` — donnait donc l'adaptateur de
 * DÉMONSTRATION, en silence. Dans cet état :
 *
 *   1. AUCUN SMS NE PART, jamais. Ni absence, ni communiqué, ni bulletin. Mais
 *      `sms_messages` enregistre `envoye`, le registre de crédit débite de
 *      vrais francs, et l'appel du matin annonce « 2 SMS envoyés pour 16 F ».
 *      La deuxième des trois promesses du produit devient un décor ;
 *
 *   2. ET LE CODE DE CONNEXION EST RENVOYÉ À LA PAGE, qui l'affiche. Connaître
 *      le numéro d'un censeur suffisait à entrer dans le logiciel de son
 *      établissement. Sur la porte des familles, le code s'affichait même sans
 *      la moindre mention de démonstration.
 *
 * TROISIÈME DÉFAUT, sur le chemin réel celui-là : le résultat de l'envoi du
 * code était IGNORÉ. Crédit épuisé, ligne résiliée, panne d'opérateur — la
 * page répondait « un code vous a été envoyé », rien n'arrivait, l'utilisateur
 * réessayait, et au bout de cinq essais la limitation de débit le mettait
 * dehors de son propre logiciel, sans un mot d'explication.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. sans `SMS_PROVIDER`, LE SERVEUR REFUSE DE DÉMARRER, et dit quoi poser ;
 *   2. une faute de frappe est refusée aussi — c'est le cas qui bascule une
 *      vraie école en démonstration sans qu'elle le sache ;
 *   3. `orange_bf` sans ses identifiants est refusé : personne ne pourrait se
 *      connecter, puisque le code passe par le même canal ;
 *   4. `mock` démarre, mais l'annonce : sur la console, sur `/sante`, sur les
 *      deux pages de connexion, et comme point BLOQUANT du tableau de bord ;
 *   5. les deux portes disent pourquoi le code est visible — la porte des
 *      familles ne le disait pas du tout ;
 *   6. UN ENVOI DE CODE REFUSÉ N'EST PLUS ANNONCÉ COMME RÉUSSI, il dit la
 *      raison, et il ne consomme pas la limite de débit de l'utilisateur.
 *
 *   node tests/canal.e2e.mjs
 */

import { spawn } from "node:child_process";
import pg from "pg";

const PORT = 4251;
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
const SCHOOL = sc[0].school_id;
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [SCHOOL]);

const purger = async () => {
  await client.query(`delete from auth_rate_limits`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_sessions`);
};
await purger();

const nu = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'")
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Démarre le serveur avec cet environnement et rend ce qu'il en advient. */
const demarrer = (env, port = PORT) => new Promise((resolve) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "src/server/app.ts"],
    { env: { ...process.env, PORT: String(port), ...env },
      stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d.toString(); });
  p.stderr.on("data", (d) => { err += d.toString(); });

  let fini = false;
  p.on("exit", (code) => {
    if (fini) return;
    fini = true; resolve({ vivant: false, code, out, err, proc: p });
  });
  (async () => {
    for (let i = 0; i < 45; i += 1) {
      if (fini) return;
      try { if ((await fetch(`http://127.0.0.1:${port}/sante`)).ok) {
        if (fini) return;
        fini = true; return resolve({ vivant: true, code: null, out, err, proc: p });
      } } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (fini) return;
    fini = true; p.kill(); resolve({ vivant: false, code: null, out, err, proc: p });
  })();
});

/* `SMS_PROVIDER` est hérité de l'environnement de `check:all`, où il vaut
 * « mock ». Pour éprouver son ABSENCE il faut le retirer, pas le vider : une
 * chaîne vide et une variable absente doivent se comporter pareil, et c'est
 * justement ce que cette suite vérifie. */
const sansVariable = { SMS_PROVIDER: undefined };

let vivants = [];
try {
  /* === 1. Le refus de démarrer ========================================== */
  console.log("\nSans canal déclaré, le serveur refuse de démarrer");

  const muet = await demarrer(sansVariable, PORT);
  check("LE SERVEUR NE DÉMARRE PAS", !muet.vivant,
    "avant, il démarrait en mode démonstration sans le dire, et le code de "
      + "connexion s'affichait à l'écran de qui le demandait");
  check("il sort en erreur", muet.code === 2, `code ${muet.code}`);
  check("et il dit quoi poser", /SMS_PROVIDER=orange_bf/.test(muet.err)
    && /SMS_PROVIDER=mock/.test(muet.err), muet.err.slice(0, 200));
  check("il dit aussi POURQUOI il refuse",
    /aucun sms|code de connexion/i.test(muet.err), muet.err.slice(0, 300));

  console.log("\nUne faute de frappe est refusée comme une absence");
  const faute = await demarrer({ SMS_PROVIDER: "orange" }, PORT);
  check("« orange » n'est pas « orange_bf »", !faute.vivant,
    "c'est exactement le cas qui bascule une vraie école en démonstration");
  check("et le refus cite la valeur reçue", /« orange »/.test(faute.err),
    faute.err.slice(0, 200));

  console.log("\n« orange_bf » sans identifiants est refusé aussi");
  const nu2 = await demarrer({ SMS_PROVIDER: "orange_bf",
    ORANGE_SMS_CLIENT_ID: undefined, ORANGE_SMS_CLIENT_SECRET: undefined,
    ORANGE_SMS_SENDER: undefined }, PORT);
  check("le serveur refuse", !nu2.vivant);
  check("et il nomme ce qui manque",
    /ORANGE_SMS_CLIENT_ID/.test(nu2.err), nu2.err.slice(0, 200));
  check("il dit que PERSONNE ne pourrait se connecter",
    /personne ne pourrait se connecter/i.test(nu2.err),
    "le code de connexion passe par le même canal que les SMS d'absence : "
      + "une configuration absente ferme le logiciel à tout le monde");

  /* === 2. Le mode démonstration s'annonce =============================== */
  console.log("\nEn mode démonstration, le produit le dit partout");
  const demo = await demarrer({ SMS_PROVIDER: "mock" }, PORT);
  check("le serveur démarre", demo.vivant, demo.err.slice(0, 200));
  if (demo.vivant) vivants.push(demo.proc);

  check("LA CONSOLE L'ANNONCE", /MODE DÉMONSTRATION/.test(demo.err),
    demo.err.slice(0, 200));
  check("et elle dit de ne pas l'utiliser en production",
    /production/.test(demo.err));

  const sante = await (await fetch(`${BASE}/sante`)).json();
  check("`/sante` LE DIT AUSSI", sante.simule === true && sante.sms === "mock",
    JSON.stringify(sante) + " — sans ce champ, rien en dehors du serveur ne "
      + "pouvait distinguer une installation qui envoie d'une qui fait semblant");

  console.log("\nLes deux portes disent pourquoi le code est visible");
  const porteStaff = await (await fetch(`${BASE}/connexion`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: "70000001" }).toString() })).text();
  const code = ((porteStaff.match(/class="num">(\d{6})</) ?? [])[1])
    ?? ((porteStaff.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1]);
  check("le code s'affiche", Boolean(code), nu(porteStaff).slice(0, 160));
  check("et la porte du personnel dit qu'aucun SMS n'est envoyé",
    /aucun SMS n(?:'|&#39;)est envoyé/.test(porteStaff),
    nu(porteStaff).slice(0, 220));

  const { rows: tuteur } = await client.query(
    `select g.phone from guardians g where coalesce(g.phone,'') <> '' limit 1`);
  const porteFamille = await (await fetch(`${BASE}/famille/connexion`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ phone: tuteur[0].phone }).toString() })).text();
  check("LA PORTE DES FAMILLES LE DIT MAINTENANT AUSSI",
    /aucun SMS n(?:'|&#39;)est envoyé/.test(porteFamille),
    "elle affichait « Code de connexion : 123456 » sans la moindre mention : "
      + nu(porteFamille).slice(0, 200));

  console.log("\nLe tableau de bord le porte, et comme un point bloquant");
  const login = async (phone) => {
    const a = await fetch(`${BASE}/connexion`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone }).toString() });
    const t = await a.text();
    const c = ((t.match(/class="num">(\d{6})</) ?? [])[1])
      ?? ((t.match(/<b[^>]*>(\d{6})<\/b>/) ?? [])[1]);
    const v = await fetch(`${BASE}/connexion/verifier`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone, code: c }).toString() });
    return (v.headers.get("set-cookie") ?? "").split(";")[0];
  };
  const cookie = await login("70000005");   // le directeur voit tout
  const board = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  check("le tableau de bord annonce le mode démonstration",
    /mode démonstration/i.test(board), nu(board).slice(0, 200));
  check("et il dit que les envois annoncés n'ont pas lieu",
    /n(?:'|&#39;)ont pas lieu/.test(board));

  demo.proc.kill();
  vivants = vivants.filter((p) => p !== demo.proc);
  await new Promise((r) => setTimeout(r, 400));

  /* === 3. Un envoi de code refusé n'est pas un envoi ==================== */
  console.log("\nUn code que l'opérateur refuse n'est plus annoncé comme parti");

  /* `SMS_MOCK_FAIL` fait refuser ce numéro par l'adaptateur, comme le ferait
   * Orange devant une ligne résiliée — c'est à cela qu'il sert. Mais en mode
   * `mock` le code s'affiche sans passer par l'envoi : pour éprouver le chemin
   * réel il faut un canal qui ENVOIE. On prend donc `orange_bf`, configuré
   * avec des identifiants qui ne valent rien : l'appel à Orange échouera, ce
   * qui est exactement la panne qu'on veut voir. */
  await purger();
  const reel = await demarrer({ SMS_PROVIDER: "orange_bf",
    ORANGE_SMS_CLIENT_ID: "epreuve", ORANGE_SMS_CLIENT_SECRET: "epreuve",
    ORANGE_SMS_SENDER: "22670000000" }, PORT);
  check("le serveur démarre avec un canal réel", reel.vivant, reel.err.slice(0, 200));
  if (reel.vivant) {
    vivants.push(reel.proc);

    const essai = await (await fetch(`${BASE}/connexion`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ phone: "70000001" }).toString() })).text();

    check("L'ÉCHEC EST DIT, PAS MASQUÉ EN « CODE ENVOYÉ »",
      /n(?:'|&#39;)a pas pu être envoyé/.test(essai),
      "avant : « Code envoyé au 70000001 », et rien n'arrivait jamais — "
        + nu(essai).slice(0, 200));
    check("aucun code ne s'affiche sur un canal réel", !/\b\d{6}\b/.test(nu(essai)),
      nu(essai).slice(0, 200));
    check("le refus dit que ce n'est pas le numéro de l'utilisateur",
      /pas votre numéro/.test(essai));

    const { rows: defis } = await client.query(
      `select count(*)::int as n from auth_otp_challenges
        where phone = '70000001' and consumed_at is null`);
    check("LE DÉFI EST ANNULÉ", defis[0].n === 0,
      `${defis[0].n} défi(s) ouvert(s) — garder un code que personne n'a reçu `
        + `n'a pas de sens`);

    const { rows: limite } = await client.query(
      `select count(*)::int as n from auth_rate_limits
        where bucket_key = 'otp:70000001'`);
    check("ET LA LIMITE DE DÉBIT N'EST PAS CONSOMMÉE", limite[0].n === 0,
      "au bout de cinq essais, l'utilisateur était mis dehors de son propre "
        + "logiciel pour une panne qui n'était pas la sienne");

    reel.proc.kill();
    vivants = vivants.filter((p) => p !== reel.proc);
  }

} finally {
  for (const p of vivants) { try { p.kill(); } catch {} }
  await purger().catch(() => {});
  await client.end().catch(() => {});
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Une variable d'environnement oubliée ne transforme plus le "
  + "logiciel en annuaire ouvert.");
