/**
 * Arithmétique des bourses et remises.
 *
 * Ces quelques lignes décident de ce qu'une famille paie. Une erreur ici ne
 * produit pas un écran laid : elle produit une facture fausse, dans un sens ou
 * dans l'autre, et personne ne s'en aperçoit avant la fin de l'année.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { effet, effetCumule } from "../src/server/bourses.ts";

const pct = (p: number) => ({ percent: p, amountFcfa: null });
const fixe = (a: number) => ({ percent: null, amountFcfa: a });

test("un pourcentage retire sa part", () => {
  assert.equal(effet(80000, 50, null), 40000);
  assert.equal(effet(80000, 25, null), 20000);
  assert.equal(effet(80000, 100, null), 80000);
});

test("un montant fixe retire ce montant", () => {
  assert.equal(effet(80000, null, 20000), 20000);
});

test("une remise ne peut pas dépasser ce qui est dû", () => {
  assert.equal(effet(15000, null, 40000), 15000,
    "sinon l'établissement devrait de l'argent à la famille");
});

test("une ligne sans pourcentage ni montant ne retire rien", () => {
  assert.equal(effet(80000, null, null), 0);
});

test("DEUX REMISES DE 50 % FONT 75 %, PAS LA GRATUITÉ", () => {
  // La faute qui coûte le plus cher : additionner les pourcentages.
  assert.equal(effetCumule(80000, [pct(50), pct(50)]), 60000);
  assert.notEqual(effetCumule(80000, [pct(50), pct(50)]), 80000);
});

test("trois remises de 50 % laissent encore quelque chose à payer", () => {
  assert.equal(effetCumule(80000, [pct(50), pct(50), pct(50)]), 70000);
});

test("l'ordre des remises change leur effet individuel, pas le total dû", () => {
  const a = effetCumule(80000, [pct(50), fixe(20000)]);
  const b = effetCumule(80000, [fixe(20000), pct(50)]);
  assert.equal(a, 40000 + 20000);
  assert.equal(b, 20000 + 30000);
  assert.notEqual(a, b, "un montant fixe posé en premier retire moins ensuite");
});

test("le cumul ne dépasse jamais le montant dû", () => {
  assert.equal(effetCumule(50000, [fixe(40000), fixe(40000)]), 50000);
  assert.equal(effetCumule(50000, [pct(100), pct(100)]), 50000);
});

test("un montant nul reste nul", () => {
  assert.equal(effetCumule(0, [pct(50), fixe(1000)]), 0);
});

test("les francs CFA n'ont pas de centimes", () => {
  // 33 % de 80 000 = 26 400 exactement ; 33 % de 79 999 doit rester entier.
  assert.equal(Number.isInteger(effet(79999, 33, null)), true);
  assert.equal(effet(80000, 33, null), 26400);
});
