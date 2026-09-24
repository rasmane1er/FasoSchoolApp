/**
 * Une vérification n'est pas une contrainte.
 *
 * CE QUI A ÉTÉ TROUVÉ, EN CLIQUANT PLUSIEURS FOIS SUR « AJOUTER LA CLASSE ».
 * Dix POST simultanés — le geste humain normal sur une connexion lente, celle
 * que ce produit vise — et la base portait :
 *
 *     classes « 6e Z » : 6
 *
 * Six classes identiques, six identifiants différents. Le tableau de bord les
 * liste six fois avec six effectifs ; les inscriptions se répartissent entre
 * elles ; le bulletin est calculé dans l'une, l'appel se fait dans une autre.
 *
 * LE CODE AVAIT POURTANT UNE GARDE, correcte et lisible :
 *
 *     select 1 from classes where academic_year_id = $1 and label = $2
 *     if (exists.rowCount > 0) return { error: `La classe ${label} existe déjà.` }
 *
 * Elle ne protège rien. Entre le `select` et l'`insert`, une autre requête
 * passe : six des dix avaient lu avant qu'aucune n'ait écrit. C'est la
 * première règle du dépôt — *un affichage n'est jamais la protection* — prise
 * un cran plus bas : **une lecture non plus.** Ce qui protège, c'est ce que la
 * base refuse.
 *
 * ET LE DÉPÔT PORTAIT SEPT GARDES DE CETTE FORME. Trois avaient une contrainte
 * derrière elles, quatre n'en avaient aucune : `classes`, `evaluations`,
 * `fee_schedules`, `livret_entries`. Quatre sur sept — la protection était
 * jouée à pile ou face.
 *
 * CE QUE CETTE SUITE VÉRIFIE :
 *
 *   1. dix clics simultanés ne créent QU'UNE classe, et les autres reçoivent
 *      la phrase de la garde — jamais « erreur » : à qui l'on répond « erreur »
 *      on ne dit pas si son geste est passé, et il recommence ;
 *   2. ELLE SAIT ÉCHOUER : l'index retiré, les six reviennent. Un témoin qui
 *      ne sait pas échouer ne prouve rien ;
 *   3. les quatre serrures sont posées, et `doublons_a_trancher()` est muette ;
 *   4. la migration REFUSE sur une base qui porte déjà des doublons, sans
 *      toucher une ligne — trancher lequel survit n'est pas une décision de
 *      logiciel ;
 *   5. et un LINT relit le dépôt : toute garde « est-ce que ça existe déjà ? »
 *      suivie d'une écriture doit avoir une contrainte derrière elle, ou dire
 *      pourquoi elle n'en a pas. C'est l'assertion qui attrapera la prochaine.
 *
 *   node tests/doublons.e2e.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const execFileP = promisify(execFile);
const PORT = 4302;
const BASE = `http://127.0.0.1:${PORT}`;
const INDEX_CLASSES = "classes_une_par_annee_et_libelle";
/* LA DÉFINITION EXACTE, RECOPIÉE DE LA MIGRATION. C'est elle qu'on remet
 * après avoir éprouvé l'échec : une suite rend ce qu'elle emprunte à une
 * valeur CONNUE, jamais à la photo qu'elle vient de prendre. */
const DEF_CLASSES =
  `create unique index if not exists ${INDEX_CLASSES}`
  + ` on classes (school_id, academic_year_id, label)`;

let passed = 0;
const failures = [];
const check = (name, cond, detail = "") => {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? " — " + detail : ""}`); console.log(`  FAIL ${name} ${detail}`); }
};

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

/* LE RÔLE APPLICATIF N'EST PAS PROPRIÉTAIRE DES TABLES, ET C'EST VOULU : il
 * n'a pas le droit de poser ni de retirer un index. La première version de
 * cette suite l'a appris en échouant sur « must be owner of table classes » —
 * ce qui est la meilleure nouvelle possible, puisque c'est la garantie que le
 * RLS ne peut pas être contourné depuis le produit. Tout ce qui touche au
 * SCHÉMA passe donc par ADMIN_DATABASE_URL, et sans elle la suite le dit
 * bruyamment plutôt que de passer au vert sans avoir rien mesuré. */
const ADMIN = process.env.ADMIN_DATABASE_URL ?? "";
if (!ADMIN) {
  console.error(
    "\nADMIN_DATABASE_URL absent : cette suite retire et repose un index, ce "
    + "que le rôle applicatif ne peut pas faire — et c'est exactement ce qui "
    + "protège le cloisonnement. Sans elle, elle ne prouverait rien.\n"
    + "  ADMIN_DATABASE_URL=postgres://postgres@… npm run test:doublons\n");
  await client.end(); process.exit(1);
}
const admin = new pg.Client({ connectionString: ADMIN });
await admin.connect();
const { rows: sc } = await client.query(
  `select school_id from auth_lookup_user('70000001')`);
await client.query(`select set_config('schoolfaso.school_id', $1, false)`, [sc[0].school_id]);

/* CE QU'ON EMPRUNTE : les classes existantes, reconnues par leurs
 * identifiants — une marque posée par la suite elle-même, pas une date. */
const { rows: avant } = await client.query(`select id from classes`);
const CLASSES_AVANT = avant.map((r) => r.id);
const { rows: annees } = await client.query(
  `select id from academic_years order by (status = 'en_cours') desc, starts_on desc limit 1`);
const ANNEE = annees[0]?.id;

const rendre = async () => {
  await client.query(`delete from classes where id <> all($1::uuid[])`, [CLASSES_AVANT]);
  await client.query(`delete from audit_log where action = 'class.create'`);
  await client.query(`delete from auth_sessions`);
  await client.query(`delete from auth_otp_challenges`);
  await client.query(`delete from auth_rate_limits`);
  /* La serrure est remise DANS TOUS LES CAS, y compris si la suite meurt au
     milieu : c'est une contrainte de production, pas un décor de test. */
  await admin.query(DEF_CLASSES);
};
await rendre();

if (!ANNEE) {
  console.error("Il faut une année scolaire : lancez « npm run demo ».");
  await client.end(); await admin.end(); process.exit(1);
}

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
if (!up) {
  console.error("Le serveur n'a pas démarré.\n" + stderr.slice(0, 1200));
  server.kill(); await rendre(); await client.end(); await admin.end();
  process.exit(1);
}

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

const combienDe = async (lettre) => (await client.query(
  `select count(*)::int as n from classes
    where academic_year_id = $1 and label like $2`, [ANNEE, `%${lettre}`])).rows[0].n;

const cliquer = (cookie, lettre, fois) => Promise.all(
  Array.from({ length: fois }, () => fetch(`${BASE}/annee/classe`, {
    method: "POST", redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ annee: ANNEE, niveau: "6E", lettre }).toString() })));

try {
  const cookie = await login("70000001");

  /* === 1. DIX CLICS, UNE CLASSE ======================================== */
  console.log("\nDix clics simultanés sur « Ajouter la classe »");
  const reponses = await cliquer(cookie, "Y", 10);
  check("aucune requête ne tombe en erreur serveur",
    reponses.every((r) => r.status < 500),
    reponses.map((r) => r.status).join(" ")
      + " — un 500 dit à l'utilisateur « erreur » sans lui dire si son geste"
      + " est passé, et il recommence");
  check("UNE SEULE CLASSE EST CRÉÉE", (await combienDe("Y")) === 1,
    `${await combienDe("Y")} — six auparavant, avec six effectifs différents`);

  /* Le message de refus est celui de la garde, pas celui d'une panne. */
  const corps = await Promise.all(reponses.map((r) => r.text().catch(() => "")));
  const refus = corps.map(texte).filter((t) => /existe déjà/i.test(t));
  check("les clics perdants disent « existe déjà »", refus.length >= 1,
    `${refus.length} sur ${corps.length}`);
  check("et jamais « erreur interne »",
    !corps.some((t) => /erreur interne|internal server error/i.test(texte(t))));

  /* === 2. ET ELLE SAIT ÉCHOUER ========================================= */
  console.log("\nET ELLE SAIT ÉCHOUER : la serrure retirée");
  /* Un témoin de sûreté qui n'échoue jamais ne prouve rien. On retire
   * exactement l'index posé par 0032, on refait le même geste, et le défaut
   * doit revenir. La serrure est remise dans le `finally`. */
  await admin.query(`drop index if exists ${INDEX_CLASSES}`);
  await cliquer(cookie, "W", 10);
  const sansSerrure = await combienDe("W");
  check("SANS L'INDEX, LES DOUBLONS REVIENNENT", sansSerrure > 1,
    `${sansSerrure} — si ce chiffre vaut 1, cette suite ne prouve plus rien :`
      + ` elle passerait avec la contrainte retirée`);
  check("et la fonction les nomme",
    (await client.query(`select count(*)::int as n from doublons_a_trancher()`))
      .rows[0].n > 0,
    "un doublon qu'on ne sait pas lister est un doublon qu'on ne corrigera pas");

  /* === 3. LA MIGRATION REFUSE PLUTÔT QUE DE CHOISIR ==================== */
  console.log("\nLa migration s'arrête plutôt que de trancher à votre place");
  const fichier = readdirSync("db/migrations")
    .find((f) => /^0032_/.test(f));
  check("la migration existe", Boolean(fichier), String(fichier));
  const rejeu = await execFileP("psql", [
    ADMIN, "-v", "ON_ERROR_STOP=1", "-f", `db/migrations/${fichier}`])
    .then(() => ({ code: 0, err: "" }))
    .catch((e) => ({ code: e.code ?? 1, err: (e.stderr ?? "") + (e.stdout ?? "") }));
  check("ELLE REFUSE sur une base qui porte des doublons", rejeu.code !== 0,
    "poser la contrainte exigerait d'en effacer un, et choisir lequel n'est"
      + " pas une décision de logiciel");
  check("elle dit lesquels", /classes\s*:/.test(rejeu.err), rejeu.err.slice(-300));
  check("elle dit quoi faire", /doublons_a_trancher/.test(rejeu.err),
    "un refus muet renvoie chercher à l'aveugle");
  check("ET ELLE N'A TOUCHÉ AUCUNE LIGNE", (await combienDe("W")) === sansSerrure,
    `${await combienDe("W")} au lieu de ${sansSerrure}`);

  /* On tranche comme un humain l'aurait fait, et la migration passe. */
  await client.query(
    `delete from classes where id <> all($1::uuid[]) and label like '%W'
       and id <> (select min(id::text)::uuid from classes
                   where id <> all($1::uuid[]) and label like '%W')`,
    [CLASSES_AVANT]);
  const apresTri = await execFileP("psql", [
    ADMIN, "-v", "ON_ERROR_STOP=1", "-f", `db/migrations/${fichier}`])
    .then(() => 0).catch((e) => e.code ?? 1);
  check("une fois les doublons tranchés, elle passe", apresTri === 0,
    "sinon le refus serait un cul-de-sac");

  /* === 4. LES QUATRE SERRURES ========================================== */
  console.log("\nLes quatre serrures sont posées");
  const { rows: idx } = await client.query(
    `select indexname from pg_indexes where schemaname = 'public'`);
  const noms = new Set(idx.map((r) => r.indexname));
  for (const [n, pourquoi] of [
    ["classes_une_par_annee_et_libelle",
      "le tableau de bord listait la classe six fois"],
    ["evaluations_une_par_classe_et_date",
      "le même devoir compté deux fois fausse une moyenne sans qu'une note soit fausse"],
    ["fee_schedules_une_par_annee_et_niveau",
      "deux grilles pour un niveau, c'est deux factures pour un enfant"],
    ["livret_entries_une_par_eleve_et_annee",
      "le livret est un document que l'élève emporte"],
  ]) {
    check(`« ${n} »`, noms.has(n), pourquoi);
  }
  check("et plus aucun doublon à trancher",
    (await client.query(`select count(*)::int as n from doublons_a_trancher()`))
      .rows[0].n === 0);

  /* === 5. LE LINT : LA PROCHAINE GARDE SANS SERRURE ==================== */
  console.log("\nToute garde « existe déjà ? » a une serrure derrière elle");
  /* CE QUE CE LINT PROUVE, ET CE QU'IL NE PROUVE PAS. Il repère la forme —
   * une lecture d'existence suivie d'une écriture — et exige que la table
   * écrite porte au moins une contrainte d'unicité autre que sa clé primaire.
   * Il ne vérifie pas que les COLONNES de la contrainte sont celles de la
   * garde : cela demanderait de comprendre le SQL des deux côtés. Il attrape
   * donc le défaut trouvé ici — aucune contrainte du tout — et pas une
   * contrainte mal placée. C'est dit plutôt que laissé croire.
   *
   * Une garde volontairement sans serrure — un avertissement qui n'est pas un
   * refus, comme les homonymes d'un même établissement, qui existent — écrit
   * `-- doublon:` suivi de sa raison, comme `-- borne:` ailleurs. */
  const { rows: uniques } = await client.query(
    `select c.relname as tbl
       from pg_index x
       join pg_class c on c.oid = x.indrelid
       join pg_class i on i.oid = x.indexrelid
      where x.indisunique and not x.indisprimary
        and c.relnamespace = 'public'::regnamespace`);
  const protegees = new Set(uniques.map((r) => r.tbl));

  const gardes = [];
  for (const f of readdirSync("src/server").filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(`src/server/${f}`, "utf8");
    /* UNE GARDE DE DOUBLON, ET PAS UNE RECHERCHE. `rowCount === 0` veut dire
     * « je ne l'ai pas trouvé » — un élève inconnu, un parent sans numéro : ce
     * n'est pas le défaut cherché ici, et la première version du lint accusait
     * deux lectures de ce genre. On ne retient que « j'en ai déjà un », soit
     * `> 0` ou `!== 0`. `> 1`, qui autorise un homonyme et refuse deux, est
     * volontairement laissé de côté : deux élèves du même nom, dans une même
     * école, existent. */
    const re = /(const\s+\w+\s*=\s*await\s+c\.query\(\s*`select[^`]{0,400}?`[^;]{0,200};)\s*\n\s*if\s*\(\s*\w+\.rowCount!?\s*(?:>\s*0|!==\s*0)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const suite = src.slice(m.index + m[0].length,
                              m.index + m[0].length + 900);
      const ins = /insert\s+into\s+(\w+)/.exec(suite);
      if (!ins) continue;
      if (ins[1] === "audit_log") continue;          // journal, pas un unique
      if (/--\s*doublon:/.test(m[1])) continue;      // exception, avec sa raison
      gardes.push({ f, tbl: ins[1],
        ligne: src.slice(0, m.index).split("\n").length });
    }
  }
  check("le lint trouve bien des gardes de cette forme", gardes.length > 0,
    "sinon il ne mesure rien — c'est l'expression régulière qui a cessé de "
      + "reconnaître le code, pas le code qui est devenu parfait");
  const nues = gardes.filter((g) => !protegees.has(g.tbl));
  check("AUCUNE GARDE N'EST SEULE", nues.length === 0,
    nues.map((g) => `${g.f}:${g.ligne} → ${g.tbl}`).join(", ")
      + " — une lecture ne protège rien : posez une contrainte d'unicité, ou "
      + "écrivez « -- doublon: » avec la raison pour laquelle il n'en faut pas");
  console.log(`         (${gardes.length} gardes relues, ${protegees.size} tables `
    + `portent une contrainte d'unicité)`);

} catch (e) {
  failures.push("exception : " + (e?.stack ?? e));
  console.log("  FAIL exception", e?.message ?? e);
} finally {
  server.kill();
  await rendre().catch(() => {});
  await client.end().catch(() => {});
  await admin.end().catch(() => {});
}

console.log(`\n${passed} assertions passées, ${failures.length} échec(s).`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("Une vérification n'est pas une contrainte, et la base le sait.");
