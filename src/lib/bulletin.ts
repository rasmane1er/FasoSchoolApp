/**
 * Moteur de calcul du bulletin.
 *
 * Fonctions pures : aucune dépendance à la base, entièrement testable.
 * Toutes les règles arrivent en paramètre depuis grading_policies,
 * coefficient_sets et mention_bands — rien n'est codé en dur, parce que le
 * ministère a modifié les coefficients ET la règle de redoublement en 2026.
 *
 * QUATRE RÈGLES NE SONT PAS VÉRIFIÉES et doivent être confirmées auprès d'un
 * censeur burkinabè avant tout usage réel :
 *   1. la pondération devoirs / composition
 *   2. la table des coefficients appliquée aux bulletins internes
 *   3. les seuils de mention
 *   4. le gabarit du bulletin
 * Elles sont livrées comme données par seed_school_defaults(), avec leur
 * provenance dans source_note.
 */

export type EvalType = "interrogation" | "devoir" | "composition" | "examen_blanc";

export type Rounding = "half_up" | "half_even" | "truncate";
export type RankTiePolicy = "same_rank_skip" | "same_rank_dense";

export interface GradingPolicy {
  interrogationWeight: number;
  devoirWeight: number;
  compositionWeight: number;
  scaleMax: number;
  passMark: number;
  decimals: number;
  rounding: Rounding;
  rankTiePolicy: RankTiePolicy;
  /**
   * Une absence non justifiée compte-t-elle 0 dans la moyenne ?
   * Une absence justifiée est toujours exclue du calcul.
   */
  unjustifiedAbsenceCountsAsZero: boolean;
}

export interface MentionBand {
  label: string;
  minAverage: number;
  maxAverage: number;
}

export interface GradeInput {
  studentId: string;
  subjectId: string;
  evalType: EvalType;
  /** Note ramenée sur scaleMax. null si l'élève n'a pas de note. */
  score: number | null;
  isAbsent: boolean;
  isJustified: boolean;
}

export interface SubjectResult {
  subjectId: string;
  /** null = aucune note exploitable ; la matière sort du calcul général. */
  moyenne: number | null;
  coefficient: number;
  points: number | null;
  gradesCounted: number;
}

export interface StudentResult {
  studentId: string;
  subjects: SubjectResult[];
  moyenneGenerale: number | null;
  totalPoints: number;
  totalCoefficients: number;
  mention: string | null;
  rang: number | null;
  effectif: number;
}

export interface ClassResult {
  students: StudentResult[];
  moyenneDeClasse: number | null;
  moyenneParMatiere: Map<string, number | null>;
}

// ---------------------------------------------------------------------------
// Arrondi
// ---------------------------------------------------------------------------

export function round(value: number, decimals: number, mode: Rounding): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;

  if (mode === "truncate") {
    return Math.trunc(scaled) / factor;
  }
  if (mode === "half_even") {
    const floor = Math.floor(scaled);
    const diff = scaled - floor;
    if (Math.abs(diff - 0.5) > Number.EPSILON) {
      return Math.round(scaled) / factor;
    }
    // Exactement .5 : on va vers le pair.
    return (floor % 2 === 0 ? floor : floor + 1) / factor;
  }
  // half_up, et correctement : Math.round(-0.5) vaut 0 en JS, pas -1.
  const rounded = scaled >= 0
    ? Math.floor(scaled + 0.5)
    : Math.ceil(scaled - 0.5);
  return rounded / factor;
}

// ---------------------------------------------------------------------------
// Moyenne par matière
// ---------------------------------------------------------------------------

function weightFor(policy: GradingPolicy, type: EvalType): number {
  switch (type) {
    case "interrogation": return policy.interrogationWeight;
    case "devoir": return policy.devoirWeight;
    case "composition": return policy.compositionWeight;
    // Les examens blancs préparent le BEPC ou le BAC : ils n'entrent pas dans
    // la moyenne trimestrielle sauf décision de l'établissement.
    case "examen_blanc": return 0;
  }
}

/**
 * Moyenne d'une matière pour un élève.
 *
 * Le piège : en cours de trimestre la composition n'a pas encore eu lieu.
 * Diviser par la somme de TOUS les poids donnerait une moyenne artificiellement
 * basse. On ne divise que par les poids des types réellement présents.
 */
export function computeSubjectAverage(
  grades: GradeInput[],
  policy: GradingPolicy,
): { moyenne: number | null; counted: number } {
  const byType = new Map<EvalType, number[]>();
  let counted = 0;

  for (const g of grades) {
    // Absence justifiée : l'évaluation est neutralisée, elle ne pénalise pas.
    if (g.isAbsent && g.isJustified) continue;

    let value: number | null = g.score;
    if (g.isAbsent && !g.isJustified) {
      if (!policy.unjustifiedAbsenceCountsAsZero) continue;
      value = 0;
    }
    if (value === null || Number.isNaN(value)) continue;

    const w = weightFor(policy, g.evalType);
    if (w <= 0) continue; // type non pris en compte (examen blanc)

    const bucket = byType.get(g.evalType) ?? [];
    bucket.push(value);
    byType.set(g.evalType, bucket);
    counted += 1;
  }

  if (byType.size === 0) return { moyenne: null, counted: 0 };

  let numerator = 0;
  let denominator = 0;
  for (const [type, scores] of byType) {
    const w = weightFor(policy, type);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    numerator += mean * w;
    denominator += w;
  }

  if (denominator === 0) return { moyenne: null, counted: 0 };

  return {
    moyenne: round(numerator / denominator, policy.decimals, policy.rounding),
    counted,
  };
}

// ---------------------------------------------------------------------------
// Moyenne générale
// ---------------------------------------------------------------------------

/**
 * moyenne générale = Σ(moyenne_matière × coefficient) / Σ(coefficients)
 *
 * Une matière sans note exploitable est exclue des DEUX sommes. Compter son
 * coefficient au dénominateur reviendrait à lui attribuer 0.
 */
export function computeGeneralAverage(
  subjects: SubjectResult[],
  policy: GradingPolicy,
): { moyenne: number | null; totalPoints: number; totalCoefficients: number } {
  let totalPoints = 0;
  let totalCoefficients = 0;

  for (const s of subjects) {
    if (s.moyenne === null) continue;
    totalPoints += s.moyenne * s.coefficient;
    totalCoefficients += s.coefficient;
  }

  if (totalCoefficients === 0) {
    return { moyenne: null, totalPoints: 0, totalCoefficients: 0 };
  }

  return {
    moyenne: round(totalPoints / totalCoefficients, policy.decimals, policy.rounding),
    totalPoints: round(totalPoints, policy.decimals, policy.rounding),
    totalCoefficients,
  };
}

// ---------------------------------------------------------------------------
// Mention
// ---------------------------------------------------------------------------

export function findMention(
  moyenne: number | null,
  bands: MentionBand[],
): string | null {
  if (moyenne === null) return null;
  for (const b of bands) {
    if (moyenne >= b.minAverage && moyenne <= b.maxAverage) return b.label;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------

/**
 * Classement au sein de la classe.
 *
 * same_rank_skip : 1, 2, 2, 4  (convention francophone habituelle)
 * same_rank_dense: 1, 2, 2, 3
 *
 * Un élève sans moyenne générale n'est pas classé (rang null) plutôt que
 * classé dernier : il n'a pas été évalué, ce n'est pas un mauvais résultat.
 */
export function assignRanks(
  results: StudentResult[],
  policy: GradingPolicy,
): void {
  const ranked = results
    .filter((r) => r.moyenneGenerale !== null)
    .sort((a, b) => (b.moyenneGenerale as number) - (a.moyenneGenerale as number));

  let previousScore: number | null = null;
  let previousRank = 0;

  ranked.forEach((r, index) => {
    const score = r.moyenneGenerale as number;
    if (previousScore !== null && score === previousScore) {
      r.rang = previousRank;
    } else {
      r.rang = policy.rankTiePolicy === "same_rank_skip"
        ? index + 1
        : previousRank + 1;
      previousRank = r.rang;
      previousScore = score;
    }
  });

  for (const r of results) {
    if (r.moyenneGenerale === null) r.rang = null;
    r.effectif = ranked.length;
  }
}

// ---------------------------------------------------------------------------
// Calcul complet d'une classe
// ---------------------------------------------------------------------------

export function computeClassBulletins(input: {
  studentIds: string[];
  grades: GradeInput[];
  coefficients: Map<string, number>;   // subjectId -> coefficient
  policy: GradingPolicy;
  mentionBands: MentionBand[];
}): ClassResult {
  const { studentIds, grades, coefficients, policy, mentionBands } = input;

  const gradesByStudent = new Map<string, Map<string, GradeInput[]>>();
  for (const g of grades) {
    const perStudent = gradesByStudent.get(g.studentId) ?? new Map();
    const perSubject = perStudent.get(g.subjectId) ?? [];
    perSubject.push(g);
    perStudent.set(g.subjectId, perSubject);
    gradesByStudent.set(g.studentId, perStudent);
  }

  const students: StudentResult[] = studentIds.map((studentId) => {
    const perSubject = gradesByStudent.get(studentId) ?? new Map();

    const subjects: SubjectResult[] = [];
    for (const [subjectId, coefficient] of coefficients) {
      const subjectGrades = perSubject.get(subjectId) ?? [];
      const { moyenne, counted } = computeSubjectAverage(subjectGrades, policy);
      subjects.push({
        subjectId,
        moyenne,
        coefficient,
        points: moyenne === null
          ? null
          : round(moyenne * coefficient, policy.decimals, policy.rounding),
        gradesCounted: counted,
      });
    }

    const general = computeGeneralAverage(subjects, policy);

    return {
      studentId,
      subjects,
      moyenneGenerale: general.moyenne,
      totalPoints: general.totalPoints,
      totalCoefficients: general.totalCoefficients,
      mention: findMention(general.moyenne, mentionBands),
      rang: null,
      effectif: 0,
    };
  });

  assignRanks(students, policy);

  // Moyenne de classe : colonne de comparaison du bulletin.
  const withAverage = students.filter((s) => s.moyenneGenerale !== null);
  const moyenneDeClasse = withAverage.length === 0
    ? null
    : round(
        withAverage.reduce((a, s) => a + (s.moyenneGenerale as number), 0) / withAverage.length,
        policy.decimals,
        policy.rounding,
      );

  const moyenneParMatiere = new Map<string, number | null>();
  for (const subjectId of coefficients.keys()) {
    const values = students
      .map((s) => s.subjects.find((x) => x.subjectId === subjectId)?.moyenne)
      .filter((v): v is number => typeof v === "number");
    moyenneParMatiere.set(
      subjectId,
      values.length === 0
        ? null
        : round(values.reduce((a, b) => a + b, 0) / values.length, policy.decimals, policy.rounding),
    );
  }

  return { students, moyenneDeClasse, moyenneParMatiere };
}

// ---------------------------------------------------------------------------
// Passage en classe supérieure
// ---------------------------------------------------------------------------

export interface PromotionRule {
  levelCode: string;
  redoublementAllowed: boolean;
  minAverageToPass: number | null;
}

export type ConseilDecision = "admis" | "redouble" | "exclu" | "reoriente";

/**
 * Proposition au conseil de classe — une PROPOSITION, pas une décision.
 * Le conseil tranche ; sa composition et ses seuils n'ont pas pu être établis
 * depuis un texte officiel burkinabè.
 *
 * Règle particulière : le redoublement est interdit en CP1, CE1 et CM1
 * (première année de chaque sous-cycle du primaire, arrêté de 2019). Dans ces
 * classes le passage est automatique, quelle que soit la moyenne.
 */
export function proposeDecision(
  moyenneAnnuelle: number | null,
  rule: PromotionRule,
): { decision: ConseilDecision; reason: string } {
  if (!rule.redoublementAllowed) {
    return {
      decision: "admis",
      reason: `Passage automatique : redoublement interdit en ${rule.levelCode} (arrêté 2019).`,
    };
  }
  if (moyenneAnnuelle === null) {
    return { decision: "admis", reason: "Aucune moyenne : à examiner par le conseil." };
  }
  const threshold = rule.minAverageToPass ?? 10;
  return moyenneAnnuelle >= threshold
    ? { decision: "admis", reason: `Moyenne ${moyenneAnnuelle} ≥ ${threshold}.` }
    : { decision: "redouble", reason: `Moyenne ${moyenneAnnuelle} < ${threshold}.` };
}
