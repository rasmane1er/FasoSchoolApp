/**
 * Création des évaluations.
 *
 * Il manquait la première marche. On pouvait saisir des notes, les synchroniser
 * hors ligne, arbitrer les divergences, calculer des moyennes et publier des
 * bulletins — mais rien ne permettait de dire « j'ai donné un devoir surveillé
 * le 12 novembre ». Les évaluations ne venaient que du script de démonstration,
 * ce qui rendait tout le reste inutilisable dans un vrai établissement.
 *
 * UNE DISTINCTION BURKINABÈ EST APPLIQUÉE ICI :
 *
 * **La composition est harmonisée.** Son sujet est arrêté au niveau du
 * district ou de la région, pas par l'enseignant de la classe. Une composition
 * se crée donc pour TOUTES les classes d'un même niveau à la fois, par le
 * censeur ; un devoir ou une interrogation appartiennent à l'enseignant et à
 * sa classe. C'est la raison d'être de `scope` dans le schéma, et cela évite
 * au censeur de recréer douze fois la même composition.
 *
 * DEUX REFUS :
 *
 * - Rien ne se crée dans un trimestre clôturé. Le carnet est fermé.
 * - Une évaluation qui porte déjà des notes ne se supprime pas : supprimer
 *   effacerait les notes en cascade, sans que personne ne l'ait demandé. Il
 *   faut d'abord vider les notes, et l'écran le dit.
 */

import { withSchool } from "../lib/db.ts";
import { esc, plural } from "./html.ts";
import { perimetreDe, peutMatiere, voitTout } from "./services.ts";
import type { SessionUser } from "./session.ts";

export const TYPES: Array<[string, string]> = [
  ["interrogation", "Interrogation"],
  ["devoir", "Devoir surveillé"],
  ["composition", "Composition (harmonisée)"],
  ["examen_blanc", "Examen blanc"],
];

/** « 12/11/2026 » ou « 2026-11-12 » → « 2026-11-12 ». */
export function toIso(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fr = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  let y: number, m: number, d: number;
  if (iso) { y = +iso[1]!; m = +iso[2]!; d = +iso[3]!; }
  else if (fr) { d = +fr[1]!; m = +fr[2]!; y = +fr[3]!; }
  else return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface EvalRow {
  id: string; type: string; label: string | null; heldOn: string | null;
  scope: string; notes: number; effectif: number;
}

export async function listEvaluations(
  schoolId: string, classId: string, termId: string, subjectId: string,
): Promise<EvalRow[]> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select ev.id, ev.eval_type, ev.label, ev.held_on, ev.scope,
              (select count(*)::int from grade_entries g
                where g.evaluation_id = ev.id
                  and (g.score is not null or g.is_absent)) as notes,
              (select count(*)::int from enrolments e
                where e.class_id = ev.class_id) as effectif
         from evaluations ev
        where ev.class_id = $1 and ev.term_id = $2 and ev.subject_id = $3
        order by ev.held_on nulls last, ev.eval_type`, [classId, termId, subjectId]);
    return r.rows.map((x) => ({
      id: x.id, type: x.eval_type, label: x.label,
      heldOn: x.held_on instanceof Date
        ? x.held_on.toISOString().slice(0, 10)
        : (x.held_on ? String(x.held_on).slice(0, 10) : null),
      scope: x.scope, notes: x.notes, effectif: x.effectif,
    }));
  });
}

// ---------------------------------------------------------------------------
// Création
// ---------------------------------------------------------------------------

export interface CreateOutcome { flash?: string; error?: string }

export async function createEvaluation(
  user: SessionUser, form: URLSearchParams,
): Promise<CreateOutcome> {
  const schoolId = user.schoolId!;
  const classId = form.get("classe") ?? "";
  const subjectId = form.get("matiere") ?? "";
  const type = form.get("type") ?? "devoir";
  const label = (form.get("intitule") ?? "").trim() || null;
  const dateRaw = (form.get("date") ?? "").trim();

  if (!classId || !subjectId) return { error: "Classe ou matière manquante." };
  if (!TYPES.some(([t]) => t === type)) return { error: "Type d'évaluation inconnu." };

  const heldOn = dateRaw ? toIso(dateRaw) : null;
  if (dateRaw && !heldOn) return { error: "Date illisible. Écrivez-la 12/11/2026." };

  // La saisie des notes est déjà bornée par la répartition des services ; la
  // création l'est de la même façon, et pour la même raison.
  const perimetre = await perimetreDe(user);
  if (!peutMatiere(perimetre, classId, subjectId)) {
    return { error: "Cette matière ne fait pas partie de votre répartition de services." };
  }

  // Une composition est harmonisée : elle n'appartient pas à l'enseignant.
  if (type === "composition" && !voitTout(user)) {
    return { error: "Une composition est harmonisée : son sujet est arrêté au "
      + "niveau du district. Seul le censeur peut l'ouvrir, et elle vaudra pour "
      + "toutes les classes du niveau." };
  }

  return withSchool(schoolId, async (c) => {
    const ctx = await c.query(
      `select cl.level_code, cl.academic_year_id, t.id as term_id, t.status
         from classes cl
         join terms t on t.academic_year_id = cl.academic_year_id
        where cl.id = $1 and t.id = $2`, [classId, form.get("trimestre") ?? ""]);
    if (ctx.rowCount === 0) return { error: "Trimestre introuvable pour cette classe." };
    if (ctx.rows[0].status !== "ouvert") {
      return { error: "Trimestre clôturé : aucune évaluation ne peut y être ajoutée." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    /* Une composition s'ouvre pour toutes les classes du niveau d'un coup :
       le sujet est le même, et le censeur n'a pas à la recréer douze fois. */
    const cibles = type === "composition"
      ? (await c.query(
          `select id from classes
            where academic_year_id = $1 and level_code = $2 order by label`,
          [ctx.rows[0].academic_year_id, ctx.rows[0].level_code])).rows.map((x) => x.id)
      : [classId];

    let creees = 0;
    for (const cible of cibles) {
      const dup = await c.query(
        `select 1 from evaluations
          where class_id = $1 and term_id = $2 and subject_id = $3
            and eval_type = $4 and held_on is not distinct from $5::date`,
        [cible, ctx.rows[0].term_id, subjectId, type, heldOn]);
      if (dup.rowCount! > 0) continue;

      await c.query(
        `insert into evaluations (school_id, term_id, class_id, subject_id,
                                  eval_type, scope, label, held_on, created_by)
         values (current_school_id(), $1, $2, $3, $4, $5, $6, $7::date, $8)`,
        [ctx.rows[0].term_id, cible, subjectId, type,
         type === "composition" ? "etablissement" : "classe",
         label, heldOn, staffId]);
      creees += 1;
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'evaluation.create', 'class', $2, $3)`,
      [user.userId, classId, JSON.stringify({ type, heldOn, creees })]);

    if (creees === 0) {
      return { error: "Cette évaluation existe déjà à cette date." };
    }
    return {
      flash: type === "composition"
        ? `Composition ouverte pour ${plural(creees, "classe", "classes")} du niveau.`
        : "Évaluation créée.",
    };
  });
}

export async function deleteEvaluation(
  user: SessionUser, id: string,
): Promise<CreateOutcome> {
  if (!id) return { error: "Évaluation introuvable." };
  const schoolId = user.schoolId!;
  const perimetre = await perimetreDe(user);

  return withSchool(schoolId, async (c) => {
    const ev = await c.query(
      `select ev.class_id, ev.subject_id, t.status,
              (select count(*)::int from grade_entries g
                where g.evaluation_id = ev.id
                  and (g.score is not null or g.is_absent)) as notes
         from evaluations ev join terms t on t.id = ev.term_id
        where ev.id = $1`, [id]);
    if (ev.rowCount === 0) return { error: "Évaluation introuvable." };
    if (!peutMatiere(perimetre, ev.rows[0].class_id, ev.rows[0].subject_id)) {
      return { error: "Cette matière ne fait pas partie de votre répartition." };
    }
    if (ev.rows[0].status !== "ouvert") {
      return { error: "Trimestre clôturé : rien ne peut plus y être supprimé." };
    }
    /* Supprimer une évaluation notée effacerait les notes en cascade. Personne
       ne demande cela ; on refuse et on dit ce qu'il faut faire d'abord. */
    if (ev.rows[0].notes > 0) {
      return { error: `Cette évaluation porte ${plural(ev.rows[0].notes, "note",
        "notes")} : la supprimer les effacerait. Videz-les d'abord si c'est bien `
        + `ce que vous voulez.` };
    }

    await c.query(`delete from evaluations where id = $1`, [id]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id)
       values (current_school_id(), $1, 'evaluation.delete', 'evaluation', $2)`,
      [user.userId, id]);
    return { flash: "Évaluation supprimée." };
  });
}

// ---------------------------------------------------------------------------
// Fragment inséré dans l'écran de saisie des notes
// ---------------------------------------------------------------------------

export function evaluationsCard(
  user: SessionUser, evals: EvalRow[], classId: string, subjectId: string,
  termId: string, clos: boolean,
): string {
  const libelle = (t: string) => TYPES.find(([v]) => v === t)?.[1] ?? t;
  const jour = (iso: string | null) => {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  return `<div class="card">
  <header><b>Évaluations du trimestre</b>
    <span style="color:var(--muted);font-size:13px">${
      plural(evals.length, "évaluation", "évaluations")}</span></header>

  ${evals.length ? `<div class="scroll"><table>
    <thead><tr><th>Type</th><th>Intitulé</th><th>Date</th><th class="r">Notes saisies</th>
      <th class="r"></th></tr></thead>
    <tbody>${evals.map((e) => `<tr>
      <td>${esc(libelle(e.type))}${e.scope !== "classe"
        ? ` <span class="pill p-info">harmonisée</span>` : ""}</td>
      <td>${esc(e.label ?? "—")}</td>
      <td class="num">${jour(e.heldOn)}</td>
      <td class="r num">${e.notes} / ${e.effectif}</td>
      <td class="r">${clos ? "" : `<form method="post" action="/notes/evaluation/retirer"
             style="margin:0">
        <input type="hidden" name="id" value="${e.id}">
        <input type="hidden" name="classe" value="${esc(classId)}">
        <input type="hidden" name="matiere" value="${esc(subjectId)}">
        <button class="btn ghost" type="submit"
                style="height:30px;padding:0 11px">Supprimer</button></form>`}</td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="body"><p class="hint" style="margin:0">
    Aucune évaluation pour cette matière ce trimestre. Créez-en une pour
    pouvoir saisir des notes.</p></div>`}

  ${clos ? `<div class="body" style="border-top:1px solid var(--rule)">
    <p class="hint" style="margin:0">Trimestre clôturé : aucune évaluation ne
    peut y être ajoutée.</p></div>` : `
  <form method="post" action="/notes/evaluation" class="body"
        style="border-top:1px solid var(--rule)">
    <input type="hidden" name="classe" value="${esc(classId)}">
    <input type="hidden" name="matiere" value="${esc(subjectId)}">
    <input type="hidden" name="trimestre" value="${esc(termId)}">
    <div class="trois">
      <div><label for="type">Type</label>
        <select id="type" name="type">
          ${TYPES.filter(([t]) => t !== "composition" || voitTout(user))
            .map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select></div>
      <div><label for="intitule">Intitulé</label>
        <input type="text" id="intitule" name="intitule"
               placeholder="Devoir surveillé n°2"></div>
      <div><label for="date">Date</label>
        <input type="text" id="date" name="date" inputmode="numeric"
               placeholder="jj/mm/aaaa"></div>
    </div>
    ${voitTout(user) ? `<p class="hint">Une <b>composition</b> est harmonisée :
      la créer l'ouvre pour toutes les classes du niveau d'un seul coup.</p>` : ""}
    <div class="row" style="margin-top:14px">
      <button type="submit" class="btn ghost">Ajouter l'évaluation</button>
    </div>
  </form>`}
</div>`;
}
