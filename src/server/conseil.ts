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

/** « 2026-07-01 » -> « 01/07/2026 ». `fr()` formate des nombres, pas des
 *  dates : une règle datée doit s'afficher comme une date. */
const jourFr = (iso: string): string => {
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

/**
 * Le seuil au-delà duquel l'assiduité est SIGNALÉE — pas sanctionnée.
 *
 * Aucun texte burkinabè public ne fixe un nombre d'absences au-delà duquel un
 * élève ne peut plus passer, et inventer ce chiffre reviendrait à écrire une
 * règle nationale dans un logiciel privé. Dix jours est un repère de lecture :
 * il met la ligne en évidence pour que le conseil la regarde, et rien de plus.
 * Le jour où un établissement ou un texte fixe le sien, ce nombre devient une
 * règle datée dans `promotion_rules`, comme les autres.
 */
export const SEUIL_ABSENCES = 10;

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
  /* Assiduité et conduite. Elles ne touchent PAS à la proposition — voir le
     commentaire de `loadDeliberation` — mais un conseil qui ne les voit pas
     délibère sur une moyenne dont il ignore les conditions. */
  absences: number;
  absencesNonJustifiees: number;
  retards: number;
  incidents: number;
  sanctionsLourdes: number;
  /** Faits consignés qui n'ont reçu AUCUNE suite. Une phrase sur l'école. */
  faitsSansSuite: number;
}

export interface Deliberation {
  classLabel: string;
  levelCode: string;
  yearId: string;
  yearLabel: string;
  termCount: number;
  /** Nombre de trimestres qui portent effectivement des notes. */
  termsWithData: number;
  /** Le seuil au-delà duquel l'assiduité est signalée à l'écran. */
  seuilAbsences: number;
  rows: DeliberationRow[];
  ruleNote: string | null;
  /** La règle EN VIGUEUR aujourd'hui, ou `null` s'il n'y en a aucune. */
  regle: RegleDePassage | null;
  /** Celle qui prendra effet plus tard, s'il en existe une. */
  regleAVenir: RegleAVenir | null;
  /** L'interdiction nationale, telle que `levels` l'encode (arrêté 2019). */
  interditParTexte: boolean;
  /** La date à laquelle la règle a été demandée. Affichée, pas devinée. */
  auJour: string;
}

export interface RegleDePassage {
  levelCode: string | null;
  effectiveFrom: string;
  redoublementAllowed: boolean;
  minAverageToPass: number | null;
  sourceNote: string | null;
}

export interface RegleAVenir {
  effectiveFrom: string;
  redoublementAllowed: boolean;
  minAverageToPass: number | null;
  sourceNote: string | null;
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
    /* LA RÈGLE EN VIGUEUR AUJOURD'HUI — et le mot « aujourd'hui » est tout le
     * correctif.
     *
     * Cette requête n'avait pas de borne de date. Une réforme saisie d'avance,
     * à effet dans trois cents jours, gouvernait la délibération EN COURS :
     * éprouvé sur la démonstration, les douze options « redouble »
     * disparaissaient et la barre passait de 10 à 12. Le README dit depuis le
     * premier jour que les règles pédagogiques sont des données datées ;
     * `repository.ts` l'applique pour les coefficients et la notation ; le
     * seul écran qui décide de l'année d'un enfant ne le faisait pas.
     *
     * La règle à venir est demandée elle aussi — non pour l'appliquer, mais
     * pour l'ANNONCER. Saisir la réforme de l'an prochain est une bonne
     * pratique ; la cacher était le défaut. */
    const rule = await c.query(
      `select r.*, r.effective_from::text as depuis
         from regle_de_passage($1, current_date) r`, [k.rows[0].level_code]);
    const aVenir = await c.query(
      `select r.*, r.effective_from::text as depuis
         from regle_de_passage_a_venir($1, current_date) r`,
      [k.rows[0].level_code]);
    const texte = await c.query(
      `select redoublement_interdit_par_texte($1) as interdit,
              current_date::text as jour`, [k.rows[0].level_code]);
    const prior = await c.query(
      `select student_id, decision, appreciation from conseil_decisions
        where academic_year_id = $1`, [k.rows[0].academic_year_id]);

    /* Assiduité et conduite de l'année, par élève. Un conseil de classe
       burkinabè délibère sur « travail, assiduité et conduite » : ne montrer
       que la moyenne, c'est délibérer sur un tiers du dossier. */
    const vie = await c.query(
      `select e.student_id,
              count(*) filter (where ar.status = 'absent')::int as absences,
              count(*) filter (where ar.status = 'absent'
                                 and not ar.is_justified)::int as non_justifiees,
              count(*) filter (where ar.status = 'retard')::int as retards
         from enrolments e
         left join attendance_records ar on ar.student_id = e.student_id
         left join attendance_sessions ses
                on ses.id = ar.attendance_session_id
               and ses.class_id = e.class_id
        where e.class_id = $1
        group by e.student_id`, [classId]);

    /* TROIS NOMBRES, PAS DEUX.
     *
     * `incidents` seul ment par omission. Un élève signalé quatre fois sans
     * qu'on ait jamais rien fait et un élève signalé quatre fois avec quatre
     * convocations des parents affichaient tous deux « 4 » — éprouvé — et le
     * conseil décidait de leur passage sur ce chiffre-là.
     *
     * Or ce sont deux dossiers OPPOSÉS. « Quatre faits, quatre convocations »
     * dit que l'établissement a réagi et que la situation a persisté. « Quatre
     * faits, aucune suite » dit que l'établissement a été prévenu quatre fois
     * et n'a rien fait : c'est une phrase sur l'ÉCOLE, pas sur l'enfant, et
     * elle doit être lue comme telle au moment où l'on décide de son année.
     *
     * `discipline.ts` dit depuis le premier jour que c'est à cela que sert le
     * registre : « une description est obligatoire, une sanction ne l'est pas
     * [...] c'est précisément ce registre qui permet de dire, au conseil, qu'un
     * élève a été signalé quatre fois sans qu'on ait jamais rien fait ». Le
     * registre le permettait ; le conseil ne le demandait pas. */
    const conduite = await c.query(
      `select bi.student_id,
              count(*)::int as incidents,
              count(*) filter (where bi.sanction in
                ('exclusion_temporaire','exclusion_definitive'))::int as lourdes,
              count(*) filter (where coalesce(bi.sanction, '') = '')::int as sans_suite
         from behavior_incidents bi
         join enrolments e on e.student_id = bi.student_id
        where e.class_id = $1 and bi.retracted_at is null
        group by bi.student_id`, [classId]);

    return {
      label: k.rows[0].label as string,
      levelCode: k.rows[0].level_code as string,
      yearId: k.rows[0].academic_year_id as string,
      yearLabel: k.rows[0].year_label as string,
      termIds: terms.rows.map((t) => t.id as string),
      rule: rule.rows[0] ?? null,
      aVenir: aVenir.rows[0] ?? null,
      interditParTexte: texte.rows[0].interdit as boolean,
      auJour: texte.rows[0].jour as string,
      prior: new Map(prior.rows.map((p) => [p.student_id as string, p])),
      vie: new Map(vie.rows.map((v: any) => [v.student_id as string, v])),
      conduite: new Map(conduite.rows.map((v: any) => [v.student_id as string, v])),
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

  /* EN L'ABSENCE DE RÈGLE, ON N'AUTORISE PAS : ON NE SAIT PAS.
   *
   * La ligne d'avant disait `ctx.rule?.redoublement_allowed ?? true`. Supprimez
   * la ligne `promotion_rules` du CP1 — un niveau où l'arrêté de 2019 INTERDIT
   * le redoublement — et les douze options réapparaissaient ; le POST était
   * accepté ; la base portait `redouble` pour un élève de CP1 et l'écran
   * annonçait « 1 décision enregistrée ». Éprouvé.
   *
   * Désormais, faute de règle, aucune décision n'est enregistrable du tout :
   * `regle === null` retire le formulaire et fait refuser l'écriture. Et tant
   * qu'à choisir un défaut pour l'affichage, on prend celui du texte national
   * plutôt que son contraire. */
  const redoublementAllowed = ctx.rule
    ? ctx.rule.redoublement_allowed as boolean
    : !ctx.interditParTexte;
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
    const v = ctx.vie.get(s.id);
    const cd = ctx.conduite.get(s.id);
    return {
      studentId: s.id, matricule: s.matricule,
      lastName: s.last, firstNames: s.first,
      parTrimestre, moyenneAnnuelle: annuelle,
      proposition: p.decision, motif: p.reason,
      redoublementAllowed,
      decision: before?.decision ?? null,
      appreciation: before?.appreciation ?? null,
      absences: Number(v?.absences ?? 0),
      absencesNonJustifiees: Number(v?.non_justifiees ?? 0),
      retards: Number(v?.retards ?? 0),
      incidents: Number(cd?.incidents ?? 0),
      sanctionsLourdes: Number(cd?.lourdes ?? 0),
      faitsSansSuite: Number(cd?.sans_suite ?? 0),
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
    seuilAbsences: SEUIL_ABSENCES,
    ruleNote: ctx.rule?.source_note ?? null,
    regle: ctx.rule ? {
      levelCode: ctx.rule.level_code ?? null,
      effectiveFrom: ctx.rule.depuis as string,
      redoublementAllowed: ctx.rule.redoublement_allowed as boolean,
      minAverageToPass: ctx.rule.min_average_to_pass === null
        ? null : Number(ctx.rule.min_average_to_pass),
      sourceNote: ctx.rule.source_note ?? null,
    } : null,
    regleAVenir: ctx.aVenir ? {
      effectiveFrom: ctx.aVenir.depuis as string,
      redoublementAllowed: ctx.aVenir.redoublement_allowed as boolean,
      minAverageToPass: ctx.aVenir.min_average_to_pass === null
        ? null : Number(ctx.aVenir.min_average_to_pass),
      sourceNote: ctx.aVenir.source_note ?? null,
    } : null,
    interditParTexte: ctx.interditParTexte,
    auJour: ctx.auJour,
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

  /* SANS RÈGLE EN VIGUEUR, ON NE DÉLIBÈRE PAS.
   *
   * `repository.ts` refuse de calculer un bulletin sans politique de notation
   * en vigueur — « Aucune politique de notation en vigueur » — et c'est la
   * bonne réaction : mieux vaut un écran qui s'arrête qu'un calcul d'apparence
   * sérieuse. Le conseil de classe, lui, se contentait d'un `?? true` et
   * enregistrait `redouble` pour un élève de CP1.
   *
   * L'écran retire déjà le formulaire ; ceci est le vrai verrou, parce qu'un
   * écran n'est jamais la protection. */
  if (!deliberation.regle) {
    return { saved: 0, refused: [
      `Aucune règle de passage n'est en vigueur au ${jourFr(deliberation.auJour)} `
      + `pour le niveau ${deliberation.levelCode}. Rien n'a été enregistré : `
      + `délibérer sans règle reviendrait à en inventer une.`] };
  }

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
        /* Le motif cite la règle QUI S'APPLIQUE, pas un arrêté choisi
         * d'avance. Citer l'arrêté de 2019 devant une classe de 6e — ce que
         * faisait l'écran — donne au chef d'établissement une phrase fausse à
         * répéter à une famille qui conteste. */
        out.refused.push(
          `${r.lastName} ${r.firstNames} : le redoublement est interdit en `
          + `${deliberation.levelCode} ${deliberation.interditParTexte
            ? "(arrêté 2019, première année de sous-cycle du primaire)"
            : `par la règle en vigueur depuis le ${
                jourFr(deliberation.regle!.effectiveFrom)}`}. `
          + `Décision non enregistrée.`);
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

    /* Assiduité et conduite. Le chiffre est mis en évidence au-delà du seuil,
       et NE CHANGE RIEN à la proposition : c'est au conseil de peser une
       moyenne au regard des conditions dans lesquelles elle a été obtenue. */
    const assidu = r.absences > d.seuilAbsences || r.sanctionsLourdes > 0;
    const vie = `
      <td class="num r"${r.absences > d.seuilAbsences
        ? ' style="color:var(--laterite);font-weight:600"' : ""}>${r.absences}${
        r.absencesNonJustifiees > 0
          ? `<span class="dit">dont ${r.absencesNonJustifiees} non justifiée${
              r.absencesNonJustifiees > 1 ? "s" : ""}</span>` : ""}</td>
      <td class="num r">${r.retards}</td>
      <td class="num r"${r.sanctionsLourdes > 0
        ? ' style="color:var(--laterite);font-weight:600"' : ""}>${r.incidents}${
        r.sanctionsLourdes > 0
          ? `<span class="dit bad">dont ${r.sanctionsLourdes} exclusion${
              r.sanctionsLourdes > 1 ? "s" : ""}</span>` : ""}${
        /* LE CHIFFRE SEUL NE DIT PAS DE QUOI IL EST FAIT.
           « Sans suite » n'est PAS mis en laterite : ce n'est pas une charge
           de plus contre l'élève, c'est le contraire. On l'écrit en gris, à sa
           place, et on le formule du côté de l'établissement — « aucune suite
           donnée », pas « quatre fautes impunies ». */
        r.faitsSansSuite > 0
          ? `<span class="dit">${r.faitsSansSuite === r.incidents
              ? "aucune suite donnée" : `dont ${r.faitsSansSuite} sans suite`
            }</span>` : ""}</td>`;

    return `<tr${r.decision ? (assidu ? ' class="warn"' : "") : ' class="warn"'}>
      <td><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}
        <div class="dit" style="color:var(--faint)">${esc(r.matricule)}</div></td>
      ${r.parTrimestre.map((m) => `<td class="num r">${fr(m)}</td>`).join("")}
      <td class="num r"><b>${fr(r.moyenneAnnuelle)}</b></td>
      ${vie}
      <td>
        <span class="pill ${r.proposition === "admis" ? "p-ok" : "p-warn"}">${
          esc(r.proposition)}</span>
        <span class="dit" style="color:var(--muted)">${esc(r.motif)}</span>
      </td>
      ${d.regle ? `
      <td><select name="d_${r.studentId}" style="min-width:200px">${choix}</select></td>
      <td><input type="text" name="a_${r.studentId}" style="min-width:180px"
                 value="${esc(r.appreciation ?? "")}" placeholder="Appréciation"></td>`
      /* SANS RÈGLE, PAS DE CHOIX À OFFRIR. Laisser les listes déroulantes
       * affichées hors de tout formulaire donnerait un écran où l'on choisit
       * sans que rien ne s'enregistre — la pire des deux situations. */
      : `<td colspan="2" style="color:var(--muted)">${r.decision
          ? `Décision déjà au dossier : <b>${esc(r.decision)}</b>. Elle n'est
             pas modifiable tant qu'aucune règle n'est en vigueur.`
          : "Aucune règle de passage en vigueur : rien à prononcer."}</td>`}
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

<div class="note">
  <b>Assiduité et conduite sont affichées, et n'entrent dans aucun calcul.</b>
  Un conseil de classe burkinabè délibère sur le travail, l'assiduité et la
  conduite : ne montrer que la moyenne, c'est délibérer sur un tiers du
  dossier. Mais aucun texte public ne fixe un nombre d'absences au-delà duquel
  un élève ne peut plus passer, et l'inventer reviendrait à écrire une règle
  nationale dans un logiciel privé. Au-delà de ${d.seuilAbsences} absences, ou
  s'il y a eu exclusion, la ligne est mise en évidence — c'est un repère de
  lecture, pas un seuil réglementaire, et la décision reste entière.
</div>

<div class="note">
  <b>« Sans suite » se lit du côté de l'établissement.</b> Quatre faits avec
  quatre convocations et quatre faits sans aucune suite affichaient le même
  « 4 ». Ce sont pourtant deux dossiers opposés : le premier dit que l'école a
  réagi et que la situation a persisté ; le second dit qu'elle a été prévenue
  quatre fois et n'a rien fait. La mention n'est donc pas en rouge — ce n'est
  pas une charge de plus contre l'élève, c'est ce qui manque en face.
</div>

<div class="note warn">
  <b>Moyenne annuelle : moyenne simple des trimestres qui portent des notes.</b>
  La pondération des trois trimestres n'a pas pu être établie depuis une source
  burkinabè — le troisième est plus court, certains établissements le comptent
  moins. À confirmer avec le censeur avant tout usage officiel.
</div>

${!d.regle ? `<div class="note bad">
  <b>Aucune règle de passage en vigueur au ${esc(jourFr(d.auJour))} pour le niveau
  ${esc(d.levelCode)}.</b>
  Le conseil ne peut pas délibérer : la barre d'admission et l'autorisation de
  redoubler sont inconnues, et aucune décision n'est enregistrable — un POST
  fabriqué à la main est refusé lui aussi.
  <div style="margin-top:6px;font-size:13.5px">Avant, l'absence de règle était
  lue comme une permission : les douze options « redouble » s'affichaient, y
  compris en CP1 où l'arrêté de 2019 l'interdit, et la décision partait en base.
  ${d.interditParTexte ? `<b>Ce niveau est justement de ceux-là.</b> ` : ""}
  Installez la règle — <code>promotion_rules</code>, avec sa date d'effet et sa
  provenance — puis revenez.</div>
</div>` : !d.rows[0]?.redoublementAllowed ? `<div class="note">
  <b>Passage automatique en ${esc(d.levelCode)}.</b>
  ${d.interditParTexte
    // La phrase n'est vraie qu'au primaire, et l'écran la servait pour
    // n'importe quel niveau dès que la règle interdisait le redoublement.
    ? `Le redoublement est interdit en première année de chaque sous-cycle du
       primaire (arrêté 2019) : l'option n'est pas proposée. Mesure contestée
       par le SYNAPEC ; elle est enregistrée comme une règle datée, pas comme
       une constante du programme.`
    : `L'option n'est pas proposée parce que la règle en vigueur dans cet
       établissement depuis le ${esc(jourFr(d.regle.effectiveFrom))} l'interdit à ce
       niveau. Ce n'est PAS l'arrêté de 2019, qui ne vise que la première année
       de chaque sous-cycle du primaire.`}
</div>` : ""}

${d.regle ? `<div class="note">
  <b>La règle appliquée.</b>
  ${d.regle.levelCode
    ? `Propre au niveau ${esc(d.regle.levelCode)}` : `Règle générale de l'établissement`},
  en vigueur depuis le <b>${esc(jourFr(d.regle.effectiveFrom))}</b>.
  Admission à partir de ${d.regle.minAverageToPass === null
    ? "— (non fixée)"
    : `<b class="num">${esc(fr(d.regle.minAverageToPass))}/20</b>`} ;
  redoublement ${d.regle.redoublementAllowed ? "autorisé" : "interdit"}.
  ${d.regle.sourceNote
    // La provenance était calculée et jamais affichée. Une règle qui décide de
    // l'année d'un enfant doit dire d'où elle sort, sur l'écran où elle sert.
    ? `<div style="margin-top:6px;font-size:13.5px"><i>${esc(d.regle.sourceNote)}</i></div>`
    : `<div style="margin-top:6px;font-size:13.5px;color:var(--muted)">Cette
       règle ne porte aucune note de provenance : personne ne sait d'où elle
       sort. C'est à renseigner.</div>`}
</div>` : ""}

${d.regleAVenir ? `<div class="note warn">
  <b>Une autre règle prend effet le ${esc(jourFr(d.regleAVenir.effectiveFrom))}.</b>
  Elle ne s'applique pas à cette délibération — celle-ci suit la règle en
  vigueur aujourd'hui.
  <div style="margin-top:6px;font-size:13.5px">Ce qu'elle changera :
  admission à partir de ${d.regleAVenir.minAverageToPass === null
    ? "— (non fixée)" : esc(fr(d.regleAVenir.minAverageToPass)) + "/20"},
  redoublement ${d.regleAVenir.redoublementAllowed ? "autorisé" : "interdit"}.
  ${d.regleAVenir.sourceNote ? esc(d.regleAVenir.sourceNote) : ""}
  <br>Avant, une règle saisie d'avance gouvernait l'année en cours sans le
  dire : la barre changeait le jour de la saisie, pas le jour de son effet.</div>
</div>` : ""}

${d.regle ? `<form method="post" action="/conseil?classe=${esc(classId)}">` : ""}
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
          <th class="r">Abs.</th><th class="r">Ret.</th><th class="r">Disc.</th>
          <th>Proposition</th><th>Décision du conseil</th><th>Appréciation</th>
        </tr></thead>
        <tbody>${d.rows.map(ligne).join("\n")}</tbody>
      </table>
    </div>
    ${d.regle ? `<div class="body row" style="border-top:1px solid var(--rule)">
      <div class="grow"></div>
      <button type="submit" class="btn">Enregistrer les décisions</button>
    </div>` : `<div class="body" style="border-top:1px solid var(--rule)">
      <span style="color:var(--laterite)">Les décisions ne sont pas
      enregistrables tant qu'aucune règle de passage n'est en vigueur. Le
      tableau reste lisible : la délibération se prépare, elle ne se
      prononce pas.</span>
    </div>`}
  </div>
${d.regle ? `</form>` : ""}`;

  return page(chrome, "Conseil de classe", body);
}
