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

    const staff = await c.query(
      `insert into staff (school_id, full_name, fonction)
       values ($1, 'ZONGO Alimata', 'enseignant') returning id`,
      [schoolId],
    );
    const staffId = staff.rows[0].id;

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
