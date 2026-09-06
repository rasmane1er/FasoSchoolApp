/**
 * Lecture d'une liste d'élèves.
 *
 * Les cas testés ici sont ceux qui font échouer un import en vrai : l'encodage
 * d'Excel sous Windows, l'ordre jour/mois, les numéros écrits à la main, et
 * la colonne unique « Nom et prénoms ».
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeBytes, sniffDelimiter, parseDelimited, normalizeHeader, mapHeaders,
  splitFullName, normalizeSex, normalizePhone, normalizeDate,
  readRoster, readRosterText, makeMatricule, importable,
} from "../src/lib/roster.ts";

const AUJOURD_HUI = new Date("2026-09-06T00:00:00Z");

// ---------------------------------------------------------------------------

test("le CSV d'Excel francophone est lu sans casser les accents", () => {
  // « Nom;Prénoms\nBAMBARA;Alizèta » tel qu'Excel l'écrit sous Windows.
  const win1252 = Uint8Array.from([
    0x4e, 0x6f, 0x6d, 0x3b, 0x50, 0x72, 0xe9, 0x6e, 0x6f, 0x6d, 0x73, 0x0a,
    0x42, 0x41, 0x4d, 0x42, 0x41, 0x52, 0x41, 0x3b, 0x41, 0x6c, 0x69, 0x7a, 0xe8, 0x74, 0x61,
  ]);
  const r = readRoster(win1252, AUJOURD_HUI);
  assert.equal(r.encoding, "windows-1252");
  assert.equal(r.rows[0]!.lastName, "BAMBARA");
  assert.equal(r.rows[0]!.firstNames, "Alizèta");
});

test("l'UTF-8 reste de l'UTF-8, avec ou sans BOM", () => {
  const utf8 = new TextEncoder().encode("Nom;Prénoms\nBAMBARA;Alizèta");
  assert.equal(decodeBytes(utf8).encoding, "utf-8");
  assert.equal(decodeBytes(utf8).text.includes("Alizèta"), true);

  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  const d = decodeBytes(bom);
  assert.equal(d.encoding, "utf-8 (BOM)");
  assert.equal(d.text.startsWith("Nom"), true, "le BOM ne doit pas rester dans l'en-tête");
});

test("le séparateur est deviné, point-virgule comme virgule comme tabulation", () => {
  assert.equal(sniffDelimiter("Nom;Prénoms;Sexe\nA;B;C"), ";");
  assert.equal(sniffDelimiter("Nom,Prénoms,Sexe\nA,B,C"), ",");
  assert.equal(sniffDelimiter("Nom\tPrénoms\tSexe"), "\t");
});

test("les guillemets protègent le séparateur", () => {
  const t = parseDelimited('Nom;Adresse\nOUEDRAOGO;"Secteur 15; porte 42"', ";");
  assert.deepEqual(t[1], ["OUEDRAOGO", "Secteur 15; porte 42"]);
});

test("un guillemet doublé est un guillemet", () => {
  assert.deepEqual(parseDelimited('a;"il dit ""oui"""', ";")[0], ["a", 'il dit "oui"']);
});

// ---------------------------------------------------------------------------

test("les intitulés de colonnes sont reconnus malgré accents et ponctuation", () => {
  assert.equal(normalizeHeader("Prénom(s)"), "prenom");
  assert.equal(normalizeHeader("N° Matricule"), "n matricule");
  assert.equal(normalizeHeader("Né(e) le"), "ne le");

  const m = mapHeaders(["N° Matricule", "NOM", "Prénom(s)", "Sexe", "Né(e) le", "Tél. tuteur"]);
  assert.deepEqual(m, {
    matricule: 0, last_name: 1, first_names: 2, sex: 3, date_of_birth: 4, guardian_phone: 5,
  });
});

test("« nom du tuteur » ne prend pas la place de « nom »", () => {
  const m = mapHeaders(["Nom", "Prénoms", "Nom du tuteur", "Téléphone"]);
  assert.equal(m.last_name, 0);
  assert.equal(m.guardian_name, 2);
  assert.equal(m.guardian_phone, 3);
});

test("les colonnes non reconnues sont nommées, pas ignorées en silence", () => {
  const r = readRosterText("Nom;Prénoms;Groupe sanguin\nSAWADOGO;Issa;O+");
  assert.deepEqual(r.unmapped, ["Groupe sanguin"]);
});

// ---------------------------------------------------------------------------

test("« BAMBARA Alizèta » se sépare sur les capitales", () => {
  assert.deepEqual(splitFullName("BAMBARA Alizèta"),
    { last: "BAMBARA", first: "Alizèta", guessed: false });
  assert.deepEqual(splitFullName("OUEDRAOGO KABORE Marie Louise"),
    { last: "OUEDRAOGO KABORE", first: "Marie Louise", guessed: false });
});

test("sans capitales, la séparation est une supposition — et elle est signalée", () => {
  const s = splitFullName("Bambara Alizeta");
  assert.equal(s.last, "Bambara");
  assert.equal(s.guessed, true, "il faut le dire à l'utilisateur");

  const r = readRosterText("Nom et prénoms;Sexe\nBambara Alizeta;F");
  assert.equal(r.rows[0]!.warnings.length, 1);
  assert.match(r.rows[0]!.warnings[0]!, /à vérifier/);
  assert.equal(importable(r.rows[0]!), true, "un doute n'est pas un blocage");
});

test("le sexe s'écrit de six façons", () => {
  for (const v of ["M", "m", "Masculin", "garçon", "G", "H"]) assert.equal(normalizeSex(v), "M", v);
  for (const v of ["F", "féminin", "Fille", "f "]) assert.equal(normalizeSex(v), "F", v);
  assert.equal(normalizeSex("?"), null);
});

test("un numéro burkinabè se ramène à huit chiffres", () => {
  for (const v of ["70123456", "70 12 34 56", "+226 70123456", "00226-70-12-34-56", "226 70 12 34 56"]) {
    assert.equal(normalizePhone(v).phone, "70123456", v);
  }
  assert.equal(normalizePhone("").phone, null);
  assert.match(normalizePhone("7012345").problem!, /7 chiffres/);
  assert.match(normalizePhone("31123456").problem!, /préfixe/);
});

test("12/03/2014 est le 12 mars", () => {
  assert.equal(normalizeDate("12/03/2014", AUJOURD_HUI).date, "2014-03-12");
  assert.equal(normalizeDate("12-03-2014", AUJOURD_HUI).date, "2014-03-12");
  assert.equal(normalizeDate("2014-03-12", AUJOURD_HUI).date, "2014-03-12");
  assert.equal(normalizeDate("12 mars 2014", AUJOURD_HUI).date, "2014-03-12");
});

test("une date impossible est refusée, une date invraisemblable est signalée", () => {
  assert.equal(normalizeDate("31/02/2014", AUJOURD_HUI).date, null);
  assert.match(normalizeDate("31/02/2014", AUJOURD_HUI).problem!, /impossible/);

  const vieux = normalizeDate("12/03/1975", AUJOURD_HUI);
  assert.equal(vieux.date, "1975-03-12", "la valeur est conservée");
  assert.match(vieux.problem!, /à vérifier/, "mais elle est signalée");
});

test("une année sur deux chiffres bascule au bon siècle", () => {
  assert.equal(normalizeDate("12/03/14", AUJOURD_HUI).date, "2014-03-12");
  assert.equal(normalizeDate("12/03/95", AUJOURD_HUI).date, "1995-03-12");
});

// ---------------------------------------------------------------------------

test("une liste complète se lit d'un bout à l'autre", () => {
  const csv = [
    "Matricule;NOM;Prénoms;Sexe;Né(e) le;Classe;Nom du tuteur;Téléphone;Redoublant",
    "M001;BAMBARA;Alizèta;F;12/03/2014;6e B;BAMBARA Salif;70 12 34 56;non",
    "M002;OUEDRAOGO;Issa;M;05/07/2013;6e B;;;oui",
  ].join("\n");
  const r = readRosterText(csv, "utf-8", AUJOURD_HUI);

  assert.equal(r.headerFound, true);
  assert.equal(r.rows.length, 2);

  const a = r.rows[0]!;
  assert.equal(a.line, 2, "la ligne renvoyée est celle du fichier, en-tête compris");
  assert.equal(a.matricule, "M001");
  assert.equal(a.sex, "F");
  assert.equal(a.dateOfBirth, "2014-03-12");
  assert.equal(a.className, "6e B");
  assert.equal(a.guardianPhone, "70123456");
  assert.equal(a.isRedoublant, false);
  assert.deepEqual(a.problems, []);
  assert.deepEqual(a.warnings, []);

  assert.equal(r.rows[1]!.isRedoublant, true);
  assert.equal(r.rows[1]!.guardianPhone, null);
});

test("un fichier sans en-tête est lu quand même", () => {
  const r = readRosterText("BAMBARA Alizèta;F;12/03/2014", "utf-8", AUJOURD_HUI);
  assert.equal(r.headerFound, false);
  assert.equal(r.rows.length, 1, "la première ligne est un élève, pas un en-tête");
  assert.equal(r.rows[0]!.lastName, "BAMBARA");
  assert.equal(r.rows[0]!.line, 1);
});

test("un doublon dans le fichier bloque la deuxième ligne, pas la première", () => {
  const csv = [
    "Nom;Prénoms;Né(e) le",
    "BAMBARA;Alizèta;12/03/2014",
    "BAMBARA;Alizèta;12/03/2014",
  ].join("\n");
  const r = readRosterText(csv, "utf-8", AUJOURD_HUI);
  assert.equal(importable(r.rows[0]!), true);
  assert.equal(importable(r.rows[1]!), false);
  assert.match(r.rows[1]!.problems[0]!, /ligne 2/);
});

test("un matricule répété est un doublon même si les noms diffèrent", () => {
  const r = readRosterText(
    "Matricule;Nom\nM001;BAMBARA\nM001;OUEDRAOGO", "utf-8", AUJOURD_HUI);
  assert.match(r.rows[1]!.problems[0]!, /matricule M001/);
});

test("une ligne sans nom ne s'importe pas", () => {
  const r = readRosterText("Nom;Prénoms\n;Alizèta", "utf-8", AUJOURD_HUI);
  assert.equal(importable(r.rows[0]!), false);
  assert.deepEqual(r.rows[0]!.problems, ["aucun nom"]);
});

test("les lignes vides d'un tableau collé disparaissent", () => {
  const r = readRosterText("Nom\tPrénoms\nBAMBARA\tAlizèta\n\n\n", "utf-8", AUJOURD_HUI);
  assert.equal(r.rows.length, 1);
});

test("le matricule attribué est stable et lisible", () => {
  assert.equal(makeMatricule(2026, 31), "2026-0031");
  assert.equal(makeMatricule(2026, 1), "2026-0001");
});
