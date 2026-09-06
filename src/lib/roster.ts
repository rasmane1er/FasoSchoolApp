/**
 * Lecture d'une liste d'élèves telle qu'un établissement la possède
 * réellement : un fichier Excel exporté en CSV, ou un tableau collé.
 *
 * Ce module ne touche ni à la base ni au réseau. Il transforme des octets en
 * lignes vérifiées, avec un problème nommé par ligne fautive. Il n'invente
 * rien : une donnée douteuse est signalée, jamais devinée en silence.
 *
 * Les pièges traités ici sont ceux du terrain, pas ceux d'un manuel :
 *
 *   - Excel francophone sous Windows exporte en **Windows-1252 avec des
 *     points-virgules**. Lu en UTF-8, « Alizèta » devient « AlizÃ¨ta ». Une
 *     école qui voit ses élèves ainsi ferme le logiciel et n'y revient pas.
 *   - « 12/03/2014 » est le 12 mars. Jamais le 3 décembre.
 *   - « 70 12 34 56 », « +226 70123456 », « 00226-70-12-34-56 » sont le même
 *     numéro.
 *   - Beaucoup de listes n'ont qu'une colonne « Nom et prénoms », avec le nom
 *     de famille en capitales : « BAMBARA Alizèta ».
 */

// ---------------------------------------------------------------------------
// Octets → texte
// ---------------------------------------------------------------------------

/** Décode en UTF-8 si c'en est, sinon en Windows-1252. */
export function decodeBytes(bytes: Uint8Array): { text: string; encoding: string } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8 (BOM)" };
  }
  try {
    const strict = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: strict, encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** Le séparateur le plus fréquent hors guillemets sur la première ligne. */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ";", bestCount = -1;
  for (const d of [";", ",", "\t", "|"]) {
    let n = 0, quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) n += 1;
    }
    if (n > bestCount) { best = d; bestCount = n; }
  }
  return best;
}

/** Découpage CSV avec guillemets (RFC 4180), sauts de ligne inclus. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  row.push(field);
  rows.push(row);

  // Les tableaux collés depuis Excel finissent par une ligne vide.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// ---------------------------------------------------------------------------
// Reconnaissance des colonnes
// ---------------------------------------------------------------------------

/**
 * Minuscules, sans accents, sans ponctuation : « Prénom(s) » → « prenom ».
 *
 * Les parenthèses partent AVANT le reste. Sans cela « Prénom(s) » devient
 * « prenom s », et ce « s » isolé se met à ressembler à un intitulé de
 * colonne à lui tout seul.
 */
export function normalizeHeader(s: string): string {
  return s
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type Column =
  | "matricule" | "last_name" | "first_names" | "full_name"
  | "sex" | "date_of_birth" | "place_of_birth"
  | "guardian_name" | "guardian_phone" | "class" | "redoublant";

/* Les intitulés réellement rencontrés dans les listes d'établissements.
   L'ordre compte : le premier motif qui correspond gagne, donc les intitulés
   composés viennent avant les simples (« nom du tuteur » avant « nom »). */
const HEADER_PATTERNS: Array<[Column, RegExp]> = [
  ["guardian_phone", /\b(tel|telephone|contact|numero|portable|cellulaire|whatsapp)\b/],
  ["guardian_name", /\b(tuteur|tutrice|parent|pere|mere|responsable|garant)\b/],
  ["matricule", /\b(matricule|mle|immatriculation|identifiant|code eleve|n eleve)\b/],
  ["full_name", /\b(noms? et (les )?prenoms?|noms? prenoms?|nom complet|identite)\b/],
  ["last_name", /\b(nom de famille|nom de l eleve|nom)\b/],
  ["first_names", /\b(prenom|prenoms)\b/],
  // Pas de « s » seul ici : il attraperait n’importe quel intitulé abrégé.
  ["sex", /\b(sexe|genre|m f|f m|g f|garcon fille)\b/],
  ["date_of_birth", /\b(date de naissance|ne e le|nee le|ne le|naissance|dn)\b/],
  ["place_of_birth", /\b(lieu de naissance|lieu|ville de naissance)\b/],
  ["class", /\b(classe|niveau|salle)\b/],
  ["redoublant", /\b(redoublant|redouble|red)\b/],
];

export function mapHeaders(header: string[]): Partial<Record<Column, number>> {
  const out: Partial<Record<Column, number>> = {};
  header.forEach((raw, i) => {
    const h = normalizeHeader(raw);
    if (!h) return;
    for (const [col, re] of HEADER_PATTERNS) {
      if (out[col] !== undefined) continue;
      if (re.test(h)) { out[col] = i; return; }
    }
  });
  return out;
}

/** Une ligne d'en-tête ressemble-t-elle à un en-tête, ou à un premier élève ? */
export function looksLikeHeader(row: string[]): boolean {
  const mapped = mapHeaders(row);
  const named = Object.keys(mapped).length;
  const hasDigitsOnly = row.some((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c.trim()));
  return named >= 2 && !hasDigitsOnly;
}

// ---------------------------------------------------------------------------
// Normalisation des champs
// ---------------------------------------------------------------------------

/** Espaces multiples réduits, espaces insécables ramenés à l'espace. */
export const tidy = (s: string): string =>
  s.replace(/[  ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Sépare « BAMBARA Alizèta » en nom / prénoms.
 *
 * Convention burkinabè : le nom de famille vient en premier, souvent en
 * capitales. Sans capitales, on prend le premier mot — et on le signale,
 * parce qu'une supposition silencieuse sur le nom d'un enfant n'est pas
 * acceptable.
 */
export function splitFullName(full: string): { last: string; first: string; guessed: boolean } {
  const parts = tidy(full).split(" ").filter(Boolean);
  if (parts.length === 0) return { last: "", first: "", guessed: false };
  if (parts.length === 1) return { last: parts[0]!, first: "", guessed: false };

  const isCaps = (w: string) => w.length > 1 && w === w.toLocaleUpperCase("fr") &&
    /\p{Lu}/u.test(w);

  let n = 0;
  while (n < parts.length && isCaps(parts[n]!)) n += 1;

  if (n > 0 && n < parts.length) {
    return { last: parts.slice(0, n).join(" "), first: parts.slice(n).join(" "), guessed: false };
  }
  // Tout en capitales, ou rien : on retombe sur la convention, en le disant.
  return { last: parts[0]!, first: parts.slice(1).join(" "), guessed: true };
}

export function normalizeSex(raw: string): "M" | "F" | null {
  const v = normalizeHeader(raw);
  if (!v) return null;
  if (/^(m|masculin|garcon|g|h|homme|male|1)$/.test(v)) return "M";
  if (/^(f|feminin|fille|femme|female|2)$/.test(v)) return "F";
  return null;
}

/**
 * Un numéro burkinabè, ramené à ses huit chiffres.
 * Accepte +226, 00226, 226 en tête, et n'importe quelle ponctuation.
 */
export function normalizePhone(raw: string): { phone: string | null; problem?: string } {
  const t = tidy(raw);
  if (!t) return { phone: null };
  let d = t.replace(/[^\d]/g, "");
  if (d.startsWith("00226")) d = d.slice(5);
  else if (d.startsWith("226") && d.length === 11) d = d.slice(3);
  if (d.length !== 8) return { phone: null, problem: `numéro « ${t} » : ${d.length} chiffres au lieu de 8` };
  if (!/^[025679]/.test(d)) return { phone: null, problem: `numéro « ${t} » : préfixe inhabituel` };
  return { phone: d };
}

const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

/**
 * Une date de naissance. Le jour vient toujours en premier : « 12/03/2014 »
 * est le 12 mars, jamais le 3 décembre. Renvoie une date ISO.
 */
export function normalizeDate(raw: string, today = new Date()): { date: string | null; problem?: string } {
  const t = tidy(raw);
  if (!t) return { date: null };

  let y = 0, m = 0, d = 0;

  const iso = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const dmy = t.match(/^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})$/);
  const txt = t.match(/^(\d{1,2})\s+([a-zA-Zéèûôç]+)\s+(\d{4})$/);

  if (iso) { y = +iso[1]!; m = +iso[2]!; d = +iso[3]!; }
  else if (dmy) {
    d = +dmy[1]!; m = +dmy[2]!; y = +dmy[3]!;
    if (dmy[3]!.length === 2) y = y > 30 ? 1900 + y : 2000 + y;
  } else if (txt) {
    d = +txt[1]!; y = +txt[3]!;
    m = MONTHS[normalizeHeader(txt[2]!)] ?? 0;
    if (!m) return { date: null, problem: `date « ${t} » : mois non reconnu` };
  } else {
    return { date: null, problem: `date « ${t} » illisible` };
  }

  if (m < 1 || m > 12) return { date: null, problem: `date « ${t} » : mois ${m}` };
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > last) return { date: null, problem: `date « ${t} » : jour ${d} impossible` };

  const iso8601 = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const age = (today.getTime() - Date.UTC(y, m - 1, d)) / (365.2425 * 86400e3);
  if (age < 2 || age > 30) {
    return { date: iso8601, problem: `date « ${t} » : âge ${Math.floor(age)} ans, à vérifier` };
  }
  return { date: iso8601 };
}

// ---------------------------------------------------------------------------
// Une liste entière
// ---------------------------------------------------------------------------

export interface RosterRow {
  line: number;                 // numéro de ligne dans le fichier, 1 = en-tête
  matricule: string | null;
  lastName: string;
  firstNames: string;
  sex: "M" | "F" | null;
  dateOfBirth: string | null;
  placeOfBirth: string | null;
  className: string | null;
  isRedoublant: boolean;
  guardianName: string | null;
  guardianPhone: string | null;
  problems: string[];           // bloquant : la ligne ne sera pas importée
  warnings: string[];           // importable, mais à regarder
}

export interface RosterReading {
  encoding: string;
  delimiter: string;
  headerFound: boolean;
  columns: Partial<Record<Column, number>>;
  unmapped: string[];
  rows: RosterRow[];
}

const TRUE_WORDS = /^(oui|o|yes|y|1|x|vrai|true|r|red|redoublant|redoublante)$/;

export function readRoster(bytes: Uint8Array, today = new Date()): RosterReading {
  const { text, encoding } = decodeBytes(bytes);
  return readRosterText(text, encoding, today);
}

export function readRosterText(text: string, encoding = "utf-8", today = new Date()): RosterReading {
  const delimiter = sniffDelimiter(text);
  const table = parseDelimited(text, delimiter);
  if (table.length === 0) {
    return { encoding, delimiter, headerFound: false, columns: {}, unmapped: [], rows: [] };
  }

  const headerFound = looksLikeHeader(table[0]!);
  const header = headerFound ? table[0]! : [];
  const columns = headerFound ? mapHeaders(header) : {};
  const used = new Set(Object.values(columns));
  const unmapped = header
    .map((h, i) => (used.has(i) || !tidy(h) ? null : tidy(h)))
    .filter((h): h is string => h !== null);

  const body = headerFound ? table.slice(1) : table;
  const offset = headerFound ? 2 : 1;

  const rows: RosterRow[] = body.map((cells, idx) => {
    const at = (c: Column): string => {
      const i = columns[c];
      return i === undefined ? "" : tidy(cells[i] ?? "");
    };

    const problems: string[] = [];
    const warnings: string[] = [];

    let lastName = at("last_name");
    let firstNames = at("first_names");
    if (!lastName && !firstNames) {
      const combined = at("full_name") || (headerFound ? "" : tidy(cells[0] ?? ""));
      if (combined) {
        const s = splitFullName(combined);
        lastName = s.last;
        firstNames = s.first;
        if (s.guessed) warnings.push("nom et prénoms séparés d'après l'ordre habituel — à vérifier");
      }
    }
    if (!lastName) problems.push("aucun nom");

    const sexRaw = at("sex");
    const sex = normalizeSex(sexRaw);
    if (sexRaw && !sex) warnings.push(`sexe « ${sexRaw} » non reconnu`);

    const dob = normalizeDate(at("date_of_birth"), today);
    if (dob.problem) warnings.push(dob.problem);

    const g = normalizePhone(at("guardian_phone"));
    if (g.problem) warnings.push(g.problem);

    const guardianName = at("guardian_name") || null;
    if (g.phone && !guardianName) warnings.push("numéro sans nom de tuteur");

    return {
      line: idx + offset,
      matricule: at("matricule") || null,
      lastName,
      firstNames,
      sex,
      dateOfBirth: dob.date,
      placeOfBirth: at("place_of_birth") || null,
      className: at("class") || null,
      isRedoublant: TRUE_WORDS.test(normalizeHeader(at("redoublant"))),
      guardianName,
      guardianPhone: g.phone,
      problems,
      warnings,
    };
  });

  markDuplicates(rows);
  return { encoding, delimiter, headerFound, columns, unmapped, rows };
}

/** Clé d'identité d'un élève à l'intérieur d'un même fichier. */
export const identityKey = (r: RosterRow): string =>
  normalizeHeader(`${r.lastName} ${r.firstNames}`) + "|" + (r.dateOfBirth ?? "");

/** Signale les doublons internes au fichier : ils bloquent, ils ne s'importent pas. */
export function markDuplicates(rows: RosterRow[]): void {
  const byMatricule = new Map<string, number>();
  const byIdentity = new Map<string, number>();

  for (const r of rows) {
    if (r.matricule) {
      const k = r.matricule.toUpperCase();
      const first = byMatricule.get(k);
      if (first !== undefined) r.problems.push(`matricule ${r.matricule} déjà en ligne ${first}`);
      else byMatricule.set(k, r.line);
    }
    if (r.lastName) {
      const k = identityKey(r);
      const first = byIdentity.get(k);
      if (first !== undefined) r.problems.push(`même nom et même date qu'en ligne ${first}`);
      else byIdentity.set(k, r.line);
    }
  }
}

/**
 * Matricule attribué quand la liste n'en porte pas.
 * Année de rentrée + rang, sur quatre chiffres : 2026-0031.
 */
export const makeMatricule = (year: number, rank: number): string =>
  `${year}-${String(rank).padStart(4, "0")}`;

export const importable = (r: RosterRow): boolean => r.problems.length === 0;
