/**
 * Ce qui doit être vrai pour qu'on ose mettre ce produit en ligne.
 *
 * DEUX CHOSES, ET ELLES SE TIENNENT.
 *
 * 1. LES EN-TÊTES DE SÉCURITÉ SONT POSÉS SUR TOUTE RÉPONSE. Première version
 *    du correctif : dans le `html()` qui rend les pages. C'était le même
 *    défaut que celui de l'histoire des notes, en plus discret — les fichiers
 *    statiques, les pièces jointes téléchargées, les redirections et les
 *    réponses d'erreur ne passent pas par là. Une politique qui ne couvre que
 *    les chemins auxquels on a pensé n'est pas une politique. Ils sont donc
 *    posés à l'entrée du routeur, et cette suite le vérifie sur chaque forme
 *    de réponse que le produit sait produire.
 *
 *    `script-src 'self'` sans `unsafe-inline` est la ligne qui compte : ce
 *    produit n'a aucun script tiers et aucun bloc `<script>` en ligne, donc
 *    il peut se le permettre — et cela ferme toute la classe des injections
 *    de script, y compris là où un échappement aurait été oublié.
 *
 * 2. LA LISTE DES MIGRATIONS NE DÉRIVE PAS. Chaque migration doit être
 *    déclarée à QUATRE endroits : `package.json`, `scripts/preparer-base.sh`,
 *    `scripts/epreuve-cloisonnement.sh` et `tests/cloisonnement.e2e.mjs`. En
 *    oublier un ne casse rien tout de suite : la base de développement est
 *    déjà migrée. Cela casse le jour d'une installation neuve — c'est-à-dire
 *    le jour de la première vraie école. Ce témoin compare les quatre listes
 *    au contenu du répertoire.
 *
 *    Et `railway.json` doit lancer la migration comme commande de RELEASE :
 *    un conteneur qui migre en démarrant migre aussi quand il redémarre en
 *    boucle, et deux instances qui démarrent ensemble migrent en même temps.
 *
 *   node tests/deploiement.e2e.mjs
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const PORT = 4295;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

/* === 1. Les quatre listes de migrations ================================= */
console.log("\nLa liste des migrations ne dérive pas");

const surDisque = readdirSync("db/migrations")
  .filter((f) => f.endsWith(".sql")).map((f) => f.replace(/\.sql$/, "")).sort();

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const listeDe = (texte) => [...texte.matchAll(/db\/migrations\/([0-9a-z_]+)\.sql/g)]
  .map((m) => m[1]);

const sources = {
  "package.json (db:migrate)": listeDe(pkg.scripts["db:migrate"]),
  "scripts/preparer-base.sh": listeDe(readFileSync("scripts/preparer-base.sh", "utf8")),
  "scripts/epreuve-cloisonnement.sh":
    listeDe(readFileSync("scripts/epreuve-cloisonnement.sh", "utf8")),
};
/* La suite de cloisonnement porte une liste de NOMS, pas de chemins. */
const cloison = readFileSync("tests/cloisonnement.e2e.mjs", "utf8");
const bloc = cloison.slice(cloison.indexOf("const MIGRATIONS"),
                           cloison.indexOf("];", cloison.indexOf("const MIGRATIONS")));
sources["tests/cloisonnement.e2e.mjs"] =
  [...bloc.matchAll(/"([0-9]{4}_[a-z0-9_]+)"/g)].map((m) => m[1]);

check(`le répertoire porte ${surDisque.length} migrations`, surDisque.length > 0);

for (const [nom, liste] of Object.entries(sources)) {
  const manquantes = surDisque.filter((m) => !liste.includes(m));
  const inconnues = liste.filter((m) => !surDisque.includes(m));
  check(`${nom} les déclare toutes, dans l'ordre`,
    manquantes.length === 0 && inconnues.length === 0
      && liste.join(",") === surDisque.join(","),
    manquantes.length ? `manque : ${manquantes.join(", ")}`
      : inconnues.length ? `inconnue(s) : ${inconnues.join(", ")}`
      : `l'ordre diffère — une migration appliquée hors séquence peut`
        + ` référencer une table qui n'existe pas encore`);
}

/* === 2. La configuration de déploiement ================================ */
console.log("\nLa configuration de mise en ligne dit ce qu'elle fait");

check("un Dockerfile existe", existsSync("Dockerfile"));
const dockerfile = existsSync("Dockerfile") ? readFileSync("Dockerfile", "utf8") : "";
check("l'image ne tourne pas en root", /^USER node$/m.test(dockerfile),
  "un processus qui n'a besoin d'écrire nulle part n'a pas besoin d'être root");
check("elle embarque psql et gpg",
  /postgresql-client/.test(dockerfile) && /gnupg/.test(dockerfile),
  "le premier pour les migrations et pg_dump, le second parce qu'une "
    + "sauvegarde en clair est une fuite qui attend son heure");
check("elle n'installe pas les dépendances de développement",
  /npm ci --omit=dev/.test(dockerfile),
  "Playwright et TypeScript n'ont rien à faire en production");

check("un railway.json existe", existsSync("railway.json"));
const rail = existsSync("railway.json")
  ? JSON.parse(readFileSync("railway.json", "utf8")) : {};
check("la migration est une commande de RELEASE, pas de démarrage",
  rail.deploy?.preDeployCommand === "npm run db:migrate"
    && !/db:migrate/.test(rail.deploy?.startCommand ?? ""),
  JSON.stringify(rail.deploy)
    + " — un conteneur qui migre en démarrant migre aussi quand il redémarre"
    + " en boucle, et deux instances qui démarrent ensemble migrent ensemble");
check("le healthcheck interroge /sante",
  rail.deploy?.healthcheckPath === "/sante",
  "il répond 200 seulement si la base répond, et il dit si les SMS sont simulés");

check("le runbook de mise en ligne existe", existsSync("DEPLOIEMENT.md"));
/* ON LIT LE RUNBOOK COMME UN TEXTE, PAS COMME DES LIGNES. Première version :
 * des expressions régulières sur le fichier brut, qui échouaient parce que la
 * phrase cherchée était coupée par un retour à la ligne. Une assertion qui
 * dépend de la largeur des colonnes n'éprouve pas le contenu. */
const runbook = (existsSync("DEPLOIEMENT.md")
  ? readFileSync("DEPLOIEMENT.md", "utf8") : "")
  .replace(/\s+/g, " ");
check("il dit que le rôle applicatif n'est pas superutilisateur",
  /superutilisateur contourne entièrement le row-level security/.test(runbook),
  "c'est la ligne la plus importante de tout le document");
check("il dit que pg_dump exige le rôle propriétaire",
  /ADMIN_DATABASE_URL.*et non.*DATABASE_URL|`ADMIN_DATABASE_URL`, et non/s.test(runbook),
  "lancé avec le rôle applicatif, pg_dump produit une sauvegarde vide sans le dire");
check("il dit ce que le déploiement NE fait pas",
  /Aucun SMS ne part tant qu/.test(runbook)
    && /exigent un RCCM/.test(runbook)
    && /règles non vérifiées restent non vérifiées/.test(runbook),
  "un runbook qui promet plus que le produit ne tient est un piège");

/* === 2bis. Le code respecte la politique qu'il pose ===================== */
console.log("\nLe code respecte la politique qu'il pose");

/* CE TÉMOIN A ÉTÉ ÉCRIT APRÈS COUP, ET IL AURAIT ÉVITÉ UNE PANNE.
 *
 * Sept écrans portaient `onchange="this.form.submit()"` dans le HTML. Le jour
 * où le produit a posé `script-src 'self'`, le navigateur a cessé d'exécuter
 * ces gestionnaires : changer de classe dans une liste déroulante ne faisait
 * plus RIEN. Aucune erreur à l'écran, aucune trace au serveur ; la suite du
 * parcours complet est morte sur une navigation qui n'arrivait jamais.
 *
 * Un gestionnaire écrit dans un attribut EST du script en ligne — le
 * navigateur ne distingue pas celui qu'on a écrit de celui qu'on a subi.
 * Ils vivent désormais dans `public/app.js`. Ce témoin relit le code source
 * du dépôt pour qu'il n'y ait pas de seconde fois. */
{
  const dossier = "src";
  const fichiers = [];
  const marche = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) marche(p);
      else if (/\.ts$/.test(e.name)) fichiers.push(p);
    }
  };
  marche(dossier);

  /* ON LIT LE CODE, PAS LES COMMENTAIRES. Première version : elle a signalé
   * `src/server/app.ts` pour un bloc `<script>` qui n'existait que dans le
   * commentaire expliquant… qu'il n'y en a aucun. Un témoin qui accuse la
   * prose qui le décrit apprend à être ignoré. */
  const sansCommentaires = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n").map((l) => l.replace(/(^|\s)\/\/.*$/, "$1")).join("\n");

  const coupables = [];
  for (const f of fichiers) {
    const texte = sansCommentaires(readFileSync(f, "utf8"));
    for (const m of texte.matchAll(/\son[a-z]+\s*=\s*"[^"]*"/g)) {
      /* `on` suivi d'un mot, dans une chaîne de gabarit HTML. On ne garde que
         les gestionnaires connus du navigateur : `only=`, `once=` et autres
         faux positifs ne sont pas des attributs d'événement. */
      if (/^\s(onclick|onchange|onsubmit|oninput|onload|onerror|onfocus|onblur|onkeyup|onkeydown|onmouseover)=/.test(m[0])) {
        coupables.push(`${f} : ${m[0].trim().slice(0, 48)}`);
      }
    }
    if (/<script(?![^>]*\ssrc=)[^>]*>/.test(texte)) {
      coupables.push(`${f} : un bloc <script> en ligne`);
    }
  }
  check("aucun gestionnaire d'événement en ligne dans le HTML rendu",
    coupables.length === 0,
    coupables.slice(0, 4).join(" | ")
      + " — `script-src 'self'` les rend inertes SANS UN MOT : le geste ne"
      + " fait plus rien, et rien ne le dit");
}

/* === 3. Les en-têtes, sur chaque forme de réponse ====================== */
console.log("\nLes en-têtes de sécurité sont posés sur TOUTE réponse");

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

try {
  const ATTENDUS = [
    ["content-security-policy", /script-src 'self'/],
    ["x-content-type-options", /nosniff/],
    ["referrer-policy", /same-origin/],
    ["x-frame-options", /DENY/],
  ];

  /* CHAQUE FORME DE RÉPONSE, y compris celles qui ne passent pas par le
   * rendu des pages : c'est précisément là que la première version du
   * correctif ne posait rien. */
  const formes = [
    ["une page", "/connexion", {}],
    ["un fichier statique", "/app.js", {}],
    ["le manifeste de la PWA", "/manifest.webmanifest", {}],
    ["le service worker", "/sw.js", {}],
    ["une réponse JSON", "/sante", {}],
    ["une redirection vers la connexion", "/", { redirect: "manual" }],
    ["une page inconnue", "/il-n-existe-pas", {}],
  ];

  for (const [quoi, chemin, opts] of formes) {
    const r = await fetch(`${BASE}${chemin}`, opts);
    const manquants = ATTENDUS.filter(([h, re]) => !re.test(r.headers.get(h) ?? ""));
    check(`${quoi} les porte`, manquants.length === 0,
      `manque : ${manquants.map(([h]) => h).join(", ")} (HTTP ${r.status})`);
  }

  const csp = (await fetch(`${BASE}/connexion`)).headers.get("content-security-policy") ?? "";
  check("la politique interdit le script en ligne",
    /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
    csp + " — ce produit n'a aucun script tiers ni aucun bloc <script> en"
      + " ligne : il peut se le permettre, et cela ferme toute la classe des"
      + " injections, y compris là où un échappement aurait été oublié");
  check("elle interdit l'encadrement dans une page tierce",
    /frame-ancestors 'none'/.test(csp),
    "personne n'encadre l'espace des familles dans une page à lui");
  check("elle borne où un formulaire peut poster",
    /form-action 'self'/.test(csp),
    "la garde contre une page maquillée qui emprunterait nos écrans pour"
      + " récolter un code de connexion");

  /* HSTS : POSÉ EN HTTPS, ET SEULEMENT LÀ. En clair le navigateur l'ignore ;
   * en développement local il condamnerait 127.0.0.1 à l'https pour six mois
   * sur la machine de l'installateur. */
  const clair = await fetch(`${BASE}/connexion`);
  check("HSTS n'est PAS posé sur une réponse en clair",
    clair.headers.get("strict-transport-security") === null,
    `${clair.headers.get("strict-transport-security")}`);
  const derriereProxy = await fetch(`${BASE}/connexion`,
    { headers: { "x-forwarded-proto": "https" } });
  check("il l'est derrière un proxy qui annonce https",
    /max-age=\d+/.test(derriereProxy.headers.get("strict-transport-security") ?? ""),
    `${derriereProxy.headers.get("strict-transport-security")}`);

  /* LES PAGES NE DORMENT PAS DANS UN CACHE PARTAGÉ. Elles portent des notes,
   * des absences et des numéros de famille. */
  const page = await fetch(`${BASE}/connexion`);
  check("une page n'est jamais mise en cache",
    /no-store/.test(page.headers.get("cache-control") ?? ""),
    `${page.headers.get("cache-control")}`);
} catch (e) {
  failures.push(`la suite s'est interrompue — ${e?.message ?? e}`);
  console.log(`  FAIL la suite s'est interrompue — ${e?.message ?? e}`);
} finally {
  server.kill();
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Le produit peut être mis en ligne : les en-têtes couvrent toutes "
  + "les réponses, et les quatre listes de migrations disent la même chose.");
