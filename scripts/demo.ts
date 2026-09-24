/**
 * Démonstration bout en bout : base -> moteur -> bulletins imprimables.
 *
 *   export DATABASE_URL=postgres://...
 *   npm run db:migrate
 *   node --experimental-strip-types scripts/demo.ts
 *
 * Crée un établissement de démonstration, une 6e avec 12 élèves, huit
 * disciplines, deux devoirs et une composition par discipline, puis calcule
 * et écrit les bulletins dans out/bulletins-6eB-T1.html.
 *
 * C'est ce fichier qu'on montre à un censeur. Pas une maquette : le document
 * sort du même chemin que celui d'une vraie classe.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { pool, withSchool, withoutSchool } from "../src/lib/db.ts";
import { computeClassBulletins } from "../src/lib/bulletin.ts";
import { loadBulletinInputs } from "../src/lib/repository.ts";
import { renderClassBulletins } from "../src/lib/render.ts";

const ELEVES: Array<[string, string, "M" | "F", string, string]> = [
  ["BAMBARA",   "Alizèta",   "F", "2014-02-11", "Ouagadougou"],
  ["COMPAORÉ",  "Salif",     "M", "2013-11-04", "Ziniaré"],
  ["DIALLO",    "Hawa",      "F", "2014-06-23", "Dori"],
  ["KABORÉ",    "Aminata",   "F", "2014-01-19", "Ouagadougou"],
  ["KONATÉ",    "Issouf",    "M", "2013-09-30", "Bobo-Dioulasso"],
  ["NIKIÉMA",   "Rasmané",   "M", "2014-04-02", "Kaya"],
  ["OUÉDRAOGO", "Fatimata",  "F", "2014-03-14", "Koudougou"],
  ["SAWADOGO",  "Boukary",   "M", "2013-12-08", "Ouagadougou"],
  ["SOMÉ",      "Prosper",   "M", "2014-05-17", "Gaoua"],
  ["TRAORÉ",    "Mariam",    "F", "2014-07-21", "Banfora"],
  ["YAMÉOGO",   "Clarisse",  "F", "2013-10-26", "Ouagadougou"],
  ["ZONGO",     "Abdoulaye", "M", "2014-08-09", "Tenkodogo"],
];

const MATIERES = [
  "MATHEMATIQUES", "FRANCAIS", "ANGLAIS", "HISTOIRE",
  "GEOGRAPHIE", "SVT", "EDUC_CIVIQUE", "EPS",
];

/** Générateur déterministe : la démo donne les mêmes notes à chaque exécution. */
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/* ---------------------------------------------------------------------------
 * LA DÉMONSTRATION SE SITUE PAR RAPPORT À AUJOURD'HUI.
 *
 * CE QUI ÉTAIT FIGÉ. Toutes les dates de ce script étaient écrites en dur sur
 * l'année scolaire 2026-2027. Le jour où cette démonstration a été relue, on
 * était le 14 septembre 2026 — dix-sept jours AVANT l'ouverture de cette
 * année-là — et le produit montrait donc, à qui le découvrait :
 *
 *   * l'appel du matin REFUSÉ, mot pour mot : « Pas d'appel ce jour-là. Cette
 *     date est hors de l'année scolaire 2026-2027. » L'écran le plus
 *     démontrable de la deuxième promesse du produit, inutilisable ;
 *   * l'écran de la scolarité annonçant « En retard aujourd'hui : 0 F,
 *     0 famille » — aucune échéance n'étant encore tombée, la distinction
 *     construite pour cet écran n'avait rien à montrer.
 *
 * Le produit avait raison chaque fois. C'est la démonstration qui était datée,
 * et qui le serait davantage chaque année : en 2028, elle raconterait une année
 * scolaire révolue.
 *
 * CE QUI EST FAIT. Une seule ancre, `DEBUT` : le premier jour de l'année
 * scolaire, placé soixante-quinze jours avant aujourd'hui. Toutes les autres
 * dates en découlent par un décalage en jours — les mêmes décalages
 * qu'auparavant, relevés sur l'année 2026-2027 d'origine.
 *
 * Soixante-quinze jours, parce que c'est le point où la démonstration montre le
 * plus : le premier trimestre est presque au bout (il ferme dans cinq jours),
 * ses trois évaluations et ses douze appels sont derrière, la première tranche
 * de scolarité est échue depuis longtemps — donc les familles qui n'ont rien
 * versé sont RÉELLEMENT en retard et celles qui ont versé 40 000 F sont
 * RÉELLEMENT en avance — et l'appel du matin s'ouvre aujourd'hui.
 * ------------------------------------------------------------------------- */

/* DEUX POSITIONS POSSIBLES, ET ON NE CHOISIT PAS À LA PLACE DE L'UTILISATEUR.
 *
 * Le calendrier burkinabè va d'octobre à juillet. Une démonstration lancée en
 * août ou en septembre tombe donc dans les vacances, et le produit refuse
 * l'appel du matin — à juste titre : il n'y a pas école. Mais celui qui montre
 * le produit ce jour-là n'a rien à montrer.
 *
 *   défaut          l'année scolaire RÉELLE : celle qui contient aujourd'hui,
 *                   ou la dernière achevée si l'on est en vacances. Les mois
 *                   sont ceux du Burkina, et les écrans disent la vérité de la
 *                   saison — vacances comprises ;
 *
 *   --aujourdhui    l'année est placée pour que CE JOUR tombe au 75e jour du
 *                   premier trimestre. Tout est démontrable : l'appel s'ouvre,
 *                   des familles sont réellement en retard d'une tranche,
 *                   d'autres réellement en avance. En échange, les mois ne
 *                   sont plus ceux du calendrier réel, et le script le DIT.
 */
const iso = (a: number, m: number, j: number) => new Date(Date.UTC(a, m, j));

/** La première année civile que le calendrier légal du produit couvre. */
const PREMIERE_ANNEE_COUVERTE = 2026;

/** Le 1er octobre le plus récent qui soit déjà passé. */
const derniereRentree = (): Date => {
  const a = new Date();
  const an = a.getUTCFullYear();
  return a >= iso(an, 9, 1) ? iso(an, 9, 1) : iso(an - 1, 9, 1);
};

/* Le mode « placé » est demandé, OU imposé quand le calendrier réel ne peut
   pas servir : les fêtes légales inscrites dans le produit commencent en 2026
   (loi du 9 janvier 2026), et une démonstration sur une année antérieure
   ouvrirait l'appel du matin le jour de Noël — le défaut même que ce produit
   s'emploie à empêcher. */
const REEL_UTILISABLE =
  derniereRentree().getUTCFullYear() >= PREMIERE_ANNEE_COUVERTE;
const PLACER_AUJOURDHUI =
  process.argv.includes("--aujourdhui") || !REEL_UTILISABLE;

/**
 * LE JOUR DE L'ANNÉE OÙ « AUJOURD'HUI » EST PLACÉ, et pourquoi ce n'est plus 75.
 *
 * La démonstration était ancrée au 75ᵉ jour d'un premier trimestre qui en
 * comptait 80 : CINQ JOURS de validité. Semée le 14 septembre 2026, relue le
 * 21, elle tombait au 82ᵉ jour — hors trimestre. Le produit se comportait alors
 * exactement comme il doit, en refusant de deviner un trimestre (voir 0025) et
 * en demandant lequel ; mais une démonstration qui commence par une question
 * ne démontre plus rien, et quatre suites sont mortes le même matin sur un
 * délai d'attente qui ne parlait pas du calendrier.
 *
 * On vise donc le MILIEU du premier trimestre, allongé pour que la marge soit
 * réelle : quarante jours devant, après la dernière composition. Une
 * démonstration se sème une fois et se montre des semaines plus tard.
 * `tests/fixture.e2e.mjs` vérifie cette marge et dit de resemer quand elle est
 * mangée.
 */
const ANCRE = 80;

/** Le premier jour de l'année scolaire de démonstration. */
const DEBUT = (() => {
  if (PLACER_AUJOURDHUI) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - ANCRE);
    return iso(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return derniereRentree();
})();

/** Une date de la démonstration : `DEBUT` + n jours, en ISO. */
const jour = (n: number): string => {
  const d = new Date(DEBUT);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* Les décalages, relevés sur l'année 2026-2027 écrite en dur à l'origine. */
/* Le premier trimestre est allongé — 120 jours au lieu de 80 — pour que
 * l'ancre (jour 80) laisse quarante jours devant elle. Les autres suivent, et
 * les écarts entre trimestres sont conservés : ce sont les congés. */
const T1 = [0, 120], T2 = [136, 218], T3 = [227, 281];
const FIN_ANNEE = 327;
const EVALUATIONS = [19, 47, 68];        // deux devoirs et une composition
const PREMIER_APPEL = 4, PAS_APPEL = 5;  // douze appels, tous les cinq jours

/** « 2026-2027 », dérivé de l'ancre. */
const LIBELLE_ANNEE = `${DEBUT.getUTCFullYear()}-${DEBUT.getUTCFullYear() + 1}`;
/** L'année civile qui sert aux matricules et aux références. */
const AN = DEBUT.getUTCFullYear();

async function main() {
  const rng = makeRng(20261116);

  console.log("Création de l'établissement de démonstration…");
  if (PLACER_AUJOURDHUI) {
    console.log(
      "\n  L'année scolaire est placée pour que la démonstration soit\n"
      + "  utilisable AUJOURD'HUI : ses mois ne suivent donc pas le calendrier\n"
      + `  burkinabè réel (1er octobre → 15 juillet). Elle court du ${jour(0)}\n`
      + `  au ${jour(FIN_ANNEE)}.`
      + (REEL_UTILISABLE ? "\n"
         : `\n  (Imposé : le calendrier légal du produit commence en `
           + `${PREMIERE_ANNEE_COUVERTE}, et la dernière rentrée réelle lui est\n`
           + `  antérieure.)\n`));
  } else if (new Date().toISOString().slice(0, 10) > jour(FIN_ANNEE)) {
    console.log(
      `\n  L'année ${LIBELLE_ANNEE} est ACHEVÉE (${jour(0)} → ${jour(FIN_ANNEE)}) :\n`
      + "  nous sommes dans les vacances, et le produit refusera l'appel du\n"
      + "  matin — il n'y a pas école. Pour une démonstration utilisable\n"
      + "  aujourd'hui : npm run demo -- --aujourdhui\n");
  }

  // provision_school() est le seul chemin : un INSERT direct dans schools est
  // refusé par le row-level security, faute de contexte d'établissement.
  const schoolId = await withoutSchool(async (c) => {
    const r = await c.query(
      `select provision_school($1,$2,$3,$4,$5,$6) as id`,
      ["Collège Privé Wend-Panga", "prive_laic", "ouaga_bobo",
       "Ouagadougou", "Centre", jour(0)],
    );
    return r.rows[0].id as string;
  });

  const { classId, termId } = await withSchool(schoolId, async (c) => {
    const year = await c.query(
      `insert into academic_years (school_id, label, starts_on, ends_on, status)
       values ($1, $2, $3::date, $4::date, 'en_cours') returning id`,
      [schoolId, LIBELLE_ANNEE, jour(T1[0]), jour(FIN_ANNEE)],
    );
    const yearId = year.rows[0].id;

    // Trimestres inégaux : le T3 est tronqué par la session d'examens.
    const t1 = await c.query(
      `insert into terms (school_id, academic_year_id, sequence, starts_on, ends_on, status)
       values ($1, $2, 1, $3::date, $4::date, 'ouvert'),
              ($1, $2, 2, $5::date, $6::date, 'ouvert'),
              ($1, $2, 3, $7::date, $8::date, 'ouvert')
       returning id, sequence`,
      [schoolId, yearId, jour(T1[0]), jour(T1[1]), jour(T2[0]), jour(T2[1]),
       jour(T3[0]), jour(T3[1])],
    );
    const termId = t1.rows.find((r) => r.sequence === 1)!.id;

    const klass = await c.query(
      `insert into classes (school_id, academic_year_id, level_code, letter, label)
       values ($1, $2, '6E', 'B', '6e B') returning id`,
      [schoolId, yearId],
    );
    const classId = klass.rows[0].id;

    // Comptes de démonstration : le téléphone est l'identifiant.
    const comptes: Array<[string, string, string, string]> = [
      ["70000001", "OUÉDRAOGO Séraphin", "censeur",             "censeur"],
      ["70000002", "ZONGO Alimata",      "enseignant",          "enseignant"],
      ["70000003", "ZOUNGRANA Issa",     "surveillant_general", "surveillant_general"],
      ["70000004", "TAPSOBA Michel",     "econome",             "econome"],
      ["70000005", "KABORÉ Paul",        "directeur",           "directeur"],
    ];
    let staffId = "";
    for (const [phone, nom, fonction, role] of comptes) {
      const u = await c.query(
        `insert into users (school_id, full_name, phone) values ($1,$2,$3) returning id`,
        [schoolId, nom, phone],
      );
      const st = await c.query(
        `insert into staff (school_id, user_id, full_name, fonction)
         values ($1,$2,$3,$4) returning id`,
        [schoolId, u.rows[0].id, nom, fonction],
      );
      await c.query(
        `insert into user_roles (user_id, role_code, school_id) values ($1,$2,$3)`,
        [u.rows[0].id, role, schoolId],
      );
      if (fonction === "enseignant") staffId = st.rows[0].id;
    }

    // Élèves + inscriptions
    const studentIds: string[] = [];
    for (let i = 0; i < ELEVES.length; i += 1) {
      const [nom, prenoms, sexe, ddn, lieu] = ELEVES[i]!;
      const s = await c.query(
        `insert into students (school_id, matricule, last_name, first_names, sex,
                               date_of_birth, place_of_birth)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [schoolId, `WP-${AN}-${String(i + 1).padStart(4, "0")}`, nom, prenoms, sexe, ddn, lieu],
      );
      studentIds.push(s.rows[0].id);
      await c.query(
        /* LES DOUZE ÉLÈVES SONT INSCRITS À LA RENTRÉE.
           C'est ce que la démonstration raconte, et la date doit le dire :
           `enrolled_on` était laissé au défaut de la colonne — le jour où le
           script tourne — ce qui faisait de l'effectif entier une cohorte
           d'arrivées en cours d'année, et l'écran de la scolarité les
           annonçait toutes comme telles. */
        `insert into enrolments (school_id, student_id, academic_year_id,
                                 class_id, status, enrolled_on)
         values ($1, $2, $3, $4, 'inscrit',
                 (select starts_on from academic_years where id = $3))`,
        [schoolId, s.rows[0].id, yearId, classId],
      );

      // Un tuteur joignable par SMS pour chaque élève, sauf un — pour que
      // l'écran d'appel montre aussi le cas « aucun tuteur joignable ».
      if (i !== 7) {
        const g = await c.query(
          `insert into guardians (school_id, full_name, phone) values ($1,$2,$3) returning id`,
          [schoolId, `Tuteur de ${prenoms}`, `7010${String(1000 + i)}`],
        );
        await c.query(
          `insert into student_guardians (student_id, guardian_id, school_id, relationship,
                                          is_primary, receives_sms)
           values ($1,$2,$3,'parent',true,true)`,
          [s.rows[0].id, g.rows[0].id, schoolId],
        );
      }
    }

    // Scolarité : grille conforme au plafond catégorie 2 en zone Ouaga/Bobo.
    const fs = await c.query(
      `insert into fee_schedules (school_id, academic_year_id, level_code, label)
       values ($1,$2,'6E',$3) returning id`,
      [schoolId, yearId, `Grille 6e — ${LIBELLE_ANNEE}`],
    );
    const lignes: Array<[string, number, string]> = [
      ["Inscription",           15000, "plafonne"],
      ["Scolarité annuelle",    58000, "plafonne"],
      ["Frais de dossier",       5000, "plafonne"],
      ["Hébergement",           40000, "exclu"],
    ];
    for (const [label, montant, cap] of lignes) {
      await c.query(
        `insert into fee_lines (school_id, fee_schedule_id, label, amount_fcfa, cap_treatment)
         values ($1,$2,$3,$4,$5)`,
        [schoolId, fs.rows[0].id, label, montant, cap],
      );
    }

    /* L'ÉCHÉANCIER, COMME `frais.ts` LE POSE.
     *
     * Une démonstration doit montrer le produit dans l'état où il sera. Ces
     * factures étaient insérées sans échéancier : l'écran de la scolarité
     * annonçait donc « 12 factures n'ont pas d'échéancier », et l'espace
     * famille retombait sur « vous devez 78 000 F » — c'est-à-dire que la
     * démonstration montrait la troisième promesse du produit ÉTEINTE.
     *
     * Les tranches suivent les trimestres, comme à l'émission réelle, et le
     * reste de la division va sur la première : c'est l'usage. */
    const trimestres = await c.query(
      `select sequence, starts_on from terms where academic_year_id = $1
        order by sequence`, [yearId]);
    const TOTAL_FACTURE = 78000;

    for (let i = 0; i < studentIds.length; i += 1) {
      const inv = await c.query(
        `insert into invoices (school_id, student_id, academic_year_id, fee_schedule_id,
                               reference, total_fcfa, status)
         values ($1,$2,$3,$4,$5,$6,'ouverte') returning id`,
        [schoolId, studentIds[i], yearId, fs.rows[0].id,
         `F-${AN}-${String(i + 1).padStart(4, "0")}`, TOTAL_FACTURE],
      );

      const n = Math.max(1, trimestres.rowCount ?? 1);
      const tranche = Math.floor(TOTAL_FACTURE / n);
      const reste = TOTAL_FACTURE - tranche * n;
      for (const [k, t] of trimestres.rows.entries()) {
        await c.query(
          `insert into invoice_instalments (school_id, invoice_id, label,
                                            amount_fcfa, due_on, sort_order)
           values ($1,$2,$3,$4,$5::date,$6)`,
          [schoolId, inv.rows[0].id, `Tranche ${t.sequence}`,
           tranche + (k === 0 ? reste : 0), t.starts_on, k],
        );
      }

      // Deux tiers des familles ont payé une partie ou la totalité.
      const part = i % 3 === 0 ? 0 : i % 3 === 1 ? 40000 : 78000;
      if (part > 0) {
        const p = await c.query(
          `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                                 idempotency_key, confirmed_at)
           values ($1,$2,$3,'especes','confirme',$4, now()) returning id`,
          [schoolId, inv.rows[0].id, part, `demo-${i}`],
        );
        /* Le reçu porte l'état de la facture AU MOMENT DE SON ÉMISSION.
           Sans ces deux nombres, chaque reçu de la démonstration s'imprimait
           « Solde non restituable » — la branche dégradée, sur le document le
           plus soigné du produit. */
        await c.query(
          `insert into receipts (school_id, payment_id, receipt_number, sequence,
                                 amount_fcfa, total_du_fcfa, total_paye_fcfa)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [schoolId, p.rows[0].id, `R-${AN}-${String(i + 1).padStart(4, "0")}`,
           i + 1, part, TOTAL_FACTURE, part],
        );
      }
    }

    // Le compteur de reçus de l'établissement doit refléter les reçus semés,
    // sinon le premier encaissement au guichet réémet un numéro déjà pris.
    await c.query(
      `update schools set receipt_sequence = coalesce((select max(sequence) from receipts), 0)`);

    // Crédit SMS de départ : un forfait Silver de 1 000 messages à 8 000 FCFA.
    await c.query(
      `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
       values ($1,'achat',1000,8000,'Forfait Silver Orange BF')`,
      [schoolId],
    );

    // Dossier de catégorisation entamé.
    const ca = await c.query(
      `insert into category_assessments (school_id, academic_year_id, investment_score,
                                         quality_score, category, status)
       values ($1,$2,31,37,2,'brouillon') returning id`,
      [schoolId, yearId],
    );
    const criteres: Array<[string, string, string, number, number, boolean]> = [
      ["investissement", "BATI",    "Qualité du bâti et clôture",        8,  8, true],
      ["investissement", "EAU",     "Eau potable et assainissement",     7,  0, false],
      ["investissement", "ENERGIE", "Énergie",                           5,  5, true],
      ["investissement", "INFO",    "Équipement informatique",           8,  3, false],
      ["investissement", "BIBLIO",  "Bibliothèque",                      6,  6, true],
      ["investissement", "SPORT",   "Installations sportives",           8,  5, true],
      ["investissement", "CANTINE", "Cantine",                           8,  4, true],
      ["qualite",        "EXAMENS", "Résultats aux examens",            12, 10, true],
      ["qualite",        "EFFECTIF","Effectifs par classe",               8,  6, true],
      ["qualite",        "STAB",    "Stabilité du personnel",             8,  7, true],
      ["qualite",        "QUALIF",  "Qualification des enseignants",     10,  6, false],
      ["qualite",        "TIC",     "Enseignement des TIC",               6,  2, false],
      ["qualite",        "GOUV",    "Gouvernance de l'établissement",     6,  6, true],
    ];
    for (const [axis, code, label, max, got, justified] of criteres) {
      await c.query(
        `insert into category_criteria (school_id, category_assessment_id, axis, code,
                                        label, max_points, awarded_points, evidence_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [schoolId, ca.rows[0].id, axis, code, label, max, got,
         // Une DESCRIPTION de la pièce attendue, pas un faux chemin de
         // fichier. L'ancienne valeur — `evidence/bati.pdf` — ressemblait à un
         // document stocké et n'en était pas un : la démonstration apprenait
         // elle-même à l'utilisateur que la case voulait dire « un fichier est
         // joint ». Ce qui justifie un critère est un document dans
         // `documents`, et rien d'autre.
         justified ? `Pièce à joindre : justificatif ${code}` : null],
      );
    }

    /* Une vraie pièce jointe sur deux critères, pour que la démonstration
       montre la chose telle qu'elle est : un fichier qu'on ouvre, pas une
       ligne de texte. Un PDF minimal mais VALIDE — le dépôt vérifie la
       signature des octets, et un faux PDF serait refusé par le produit
       lui-même, ce qui est exactement ce qu'on veut pouvoir montrer. */
    const pdfDemo = (titre: string): Buffer => {
      const corps = `%PDF-1.4\n% ${titre}\n`
        + `1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n`
        + `2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n`
        + `3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n`
        + `trailer<</Root 1 0 R>>\n%%EOF\n`;
      return Buffer.from(corps, "latin1");
    };
    for (const code of ["BATI", "EXAMENS"]) {
      const crit = await c.query(
        `select id from category_criteria
          where category_assessment_id = $1 and code = $2`,
        [ca.rows[0].id, code]);
      if (!crit.rows[0]) continue;
      const octets = pdfDemo(code);
      await c.query(
        `insert into documents (school_id, category_criterion_id, label, doc_type,
                                content, content_type, byte_size, sha256)
         values ($1,$2,$3,'declaration',$4,'application/pdf',$5,
                 encode(sha256($4), 'hex'))
         on conflict do nothing`,
        [schoolId, crit.rows[0].id,
         code === "BATI" ? "Photo du bâtiment principal.pdf"
                         : `Résultats au BEPC ${AN - 1}-${AN}.pdf`,
         octets, octets.length]);
    }

    // Évaluations : deux devoirs et une composition par discipline.
    const subs = await c.query(
      `select id, code from subjects where school_id is null and code = any($1)`,
      [MATIERES],
    );

    /* Répartition des services. L'enseignante de la démonstration a un service
       RÉEL — français et anglais en 6e B — et pas la classe entière : c'est ce
       qui rend visible, dès la démonstration, qu'elle ne peut pas saisir les
       notes de mathématiques d'un collègue. */
    const sesMatieres = subs.rows.filter((x: any) =>
      ["FRANCAIS", "ANGLAIS"].includes(x.code));
    for (const m of sesMatieres) {
      await c.query(
        `insert into teacher_assignments (school_id, staff_id, class_id, subject_id)
         values ($1,$2,$3,$4) on conflict do nothing`,
        [schoolId, staffId, classId, m.id]);
    }

    for (const sub of subs.rows) {
      const evals: Array<[string, string]> = [
        ["devoir", jour(EVALUATIONS[0])],
        ["devoir", jour(EVALUATIONS[1])],
        ["composition", jour(EVALUATIONS[2])],
      ];
      for (const [type, date] of evals) {
        const ev = await c.query(
          `insert into evaluations (school_id, term_id, class_id, subject_id, eval_type,
                                    scope, label, held_on, created_by)
           values ($1,$2,$3,$4,$5,'classe',$6,$7,$8) returning id`,
          [schoolId, termId, classId, sub.id, type,
           type === "composition" ? "Composition du 1er trimestre" : "Devoir surveillé",
           date, staffId],
        );

        for (const studentId of studentIds) {
          // Niveau propre à chaque élève, plus une variation par évaluation.
          const base = 7 + rng() * 10;
          const score = Math.max(0, Math.min(20, base + (rng() - 0.5) * 5));

          // Deux cas volontaires : une absence justifiée et une non justifiée,
          // pour que le bulletin de démonstration montre les deux traitements.
          const absent = rng() < 0.035;
          const justified = rng() < 0.6;

          /* D'OÙ PARLENT CES NOTES : d'un script, pas d'un enseignant. Le
           * déclencheur `tracer_note()` écrit leur histoire ; autant qu'elle
           * dise la vérité sur leur origine. */
          await c.query(`select set_config('schoolfaso.grade_source', 'import', true)`);
          await c.query(
            `insert into grade_entries (school_id, evaluation_id, student_id, score,
                                        is_absent, is_justified, recorded_by)
             values ($1,$2,$3,$4,$5,$6,$7)`,
            [schoolId, ev.rows[0].id, studentId,
             absent ? null : Math.round(score * 4) / 4,
             absent, absent && justified, staffId],
          );
        }
      }
    }

    // Un peu d'assiduité, pour la colonne du bulletin.
    for (let d = 0; d < 12; d += 1) {
      const date = jour(PREMIER_APPEL + d * PAS_APPEL);
      const sess = await c.query(
        `insert into attendance_sessions (school_id, class_id, session_date, session_slot, recorded_by)
         values ($1,$2,$3,'matin',$4) returning id`,
        [schoolId, classId, date, staffId],
      );
      for (const studentId of studentIds) {
        const r = rng();
        const status = r < 0.05 ? "absent" : r < 0.08 ? "retard" : "present";
        await c.query(
          `insert into attendance_records (school_id, attendance_session_id, student_id,
                                           status, is_justified)
           values ($1,$2,$3,$4,$5)`,
          [schoolId, sess.rows[0].id, studentId, status, status === "absent" && rng() < 0.5],
        );
      }
    }

    return { classId, termId };
  });

  console.log("Chargement, calcul, rendu…");

  const inputs = await loadBulletinInputs(schoolId, classId, termId);
  const coefficients = new Map(inputs.subjects.map((s) => [s.id, s.coefficient]));
  const klass = computeClassBulletins({
    studentIds: inputs.students.map((s) => s.id),
    grades: inputs.grades,
    coefficients,
    policy: inputs.policy,
    mentionBands: inputs.mentionBands,
  });

  mkdirSync("out", { recursive: true });
  const path = `out/bulletins-${inputs.context.className.replace(/\s+/g, "")}-T${inputs.context.termSequence}.html`;
  writeFileSync(path, renderClassBulletins(inputs, klass), "utf-8");

  // Récapitulatif au terminal — c'est ce qu'on vérifie ligne à ligne avec le censeur.
  const byId = new Map(inputs.students.map((s) => [s.id, s]));
  console.log(`\n${inputs.context.schoolName} — ${inputs.context.className} — trimestre ${inputs.context.termSequence}`);
  console.log(`${inputs.subjects.length} disciplines, total des coefficients ${klass.students[0]?.totalCoefficients ?? 0}`);
  console.log("");
  console.log("Rang  Élève                          Moyenne  Mention");
  console.log("─".repeat(62));
  for (const r of [...klass.students].sort((a, b) => (a.rang ?? 99) - (b.rang ?? 99))) {
    const st = byId.get(r.studentId)!;
    const nom = `${st.lastName} ${st.firstNames}`.padEnd(30).slice(0, 30);
    const rang = String(r.rang ?? "—").padStart(3);
    const moy = (r.moyenneGenerale?.toFixed(2).replace(".", ",") ?? "—").padStart(7);
    console.log(`${rang}   ${nom} ${moy}  ${r.mention ?? "—"}`);
  }
  console.log("─".repeat(62));
  console.log(`      Moyenne de la classe          ${klass.moyenneDeClasse?.toFixed(2).replace(".", ",")}`);
  console.log(`\nBulletins écrits dans ${path}`);
  console.log(`\nComptes de démonstration (code affiché à l'écran) :`);
  console.log("  70000001  Censeur      70000003  Surveillant général");
  console.log("  70000002  Enseignante  70000004  Économe   70000005  Directeur");

  if (inputs.sourceNotes.policy) {
    console.log(`\n⚠ Règle de notation : ${inputs.sourceNotes.policy}`);
  }
  if (inputs.sourceNotes.coefficients) {
    console.log(`⚠ Coefficients      : ${inputs.sourceNotes.coefficients}`);
  }

  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
