/**
 * Le calendrier scolaire — et le jour où l'école est ouverte.
 *
 * `calendar_events` existait depuis le premier schéma. Aucune ligne du
 * logiciel ne l'avait jamais ouverte. Pendant ce temps, l'appel acceptait
 * n'importe quelle date : `?date=xyz` renvoyait une erreur PostgreSQL brute à
 * l'écran, `?date=1999-01-01` était accepté sans un mot, et `?date=2027-12-25`
 * enregistrait un appel six mois après la fin de l'année scolaire.
 *
 * CE QUE CELA COÛTE. L'appel n'écrit pas seulement une ligne : il ENVOIE UN
 * SMS à chaque famille d'élève absent, à 8 FCFA. « Votre enfant est absent
 * aujourd'hui » un dimanche, ou pendant les congés, est le message le plus
 * destructeur que ce produit puisse émettre — le parent, lui, sait qu'il n'y
 * avait pas école. Une fois suffit pour que plus personne ne croie les
 * suivants, et c'est tout le canal SMS qui meurt avec.
 *
 * TROIS SOURCES, DANS CET ORDRE, POUR DIRE SI L'ÉCOLE EST OUVERTE :
 *
 *   1. l'année scolaire — hors de ses bornes, il n'y a pas d'école ;
 *   2. la semaine de l'établissement (`schools.school_days`) — une donnée,
 *      pas une constante : certains établissements travaillent le samedi ;
 *   3. le calendrier — congés, fêtes chômées, ce que l'école a saisi.
 *
 * CE QUI N'EST PAS UN JOUR FERMÉ. Une composition, un conseil de classe, une
 * journée commémorative non chômée : ils figurent au calendrier et ne ferment
 * rien. D'où `closes_school`, et non le seul `event_type` : c'est la
 * fermeture, pas la catégorie, qui décide.
 *
 * CE QUE CE MODULE NE FAIT PAS. Il ne devine aucune date mobile. Ascension,
 * Aïd el-Fitr, Tabaski et Maouloud sont chômés au Burkina, mais Tabaski et
 * l'Aïd dépendent de l'observation de la lune et sont annoncés chaque année.
 * Les calculer d'ici serait se tromper poliment. L'écran les RÉCLAME à
 * l'établissement et dit lesquelles manquent : un logiciel qui ignore une date
 * vaut mieux qu'un logiciel qui en invente une, parce que le premier le dit.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export const TYPES: Array<{ code: string; label: string; ferme: boolean }> = [
  { code: "conges", label: "Congés", ferme: true },
  { code: "fete", label: "Fête chômée", ferme: true },
  { code: "composition", label: "Composition", ferme: false },
  { code: "examen", label: "Examen", ferme: false },
  { code: "conseil_de_classe", label: "Conseil de classe", ferme: false },
  { code: "rentree_administrative", label: "Rentrée administrative", ferme: false },
  { code: "rentree_pedagogique", label: "Rentrée pédagogique", ferme: false },
  { code: "autre", label: "Autre", ferme: false },
];

const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** `2026-09-13` et rien d'autre. Une date malformée atteignait PostgreSQL et
 *  ressortait en 22P02 à l'écran de l'utilisateur. */
export function dateValide(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export interface Verdict {
  /** L'école travaille-t-elle ce jour-là ? */
  ouvert: boolean;
  /** Dit à l'utilisateur POURQUOI. Un refus muet ne s'explique pas. */
  raison: string;
  /** Vrai quand la date n'est même pas une date. */
  malformee?: boolean;
}

/**
 * L'école est-elle ouverte ce jour-là ?
 *
 * `c` est un client DÉJÀ placé dans le contexte de l'établissement : cette
 * fonction est appelée depuis l'intérieur d'un `withSchool()`, jamais seule.
 * Aucune requête ici ne filtre sur `school_id` — c'est le RLS qui s'en charge,
 * et les lignes nationales (school_id null) restent visibles par la politique
 * de lecture.
 */
export async function jourEcole(c: any, date: string): Promise<Verdict> {
  if (!dateValide(date)) {
    return { ouvert: false, malformee: true,
             raison: "Cette date n'est pas une date." };
  }

  const an = await c.query(
    `select id, label, starts_on, ends_on from academic_years
      where $1::date between starts_on and ends_on
      order by starts_on desc limit 1`, [date]);

  if (!an.rows[0]) {
    const bornes = await c.query(
      `select to_char(starts_on, 'DD/MM/YYYY') as d,
              to_char(ends_on, 'DD/MM/YYYY') as f, label
         from academic_years order by starts_on desc limit 1`);
    const b = bornes.rows[0];
    return { ouvert: false, raison: b
      ? `Cette date est hors de l'année scolaire ${b.label} `
        + `(du ${b.d} au ${b.f}).`
      : "Aucune année scolaire n'est ouverte." };
  }

  /* Le jour de la semaine vient de PostgreSQL, pas de JavaScript : le serveur
     peut tourner dans un autre fuseau que l'école, et `new Date()` en
     donnerait la veille ou le lendemain une partie de la journée. */
  const j = await c.query(
    `select extract(isodow from $1::date)::int as jour,
            (select school_days from schools limit 1) as semaine`, [date]);
  const jour: number = j.rows[0].jour;
  const semaine: number[] = j.rows[0].semaine ?? [1, 2, 3, 4, 5];

  if (!semaine.includes(jour)) {
    return { ouvert: false,
      raison: `L'établissement ne travaille pas le ${JOURS[jour - 1]}.` };
  }

  const ev = await c.query(
    `select label, event_type from calendar_events
      where $1::date between starts_on and ends_on and closes_school
      order by school_id nulls last limit 1`, [date]);

  if (ev.rows[0]) {
    const t = TYPES.find((x) => x.code === ev.rows[0].event_type);
    return { ouvert: false,
      raison: `${ev.rows[0].label}${t ? ` (${t.label.toLowerCase()})` : ""} `
        + `— l'école est fermée.` };
  }

  return { ouvert: true, raison: "" };
}

export interface Evenement {
  id: string;
  label: string;
  type: string;
  debut: string;
  fin: string;
  ferme: boolean;
  national: boolean;
  provenance: string | null;
}

export interface VueCalendrier {
  annee: { label: string; debut: string; fin: string } | null;
  evenements: Evenement[];
  manquantes: string[];
  semaine: number[];
  semaineNote: string | null;
}

export async function loadCalendrier(user: SessionUser): Promise<VueCalendrier> {
  return withSchool(user.schoolId!, async (c) => {
    const an = (await c.query(
      `select label, starts_on, ends_on from academic_years
        order by starts_on desc limit 1`)).rows[0];

    if (!an) {
      return { annee: null, evenements: [], manquantes: [],
               semaine: [1, 2, 3, 4, 5], semaineNote: null };
    }

    const ev = await c.query(
      `select id, label, event_type, closes_school, source_note,
              school_id is null as national,
              to_char(starts_on, 'YYYY-MM-DD') as debut,
              to_char(ends_on,   'YYYY-MM-DD') as fin
         from calendar_events
        where starts_on <= $2 and ends_on >= $1
        order by starts_on, label`, [an.starts_on, an.ends_on]);

    const manq = await c.query(
      `select label from fetes_mobiles_manquantes($1, $2)`,
      [an.starts_on, an.ends_on]);

    const ec = (await c.query(
      `select school_days, school_days_note from schools limit 1`)).rows[0];

    return {
      annee: {
        label: an.label,
        debut: an.starts_on.toISOString().slice(0, 10),
        fin: an.ends_on.toISOString().slice(0, 10),
      },
      evenements: ev.rows.map((r: any) => ({
        id: r.id, label: r.label, type: r.event_type,
        debut: r.debut, fin: r.fin, ferme: r.closes_school,
        national: r.national, provenance: r.source_note,
      })),
      manquantes: manq.rows.map((r: any) => r.label),
      semaine: ec?.school_days ?? [1, 2, 3, 4, 5],
      semaineNote: ec?.school_days_note ?? null,
    };
  });
}

export async function ajouter(user: SessionUser, form: URLSearchParams):
  Promise<{ flash?: string; error?: string }> {
  const label = (form.get("label") ?? "").trim();
  const type = form.get("type") ?? "";
  const debut = (form.get("debut") ?? "").trim();
  const fin = (form.get("fin") ?? "").trim() || debut;

  if (label.length < 3) return { error: "Donnez un nom à cette période." };
  if (!TYPES.some((t) => t.code === type)) return { error: "Type inconnu." };
  if (!dateValide(debut) || !dateValide(fin)) {
    return { error: "La date n'est pas une date." };
  }
  if (fin < debut) return { error: "La fin est avant le début." };

  /* `closes_school` suit le type choisi et n'est PAS laissé à l'utilisateur :
     c'est la nature de l'événement qui décide si l'école ferme, et une case à
     cocher de plus serait une occasion de plus de se tromper. */
  const ferme = TYPES.find((t) => t.code === type)!.ferme;

  return withSchool(user.schoolId!, async (c) => {
    const doublon = await c.query(
      `select 1 from calendar_events
        where starts_on = $1 and label = $2
          and (school_id = current_school_id() or school_id is null)`,
      [debut, label]);
    if (doublon.rows[0]) {
      return { error: `« ${label} » figure déjà à cette date.` };
    }

    await c.query(
      `insert into calendar_events (school_id, label, event_type,
                                    starts_on, ends_on, closes_school)
       values (current_school_id(), $1, $2, $3, $4, $5)`,
      [label, type, debut, fin, ferme]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values (current_school_id(), $1, 'calendrier.ajout', 'calendar_event', $2)`,
      [user.userId, JSON.stringify({ label, type, debut, fin, ferme })]);

    return { flash: ferme
      ? `« ${label} » est enregistré : l'école est fermée, pas d'appel ni de SMS.`
      : `« ${label} » est enregistré. L'école travaille ce jour-là.` };
  });
}

export async function retirer(user: SessionUser, form: URLSearchParams):
  Promise<{ flash?: string; error?: string }> {
  const id = form.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: "Référence inconnue." };

  return withSchool(user.schoolId!, async (c) => {
    /* La politique RLS de suppression ne porte que sur les lignes de
       l'établissement : une ligne nationale ne peut pas partir d'ici. Mais un
       DELETE qui ne supprime rien ne lève aucune erreur — il faut donc lire
       AVANT pour pouvoir refuser avec un motif, plutôt que d'annoncer une
       suppression qui n'a pas eu lieu. */
    const ligne = (await c.query(
      `select label, school_id is null as national
         from calendar_events where id = $1`, [id])).rows[0];
    if (!ligne) return { error: "Cette période n'existe plus." };
    if (ligne.national) {
      return { error: `« ${ligne.label} » est une fête légale nationale. `
        + `Elle ne se retire pas d'ici.` };
    }

    await c.query(`delete from calendar_events where id = $1`, [id]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'calendrier.retrait', 'calendar_event', $2, $3)`,
      [user.userId, id, JSON.stringify({ label: ligne.label })]);
    return { flash: `« ${ligne.label} » est retiré du calendrier.` };
  });
}

export async function changerSemaine(user: SessionUser, form: URLSearchParams):
  Promise<{ flash?: string; error?: string }> {
  const jours = form.getAll("jour").map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (jours.length === 0) {
    return { error: "Un établissement travaille au moins un jour par semaine." };
  }
  const uniques = [...new Set(jours)].sort((a, b) => a - b);

  return withSchool(user.schoolId!, async (c) => {
    await c.query(
      `update schools set school_days = $1,
              school_days_note = 'Saisi par l''établissement.'`,
      [uniques]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values (current_school_id(), $1, 'calendrier.semaine', 'school', $2)`,
      [user.userId, JSON.stringify({ jours: uniques })]);
    return { flash: `La semaine va du ${JOURS[uniques[0]! - 1]} au `
      + `${JOURS[uniques[uniques.length - 1]! - 1]}.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

const jj = (iso: string) => iso.split("-").reverse().join("/");

export async function calendrierPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const d = await loadCalendrier(user);

  if (!d.annee) {
    return page(chrome, "Calendrier", `<h1>Calendrier</h1>
      <div class="note warn">Aucune année scolaire n'est ouverte.
      Le calendrier s'y rattache : commencez par la rentrée.</div>`);
  }

  const semaine = JOURS.map((nom, i) => `
    <label style="display:inline-flex;align-items:center;gap:6px;margin-right:14px">
      <input type="checkbox" name="jour" value="${i + 1}"${
        d.semaine.includes(i + 1) ? " checked" : ""
      } style="width:auto;height:auto">${nom}</label>`).join("");

  /* Ce qui manque passe AVANT ce qui est là. Un calendrier qui a l'air complet
     alors qu'il manque Tabaski est plus dangereux qu'un calendrier vide. */
  const reclame = d.manquantes.length ? `
    <div class="note warn" style="margin-bottom:18px">
      <b>${d.manquantes.length === 4 ? "Quatre" : plural(d.manquantes.length, "fête")}
      chômée${d.manquantes.length > 1 ? "s" : ""} manque${d.manquantes.length > 1 ? "nt" : ""}
      pour ${esc(d.annee.label)} :</b>
      ${d.manquantes.map((m) => esc(m)).join(", ")}.
      <div style="margin-top:6px;font-size:13.5px">
        Leurs dates changent chaque année et ne se calculent pas d'ici :
        Tabaski et l'Aïd el-Fitr dépendent de l'observation de la lune au
        Burkina. Tant qu'elles ne sont pas saisies, <b>l'appel restera ouvert
        ces jours-là et les familles recevront des SMS d'absence</b>.
      </div>
    </div>` : `
    <div class="note good" style="margin-bottom:18px">
      Les quatre fêtes mobiles de ${esc(d.annee.label)} sont saisies.
    </div>`;

  const lignes = d.evenements.map((e) => `
    <tr>
      <td class="num">${jj(e.debut)}${e.fin !== e.debut ? ` → ${jj(e.fin)}` : ""}</td>
      <td>${esc(e.label)}</td>
      <td>${esc(TYPES.find((t) => t.code === e.type)?.label ?? e.type)}</td>
      <td>${e.ferme
        ? '<span class="pill p-warn">École fermée</span>'
        : '<span class="pill p-ok">L\'école travaille</span>'}</td>
      <td>${e.national
        ? '<span style="font-size:12.5px;color:var(--muted)">Fête légale nationale</span>'
        : `<form method="post" action="/calendrier/retirer" style="margin:0">
             <input type="hidden" name="id" value="${esc(e.id)}">
             <button class="btn ghost" type="submit" style="padding:4px 10px;font-size:13px">Retirer</button>
           </form>`}</td>
    </tr>`).join("");

  return page(chrome, "Calendrier", `
    <h1>Calendrier — ${esc(d.annee.label)}</h1>
    <p style="color:var(--muted);max-width:66ch;margin-top:-6px">
      Du ${jj(d.annee.debut)} au ${jj(d.annee.fin)}. Ce calendrier décide des
      jours où l'appel est possible : un jour fermé, <b>aucun SMS d'absence ne
      part</b>.</p>

    ${flash ? `<div class="note good" style="margin-bottom:16px">${esc(flash)}</div>` : ""}
    ${error ? `<div class="note bad" style="margin-bottom:16px">${esc(error)}</div>` : ""}

    ${reclame}

    <div class="card" style="margin-bottom:20px">
      <h2 style="margin-top:0">La semaine de l'établissement</h2>
      ${d.semaineNote?.startsWith("DÉFAUT") ? `
        <div class="note warn" style="margin-bottom:12px">${esc(d.semaineNote)}</div>` : ""}
      <form method="post" action="/calendrier/semaine">
        ${semaine}
        <div style="margin-top:14px"><button class="btn" type="submit">Enregistrer la semaine</button></div>
      </form>
    </div>

    <div class="card" style="margin-bottom:20px">
      <h2 style="margin-top:0">Ajouter une période</h2>
      <form method="post" action="/calendrier">
        <div class="row" style="gap:12px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1 1 220px">
            <label for="label">Nom</label>
            <input id="label" name="label" required maxlength="80"
                   placeholder="Congés de Noël, Tabaski, Composition du 1er trimestre…">
          </div>
          <div>
            <label for="type">Type</label>
            <select id="type" name="type" style="width:auto">
              ${TYPES.map((t) => `<option value="${t.code}">${esc(t.label)}${
                t.ferme ? " — ferme l'école" : ""}</option>`).join("")}
            </select>
          </div>
          <div><label for="debut">Du</label>
            <input id="debut" name="debut" type="date" required style="width:auto"></div>
          <div><label for="fin">Au (facultatif)</label>
            <input id="fin" name="fin" type="date" style="width:auto"></div>
          <button class="btn" type="submit">Ajouter</button>
        </div>
      </form>
    </div>

    <div class="card"><div class="scroll"><table>
      <thead><tr><th>Dates</th><th>Période</th><th>Type</th><th>Effet</th><th></th></tr></thead>
      <tbody>${lignes || `<tr><td colspan="5" style="color:var(--muted)">Rien au calendrier.</td></tr>`}</tbody>
    </table></div></div>`);
}
