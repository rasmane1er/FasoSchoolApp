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

async function main() {
  const rng = makeRng(20261116);

  console.log("Création de l'établissement de démonstration…");

  // provision_school() est le seul chemin : un INSERT direct dans schools est
  // refusé par le row-level security, faute de contexte d'établissement.
  const schoolId = await withoutSchool(async (c) => {
    const r = await c.query(
      `select provision_school($1,$2,$3,$4,$5,$6) as id`,
      ["Collège Privé Wend-Panga", "prive_laic", "ouaga_bobo",
       "Ouagadougou", "Centre", "2026-10-01"],
    );
    return r.rows[0].id as string;
  });

  const { classId, termId } = await withSchool(schoolId, async (c) => {
    const year = await c.query(
      `insert into academic_years (school_id, label, starts_on, ends_on, status)
       values ($1, '2026-2027', '2026-10-01', '2027-07-15', 'en_cours') returning id`,
      [schoolId],
    );
    const yearId = year.rows[0].id;

    // Trimestres inégaux : le T3 est tronqué par la session d'examens.
    const t1 = await c.query(
      `insert into terms (school_id, academic_year_id, sequence, starts_on, ends_on, status)
       values ($1, $2, 1, '2026-10-01', '2026-12-20', 'ouvert'),
              ($1, $2, 2, '2027-01-05', '2027-03-28', 'ouvert'),
              ($1, $2, 3, '2027-04-06', '2027-05-30', 'ouvert')
       returning id, sequence`,
      [schoolId, yearId],
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
        [schoolId, `WP-2026-${String(i + 1).padStart(4, "0")}`, nom, prenoms, sexe, ddn, lieu],
      );
      studentIds.push(s.rows[0].id);
      await c.query(
        `insert into enrolments (school_id, student_id, academic_year_id, class_id, status)
         values ($1, $2, $3, $4, 'inscrit')`,
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
       values ($1,$2,'6E','Grille 6e — 2026-2027') returning id`,
      [schoolId, yearId],
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

    for (let i = 0; i < studentIds.length; i += 1) {
      const inv = await c.query(
        `insert into invoices (school_id, student_id, academic_year_id, fee_schedule_id,
                               reference, total_fcfa, status)
         values ($1,$2,$3,$4,$5,78000,'ouverte') returning id`,
        [schoolId, studentIds[i], yearId, fs.rows[0].id, `F-2026-${String(i + 1).padStart(4, "0")}`],
      );
      // Deux tiers des familles ont payé une partie ou la totalité.
      const part = i % 3 === 0 ? 0 : i % 3 === 1 ? 40000 : 78000;
      if (part > 0) {
        const p = await c.query(
          `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                                 idempotency_key, confirmed_at)
           values ($1,$2,$3,'especes','confirme',$4, now()) returning id`,
          [schoolId, inv.rows[0].id, part, `demo-${i}`],
        );
        await c.query(
          `insert into receipts (school_id, payment_id, receipt_number, sequence, amount_fcfa)
           values ($1,$2,$3,$4,$5)`,
          [schoolId, p.rows[0].id, `R-2026-${String(i + 1).padStart(4, "0")}`, i + 1, part],
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
         justified ? `evidence/${code.toLowerCase()}.pdf` : null],
      );
    }

    // Évaluations : deux devoirs et une composition par discipline.
    const subs = await c.query(
      `select id, code from subjects where school_id is null and code = any($1)`,
      [MATIERES],
    );

    for (const sub of subs.rows) {
      const evals: Array<[string, string]> = [
        ["devoir", "2026-10-20"],
        ["devoir", "2026-11-17"],
        ["composition", "2026-12-08"],
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
      const date = new Date(2026, 9, 5 + d * 5).toISOString().slice(0, 10);
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
