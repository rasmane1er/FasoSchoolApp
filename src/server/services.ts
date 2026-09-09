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
    /* Le professeur principal de chaque classe. La colonne
       `classes.professeur_principal_id` existait depuis le premier schéma et
       AUCUN écran ne permettait de la renseigner — pendant que le bulletin
       imprimait une ligne de signature « Le professeur principal » sans nom. */
    const classes = (await c.query(
      `select cl.id, cl.label, cl.professeur_principal_id as pp_id,
              u.full_name as pp
         from classes cl
         join levels lv on lv.code = cl.level_code
         left join staff stf on stf.id = cl.professeur_principal_id
         left join users u on u.id = stf.user_id
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

/**
 * Nommer le professeur principal d'une classe.
 *
 * C'est lui qui signe le bulletin et qui préside le conseil de classe. La
 * colonne existait depuis le premier schéma, sans clé étrangère et sans écran
 * pour la remplir : le bulletin portait donc une ligne de signature anonyme.
 *
 * Il doit être ENSEIGNANT dans l'établissement, et rien ne l'oblige à
 * enseigner dans cette classe — dans un petit établissement, le professeur
 * principal d'une 6e peut n'y faire aucune heure.
 */
export async function nommerProfesseurPrincipal(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  /* `classe_pp` et non `classe` : l'écran porte déjà un champ `classe` pour
     l'attribution des services, et deux sens différents sous un même nom sur
     la même page finissent toujours par se croiser. */
  const classId = form.get("classe_pp") ?? "";
  const staffId = (form.get("staff") ?? "").trim();
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(classId)) return { error: "Classe inconnue." };
  if (staffId !== "" && !uuid.test(staffId)) return { error: "Personne inconnue." };

  return withSchool(user.schoolId!, async (c) => {
    const cl = (await c.query(
      `select label from classes where id = $1`, [classId])).rows[0];
    if (!cl) return { error: "Cette classe n'existe pas." };

    if (staffId === "") {
      await c.query(
        `update classes set professeur_principal_id = null where id = $1`, [classId]);
      return { flash: `${cl.label} n'a plus de professeur principal. `
        + `Les bulletins publiés gardent le nom qu'ils portaient.` };
    }

    /* Le RLS empêche déjà de désigner quelqu'un d'un autre établissement — la
       ligne ne serait pas visible — mais l'écrire ici donne un refus en
       français plutôt qu'une erreur de clé étrangère. */
    const st = (await c.query(
      `select u.full_name, u.is_active from staff s
         join users u on u.id = s.user_id where s.id = $1`, [staffId])).rows[0];
    if (!st) return { error: "Cette personne n'est pas au personnel de l'établissement." };
    if (!st.is_active) {
      return { error: `${st.full_name} n'est plus en activité.` };
    }

    await c.query(
      `update classes set professeur_principal_id = $2 where id = $1`,
      [classId, staffId]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'classe.professeur_principal', 'class', $2, $3)`,
      [user.userId, classId, JSON.stringify({ classe: cl.label, staff: staffId })]);

    return { flash: `${st.full_name} est professeur principal de ${cl.label}. `
      + `Son nom figurera sur les bulletins publiés à partir de maintenant.` };
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

<div class="card" style="margin-bottom:18px">
  <header><b>Professeurs principaux</b>
    <span style="color:var(--muted);font-size:13px">celui qui signe le bulletin
      et préside le conseil de classe</span></header>
  ${d.classes.length ? `<div class="scroll"><table>
    <thead><tr><th>Classe</th><th>Professeur principal</th><th class="r"></th></tr></thead>
    <tbody>${d.classes.map((cl: any) => `<tr${cl.pp ? "" : ' class="warn"'}>
      <td><b>${esc(cl.label)}</b></td>
      <td>${cl.pp ? esc(cl.pp)
        : `<span class="pill p-warn">non désigné</span>`}</td>
      <td class="r">
        <form method="post" action="/services/principal" class="row"
              style="margin:0;gap:6px;justify-content:flex-end">
          <input type="hidden" name="classe_pp" value="${esc(cl.id)}">
          <select name="staff" style="width:auto;height:34px;font-size:13px">
            <option value="">— personne —</option>
            ${d.staff.filter((s: any) => s.fonction === "enseignant"
                 || s.id === cl.pp_id)
              .map((s: any) => `<option value="${esc(s.id)}"${
                s.id === cl.pp_id ? " selected" : ""}>${esc(s.full_name)}</option>`).join("")}
          </select>
          <button type="submit" class="btn ghost petit">Désigner</button>
        </form></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="body"><p class="hint" style="margin:0">
    Aucune classe cette année.</p></div>`}
</div>

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
