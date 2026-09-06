/**
 * Tests du moteur de bulletin.
 *
 *   node --experimental-strip-types --test tests/bulletin.test.ts
 *
 * Les cas couverts sont ceux qui cassent un bulletin en production :
 * composition pas encore passée, absence justifiée, matière sans note,
 * ex aequo, arrondi à la limite, et la règle CP1/CE1/CM1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  round,
  computeSubjectAverage,
  computeGeneralAverage,
  findMention,
  assignRanks,
  computeClassBulletins,
  proposeDecision,
  type GradingPolicy,
  type MentionBand,
  type GradeInput,
  type StudentResult,
} from "../src/lib/bulletin.ts";

// Valeurs par défaut de seed_school_defaults().
// Rappel : la pondération (devoirs + composition x2)/3 est une convention
// régionale NON VÉRIFIÉE pour le Burkina Faso.
const policy: GradingPolicy = {
  interrogationWeight: 0,
  devoirWeight: 1,
  compositionWeight: 2,
  scaleMax: 20,
  passMark: 10,
  decimals: 2,
  rounding: "half_up",
  rankTiePolicy: "same_rank_skip",
  unjustifiedAbsenceCountsAsZero: true,
};

const mentions: MentionBand[] = [
  { label: "Insuffisant", minAverage: 0, maxAverage: 9.99 },
  { label: "Passable", minAverage: 10, maxAverage: 11.99 },
  { label: "Assez bien", minAverage: 12, maxAverage: 13.99 },
  { label: "Bien", minAverage: 14, maxAverage: 15.99 },
  { label: "Très bien", minAverage: 16, maxAverage: 20 },
];

const g = (
  studentId: string,
  subjectId: string,
  evalType: GradeInput["evalType"],
  score: number | null,
  opts: Partial<GradeInput> = {},
): GradeInput => ({
  studentId, subjectId, evalType, score,
  isAbsent: false, isJustified: false, ...opts,
});

// ---------------------------------------------------------------------------

test("arrondi half_up sur .5 exact, y compris en négatif", () => {
  assert.equal(round(12.345, 2, "half_up"), 12.35);
  assert.equal(round(12.344, 2, "half_up"), 12.34);
  assert.equal(round(0.5, 0, "half_up"), 1);
  // Math.round(-0.5) vaut 0 en JS : le piège classique.
  assert.equal(round(-0.5, 0, "half_up"), -1);
  assert.equal(round(12.5, 0, "half_even"), 12);
  assert.equal(round(13.5, 0, "half_even"), 14);
  assert.equal(round(12.999, 2, "truncate"), 12.99);
});

test("moyenne matière : devoirs et composition pondérés 1 / 2", () => {
  const grades = [
    g("e1", "MATH", "devoir", 12),
    g("e1", "MATH", "devoir", 14),      // moyenne devoirs = 13
    g("e1", "MATH", "composition", 16), // (13x1 + 16x2) / 3 = 15
  ];
  assert.equal(computeSubjectAverage(grades, policy).moyenne, 15);
});

test("composition non encore passée : on ne divise pas par son poids", () => {
  // Le bug classique : (13x1 + 0x2)/3 = 4,33 au lieu de 13.
  const grades = [
    g("e1", "MATH", "devoir", 12),
    g("e1", "MATH", "devoir", 14),
  ];
  const { moyenne } = computeSubjectAverage(grades, policy);
  assert.equal(moyenne, 13, "la moyenne de mi-trimestre doit valoir 13, pas 4.33");
});

test("absence justifiée : neutralisée, ne pénalise pas", () => {
  const grades = [
    g("e1", "MATH", "devoir", 14),
    g("e1", "MATH", "devoir", null, { isAbsent: true, isJustified: true }),
  ];
  assert.equal(computeSubjectAverage(grades, policy).moyenne, 14);
  assert.equal(computeSubjectAverage(grades, policy).counted, 1);
});

test("absence non justifiée : comptée 0 quand la politique le dit", () => {
  const grades = [
    g("e1", "MATH", "devoir", 14),
    g("e1", "MATH", "devoir", null, { isAbsent: true, isJustified: false }),
  ];
  assert.equal(computeSubjectAverage(grades, policy).moyenne, 7);

  const lenient = { ...policy, unjustifiedAbsenceCountsAsZero: false };
  assert.equal(computeSubjectAverage(grades, lenient).moyenne, 14);
});

test("examen blanc exclu de la moyenne trimestrielle", () => {
  const grades = [
    g("e1", "MATH", "devoir", 14),
    g("e1", "MATH", "examen_blanc", 2),
  ];
  assert.equal(computeSubjectAverage(grades, policy).moyenne, 14);
});

test("aucune note exploitable : moyenne null, pas zéro", () => {
  assert.equal(computeSubjectAverage([], policy).moyenne, null);
  const onlyJustified = [
    g("e1", "MATH", "devoir", null, { isAbsent: true, isJustified: true }),
  ];
  assert.equal(computeSubjectAverage(onlyJustified, policy).moyenne, null);
});

test("moyenne générale : matière sans note exclue des DEUX sommes", () => {
  const subjects = [
    { subjectId: "MATH", moyenne: 15, coefficient: 3, points: 45, gradesCounted: 3, rangMatiere: null },
    { subjectId: "FR", moyenne: 10, coefficient: 3, points: 30, gradesCounted: 3, rangMatiere: null },
    { subjectId: "EPS", moyenne: null, coefficient: 2, points: null, gradesCounted: 0, rangMatiere: null },
  ];
  const r = computeGeneralAverage(subjects, policy);
  // (15x3 + 10x3) / 6 = 12,5. Compter le coeff 2 de l'EPS donnerait 9,375.
  assert.equal(r.moyenne, 12.5);
  assert.equal(r.totalCoefficients, 6);
});

test("mentions : bornes exactes", () => {
  assert.equal(findMention(9.99, mentions), "Insuffisant");
  assert.equal(findMention(10, mentions), "Passable");
  assert.equal(findMention(11.99, mentions), "Passable");
  assert.equal(findMention(12, mentions), "Assez bien");
  assert.equal(findMention(16, mentions), "Très bien");
  assert.equal(findMention(20, mentions), "Très bien");
  assert.equal(findMention(null, mentions), null);
});

test("classement : ex aequo en 1, 2, 2, 4", () => {
  const rs: StudentResult[] = [
    { studentId: "a", subjects: [], moyenneGenerale: 18, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "b", subjects: [], moyenneGenerale: 15, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "c", subjects: [], moyenneGenerale: 15, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "d", subjects: [], moyenneGenerale: 11, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
  ];
  assignRanks(rs, policy);
  assert.equal(rs.find((r) => r.studentId === "a")!.rang, 1);
  assert.equal(rs.find((r) => r.studentId === "b")!.rang, 2);
  assert.equal(rs.find((r) => r.studentId === "c")!.rang, 2);
  assert.equal(rs.find((r) => r.studentId === "d")!.rang, 4);
});

test("classement dense : 1, 2, 2, 3", () => {
  const dense = { ...policy, rankTiePolicy: "same_rank_dense" as const };
  const rs: StudentResult[] = [
    { studentId: "a", subjects: [], moyenneGenerale: 18, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "b", subjects: [], moyenneGenerale: 15, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "c", subjects: [], moyenneGenerale: 15, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "d", subjects: [], moyenneGenerale: 11, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
  ];
  assignRanks(rs, dense);
  assert.equal(rs.find((r) => r.studentId === "d")!.rang, 3);
});

test("élève sans moyenne : non classé, pas dernier", () => {
  const rs: StudentResult[] = [
    { studentId: "a", subjects: [], moyenneGenerale: 12, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
    { studentId: "b", subjects: [], moyenneGenerale: null, totalPoints: 0, totalCoefficients: 0, mention: null, rang: null, effectif: 0 },
  ];
  assignRanks(rs, policy);
  assert.equal(rs[0]!.rang, 1);
  assert.equal(rs[1]!.rang, null);
  assert.equal(rs[0]!.effectif, 1, "l'effectif ne compte que les élèves classés");
});

test("bulletin de classe complet, coefficients réforme 2026", () => {
  const coefficients = new Map([["MATH", 3], ["FR", 3], ["HG", 2]]);
  const grades: GradeInput[] = [
    g("e1", "MATH", "devoir", 16), g("e1", "MATH", "composition", 18),
    g("e1", "FR", "devoir", 12),   g("e1", "FR", "composition", 14),
    g("e1", "HG", "composition", 10),
    g("e2", "MATH", "devoir", 8),  g("e2", "MATH", "composition", 6),
    g("e2", "FR", "devoir", 11),   g("e2", "FR", "composition", 13),
    g("e2", "HG", "composition", 12),
  ];

  const result = computeClassBulletins({
    studentIds: ["e1", "e2"], grades, coefficients, policy, mentionBands: mentions,
  });

  const e1 = result.students.find((s) => s.studentId === "e1")!;
  // MATH (16 + 18x2)/3 = 17,33 ; FR (12 + 14x2)/3 = 13,33 ; HG = 10
  // (17,33x3 + 13,33x3 + 10x2) / 8 = 111,98 / 8 = 13,9975 -> 14,00
  assert.equal(e1.subjects.find((s) => s.subjectId === "MATH")!.moyenne, 17.33);
  assert.equal(e1.moyenneGenerale, 14);
  assert.equal(e1.mention, "Bien");
  assert.equal(e1.rang, 1);
  assert.equal(e1.effectif, 2);

  const e2 = result.students.find((s) => s.studentId === "e2")!;
  assert.equal(e2.rang, 2);
  assert.ok(e2.moyenneGenerale! < e1.moyenneGenerale!);

  assert.ok(result.moyenneDeClasse !== null);
  assert.equal(result.moyenneParMatiere.get("HG"), 11); // (10 + 12) / 2
});

test("redoublement interdit en CP1, CE1, CM1 : passage automatique", () => {
  for (const level of ["CP1", "CE1", "CM1"]) {
    const d = proposeDecision(4.2, {
      levelCode: level, redoublementAllowed: false, minAverageToPass: 10,
    });
    assert.equal(d.decision, "admis", `${level} doit passer automatiquement`);
    assert.match(d.reason, /arrêté 2019/);
  }
});

test("redoublement possible en CP2, CE2, CM2 et au-delà", () => {
  const d = proposeDecision(4.2, {
    levelCode: "CP2", redoublementAllowed: true, minAverageToPass: 10,
  });
  assert.equal(d.decision, "redouble");

  const ok = proposeDecision(11, {
    levelCode: "6E", redoublementAllowed: true, minAverageToPass: 10,
  });
  assert.equal(ok.decision, "admis");
});
