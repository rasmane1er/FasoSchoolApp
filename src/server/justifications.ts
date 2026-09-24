/**
 * Justifier une absence.
 *
 * `is_justified` existait sur `attendance_records` ET sur `grade_entries`
 * depuis le premier schéma, et AUCUNE ligne du logiciel ne l'avait jamais mise
 * à `true`. Trois écrans et le bulletin affichaient pourtant la distinction :
 * le bulletin imprimait « Absences justifiées : 0 » pour tout le monde, et
 * portait au compte des non justifiées celles pour lesquelles la famille avait
 * apporté un certificat. C'est une accusation imprimée sur un document remis
 * aux parents.
 *
 * DEUX JUSTIFICATIONS, DEUX PORTÉES — l'écran ne les mélange pas :
 *
 * 1. **Une absence de la journée.** Elle change ce que le bulletin imprime et
 *    ce que le conseil de classe lit. Elle ne touche à aucune note.
 *
 * 2. **Une absence à une ÉVALUATION.** Celle-là change une moyenne. Selon la
 *    règle de notation en vigueur, une absence non justifiée à une composition
 *    — coefficient 2 — compte zéro. Un élève malade ce jour-là voyait donc sa
 *    moyenne effondrée par un zéro que rien ne pouvait lever. L'écran affiche
 *    la règle en vigueur, en toutes lettres, avant de demander de décider :
 *    on ne fait pas signer un geste dont on cache l'effet.
 *
 * TROIS PRINCIPES :
 *
 * - **Un motif écrit est obligatoire.** Sans motif, une justification n'est
 *   qu'une case cochée, et personne ne peut plus dire trois mois plus tard sur
 *   quoi elle reposait. « Certificat médical du 12/11 » se vérifie ;
 *   « justifié » ne se vérifie pas.
 * - **Retirer une justification exige aussi un motif.** Le geste rétablit une
 *   absence non justifiée au dossier d'un élève : c'est tout sauf anodin.
 * - **Qui fait l'appel justifie.** C'est la vie scolaire qui reçoit le mot des
 *   parents, pas l'enseignant de mathématiques.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export interface AbsenceJour {
  id: string;
  studentId: string;
  eleve: string;
  classe: string | null;
  date: string;
  justifiee: boolean;
  motif: string | null;
  parQui: string | null;
}

export interface AbsenceEvaluation {
  id: string;
  studentId: string;
  eleve: string;
  evaluation: string;
  matiere: string;
  type: string;
  date: string;
  justifiee: boolean;
  motif: string | null;
  parQui: string | null;
}

export interface Registre {
  jours: AbsenceJour[];
  evaluations: AbsenceEvaluation[];
  classes: Array<{ id: string; label: string }>;
  classId: string | null;
  tout: boolean;
  aTraiterJours: number;
  aTraiterEvals: number;
  /** La règle en vigueur : une absence non justifiée compte-t-elle zéro ? */
  zeroSiNonJustifiee: boolean;
  regleVerifiee: boolean;
}

const jour = (d: Date | string | null): string => {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d) : d;
  return `${String(t.getDate()).padStart(2, "0")}/${
    String(t.getMonth() + 1).padStart(2, "0")}/${t.getFullYear()}`;
};

export async function loadRegistre(
  schoolId: string, classId: string | null, tout: boolean,
): Promise<Registre> {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id from academic_years
        order by (status='en_cours') desc, starts_on desc limit 1`);
    const yearId = y.rows[0]?.id ?? null;

    const classes = yearId
      ? (await c.query(
          `select cl.id, cl.label from classes cl
             join levels lv on lv.code = cl.level_code
            where cl.academic_year_id = $1 order by lv.ordinal, cl.label`,
          [yearId])).rows
      : [];
    const choisie = classId && classes.some((k: any) => k.id === classId)
      ? classId : (classes[0]?.id ?? null);

    /* La règle qui s'applique à CETTE année scolaire, pas à la date du jour :
       une année qui commence le 1er octobre a sa règle datée du 1er octobre, et
       un filtre sur `current_date` ne trouve rien en septembre — l'écran
       retomberait alors sur une valeur par défaut en annonçant une règle qui
       n'est pas celle de l'établissement. */
    const pol = await c.query(
      `select unjustified_absence_counts_as_zero as zero, source_note
         from grading_policies
        where effective_from <= coalesce(
                (select starts_on from academic_years where id = $1),
                current_date)
        order by effective_from desc limit 1`, [yearId]);

    const filtre = tout ? "" : "and not ar.is_justified";
    const j = await c.query(
      `select ar.id, ar.student_id, ar.is_justified, ar.justification,
              ses.session_date,
              st.last_name || ' ' || st.first_names as eleve,
              cl.label as classe,
              u.full_name as par_qui
         from attendance_records ar
         join attendance_sessions ses on ses.id = ar.attendance_session_id
         join students st on st.id = ar.student_id
         left join classes cl on cl.id = ses.class_id
         left join staff sf on sf.id = ar.justified_by
         left join users u on u.id = sf.user_id
        where ar.status = 'absent' and ses.class_id = $1 ${filtre}
        order by ses.session_date desc, st.last_name
        limit 150`, [choisie]);

    const e = await c.query(
      `select ge.id, ge.student_id, ge.is_justified, ge.justification,
              ev.label, ev.eval_type, ev.held_on,
              sub.label as matiere,
              st.last_name || ' ' || st.first_names as eleve,
              u.full_name as par_qui
         from grade_entries ge
         join evaluations ev on ev.id = ge.evaluation_id
         join subjects sub on sub.id = ev.subject_id
         join students st on st.id = ge.student_id
         left join staff sf on sf.id = ge.justified_by
         left join users u on u.id = sf.user_id
        where ge.is_absent and ev.class_id = $1
          ${tout ? "" : "and not ge.is_justified"}
        order by ev.held_on desc, st.last_name
        limit 150`, [choisie]);

    const compte = await c.query(
      `select
        (select count(*)::int from attendance_records ar
           join attendance_sessions ses on ses.id = ar.attendance_session_id
          where ar.status = 'absent' and not ar.is_justified
            and ses.class_id = $1) as jours,
        (select count(*)::int from grade_entries ge
           join evaluations ev on ev.id = ge.evaluation_id
          where ge.is_absent and not ge.is_justified
            and ev.class_id = $1) as evals`, [choisie]);

    return {
      classes, classId: choisie, tout,
      aTraiterJours: compte.rows[0].jours,
      aTraiterEvals: compte.rows[0].evals,
      zeroSiNonJustifiee: pol.rows[0]?.zero ?? true,
      regleVerifiee: !pol.rows[0]?.source_note,
      jours: j.rows.map((x: any): AbsenceJour => ({
        id: x.id, studentId: x.student_id, eleve: x.eleve, classe: x.classe,
        date: jour(x.session_date), justifiee: x.is_justified,
        motif: x.justification, parQui: x.par_qui,
      })),
      evaluations: e.rows.map((x: any): AbsenceEvaluation => ({
        id: x.id, studentId: x.student_id, eleve: x.eleve,
        evaluation: x.label, matiere: x.matiere, type: x.eval_type,
        date: jour(x.held_on), justifiee: x.is_justified,
        motif: x.justification, parQui: x.par_qui,
      })),
    };
  });
}

export interface Issue { flash?: string; error?: string; classId?: string }

/**
 * Justifier, ou retirer une justification.
 *
 * Dans les deux sens un motif est exigé : justifier sans raison écrite ne se
 * vérifie pas, et retirer une justification rétablit une absence non justifiée
 * au dossier d'un élève — c'est tout sauf anodin.
 */
export async function decider(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const classId = form.get("classe") || undefined;
  const quoi = form.get("quoi") ?? "";           // "jour" | "evaluation"
  const id = form.get("ligne") ?? "";
  const justifier = form.get("justifier") === "1";
  const motif = (form.get("motif") ?? "").trim().replace(/\s+/g, " ");

  if (quoi !== "jour" && quoi !== "evaluation") {
    return { classId, error: "Ligne inconnue." };
  }
  if (motif.length < 5) {
    return { classId, error: justifier
      ? "Écrivez le motif : « certificat médical du 12/11 », « décès dans la "
        + "famille ». Sans motif, une justification n'est qu'une case cochée, "
        + "et personne ne pourra dire sur quoi elle reposait."
      : "Dites pourquoi cette justification est retirée : le geste rétablit "
        + "une absence non justifiée au dossier de l'élève." };
  }

  const table = quoi === "jour" ? "attendance_records" : "grade_entries";

  return withSchool(user.schoolId!, async (c) => {
    const r = await c.query(
      `select id, is_justified from ${table} where id = $1`, [id]);
    if (r.rowCount === 0) return { classId, error: "Cette ligne n'existe pas." };
    if (r.rows[0].is_justified === justifier) {
      return { classId, error: justifier
        ? "Cette absence est déjà justifiée."
        : "Cette absence n'est pas justifiée." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    await c.query(
      `update ${table}
          set is_justified = $2, justification = $3,
              justified_by = $4, justified_at = now()
        where id = $1`,
      [id, justifier, motif, staff.rows[0]?.id ?? null]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, $2, $3, $4, $5)`,
      [user.userId, justifier ? "absence.justify" : "absence.unjustify",
       quoi, id, JSON.stringify({ motif })]);

    if (!justifier) {
      return { classId, flash: "Justification retirée. L'absence est de "
        + "nouveau comptée non justifiée." };
    }
    return { classId, flash: quoi === "jour"
      ? "Absence justifiée. Le bulletin et le conseil de classe la compteront "
        + "désormais parmi les absences justifiées."
      : "Absence justifiée. Cette évaluation est neutralisée : elle ne compte "
        + "plus dans la moyenne, ni en bien ni en mal." };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

const TYPES: Record<string, string> = {
  interrogation: "Interrogation", devoir: "Devoir", composition: "Composition",
};

export async function justificationsPage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const tout = url.searchParams.get("tout") === "1";
  const r = await loadRegistre(user.schoolId!, url.searchParams.get("classe"), tout);

  const geste = (quoi: string, id: string, justifiee: boolean) => `
    <form method="post" action="/justifications" class="row">
      <input type="hidden" name="classe" value="${esc(r.classId ?? "")}">
      <input type="hidden" name="quoi" value="${quoi}">
      <input type="hidden" name="ligne" value="${id}">
      <input type="hidden" name="justifier" value="${justifiee ? "0" : "1"}">
      <input type="text" name="motif" required
             placeholder="${justifiee ? "Motif du retrait" : "Certificat médical du…"}"
             style="width:auto;height:34px;font-size:13px">
      <button type="submit" class="btn ghost petit">${
        justifiee ? "Retirer" : "Justifier"}</button>
    </form>`;

  const body = `
<div class="row">
  <div class="grow">
    <h1>Justifier les absences</h1>
    <p class="sub">Ce que la famille a expliqué, et ce qui reste sans
    explication. Une absence justifiée n'est pas la même chose sur un bulletin
    qu'une absence sans nouvelle — et à une évaluation, elle ne vaut pas la
    même note.</p>
  </div>
  <form method="get" action="/justifications">
    <input type="hidden" name="tout" value="${tout ? "1" : "0"}">
    <select name="classe" data-envoi-auto style="width:auto">
      ${r.classes.map((k) => `<option value="${k.id}"${
        k.id === r.classId ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
    </select>
    <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
  </form>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="tiles">
  <div class="tile"><div class="k">Journées sans explication</div>
    <div class="v">${r.aTraiterJours}</div></div>
  <div class="tile"><div class="k">Évaluations sans explication</div>
    <div class="v">${r.aTraiterEvals}</div>
    <div class="n">${r.zeroSiNonJustifiee
      ? "comptées zéro dans la moyenne" : "écartées de la moyenne"}</div></div>
</div>

<p class="row" style="margin:20px 0 0">
  ${tout ? `<a href="/justifications?classe=${esc(r.classId ?? "")}">À traiter</a>
    <span style="color:var(--faint)">·</span> <b>Tout l'historique</b>`
   : `<b>À traiter</b> <span style="color:var(--faint)">·</span>
      <a href="/justifications?tout=1&amp;classe=${esc(r.classId ?? "")}">Tout l'historique</a>`}
</p>

<div class="note ${r.zeroSiNonJustifiee ? "warn" : ""}">
  <b>Ce que justifier change à une évaluation.</b> ${r.zeroSiNonJustifiee
    ? "Selon la règle de notation en vigueur, une absence NON justifiée à une "
      + "évaluation compte <b>zéro</b> dans la moyenne. Une composition vaut "
      + "coefficient 2 : un élève malade ce jour-là perd donc des points que "
      + "seul ce geste peut lui rendre."
    : "Selon la règle de notation en vigueur, une absence non justifiée est "
      + "écartée du calcul, comme une absence justifiée. Le geste ne change "
      + "alors que ce qui est imprimé, pas la moyenne."}
  Une absence justifiée est toujours neutralisée : elle ne compte ni en bien ni
  en mal.${r.regleVerifiee ? "" : " <b>Cette règle n'est pas encore confirmée</b> "
    + "par un censeur : voyez « Règles de notation »."}
</div>

${r.evaluations.length === 0 ? "" : `
<div class="card">
  <header><b>Absences à une évaluation</b> — celles-ci changent une moyenne</header>
  <div class="scroll"><table>
    <thead><tr><th>Date</th><th>Élève</th><th>Évaluation</th><th>Matière</th>
      <th>État</th><th></th></tr></thead>
    <tbody>${r.evaluations.map((a) => `
      <tr${a.justifiee ? ' class="pale"' : ""}>
        <td class="num">${esc(a.date)}</td>
        <td><a href="/eleve?id=${a.studentId}">${esc(a.eleve)}</a></td>
        <td>${esc(a.evaluation)}<span class="dit">${
          esc(TYPES[a.type] ?? a.type)}</span></td>
        <td>${esc(a.matiere)}</td>
        <td>${a.justifiee
          ? `<span class="pill p-ok">Justifiée</span>
             <span class="dit">${esc(a.motif ?? "")}${a.parQui
               ? ` — ${esc(a.parQui)}` : ""}</span>`
          : `<span class="pill ${r.zeroSiNonJustifiee ? "p-bad" : "p-warn"}">${
              r.zeroSiNonJustifiee ? "Comptée zéro" : "Écartée"}</span>`}</td>
        <td class="gestes">${geste("evaluation", a.id, a.justifiee)}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>
</div>`}

${r.jours.length === 0 ? `
<div class="note good">${tout
  ? "Aucune absence relevée dans cette classe."
  : "Aucune absence en attente d'explication dans cette classe."}</div>` : `
<div class="card">
  <header><b>Absences de la journée</b> — elles changent ce que le bulletin
    imprime, pas les notes</header>
  <div class="scroll"><table>
    <thead><tr><th>Date</th><th>Élève</th><th>État</th><th></th></tr></thead>
    <tbody>${r.jours.map((a) => `
      <tr${a.justifiee ? ' class="pale"' : ""}>
        <td class="num">${esc(a.date)}</td>
        <td><a href="/eleve?id=${a.studentId}">${esc(a.eleve)}</a></td>
        <td>${a.justifiee
          ? `<span class="pill p-ok">Justifiée</span>
             <span class="dit">${esc(a.motif ?? "")}${a.parQui
               ? ` — ${esc(a.parQui)}` : ""}</span>`
          : `<span class="pill p-warn">Sans explication</span>`}</td>
        <td class="gestes">${geste("jour", a.id, a.justifiee)}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>
  <div class="body" style="padding-top:0">
    <p class="hint">Un motif écrit est exigé dans les deux sens. « Certificat
    médical du 12/11 » se vérifie trois mois plus tard ; « justifié » ne se
    vérifie pas. Retirer une justification rétablit une absence non justifiée
    au dossier d'un élève : cela mérite une phrase, aussi.</p>
  </div>
</div>`}`;

  return page(chrome, "Justifier les absences", body);
}
