/**
 * Calendrier de l'année scolaire.
 *
 * La règle qui compte : les trois trimestres sont INÉGAUX. Le troisième est
 * tronqué par la session d'examens. Trois durées identiques, c'est presque
 * toujours quelqu'un qui a divisé l'année par trois — et alors les moyennes
 * du T3 portent sur des évaluations qui n'ont pas eu lieu.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toIso, jour, semaines, checkCalendar, shortLevel } from "../src/server/rentree.ts";

const t = (sequence: number, startsOn: string, endsOn: string) => ({ sequence, startsOn, endsOn });

/* Un calendrier réaliste : rentrée pédagogique le 1er octobre, clôture à la
   mi-juillet, T3 raccourci par les examens. */
const ANNEE = ["2026-10-01", "2027-07-15"] as const;
const TRIMESTRES = [
  t(1, "2026-10-01", "2026-12-19"),
  t(2, "2027-01-05", "2027-03-27"),
  t(3, "2027-04-06", "2027-06-12"),
];

test("les dates s'écrivent jour d'abord, ou en ISO", () => {
  assert.equal(toIso("01/10/2026"), "2026-10-01");
  assert.equal(toIso("1-10-2026"), "2026-10-01");
  assert.equal(toIso("2026-10-01"), "2026-10-01");
  assert.equal(jour("2026-10-01"), "01/10/2026");
});

test("une date impossible est refusée, pas corrigée", () => {
  assert.equal(toIso("31/02/2026"), null);
  assert.equal(toIso("00/10/2026"), null);
  assert.equal(toIso("bientôt"), null);
});

test("un calendrier ordinaire passe sans rien signaler", () => {
  const v = checkCalendar(ANNEE[0], ANNEE[1], TRIMESTRES);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
});

test("trois trimestres de durée égale sont signalés", () => {
  // Exactement l'année divisée en trois : ce que produit un tableur.
  const v = checkCalendar("2026-10-01", "2027-06-30", [
    t(1, "2026-10-01", "2026-12-30"),
    t(2, "2026-12-31", "2027-03-31"),
    t(3, "2027-04-01", "2027-06-30"),
  ]);
  assert.deepEqual(v.errors, []);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /divisé/);
});

test("un troisième trimestre plus long que les autres est signalé", () => {
  const v = checkCalendar("2026-10-01", "2027-07-15", [
    t(1, "2026-10-01", "2026-11-15"),
    t(2, "2026-11-20", "2027-01-10"),
    t(3, "2027-01-15", "2027-07-01"),
  ]);
  assert.deepEqual(v.errors, []);
  assert.match(v.warnings.join(" "), /le plus long/);
});

test("des trimestres qui se chevauchent sont une erreur, pas un avertissement", () => {
  const v = checkCalendar(ANNEE[0], ANNEE[1], [
    t(1, "2026-10-01", "2026-12-19"),
    t(2, "2026-12-01", "2027-03-27"),
    t(3, "2027-04-06", "2027-06-12"),
  ]);
  assert.match(v.errors.join(" "), /chevauchent/);
});

test("un trimestre hors de l'année est refusé", () => {
  const v = checkCalendar(ANNEE[0], ANNEE[1], [
    ...TRIMESTRES.slice(0, 2),
    t(3, "2027-04-06", "2027-09-30"),
  ]);
  assert.match(v.errors.join(" "), /hors des bornes/);
});

test("un trimestre de deux semaines est refusé", () => {
  const v = checkCalendar(ANNEE[0], ANNEE[1], [
    t(1, "2026-10-01", "2026-10-14"),
    ...TRIMESTRES.slice(1),
  ]);
  assert.match(v.errors.join(" "), /quatre semaines/);
});

test("une fin avant le début est refusée sans aller plus loin", () => {
  const v = checkCalendar("2027-07-15", "2026-10-01", TRIMESTRES);
  assert.equal(v.errors.length, 1);
  assert.match(v.errors[0]!, /avant d'avoir commencé/);
});

test("une année raccourcie par une décision régionale reste valable", () => {
  // Bobo-Dioulasso a clos 2025-2026 le 30 mai au lieu du 15 juillet pour la
  // Semaine nationale de la culture. Le calendrier est amendable par région :
  // le logiciel ne doit ni refuser cette année, ni la traiter comme suspecte.
  const v = checkCalendar("2025-10-01", "2026-05-30", [
    t(1, "2025-10-01", "2025-12-19"),
    t(2, "2026-01-05", "2026-03-20"),
    t(3, "2026-03-30", "2026-05-29"),
  ]);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
});

test("une année invraisemblablement courte est signalée", () => {
  const v = checkCalendar("2026-10-01", "2027-01-20", [
    t(1, "2026-10-01", "2026-11-05"),
    t(2, "2026-11-10", "2026-12-15"),
    t(3, "2026-12-18", "2027-01-20"),
  ]);
  assert.match(v.warnings.join(" "), /vérifiez les dates/);
});

test("les durées se comptent en semaines", () => {
  assert.equal(semaines("2026-10-01", "2026-12-19"), 11);
  assert.equal(semaines("2027-04-06", "2027-06-12"), 10);
});

test("les libellés de classe suivent l'usage burkinabè", () => {
  assert.equal(shortLevel("6E"), "6e");
  assert.equal(shortLevel("TLE"), "Tle");
  assert.equal(shortLevel("1ERE"), "1re");
  assert.equal(shortLevel("2NDE"), "2nde");
  assert.equal(shortLevel("CP1"), "CP1");
});
