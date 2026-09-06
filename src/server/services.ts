/**
 * Répartition des services : qui enseigne quoi, à quelle classe.
 *
 * Jusqu'ici, n'importe quel enseignant pouvait ouvrir n'importe quelle classe
 * et saisir des notes dans n'importe quelle discipline. Dans un établissement
 * d'une classe cela ne se voit pas ; dans un établissement de douze classes
 * c'est inacceptable, et c'est le genre de défaut qui fait perdre un client
 * après la première erreur de saisie.
 *
 * Deux principes :
 *
 * 1. **Le périmètre est une donnée, pas un rôle.** « Enseignant » ne dit rien
 *    de ce qu'on a le droit de toucher. `teacher_assignments` le dit.
 *
 * 2. **Le filtre d'affichage n'est jamais la protection.** Masquer une classe
 *    dans une liste déroulante n'empêche personne d'envoyer un identifiant à
 *    la main. La même règle est donc appliquée à la lecture ET à l'écriture,
 *    et c'est l'écriture qui compte.
 *
 * Le censeur, le proviseur et le directeur ne sont pas filtrés : leur métier
 * est de voir toute la maison.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

/** Les fonctions qui voient tout l'établissement, sans répartition. */
const SANS_LIMITE = ["proviseur", "directeur", "censeur", "surveillant_general"];

export function voitTout(user: SessionUser): boolean {
  const r = new Set([...user.roles, user.fonction ?? ""]);
  return SANS_LIMITE.some((x) => r.has(x));
}

export interface Perimetre {
  /** null = aucune limite. */
  classIds: string[] | null;
  /** Couples classe/matière autorisés, quand il y a une limite. */
  couples: Set<string>;
}

const cle = (classId: string, subjectId: string) => `${classId}|${subjectId}`;

/**
 * Ce que cet utilisateur a le droit de toucher.
 * Un membre du personnel sans fiche `staff` n'a aucun service : il ne voit
 * rien, plutôt que tout.
 */
export async function perimetreDe(user: SessionUser): Promise<Perimetre> {
  if (voitTout(user)) return { classIds: null, couples: new Set() };

  return withSchool(user.schoolId!, async (c) => {
    const r = await c.query(
      `select ta.class_id, ta.subject_id
         from teacher_assignments ta
         join staff s on s.id = ta.staff_id
        where s.user_id = $1`, [user.userId]);
    const couples = new Set(r.rows.map((x) => cle(x.class_id, x.subject_id)));
    const classIds = [...new Set(r.rows.map((x) => x.class_id as string))];
    return { classIds, couples };
  });
}

export const peutClasse = (p: Perimetre, classId: string): boolean =>
  p.classIds === null || p.classIds.includes(classId);

export const peutMatiere = (p: Perimetre, classId: string, subjectId: string): boolean =>
  p.classIds === null || p.couples.has(cle(classId, subjectId));

// ---------------------------------------------------------------------------
// Écran de répartition
// ---------------------------------------------------------------------------

export interface ServiceRow {
  id: string; staffId: string; enseignant: string; fonction: string | null;
  classe: string; classId: string; matiere: string; subjectId: string;
}

export async function loadServices(schoolId: string) {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return { yearLabel: null, services: [], staff: [], classes: [], subjects: [] };
    const yearId = y.rows[0].id as string;

    const services = await c.query(
      `select ta.id, ta.staff_id, u.full_name, s.fonction,
              cl.id as class_id, cl.label as classe,
              sub.id as subject_id, sub.label as matiere
         from teacher_assignments ta
         join staff s on s.id = ta.staff_id
         join users u on u.id = s.user_id
         join classes cl on cl.id = ta.class_id
         join subjects sub on sub.id = ta.subject_id
        where cl.academic_year_id = $1
        order by u.full_name, cl.label, sub.label`, [yearId]);

    const staff = (await c.query(
      `select s.id, u.full_name, s.fonction from staff s
         join users u on u.id = s.user_id
        where u.is_active order by u.full_name`)).rows;
    const classes = (await c.query(
      `select cl.id, cl.label from classes cl join levels lv on lv.code = cl.level_code
        where cl.academic_year_id = $1 order by lv.ordinal, cl.label`, [yearId])).rows;
    // Les matières nationales et celles propres à l'établissement.
    const subjects = (await c.query(
      `select id, label from subjects
        where school_id = current_school_id() or school_id is null
        order by label`)).rows;

    return {
      yearLabel: y.rows[0].label as string, yearId,
      services: services.rows.map((r) => ({
        id: r.id, staffId: r.staff_id, enseignant: r.full_name, fonction: r.fonction,
        classe: r.classe, classId: r.class_id, matiere: r.matiere, subjectId: r.subject_id,
      })) as ServiceRow[],
      staff, classes, subjects,
    };
  });
}

export async function addService(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const staffId = form.get("enseignant") ?? "";
  const classId = form.get("classe") ?? "";
  const subjectId = form.get("matiere") ?? "";
  if (!staffId || !classId || !subjectId) {
    return { error: "Choisissez un enseignant, une classe et une matière." };
  }

  return withSchool(user.schoolId!, async (c) => {
    const dup = await c.query(
      `select 1 from teacher_assignments
        where staff_id = $1 and class_id = $2 and subject_id = $3`,
      [staffId, classId, subjectId]);
    if (dup.rowCount! > 0) return { error: "Ce service est déjà attribué." };

    await c.query(
      `insert into teacher_assignments (school_id, staff_id, class_id, subject_id)
       values (current_school_id(), $1, $2, $3)`, [staffId, classId, subjectId]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values (current_school_id(), $1, 'service.create', 'teacher_assignment', $2)`,
      [user.userId, JSON.stringify({ staffId, classId, subjectId })]);
    return { flash: "Service attribué." };
  });
}

export async function removeService(
  user: SessionUser, id: string,
): Promise<{ flash?: string; error?: string }> {
  if (!id) return { error: "Service introuvable." };
  return withSchool(user.schoolId!, async (c) => {
    const r = await c.query(
      `delete from teacher_assignments where id = $1 returning id`, [id]);
    if (r.rowCount === 0) return { error: "Service introuvable." };
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id)
       values (current_school_id(), $1, 'service.delete', 'teacher_assignment', $2)`,
      [user.userId, id]);
    return { flash: "Service retiré." };
  });
}

export async function servicesPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const d = await loadServices(user.schoolId!);
  if (!d.yearLabel) {
    return page(chrome, "Répartition des services",
      `<h1>Répartition des services</h1>
       <div class="note warn">Aucune année scolaire ouverte.</div>`);
  }

  // Un enseignant sans aucun service ne peut rien saisir : il faut le voir.
  const avecService = new Set(d.services.map((s) => s.staffId));
  const orphelins = d.staff.filter((s: any) =>
    (s.fonction === "enseignant") && !avecService.has(s.id));

  const body = `
<div>
  <h1>Répartition des services</h1>
  <p class="sub">Qui enseigne quoi, à quelle classe. Un enseignant ne peut
  saisir de notes et faire l'appel que dans les classes qui lui sont
  attribuées ici — à la lecture comme à l'écriture.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

${orphelins.length ? `<div class="note warn">
  ${plural(orphelins.length, "enseignant n'a aucun service",
    "enseignants n'ont aucun service")} :
  ${orphelins.map((s: any) => esc(s.full_name)).join(", ")}.
  ${plural(orphelins.length, "Il ne pourra", "Ils ne pourront")} rien saisir.
</div>` : ""}

<div class="card">
  <header><b>Année ${esc(d.yearLabel)}</b>
    <span style="color:var(--muted);font-size:13px">${
      plural(d.services.length, "service attribué", "services attribués")}</span></header>
  ${d.services.length ? `<div class="scroll"><table>
    <thead><tr><th>Enseignant</th><th>Classe</th><th>Matière</th><th class="r"></th></tr></thead>
    <tbody>${d.services.map((s) => `<tr>
      <td><b>${esc(s.enseignant)}</b></td>
      <td>${esc(s.classe)}</td>
      <td>${esc(s.matiere)}</td>
      <td class="r">
        <form method="post" action="/services/retirer" style="margin:0">
          <input type="hidden" name="id" value="${s.id}">
          <button type="submit" class="btn ghost" style="height:32px;padding:0 12px">Retirer</button>
        </form></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="body"><p class="hint" style="margin:0">
    Aucun service attribué : chaque enseignant voit donc une liste vide.</p></div>`}

  <form method="post" action="/services" class="body" style="border-top:1px solid var(--rule)">
    <div class="trois">
      <div><label for="enseignant">Enseignant</label>
        <select id="enseignant" name="enseignant">
          ${d.staff.map((s: any) => `<option value="${s.id}">${esc(s.full_name)}${
            s.fonction ? ` — ${esc(s.fonction)}` : ""}</option>`).join("")}
        </select></div>
      <div><label for="classe">Classe</label>
        <select id="classe" name="classe">
          ${d.classes.map((k: any) => `<option value="${k.id}">${esc(k.label)}</option>`).join("")}
        </select></div>
      <div><label for="matiere">Matière</label>
        <select id="matiere" name="matiere">
          ${d.subjects.map((m: any) => `<option value="${m.id}">${esc(m.label)}</option>`).join("")}
        </select></div>
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn">Attribuer</button>
    </div>
  </form>
</div>`;

  return page(chrome, "Répartition des services", body);
}
