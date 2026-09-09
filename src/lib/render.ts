/**
 * Rendu du bulletin en HTML imprimable (A4 portrait).
 *
 * HTML plutôt qu'une bibliothèque PDF : le gabarit doit être corrigé devant
 * un censeur qui regarde par-dessus l'épaule, et CSS print est le moyen le
 * plus rapide d'itérer. L'impression navigateur produit le PDF.
 *
 * La mise en page est PROVISOIRE. Aucun modèle officiel MENAPLN n'est publié
 * et aucun bulletin burkinabè scanné n'a pu être trouvé. À remplacer par le
 * gabarit réel d'un établissement dès qu'on en tient un.
 */

import type { StudentResult, ClassResult } from "./bulletin.ts";
import type { BulletinInputs, StudentRow, SubjectRow } from "./repository.ts";

/** Les décisions du conseil, en toutes lettres. Le code brut (`admis_par_
 *  compensation`) n'a rien à faire sur un document remis à une famille. */
const DECISIONS: Record<string, string> = {
  admis: "Admis(e) en classe supérieure",
  admis_par_compensation: "Admis(e) par compensation",
  redouble: "Redouble la classe",
  exclu: "Exclu(e) de l'établissement",
  reoriente: "Réorienté(e)",
};

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

/** 13.63 -> "13,63" ; null -> "—" */
const fr = (n: number | null, decimals = 2): string =>
  n === null ? "—" : n.toFixed(decimals).replace(".", ",");

const ordinal = (n: number | null): string =>
  n === null ? "—" : n === 1 ? "1<sup>er</sup>" : `${n}<sup>e</sup>`;

const PAGE_CSS = `
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "IBM Plex Sans", "Helvetica Neue", Arial, sans-serif;
         color: #14161F; background: #EDEBE6; }
  .sheet { width: 210mm; min-height: 297mm; padding: 11mm 12.7mm; margin: 8mm auto;
           background: #FFFFFF; display: flex; flex-direction: column;
           box-shadow: 0 1px 4px rgba(0,0,0,.14); }
  .num { font-family: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
         font-variant-numeric: tabular-nums; }
  .grid { display: grid; grid-template-columns: 1.75fr .62fr .44fr .7fr .72fr .5fr 1.5fr; }
  .head { padding: 7px 9px; font-size: 8.5pt; letter-spacing: .05em; text-transform: uppercase;
          color: #4E5265; border-bottom: 1.5px solid #14161F; font-weight: 500; }
  .cell { padding: 6.5px 9px; border-bottom: 1px solid #DCD8CF; font-size: 9.5pt; }
  .tot  { padding: 8px 9px; border-top: 1.5px solid #14161F; font-size: 9.5pt; font-weight: 600; }
  .box  { border: 1px solid #DCD8CF; padding: 9px 11px; }
  .r    { text-align: right; }
  @media print {
    body { background: #FFFFFF; }
    .sheet { margin: 0; box-shadow: none; page-break-after: always; }
    .sheet:last-child { page-break-after: auto; }
  }
`;

function sheet(
  inputs: BulletinInputs,
  student: StudentRow,
  result: StudentResult,
  klass: ClassResult,
  subjectById: Map<string, SubjectRow>,
): string {
  const ctx = inputs.context;
  const a = inputs.absences.get(student.id) ?? { justified: 0, unjustified: 0, late: 0 };
  const conseil = inputs.conseil.get(student.id);

  const rows = result.subjects.map((s) => {
    const sub = subjectById.get(s.subjectId);
    const classAvg = klass.moyenneParMatiere.get(s.subjectId) ?? null;
    return `
      <div class="cell" style="font-weight:500">${esc(sub?.label ?? "—")}</div>
      <div class="cell num r" style="font-weight:600">${fr(s.moyenne)}</div>
      <div class="cell num r">${fr(s.coefficient, 0)}</div>
      <div class="cell num r">${fr(s.points)}</div>
      <div class="cell num r" style="color:#4E5265">${fr(classAvg)}</div>
      <div class="cell num r" style="color:#4E5265">${s.rangMatiere === null ? "—" : ordinal(s.rangMatiere)}</div>
      <div class="cell" style="color:#4E5265"></div>`;
  }).join("");

  return `
  <section class="sheet">

    <div style="display:flex;justify-content:space-between;align-items:flex-start;
                padding-bottom:9px;border-bottom:2px solid #14161F">
      <div style="line-height:1.45">
        <div style="font-size:8.5pt;font-weight:600;letter-spacing:.03em">BURKINA FASO</div>
        <div style="font-size:7.5pt;font-style:italic;color:#4E5265">Unité — Progrès — Justice</div>
      </div>
      <div style="text-align:center">
        <div style="font-size:16pt;font-weight:700;letter-spacing:-.01em">BULLETIN DE NOTES</div>
        <div style="font-size:9pt;color:#4E5265;margin-top:2px">
          Trimestre ${ctx.termSequence} — Année scolaire ${esc(ctx.academicYearLabel)}
        </div>
      </div>
      <div style="text-align:right;line-height:1.45">
        <div style="font-size:8.5pt;font-weight:600">${esc(ctx.schoolName.toUpperCase())}</div>
        <div style="font-size:7.5pt;color:#4E5265">${esc(ctx.schoolCommune ?? "")}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px 16px;
                padding:10px 0 11px;border-bottom:1px solid #DCD8CF">
      <div style="grid-column:span 2">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Nom et prénoms</div>
        <div style="font-size:11.5pt;font-weight:600;margin-top:1px">${esc(student.lastName)} ${esc(student.firstNames)}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Matricule</div>
        <div class="num" style="font-size:10pt;margin-top:1px">${esc(student.matricule)}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Classe</div>
        <div style="font-size:10pt;font-weight:600;margin-top:1px">${esc(ctx.className)} — effectif ${ctx.effectif}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Né(e) le</div>
        <div class="num" style="font-size:9.5pt;margin-top:1px">${esc(student.dateOfBirth ?? "—")}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">à</div>
        <div style="font-size:9.5pt;margin-top:1px">${esc(student.placeOfBirth ?? "—")}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Sexe</div>
        <div style="font-size:9.5pt;margin-top:1px">${esc(student.sex ?? "—")}</div>
      </div>
      <div>
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Statut</div>
        <div style="font-size:9.5pt;margin-top:1px">${student.isRedoublant ? "Redoublant(e)" : "Non redoublant(e)"}</div>
      </div>
    </div>

    <div class="grid" style="margin-top:12px">
      <div class="head">Discipline</div>
      <div class="head r">Moy. /20</div>
      <div class="head r">Coef.</div>
      <div class="head r">Moy.×Coef</div>
      <div class="head r">Moy. classe</div>
      <div class="head r">Rang</div>
      <div class="head">Appréciation</div>
      ${rows}
      <div class="tot">Totaux</div>
      <div class="tot"></div>
      <div class="tot num r">${fr(result.totalCoefficients, 0)}</div>
      <div class="tot num r">${fr(result.totalPoints)}</div>
      <div class="tot"></div>
      <div class="tot"></div>
      <div class="tot"></div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-top:13px">
      <div style="border:1.5px solid #14161F;padding:9px 11px">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Moyenne générale</div>
        <div class="num" style="font-size:19pt;font-weight:600;line-height:1.15;margin-top:2px">${fr(result.moyenneGenerale)}<span style="font-size:10pt;color:#6B6F80">/20</span></div>
      </div>
      <div class="box">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Rang</div>
        <div class="num" style="font-size:19pt;font-weight:600;line-height:1.15;margin-top:2px">${ordinal(result.rang)}<span style="font-size:10pt;color:#6B6F80"> / ${result.effectif}</span></div>
      </div>
      <div class="box">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Moyenne de la classe</div>
        <div class="num" style="font-size:19pt;font-weight:600;line-height:1.15;margin-top:2px">${fr(klass.moyenneDeClasse)}</div>
      </div>
      <div class="box">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80">Mention</div>
        <div style="font-size:14pt;font-weight:600;line-height:1.3;margin-top:4px">${esc(result.mention ?? "—")}</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:.85fr 1.6fr;gap:11px;margin-top:11px">
      <div class="box">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80;margin-bottom:6px">Assiduité</div>
        <div style="display:flex;flex-direction:column;gap:4px;font-size:9pt">
          <div style="display:flex;justify-content:space-between"><span>Absences justifiées</span><span class="num" style="font-weight:600">${a.justified}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Absences non justifiées</span><span class="num" style="font-weight:600">${a.unjustified}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Retards</span><span class="num" style="font-weight:600">${a.late}</span></div>
        </div>
      </div>
      <div class="box">
        <div style="font-size:7pt;letter-spacing:.06em;text-transform:uppercase;color:#6B6F80;margin-bottom:6px">Appréciation du conseil de classe</div>
        ${conseil?.appreciation
          ? `<div style="font-size:9pt;line-height:1.45;min-height:34px">${esc(conseil.appreciation)}</div>`
          : `<div style="height:34px;border-bottom:1px dotted #C9C4B9"></div>
             <div style="height:22px;border-bottom:1px dotted #C9C4B9;margin-top:6px"></div>`}
        ${conseil?.decision
          ? `<div style="margin-top:7px;padding-top:6px;border-top:1px solid #DCD8CF;font-size:8.5pt">
               <span style="color:#6B6F80">Décision du conseil : </span>
               <b>${esc(DECISIONS[conseil.decision] ?? conseil.decision)}</b></div>`
          : ""}
      </div>
    </div>

    <div style="margin-top:auto;padding-top:16px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px">
      <div style="border-top:1px solid #14161F;padding-top:5px;font-size:8pt;color:#4E5265">Le professeur principal${
        inputs.professeurPrincipal
          ? `<div style="color:#14161F;font-weight:600;margin-top:2px">${esc(inputs.professeurPrincipal)}</div>`
          : ""}</div>
      <div style="border-top:1px solid #14161F;padding-top:5px;font-size:8pt;color:#4E5265">Le parent ou tuteur</div>
      <div style="border-top:1px solid #14161F;padding-top:5px;font-size:8pt;color:#4E5265">Le Directeur</div>
    </div>

    <div style="margin-top:9px;display:flex;justify-content:space-between;font-size:7pt;color:#8A8E9C">
      <span>Édité le ${new Date().toLocaleDateString("fr-FR")} — ${esc(ctx.schoolName)}</span>
      <span class="num">${esc(inputs.sourceNotes.coefficients ? "barème à confirmer" : "")}</span>
    </div>

  </section>`;
}

/** Un document imprimable contenant tous les bulletins de la classe. */
export function renderClassBulletins(
  inputs: BulletinInputs,
  klass: ClassResult,
): string {
  const subjectById = new Map(inputs.subjects.map((s) => [s.id, s]));
  const studentById = new Map(inputs.students.map((s) => [s.id, s]));

  const sheets = klass.students
    .map((r) => {
      const st = studentById.get(r.studentId);
      return st ? sheet(inputs, st, r, klass, subjectById) : "";
    })
    .join("\n");

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Bulletins — ${esc(inputs.context.className)} — Trimestre ${inputs.context.termSequence}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>${PAGE_CSS}</style>
</head>
<body>
${sheets}
</body>
</html>`;
}
