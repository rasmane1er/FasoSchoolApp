/**
 * Chargement des données nécessaires au calcul d'un bulletin.
 *
 * Tout passe par withSchool() : sans contexte d'établissement, le row-level
 * security ne renvoie aucune ligne. Aucune requête ici ne filtre elle-même
 * sur school_id — c'est la base qui s'en charge, et c'est volontaire : un
 * oubli de WHERE ne peut pas provoquer de fuite.
 */

import type { PoolClient } from "pg";
import { withSchool } from "./db.ts";
import type {
  GradingPolicy, MentionBand, GradeInput, EvalType,
} from "./bulletin.ts";

export interface ClassContext {
  schoolName: string;
  schoolCommune: string | null;
  academicYearLabel: string;
  termSequence: number;
  className: string;
  levelCode: string;
  seriesCode: string | null;
  effectif: number;
}

export interface StudentRow {
  id: string;
  matricule: string;
  lastName: string;
  firstNames: string;
  sex: string | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  isRedoublant: boolean;
}

export interface SubjectRow {
  id: string;
  code: string;
  label: string;
  champ: string;
  coefficient: number;
}

export interface BulletinInputs {
  context: ClassContext;
  students: StudentRow[];
  subjects: SubjectRow[];
  grades: GradeInput[];
  policy: GradingPolicy;
  mentionBands: MentionBand[];
  absences: Map<string, { justified: number; unjustified: number; late: number }>;
  policyId: string;
  coefficientSetId: string;
  sourceNotes: { policy: string | null; coefficients: string | null };
  /* Ce que le conseil de classe a décidé pour chaque élève, et qui doit
     figurer sur le bulletin. Voir `loadConseil` pour la règle de priorité. */
  conseil: Map<string, { appreciation: string | null; decision: string | null }>;
  professeurPrincipal: string | null;
}

/**
 * Charge tout ce qu'il faut pour éditer les bulletins d'une classe.
 *
 * Les règles sont choisies par leur date d'effet : on prend le jeu en vigueur
 * au début du trimestre, jamais le plus récent. Un arrêté de janvier ne doit
 * pas recalculer le trimestre 1.
 */
export async function loadBulletinInputs(
  schoolId: string,
  classId: string,
  termId: string,
): Promise<BulletinInputs> {
  return withSchool(schoolId, async (c: PoolClient) => {
    const ctx = await c.query(
      `select s.name  as school_name,
              s.commune as school_commune,
              ay.label as year_label,
              t.sequence as term_sequence,
              t.starts_on as term_start,
              cl.label as class_label,
              cl.level_code,
              cl.series_code
         from classes cl
         join academic_years ay on ay.id = cl.academic_year_id
         join terms t          on t.id = $2
         join schools s        on s.id = cl.school_id
        where cl.id = $1`,
      [classId, termId],
    );
    if (ctx.rowCount === 0) {
      throw new Error("Classe ou trimestre introuvable dans cet établissement.");
    }
    const k = ctx.rows[0];
    const asOf: Date = k.term_start;

    const students = await c.query(
      `select st.id, st.matricule, st.last_name, st.first_names, st.sex,
              st.date_of_birth, st.place_of_birth, e.is_redoublant
         from enrolments e
         join students st on st.id = e.student_id
        where e.class_id = $1 and e.status in ('inscrit','reinscrit','transfere_entrant')
        order by st.last_name, st.first_names`,
      [classId],
    );

    // Jeu de coefficients en vigueur au début du trimestre, le plus spécifique
    // d'abord : niveau + série, puis niveau, puis général.
    const coefSet = await c.query(
      `select id, source_note
         from coefficient_sets
        where effective_from <= $1
          and (level_code is null or level_code = $2)
          and (series_code is null or series_code = $3)
        order by (level_code is not null) desc,
                 (series_code is not null) desc,
                 effective_from desc
        limit 1`,
      [asOf, k.level_code, k.series_code],
    );
    if (coefSet.rowCount === 0) {
      throw new Error("Aucun jeu de coefficients en vigueur. Lancer seed_school_defaults().");
    }
    const coefficientSetId: string = coefSet.rows[0].id;

    const subjects = await c.query(
      `select sub.id, sub.code, sub.label, sub.champ_disciplinaire as champ,
              co.coefficient
         from coefficients co
         join subjects sub on sub.id = co.subject_id
        where co.coefficient_set_id = $1
          and exists (select 1 from evaluations ev
                       where ev.subject_id = sub.id and ev.term_id = $2
                         and (ev.class_id = $3 or ev.class_id is null))
        order by co.coefficient desc, sub.label`,
      [coefficientSetId, termId, classId],
    );

    const pol = await c.query(
      `select id, interrogation_weight, devoir_weight, composition_weight,
              scale_max, pass_mark, decimals, rounding, rank_tie_policy,
              unjustified_absence_counts_as_zero, source_note
         from grading_policies
        where effective_from <= $1
        order by effective_from desc
        limit 1`,
      [asOf],
    );
    if (pol.rowCount === 0) {
      throw new Error("Aucune politique de notation en vigueur. Lancer seed_school_defaults().");
    }
    const p = pol.rows[0];

    const policy: GradingPolicy = {
      interrogationWeight: Number(p.interrogation_weight),
      devoirWeight: Number(p.devoir_weight),
      compositionWeight: Number(p.composition_weight),
      scaleMax: Number(p.scale_max),
      passMark: Number(p.pass_mark),
      decimals: Number(p.decimals),
      rounding: p.rounding,
      rankTiePolicy: p.rank_tie_policy,
      // Écrite `true` en dur jusqu'ici, en contradiction avec le principe tenu
      // partout ailleurs : une règle qui décide d'une moyenne vit dans une
      // table, avec sa date d'effet et sa provenance.
      unjustifiedAbsenceCountsAsZero: p.unjustified_absence_counts_as_zero,
    };

    const bands = await c.query(
      `select label, min_average, max_average
         from mention_bands
        where grading_policy_id = $1
        order by sort_order`,
      [p.id],
    );

    /* `ev.bareme` existait depuis le premier schéma et n'était lu nulle part :
       une note sur 10 était traitée comme une note sur 20, donc DIVISÉE PAR
       DEUX dans la moyenne. On ramène ici chaque note au barème de la règle de
       notation — c'est ce que le moteur attend (« note ramenée sur
       scaleMax »), et c'est le seul endroit où cette conversion doit vivre. */
    const grades = await c.query(
      `select ge.student_id, ev.subject_id, ev.eval_type,
              case when ge.score is null or coalesce(ev.bareme, 0) <= 0
                   then ge.score
                   else round(ge.score * $3::numeric / ev.bareme, 4)
              end as score,
              ge.is_absent, ge.is_justified
         from grade_entries ge
         join evaluations ev on ev.id = ge.evaluation_id
        where ev.term_id = $1 and (ev.class_id = $2 or ev.class_id is null)`,
      [termId, classId, policy.scaleMax],
    );

    const abs = await c.query(
      `select ar.student_id,
              count(*) filter (where ar.status = 'absent' and ar.is_justified)      as justified,
              count(*) filter (where ar.status = 'absent' and not ar.is_justified)  as unjustified,
              count(*) filter (where ar.status = 'retard')                          as late
         from attendance_records ar
         join attendance_sessions s on s.id = ar.attendance_session_id
         join terms t on t.id = $1
        where s.class_id = $2 and s.session_date between t.starts_on and t.ends_on
        group by ar.student_id`,
      [termId, classId],
    );

    const absences = new Map<string, { justified: number; unjustified: number; late: number }>();
    for (const r of abs.rows) {
      absences.set(r.student_id, {
        justified: Number(r.justified),
        unjustified: Number(r.unjustified),
        late: Number(r.late),
      });
    }

    /* CE QUE LE CONSEIL DE CLASSE A DÉCIDÉ.
     *
     * Le censeur saisit une appréciation et une décision par élève pendant la
     * séance. Le bulletin imprimait un cadre vide à la place : quarante
     * appréciations recopiées à la main.
     *
     * RÈGLE DE PRIORITÉ, la même que pour les moyennes : si le bulletin est
     * PUBLIÉ, on réimprime sa copie figée ; sinon on montre ce que le conseil
     * dit aujourd'hui. Un double ressorti en juin doit être la feuille remise
     * en décembre, mot pour mot — sans quoi les deux exemplaires diffèrent et
     * c'est celui du parent qui fait foi. */
    const conseil = new Map<string,
      { appreciation: string | null; decision: string | null }>();
    {
      const { rows } = await c.query(
        `select st.id as student_id,
                coalesce(b.appreciation_generale, cd.appreciation) as appreciation,
                coalesce(b.decision_conseil, cd.decision) as decision
           from enrolments e
           join students st on st.id = e.student_id
           left join bulletins b
             on b.student_id = st.id and b.term_id = $2 and b.status = 'publie'
           left join conseil_decisions cd
             on cd.student_id = st.id
            and cd.academic_year_id = (select academic_year_id from terms where id = $2)
          where e.class_id = $1`, [classId, termId]);
      for (const r of rows) {
        if (r.appreciation || r.decision) {
          conseil.set(r.student_id,
            { appreciation: r.appreciation, decision: r.decision });
        }
      }
    }

    /* Le professeur principal, dont la ligne de signature figurait sur le
       bulletin sans nom depuis le premier jour. Le bulletin publié porte le
       nom FIGÉ à la publication ; sinon on prend celui de la classe. */
    const professeurPrincipal: string | null = (await c.query(
      `select coalesce(
                (select b.professeur_principal from bulletins b
                   join enrolments e2 on e2.student_id = b.student_id
                  where b.class_id = $1 and b.term_id = $2 and b.status = 'publie'
                    and b.professeur_principal is not null limit 1),
                (select u.full_name from classes cl
                   join staff stf on stf.id = cl.professeur_principal_id
                   join users u on u.id = stf.user_id
                  where cl.id = $1)) as nom`,
      [classId, termId])).rows[0]?.nom ?? null;

    return {
      context: {
        schoolName: k.school_name,
        schoolCommune: k.school_commune,
        academicYearLabel: k.year_label,
        termSequence: Number(k.term_sequence),
        className: k.class_label,
        levelCode: k.level_code,
        seriesCode: k.series_code,
        effectif: students.rowCount ?? 0,
      },
      students: students.rows.map((r) => ({
        id: r.id,
        matricule: r.matricule,
        lastName: r.last_name,
        firstNames: r.first_names,
        sex: r.sex,
        dateOfBirth: r.date_of_birth ? new Date(r.date_of_birth).toLocaleDateString("fr-FR") : null,
        placeOfBirth: r.place_of_birth,
        isRedoublant: r.is_redoublant,
      })),
      subjects: subjects.rows.map((r) => ({
        id: r.id, code: r.code, label: r.label, champ: r.champ,
        coefficient: Number(r.coefficient),
      })),
      grades: grades.rows.map((r) => ({
        studentId: r.student_id,
        subjectId: r.subject_id,
        evalType: r.eval_type as EvalType,
        score: r.score === null ? null : Number(r.score),
        isAbsent: r.is_absent,
        isJustified: r.is_justified,
      })),
      policy,
      mentionBands: bands.rows.map((r) => ({
        label: r.label,
        minAverage: Number(r.min_average),
        maxAverage: Number(r.max_average),
      })),
      absences,
      policyId: p.id,
      coefficientSetId,
      sourceNotes: {
        policy: p.source_note ?? null,
        coefficients: coefSet.rows[0].source_note ?? null,
      },
      conseil,
      professeurPrincipal,
    };
  });
}
