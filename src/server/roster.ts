/**
 * Import de la liste des élèves.
 *
 * C'est le premier obstacle réel d'une rentrée : un établissement possède déjà
 * ses élèves, dans un classeur Excel ou un tableau Word, et personne ne va
 * retaper quatre cents lignes à la main. Tant que cet écran n'existe pas, le
 * logiciel ne peut pas être essayé du tout.
 *
 * Trois principes tiennent tout l'écran :
 *
 * 1. **Rien n'est écrit avant d'avoir été montré.** Le fichier est lu, chaque
 *    ligne est affichée telle qu'elle sera enregistrée, et l'import n'a lieu
 *    qu'après confirmation. Un import qui se déroule tout seul et qu'on
 *    découvre après coup est un import qu'il faut défaire à la main.
 *
 * 2. **Une ligne douteuse se corrige ici, pas dans Excel.** Les lignes
 *    signalées sont modifiables dans l'aperçu. Renvoyer le secrétaire à son
 *    fichier pour une date mal écrite, c'est perdre la matinée.
 *
 * 3. **Un élève déjà connu est réinscrit, jamais dupliqué.** À la rentrée, la
 *    liste importée contient les élèves de l'an dernier qui montent d'un
 *    niveau. Deux fiches pour le même enfant, et le bulletin de juin est faux.
 */

import { withSchool } from "../lib/db.ts";
import {
  readRoster, readRosterText, markDuplicates, makeMatricule, importable,
  identityKey, tidy, normalizeSex, normalizeDate, normalizePhone,
  type RosterRow, type RosterReading,
} from "../lib/roster.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

// ---------------------------------------------------------------------------
// Transport de l'aperçu vers la confirmation
// ---------------------------------------------------------------------------

/*
 * Entre l'aperçu et l'import, les lignes voyagent dans un champ caché, en
 * valeurs déjà normalisées, une ligne par élève, séparées par des tabulations.
 *
 * Pourquoi pas une table d'attente en base : parce qu'il faudrait l'expirer,
 * la nettoyer, et gérer le cas où le secrétaire ferme l'onglet. Le formulaire
 * porte l'état ; il n'y a rien à nettoyer. Et le poids reste modeste — quatre
 * cents élèves tiennent dans une trentaine de kilo-octets, ce qui compte quand
 * la connexion est mauvaise.
 */

const FIELDS = [
  "matricule", "lastName", "firstNames", "sex", "dateOfBirth",
  "placeOfBirth", "className", "isRedoublant", "guardianName", "guardianPhone",
] as const;

const cell = (v: string | boolean | null): string =>
  v === null || v === false ? "" : v === true ? "1" : String(v).replace(/[\t\r\n]/g, " ");

export function encodeRows(rows: RosterRow[]): string {
  return rows.map((r) => FIELDS.map((f) => cell(r[f] as never)).join("\t")).join("\n");
}

export function decodeRows(text: string): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    const c = line.split("\t");
    const at = (n: number) => (c[n] ?? "").trim();
    rows.push({
      line: i + 1,
      matricule: at(0) || null,
      lastName: at(1),
      firstNames: at(2),
      sex: at(3) === "M" ? "M" : at(3) === "F" ? "F" : null,
      dateOfBirth: at(4) || null,
      placeOfBirth: at(5) || null,
      className: at(6) || null,
      isRedoublant: at(7) === "1",
      guardianName: at(8) || null,
      guardianPhone: at(9) || null,
      problems: [],
      warnings: [],
    });
  }
  return rows;
}

/**
 * Applique les corrections saisies dans l'aperçu et revalide.
 * Une correction est reprise par la même normalisation que le fichier : le
 * secrétaire peut écrire « 12/03/2014 » ou « 70 12 34 56 » comme partout.
 */
export function applyCorrections(
  rows: RosterRow[], form: URLSearchParams, today = new Date(),
): RosterRow[] {
  rows.forEach((r, i) => {
    r.problems = [];
    r.warnings = [];

    const edited = (name: string) => {
      const v = form.get(`c${i}_${name}`);
      return v === null ? null : tidy(v);
    };

    const nom = edited("lastName");
    if (nom !== null) r.lastName = nom;
    const prenoms = edited("firstNames");
    if (prenoms !== null) r.firstNames = prenoms;

    const sexe = edited("sex");
    if (sexe !== null) r.sex = sexe === "" ? null : normalizeSex(sexe);

    const naissance = edited("dateOfBirth");
    if (naissance !== null) {
      if (naissance === "") r.dateOfBirth = null;
      else {
        const d = normalizeDate(naissance, today);
        r.dateOfBirth = d.date;
        if (d.problem) r.warnings.push(d.problem);
      }
    }

    const tel = edited("guardianPhone");
    if (tel !== null) {
      if (tel === "") r.guardianPhone = null;
      else {
        const p = normalizePhone(tel);
        r.guardianPhone = p.phone;
        if (p.problem) r.warnings.push(p.problem);
      }
    }

    const tuteur = edited("guardianName");
    if (tuteur !== null) r.guardianName = tuteur || null;

    if (!r.lastName) r.problems.push("aucun nom");
    if (form.get(`c${i}_ignorer`) === "1") r.problems.push("ligne écartée");
  });

  markDuplicates(rows);
  return rows;
}

// ---------------------------------------------------------------------------
// Contexte de l'établissement
// ---------------------------------------------------------------------------

export interface ClassOption { id: string; label: string }

async function currentYear(c: any): Promise<{ id: string; label: string; startYear: number } | null> {
  const r = await c.query(
    `select id, label, starts_on from academic_years
      order by (status = 'en_cours') desc, starts_on desc limit 1`);
  if (r.rowCount === 0) return null;
  return {
    id: r.rows[0].id,
    label: r.rows[0].label,
    startYear: new Date(r.rows[0].starts_on).getUTCFullYear(),
  };
}

async function classesOf(c: any, yearId: string): Promise<ClassOption[]> {
  const r = await c.query(
    `select id, label from classes where academic_year_id = $1 order by label`, [yearId]);
  return r.rows.map((x: any) => ({ id: x.id, label: x.label }));
}

/** « 2014-03-12 » → « 12/03/2014 », comme on l'écrit ici. */
const jour = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

/** Rapproche « 6e B », « 6ème B », « 6E B » d'une classe existante. */
export const classKey = (label: string): string =>
  label.toLowerCase()
    .replace(/è|é|ê/g, "e")
    .replace(/\b(\d+)\s*(eme|ème|e|er|re|nde|nd)\b/g, "$1e")
    .replace(/[^a-z0-9]+/g, "");

// ---------------------------------------------------------------------------
// Écran 1 : dépôt du fichier
// ---------------------------------------------------------------------------

export async function importPage(
  user: SessionUser, chrome: PageChrome, message?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const { year, classes, effectif } = await withSchool(schoolId, async (c) => {
    const y = await currentYear(c);
    const cl = y ? await classesOf(c, y.id) : [];
    const n = y
      ? await c.query(`select count(*)::int as n from enrolments where academic_year_id = $1`, [y.id])
      : { rows: [{ n: 0 }] };
    return { year: y, classes: cl, effectif: n.rows[0].n as number };
  });

  const body = `
<div>
  <h1>Inscrire des élèves</h1>
  <p class="sub">Déposez la liste que vous avez déjà — un fichier exporté d'Excel,
  ou le tableau collé. Rien ne sera enregistré avant que vous ayez vu, ligne par
  ligne, ce qui va l'être.</p>
</div>

${message ? `<div class="note bad">${esc(message)}</div>` : ""}
${!year ? `<div class="note bad">Aucune année scolaire n'est ouverte. Il faut la
  créer avant d'inscrire des élèves.</div>` : ""}

<div class="card">
  <header>
    <b>${esc(year?.label ?? "—")}</b>
    <span style="color:var(--muted);font-size:13px">
      ${plural(effectif, "élève inscrit", "élèves inscrits")} ·
      ${plural(classes.length, "classe ouverte", "classes ouvertes")}</span>
  </header>
  <form method="post" action="/inscriptions/lire" enctype="multipart/form-data" class="body">
    <label for="fichier">Fichier de la liste</label>
    <input type="file" id="fichier" name="fichier"
           accept=".csv,.txt,.tsv,text/csv,text/plain"
           style="font:inherit;font-size:13.5px;margin-bottom:6px">
    <p class="hint">CSV ou texte. Un classeur <code>.xlsx</code> doit d'abord être
    enregistré sous « CSV (séparateur : point-virgule) ».</p>

    <div class="ou"><span>ou</span></div>

    <label for="colle">Coller le tableau</label>
    <textarea id="colle" name="colle" rows="5"
      placeholder="Matricule&#9;Nom&#9;Prénoms&#9;Sexe&#9;Né(e) le&#9;Téléphone tuteur"></textarea>
    <p class="hint">Sélectionnez les cellules dans Excel, copiez, collez ici.</p>

    <div style="max-width:320px;margin-top:18px">
      <label for="classe">Classe par défaut</label>
      <select id="classe" name="classe">
        <option value="">— aucune, à répartir ensuite —</option>
        ${classes.map((k) => `<option value="${k.id}">${esc(k.label)}</option>`).join("")}
      </select>
      <p class="hint">Pour les élèves dont la classe n'est pas indiquée dans le
      fichier, ou ne correspond à aucune classe ouverte.</p>
    </div>

    <div class="row" style="margin-top:18px">
      <button type="submit" class="btn">Lire la liste</button>
    </div>
  </form>
</div>

<div class="card">
  <header><b>Ce que le fichier peut contenir</b></header>
  <div class="body" style="font-size:13.5px;line-height:1.6">
    <p style="margin:0 0 10px">Les intitulés de colonnes sont reconnus tels que
    vous les écrivez : <code>Nom</code>, <code>NOM</code>,
    <code>Nom de famille</code>, <code>Prénom(s)</code>, <code>Sexe</code>,
    <code>Né(e) le</code>, <code>Matricule</code>, <code>Classe</code>,
    <code>Nom du tuteur</code>, <code>Téléphone</code>,
    <code>Redoublant</code>.</p>
    <p style="margin:0 0 10px">Une colonne unique <code>Nom et prénoms</code>
    convient aussi : le nom de famille écrit en capitales est reconnu comme tel.</p>
    <p style="margin:0;color:var(--muted)">Les dates s'écrivent jour d'abord —
    <code>12/03/2014</code> est le 12 mars. Les numéros s'écrivent comme vous
    voulez, <code>70 12 34 56</code> ou <code>+226 70123456</code> : ils seront
    ramenés à huit chiffres.</p>
  </div>
</div>`;

  return page(chrome, "Inscrire des élèves", body);
}

// ---------------------------------------------------------------------------
// Écran 2 : aperçu ligne par ligne
// ---------------------------------------------------------------------------

export interface Existing { studentId: string; matricule: string; classe: string | null }

/** Élèves déjà en base, indexés par matricule et par identité. */
export async function loadExisting(schoolId: string, yearId: string) {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select st.id, st.matricule, st.last_name, st.first_names, st.date_of_birth,
              cl.label as classe
         from students st
         left join enrolments e on e.student_id = st.id and e.academic_year_id = $1
         left join classes cl on cl.id = e.class_id`, [yearId]);
    const byMatricule = new Map<string, Existing>();
    const byIdentity = new Map<string, Existing>();
    // Tous les élèves qui portent le même nom : indispensable pour les fiches
    // sans date de naissance, fréquentes quand l'extrait d'acte manque.
    const byName = new Map<string, Existing[]>();
    for (const x of r.rows) {
      const dob = x.date_of_birth
        ? new Date(x.date_of_birth).toISOString().slice(0, 10) : "";
      const e: Existing = { studentId: x.id, matricule: x.matricule, classe: x.classe };
      byMatricule.set(String(x.matricule).toUpperCase(), e);
      byIdentity.set(
        identityKey({ lastName: x.last_name, firstNames: x.first_names, dateOfBirth: dob } as RosterRow),
        e);
      const nk = nameKey(x.last_name, x.first_names);
      byName.set(nk, [...(byName.get(nk) ?? []), e]);
    }
    return { byMatricule, byIdentity, byName };
  });
}

export interface ExistingIndex {
  byMatricule: Map<string, Existing>;
  byIdentity: Map<string, Existing>;
  byName: Map<string, Existing[]>;
}

/** Clé de nom, insensible à la casse et aux accents. */
export const nameKey = (last: string, first: string): string =>
  last.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
  + "|" + first.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Retrouve l'élève déjà en base — ou dit franchement qu'il ne peut pas.
 *
 * Trois niveaux, du plus sûr au moins sûr :
 *   1. le matricule, s'il est donné ;
 *   2. le nom ET la date de naissance ;
 *   3. le nom seul, mais UNIQUEMENT si la ligne n'a pas de date de naissance
 *      et qu'un seul élève en base porte ce nom.
 *
 * Deux homonymes sans date, c'est « ambigu », pas « nouveau ». Créer une
 * deuxième fiche pour le même enfant fausse le bulletin de juin ; rattacher
 * la ligne au mauvais enfant est pire. Dans ce cas on demande la date.
 */
export function matchExisting(r: RosterRow, idx: ExistingIndex): Existing | "ambigu" | null {
  if (r.matricule) {
    const m = idx.byMatricule.get(r.matricule.toUpperCase());
    if (m) return m;
  }
  const exact = idx.byIdentity.get(identityKey(r));
  if (exact) return exact;

  if (!r.dateOfBirth && r.lastName) {
    const homonymes = idx.byName.get(nameKey(r.lastName, r.firstNames)) ?? [];
    if (homonymes.length === 1) return homonymes[0]!;
    if (homonymes.length > 1) return "ambigu";
  }
  return null;
}

function previewRow(i: number, r: RosterRow, existing: Existing | "ambigu" | null): string {
  const flagged = r.problems.length > 0 || r.warnings.length > 0;
  const t = (name: string, value: string, width: string) =>
    `<input type="text" name="c${i}_${name}" value="${esc(value)}"` +
    ` style="height:34px;width:${width};display:inline-block">`;

  // Le statut tient dans une pastille ; les observations sont des phrases et
  // se lisent comme telles — en capitales et sur une seule ligne, elles sont
  // illisibles et se font tronquer.
  const statut = existing === "ambigu"
    ? `<span class="pill p-bad">homonyme</span>`
    : existing
      ? `<span class="pill p-info">réinscription${
          existing.classe ? ` · ${esc(existing.classe)}` : ""}</span>`
      : "";
  const dits = [
    ...r.problems.map((p) => `<span class="dit bad">${esc(p)}</span>`),
    ...r.warnings.map((w) => `<span class="dit warn">${esc(w)}</span>`),
  ].join("");
  const notes = statut + (statut && dits ? "<br>" : "") + dits;

  if (!flagged) {
    return `<tr>
      <td class="num" style="color:var(--faint)">${r.line}</td>
      <td><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}</td>
      <td>${r.sex ?? "—"}</td>
      <td class="num">${r.dateOfBirth ? jour(r.dateOfBirth) : "—"}</td>
      <td>${esc(r.className ?? "—")}</td>
      <td>${esc(r.guardianName ?? "")}${r.guardianPhone
        ? ` <span class="num" style="color:var(--muted)">${esc(r.guardianPhone)}</span>` : ""}</td>
      <td>${notes}</td>
    </tr>`;
  }

  return `<tr class="${r.problems.length ? "bad" : "warn"}">
    <td class="num" style="color:var(--faint)">${r.line}</td>
    <td style="white-space:nowrap">${t("lastName", r.lastName, "120px")}
      ${t("firstNames", r.firstNames, "120px")}</td>
    <td>${t("sex", r.sex ?? "", "44px")}</td>
    <td>${t("dateOfBirth", r.dateOfBirth ? jour(r.dateOfBirth) : "", "108px")}</td>
    <td>${esc(r.className ?? "—")}</td>
    <td style="white-space:nowrap">${t("guardianName", r.guardianName ?? "", "108px")}
      ${t("guardianPhone", r.guardianPhone ?? "", "94px")}</td>
    <td>${notes}
      <label style="margin:6px 0 0;text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--muted)">
        <input type="checkbox" name="c${i}_ignorer" value="1" style="width:auto;height:auto">
        écarter cette ligne</label></td>
  </tr>`;
}

export async function previewPage(
  user: SessionUser, chrome: PageChrome, reading: RosterReading, defaultClass: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const { year, classes } = await withSchool(schoolId, async (c) => {
    const y = await currentYear(c);
    return { year: y, classes: y ? await classesOf(c, y.id) : [] };
  });
  if (!year) {
    return page(chrome, "Inscrire", `<div class="note bad">Aucune année scolaire ouverte.</div>`);
  }

  const idx = await loadExisting(schoolId, year.id);
  const rows = reading.rows;
  const matches = rows.map((r) => matchExisting(r, idx));
  // Une ligne ambiguë bloque : c'est la seule façon d'obtenir la date qui
  // manque, et elle vaut mieux qu'une fiche rattachée au mauvais enfant.
  matches.forEach((m, i) => {
    if (m === "ambigu") rows[i]!.problems.push("homonyme en base, date de naissance requise");
  });

  const ok = rows.filter(importable).length;
  const bad = rows.length - ok;
  const again = matches.filter((m, i) => m && m !== "ambigu" && importable(rows[i]!)).length;
  const warned = rows.filter((r) => importable(r) && r.warnings.length > 0).length;

  const known = new Map(classes.map((k) => [classKey(k.label), k]));
  const unknownClasses = [...new Set(
    rows.map((r) => r.className).filter((x): x is string => !!x && !known.has(classKey(x))))];

  const tile = (v: number, k: string, n: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="n">${n}</div></div>`;

  const body = `
<div>
  <h1>Aperçu de la liste</h1>
  <p class="sub">${plural(rows.length, "ligne lue", "lignes lues")} —
  ${esc(reading.encoding)}, séparateur
  « ${esc(reading.delimiter === "\t" ? "tabulation" : reading.delimiter)} ».
  <b>Rien n'est encore enregistré.</b></p>
</div>

<div class="tiles">
  ${tile(ok, "À inscrire", "lignes retenues")}
  ${tile(again, "Réinscriptions", "élèves déjà connus")}
  ${tile(warned, "À vérifier", "importées, mais signalées")}
  ${tile(bad, "Bloquées", "ne seront pas importées")}
</div>

${reading.unmapped.length ? `<div class="note">Colonnes du fichier non
  utilisées : ${reading.unmapped.map((u) => `<code>${esc(u)}</code>`).join(", ")}.</div>` : ""}
${!reading.headerFound ? `<div class="note warn">Aucune ligne d'en-tête reconnue :
  la première ligne a été lue comme un élève. Vérifiez-la avant d'importer.</div>` : ""}
${unknownClasses.length ? `<div class="note warn">Classes citées dans le fichier
  sans correspondance ouverte :
  ${unknownClasses.map((u) => `<code>${esc(u)}</code>`).join(", ")}. Ces élèves
  iront dans la classe par défaut choisie ci-dessous.</div>` : ""}

<form method="post" action="/inscriptions/importer">
  <input type="hidden" name="lignes" value="${esc(encodeRows(rows))}">

  <div class="card">
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Ligne</th><th>Nom et prénoms</th><th>Sexe</th><th>Naissance</th>
          <th>Classe</th><th>Tuteur</th><th style="min-width:280px">Observations</th>
        </tr></thead>
        <tbody>
          ${rows.map((r, i) => previewRow(i, r, matches[i] ?? null)).join("\n")}
        </tbody>
      </table>
    </div>
  </div>

  <div class="card" style="margin-top:18px">
    <div class="body row">
      <div style="width:220px">
        <label for="classe2">Classe par défaut</label>
        <select id="classe2" name="classe">
          <option value="">— aucune —</option>
          ${classes.map((k) => `<option value="${k.id}"${
            k.id === defaultClass ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
        </select>
      </div>
      <div class="grow"></div>
      <a class="btn ghost" href="/inscriptions">Recommencer</a>
      <button type="submit" class="btn"${ok === 0 ? " disabled" : ""}>
        Inscrire ${plural(ok, "élève", "élèves")}</button>
    </div>
  </div>
</form>`;

  return page(chrome, "Aperçu de la liste", body);
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export interface ImportOutcome {
  created: number;
  reenrolled: number;
  guardiansLinked: number;
  skipped: number;
  /** Lignes laissées de côté parce qu'un homonyme existe et que la date manque. */
  ambiguous: number;
}

export async function runImport(
  user: SessionUser, rows: RosterRow[], defaultClass: string,
): Promise<ImportOutcome> {
  const schoolId = user.schoolId!;
  return withSchool(schoolId, async (c) => {
    const year = await currentYear(c);
    if (!year) throw new Error("Aucune année scolaire ouverte.");
    const classes = await classesOf(c, year.id);
    const byKey = new Map(classes.map((k) => [classKey(k.label), k.id]));

    // Rang de départ des matricules attribués : jamais réutilisé.
    const seq = await c.query(
      `select coalesce(max(substring(matricule from '\\d+$')::int), 0) as n
         from students where matricule like $1`, [`${year.startYear}-%`]);
    let rank = Number(seq.rows[0].n);

    const out: ImportOutcome = {
      created: 0, reenrolled: 0, guardiansLinked: 0, skipped: 0, ambiguous: 0,
    };

    for (const r of rows) {
      if (!importable(r)) { out.skipped += 1; continue; }

      const classId = (r.className ? byKey.get(classKey(r.className)) : undefined)
        ?? (defaultClass || null);

      // Un élève déjà connu n'est jamais dupliqué. Même règle que l'aperçu :
      // matricule, puis nom + date de naissance, puis nom seul quand la ligne
      // n'a pas de date — et seulement s'il n'y a qu'un porteur de ce nom.
      let found = r.matricule
        ? await c.query(`select id from students where upper(matricule) = upper($1)`, [r.matricule])
        : { rowCount: 0, rows: [] as any[] };
      if (found.rowCount === 0) {
        found = await c.query(
          `select id from students
            where lower(last_name) = lower($1) and lower(first_names) = lower($2)
              and date_of_birth is not distinct from $3::date`,
          [r.lastName, r.firstNames, r.dateOfBirth]);
      }
      if (found.rowCount === 0 && !r.dateOfBirth) {
        const homonymes = await c.query(
          `select id from students
            where lower(last_name) = lower($1) and lower(first_names) = lower($2)`,
          [r.lastName, r.firstNames]);
        if (homonymes.rowCount! > 1) { out.ambiguous += 1; continue; }
        if (homonymes.rowCount === 1) found = homonymes;
      }

      let studentId: string;
      const isKnown = found.rowCount! > 0;
      if (isKnown) {
        studentId = found.rows[0].id;
        // On complète ce qui manque ; on n'écrase pas ce qui existe. La fiche
        // en base a pu être corrigée à la main depuis.
        await c.query(
          `update students set
             sex = coalesce(sex, $2),
             date_of_birth = coalesce(date_of_birth, $3::date),
             place_of_birth = coalesce(place_of_birth, $4)
           where id = $1`,
          [studentId, r.sex, r.dateOfBirth, r.placeOfBirth]);
      } else {
        rank += 1;
        const matricule = r.matricule ?? makeMatricule(year.startYear, rank);
        const ins = await c.query(
          `insert into students
             (school_id, matricule, last_name, first_names, sex, date_of_birth, place_of_birth)
           values (current_school_id(), $1, $2, $3, $4, $5::date, $6)
           returning id`,
          [matricule, r.lastName, r.firstNames, r.sex, r.dateOfBirth, r.placeOfBirth]);
        studentId = ins.rows[0].id;
      }

      await c.query(
        `insert into enrolments
           (school_id, student_id, academic_year_id, class_id, status, is_redoublant)
         values (current_school_id(), $1, $2, $3, $4, $5)
         on conflict (student_id, academic_year_id) do update
           set class_id = coalesce(excluded.class_id, enrolments.class_id),
               is_redoublant = excluded.is_redoublant,
               -- Un transfert ou une exclusion décidés à la main ne sont pas
               -- effacés par un réimport de la liste.
               status = case when enrolments.status in ('inscrit', 'reinscrit')
                             then excluded.status else enrolments.status end`,
        [studentId, year.id, classId, isKnown ? "reinscrit" : "inscrit", r.isRedoublant]);

      if (isKnown) out.reenrolled += 1; else out.created += 1;

      if (r.guardianPhone) {
        const g = await c.query(
          `select id from guardians where phone = $1 limit 1`, [r.guardianPhone]);
        const guardianId = g.rowCount! > 0
          ? g.rows[0].id
          : (await c.query(
              `insert into guardians (school_id, full_name, phone)
               values (current_school_id(), $1, $2) returning id`,
              [r.guardianName ?? `Tuteur de ${r.lastName}`, r.guardianPhone])).rows[0].id;

        const link = await c.query(
          `insert into student_guardians
             (student_id, guardian_id, school_id, is_primary, receives_sms)
           values ($1, $2, current_school_id(), true, true)
           on conflict (student_id, guardian_id) do nothing
           returning student_id`,
          [studentId, guardianId]);
        if (link.rowCount! > 0) out.guardiansLinked += 1;
      }
    }

    return out;
  });
}

export function resultPage(chrome: PageChrome, out: ImportOutcome): string {
  const total = out.created + out.reenrolled;
  const sansTuteur = total - out.guardiansLinked;
  const tile = (v: number, k: string, n: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="n">${n}</div></div>`;

  const body = `
<div>
  <h1>Inscription terminée</h1>
  <p class="sub">${plural(total, "élève est inscrit", "élèves sont inscrits")}
  pour l'année en cours.</p>
</div>

<div class="tiles">
  ${tile(out.created, "Nouveaux", "élèves créés")}
  ${tile(out.reenrolled, "Réinscriptions", "élèves déjà connus")}
  ${tile(out.guardiansLinked, "Tuteurs", "numéros rattachés")}
  ${tile(out.skipped, "Écartées", "lignes non importées")}
</div>

${out.ambiguous > 0 ? `<div class="note bad">
  ${plural(out.ambiguous, "ligne porte un nom déjà présent", "lignes portent un nom déjà présent")}
  en base sans date de naissance pour les départager.
  ${plural(out.ambiguous, "Elle n'a pas été importée", "Elles n'ont pas été importées")} :
  ajoutez la date de naissance et recommencez. Rattacher un enfant à la fiche
  d'un homonyme serait pire qu'un import incomplet.</div>` : ""}

${sansTuteur > 0 ? `<div class="note warn">
  ${plural(sansTuteur, "élève n'a pas de numéro de tuteur", "élèves n'ont pas de numéro de tuteur")}.
  ${plural(sansTuteur, "Sa famille ne recevra", "Leurs familles ne recevront")}
  aucun SMS le jour d'une absence tant que le numéro manque.</div>` : ""}

<div class="row">
  <a class="btn ghost" href="/inscriptions">Importer une autre liste</a>
  <a class="btn" href="/scolarite">Voir la scolarité</a>
</div>`;
  return page(chrome, "Inscription terminée", body);
}

// ---------------------------------------------------------------------------
// Lecture d'un envoi
// ---------------------------------------------------------------------------

/** Fichier déposé ou tableau collé — le premier des deux qui porte du texte. */
export function readSubmitted(
  file: Buffer | undefined, pasted: string, today = new Date(),
): RosterReading | null {
  if (file && file.length > 0) return readRoster(new Uint8Array(file), today);
  if (pasted.trim() !== "") return readRosterText(pasted, "texte collé", today);
  return null;
}
