/**
 * Conseil de classe : la délibération de fin d'année.
 *
 * L'écran propose, le conseil dispose. La distinction n'est pas décorative :
 * la composition du conseil et ses seuils de compensation n'ont pas pu être
 * établis depuis un texte burkinabè public. Le logiciel avance donc une
 * proposition motivée, et enregistre la décision que des humains ont prise.
 *
 * Une seule règle est appliquée sans discussion, parce qu'elle est écrite :
 * **le redoublement est interdit en CP1, CE1 et CM1** — première année de
 * chaque sous-cycle du primaire, arrêté de 2019. Dans ces classes l'option
 * « redouble » n'est même pas offerte. La mesure est contestée par le SYNAPEC ;
 * c'est pourquoi elle vit dans `promotion_rules`, avec sa date d'effet, et non
 * dans un `if`.
 *
 * La moyenne annuelle est la moyenne des trimestres saisis. **La pondération
 * des trois trimestres n'a pas été vérifiée** — le troisième est plus court,
 * certains établissements le pondèrent moins. L'écran le dit à chaque fois
 * plutôt que de laisser croire à un calcul officiel.
 */

import { withSchool } from "../lib/db.ts";
import { computeClassBulletins, proposeDecision, round,
  type ConseilDecision } from "../lib/bulletin.ts";
import { loadBulletinInputs } from "../lib/repository.ts";
import { page, esc, fr, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export const DECISIONS: Array<[ConseilDecision | "admis_par_compensation", string]> = [
  ["admis", "Admis en classe supérieure"],
  ["admis_par_compensation", "Admis par compensation"],
  ["redouble", "Redouble"],
  ["reoriente", "Réorienté"],
  ["exclu", "Exclu"],
];

export interface DeliberationRow {
  studentId: string;
  matricule: string;
  lastName: string;
  firstNames: string;
  /** Moyenne générale de chaque trimestre saisi, dans l'ordre. */
  parTrimestre: Array<number | null>;
  moyenneAnnuelle: number | null;
  proposition: ConseilDecision;
  motif: string;
  redoublementAllowed: boolean;
  decision: string | null;
  appreciation: string | null;
}

export interface Deliberation {
  classLabel: string;
  levelCode: string;
  yearId: string;
  yearLabel: string;
  termCount: number;
  /** Nombre de trimestres qui portent effectivement des notes. */
  termsWithData: number;
  rows: DeliberationRow[];
  ruleNote: string | null;
}

/**
 * Moyenne annuelle : moyenne simple des trimestres qui portent une moyenne.
 * Un trimestre non saisi ne compte pas — il ne vaut pas zéro.
 */
export function moyenneAnnuelle(
  parTrimestre: Array<number | null>, decimals: number,
  rounding: "half_up" | "half_even" | "truncate",
): number | null {
  const v = parTrimestre.filter((x): x is number => x !== null);
  if (v.length === 0) return null;
  return round(v.reduce((a, b) => a + b, 0) / v.length, decimals, rounding);
}

export async function loadDeliberation(
  schoolId: string, classId: string,
): Promise<Deliberation | null> {
  const ctx = await withSchool(schoolId, async (c) => {
    const k = await c.query(
      `select cl.label, cl.level_code, cl.academic_year_id, ay.label as year_label
         from classes cl join academic_years ay on ay.id = cl.academic_year_id
        where cl.id = $1`, [classId]);
    if (k.rowCount === 0) return null;
    const terms = await c.query(
      `select id, sequence from terms where academic_year_id = $1 order by sequence`,
      [k.rows[0].academic_year_id]);
    const rule = await c.query(
      `select redoublement_allowed, min_average_to_pass, source_note
         from promotion_rules
        where (level_code = $1 or level_code is null)
        order by level_code nulls last, effective_from desc limit 1`,
      [k.rows[0].level_code]);
    const prior = await c.query(
      `select student_id, decision, appreciation from conseil_decisions
        where academic_year_id = $1`, [k.rows[0].academic_year_id]);
    return {
      label: k.rows[0].label as string,
      levelCode: k.rows[0].level_code as string,
      yearId: k.rows[0].academic_year_id as string,
      yearLabel: k.rows[0].year_label as string,
      termIds: terms.rows.map((t) => t.id as string),
      rule: rule.rows[0] ?? null,
      prior: new Map(prior.rows.map((p) => [p.student_id as string, p])),
    };
  });
  if (!ctx) return null;
  if (ctx.termIds.length === 0) return null;

  // Une passe par trimestre : le moteur de bulletin est déjà la seule
  // autorité sur le calcul d'une moyenne, on ne le réécrit pas ici.
  const parEleve = new Map<string, Array<number | null>>();
  let identites: Array<{ id: string; matricule: string; last: string; first: string }> = [];
  let decimals = 2;
  let rounding: "half_up" | "half_even" | "truncate" = "half_up";

  for (const [i, termId] of ctx.termIds.entries()) {
    const inputs = await loadBulletinInputs(schoolId, classId, termId);
    decimals = inputs.policy.decimals;
    rounding = inputs.policy.rounding;
    if (identites.length === 0) {
      identites = inputs.students.map((s) => ({
        id: s.id, matricule: s.matricule, last: s.lastName, first: s.firstNames,
      }));
    }
    const klass = computeClassBulletins({
      studentIds: inputs.students.map((s) => s.id),
      grades: inputs.grades,
      coefficients: new Map(inputs.subjects.map((s) => [s.id, s.coefficient])),
      policy: inputs.policy,
      mentionBands: inputs.mentionBands,
    });
    for (const st of klass.students) {
      const arr = parEleve.get(st.studentId)
        ?? Array.from({ length: ctx.termIds.length }, () => null);
      arr[i] = st.moyenneGenerale;
      parEleve.set(st.studentId, arr);
    }
  }

  const redoublementAllowed = ctx.rule?.redoublement_allowed ?? true;
  const rows: DeliberationRow[] = identites.map((s) => {
    const parTrimestre = parEleve.get(s.id)
      ?? Array.from({ length: ctx.termIds.length }, () => null);
    const annuelle = moyenneAnnuelle(parTrimestre, decimals, rounding);
    const p = proposeDecision(annuelle, {
      levelCode: ctx.levelCode,
      redoublementAllowed,
      minAverageToPass: ctx.rule?.min_average_to_pass === null
        || ctx.rule?.min_average_to_pass === undefined
        ? null : Number(ctx.rule.min_average_to_pass),
    });
    const before = ctx.prior.get(s.id);
    return {
      studentId: s.id, matricule: s.matricule,
      lastName: s.last, firstNames: s.first,
      parTrimestre, moyenneAnnuelle: annuelle,
      proposition: p.decision, motif: p.reason,
      redoublementAllowed,
      decision: before?.decision ?? null,
      appreciation: before?.appreciation ?? null,
    };
  }).sort((a, b) => (b.moyenneAnnuelle ?? -1) - (a.moyenneAnnuelle ?? -1));

  // Combien de trimestres portent réellement une moyenne : délibérer sur une
  // année dont un seul trimestre est saisi ne veut rien dire, et il vaut mieux
  // le dire que de produire une décision d'apparence sérieuse.
  const termsWithData = Array.from({ length: ctx.termIds.length }, (_, i) =>
    rows.some((r) => r.parTrimestre[i] !== null)).filter(Boolean).length;

  return {
    classLabel: ctx.label, levelCode: ctx.levelCode,
    yearId: ctx.yearId, yearLabel: ctx.yearLabel,
    termCount: ctx.termIds.length, termsWithData, rows,
    ruleNote: ctx.rule?.source_note ?? null,
  };
}

// ---------------------------------------------------------------------------
// Enregistrement
// ---------------------------------------------------------------------------

export interface SaveOutcome { saved: number; refused: string[] }

/**
 * Enregistre les décisions du conseil.
 *
 * Un redoublement prononcé dans une classe où il est interdit est REFUSÉ, pas
 * corrigé en silence : quelqu'un doit savoir que la délibération a heurté un
 * texte, et pourquoi.
 *
 * Chaque décision alimente aussi le livret scolaire — le dossier cumulatif qui
 * suit l'élève d'un établissement à l'autre. C'est ce qui rend réelle la
 * continuité du parcours quand une famille déménage.
 */
export async function saveDeliberation(
  user: SessionUser, classId: string, form: URLSearchParams,
): Promise<SaveOutcome> {
  const schoolId = user.schoolId!;
  const deliberation = await loadDeliberation(schoolId, classId);
  if (!deliberation) return { saved: 0, refused: ["Classe introuvable."] };

  const valid = new Set(DECISIONS.map(([code]) => code as string));
  const out: SaveOutcome = { saved: 0, refused: [] };

  await withSchool(schoolId, async (c) => {
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;
    const school = await c.query(`select name from schools limit 1`);
    const schoolName = school.rows[0]?.name ?? "";

    for (const r of deliberation.rows) {
      const raw = (form.get(`d_${r.studentId}`) ?? "").trim();
      if (!raw) continue;
      if (!valid.has(raw)) { out.refused.push(`${r.lastName} : décision inconnue.`); continue; }
      if (raw === "redouble" && !r.redoublementAllowed) {
        out.refused.push(
          `${r.lastName} ${r.firstNames} : le redoublement est interdit en `
          + `${deliberation.levelCode} (arrêté 2019). Décision non enregistrée.`);
        continue;
      }
      const appreciation = (form.get(`a_${r.studentId}`) ?? "").trim() || null;

      await c.query(
        `insert into conseil_decisions
           (school_id, student_id, academic_year_id, decision, appreciation,
            decided_on, recorded_by)
         values (current_school_id(), $1, $2, $3, $4, current_date, $5)
         on conflict (student_id, academic_year_id) do update
           set decision = excluded.decision, appreciation = excluded.appreciation,
               decided_on = excluded.decided_on, recorded_by = excluded.recorded_by`,
        [r.studentId, deliberation.yearId, raw, appreciation, staffId]);

      // Le livret est cumulatif : une ligne par élève et par année, corrigée
      // si le conseil revient sur sa décision, jamais dupliquée.
      const existing = await c.query(
        `select id from livret_entries
          where student_id = $1 and academic_year_label = $2 and not is_external`,
        [r.studentId, deliberation.yearLabel]);
      if (existing.rowCount! > 0) {
        await c.query(
          `update livret_entries set moyenne_annuelle = $2, decision = $3,
                                     level_code = $4
            where id = $1`,
          [existing.rows[0].id, r.moyenneAnnuelle, raw, deliberation.levelCode]);
      } else {
        await c.query(
          `insert into livret_entries
             (school_id, student_id, academic_year_label, level_code, school_name,
              moyenne_annuelle, decision)
           values (current_school_id(), $1, $2, $3, $4, $5, $6)`,
          [r.studentId, deliberation.yearLabel, deliberation.levelCode,
           schoolName, r.moyenneAnnuelle, raw]);
      }
      out.saved += 1;
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'conseil.save', 'class', $2, $3)`,
      [user.userId, classId,
       JSON.stringify({ enregistrees: out.saved, refusees: out.refused.length })]);
  });

  return out;
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function conseilPage(
  user: SessionUser, chrome: PageChrome, url: URL, flash?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const classId = url.searchParams.get("classe") ?? "";

  const { classes, yearLabel } = await withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return { classes: [], yearLabel: null };
    const cl = await c.query(
      `select cl.id, cl.label from classes cl
        join levels lv on lv.code = cl.level_code
       where cl.academic_year_id = $1 order by lv.ordinal, cl.label`, [y.rows[0].id]);
    return { classes: cl.rows, yearLabel: y.rows[0].label as string };
  });

  const selector = `
    <form method="get" action="/conseil" class="row" style="margin-left:auto">
      <select name="classe" onchange="this.form.submit()" style="width:auto">
        <option value="">Choisir une classe…</option>
        ${classes.map((k: any) => `<option value="${esc(k.id)}"${
          k.id === classId ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
      </select>
      <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
    </form>`;

  const entete = (sous: string) => `
    <div class="row">
      <div><h1>Conseil de classe</h1><p class="sub">${sous}</p></div>
      ${selector}
    </div>`;

  if (!yearLabel) {
    return page(chrome, "Conseil de classe",
      `${entete("")}<div class="note warn">Aucune année scolaire.</div>`);
  }
  if (!classId) {
    return page(chrome, "Conseil de classe",
      entete(`Délibération de fin d'année ${esc(yearLabel)}. Choisissez une classe.`));
  }

  const d = await loadDeliberation(schoolId, classId);
  if (!d) {
    return page(chrome, "Conseil de classe",
      `${entete("")}<div class="note bad">Cette classe n'a pas de trimestre défini.</div>`);
  }

  const prononcees = d.rows.filter((r) => r.decision).length;

  const ligne = (r: DeliberationRow) => {
    const choix = DECISIONS
      .filter(([code]) => !(code === "redouble" && !r.redoublementAllowed))
      .map(([code, label]) => {
        const selected = r.decision ? r.decision === code : code === r.proposition;
        return `<option value="${code}"${selected ? " selected" : ""}>${esc(label)}</option>`;
      }).join("");

    return `<tr${r.decision ? "" : ' class="warn"'}>
      <td><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}
        <div class="dit" style="color:var(--faint)">${esc(r.matricule)}</div></td>
      ${r.parTrimestre.map((m) => `<td class="num r">${fr(m)}</td>`).join("")}
      <td class="num r"><b>${fr(r.moyenneAnnuelle)}</b></td>
      <td>
        <span class="pill ${r.proposition === "admis" ? "p-ok" : "p-warn"}">${
          esc(r.proposition)}</span>
        <span class="dit" style="color:var(--muted)">${esc(r.motif)}</span>
      </td>
      <td><select name="d_${r.studentId}" style="min-width:200px">${choix}</select></td>
      <td><input type="text" name="a_${r.studentId}" style="min-width:180px"
                 value="${esc(r.appreciation ?? "")}" placeholder="Appréciation"></td>
    </tr>`;
  };

  const body = `
${entete(`${esc(d.classLabel)} — année ${esc(d.yearLabel)}. Le logiciel propose ;
  le conseil décide.`)}

${flash ? `<div class="note ${flash.includes("interdit") ? "bad" : "good"}">${flash}</div>` : ""}

${d.termsWithData < d.termCount ? `<div class="note bad">
  <b>Année incomplète : ${plural(d.termsWithData, "trimestre porte des notes",
    "trimestres portent des notes")} sur ${d.termCount}.</b>
  Une délibération prononcée maintenant reposerait sur une moyenne qui n'est pas
  la moyenne de l'année. Attendez la clôture du dernier trimestre.
</div>` : ""}

<div class="note warn">
  <b>Moyenne annuelle : moyenne simple des trimestres qui portent des notes.</b>
  La pondération des trois trimestres n'a pas pu être établie depuis une source
  burkinabè — le troisième est plus court, certains établissements le comptent
  moins. À confirmer avec le censeur avant tout usage officiel.
</div>

${!d.rows[0]?.redoublementAllowed ? `<div class="note">
  <b>Passage automatique en ${esc(d.levelCode)}.</b> Le redoublement est interdit
  en première année de chaque sous-cycle du primaire (arrêté 2019) : l'option
  n'est pas proposée. Mesure contestée par le SYNAPEC ; elle est enregistrée
  comme une règle datée, pas comme une constante du programme.
</div>` : ""}

<form method="post" action="/conseil?classe=${esc(classId)}">
  <div class="card">
    <header>
      <b>${esc(d.classLabel)}</b>
      <span style="color:var(--muted);font-size:13px">
        ${plural(d.rows.length, "élève", "élèves")} ·
        ${plural(prononcees, "décision prononcée", "décisions prononcées")}</span>
    </header>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>Élève</th>
          ${d.rows[0]?.parTrimestre.map((_, i) => `<th class="r">T${i + 1}</th>`).join("") ?? ""}
          <th class="r">Annuelle</th>
          <th>Proposition</th><th>Décision du conseil</th><th>Appréciation</th>
        </tr></thead>
        <tbody>${d.rows.map(ligne).join("\n")}</tbody>
      </table>
    </div>
    <div class="body row" style="border-top:1px solid var(--rule)">
      <div class="grow"></div>
      <button type="submit" class="btn">Enregistrer les décisions</button>
    </div>
  </div>
</form>`;

  return page(chrome, "Conseil de classe", body);
}
