/**
 * Les résultats aux examens.
 *
 * CE QUI EXISTAIT SANS SERVIR. `students.cep_result` et
 * `students.concours_6e_result` étaient dans le schéma depuis le premier jour,
 * avec leurs contraintes de valeur — et aucun écran ne permettait de les
 * renseigner. Le logiciel stockait des résultats d'examen que personne ne
 * pouvait saisir ni relire.
 *
 * POURQUOI CET ÉCRAN COMPTE PLUS QU'IL N'EN A L'AIR.
 *
 * L'arrêté n°2026-101 note la qualité sur 50 points, et « Résultats aux
 * examens » est le critère le plus lourd de cet axe. C'est aussi l'argument
 * central pour lequel un établissement achète un logiciel de gestion plutôt
 * qu'un tableur : la moitié qualité de la grille réclame des chiffres qu'un
 * système produit comme SOUS-PRODUIT, et qu'une école sans système rassemble à
 * la main chaque année. Un logiciel qui ne sait pas dire son taux de réussite
 * au BEPC ne soutient pas l'argument qui le vend.
 *
 * TROIS PRINCIPES.
 *
 * 1. **« Non présenté » n'est pas « refusé ».** Un élève absent à l'examen ne
 *    compte pas dans le taux de réussite. Les confondre ferait baisser un
 *    chiffre qui part au ministère et dont dépend le plafond légal des frais.
 *
 * 2. **Le taux se calcule dans la base, pas ici.** `taux_reussite()` est la
 *    seule définition ; l'écran, le dossier de catégorisation et les tests
 *    lisent la même. Trois copies d'un même calcul finissent par diverger, et
 *    celle qui part au ministère est celle qu'on ne relit pas.
 *
 * 3. **Le logiciel ne note rien.** Il établit le chiffre et dit à quel critère
 *    il se rapporte. La grille de l'arrêté n'a pas pu être obtenue ; convertir
 *    un taux en points serait inventer le barème qui fixe ce qu'une école a le
 *    droit de facturer.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

/** Quel niveau passe quel examen. Une donnée du système éducatif, pas un choix
 *  du logiciel : le CEP et le concours d'entrée en sixième se passent en CM2,
 *  le BEPC en troisième, le baccalauréat en terminale. */
export const EXAMENS: Array<{
  code: string; label: string; colonne: string; niveaux: string[];
}> = [
  { code: "cep", label: "CEP", colonne: "cep_result", niveaux: ["CM2"] },
  { code: "concours_6e", label: "Concours d'entrée en 6e",
    colonne: "concours_6e_result", niveaux: ["CM2"] },
  { code: "bepc", label: "BEPC", colonne: "bepc_result", niveaux: ["3E"] },
  { code: "bac", label: "Baccalauréat", colonne: "bac_result", niveaux: ["TLE"] },
];

export const RESULTATS: Array<{ code: string; label: string; pastille: string }> = [
  { code: "admis", label: "Admis", pastille: "p-ok" },
  { code: "refuse", label: "Refusé", pastille: "p-bad" },
  { code: "non_presente", label: "Non présenté", pastille: "p-warn" },
];

export interface EleveExamen {
  id: string;
  nom: string;
  classe: string;
  resultats: Record<string, string | null>;
}

export interface VueExamens {
  annee: { id: string; label: string } | null;
  /** Les examens que cet établissement présente réellement cette année. */
  examens: typeof EXAMENS;
  eleves: EleveExamen[];
  taux: Array<{ code: string; label: string; presentes: number;
                admis: number; taux: number | null }>;
}

export async function loadExamens(schoolId: string): Promise<VueExamens> {
  return withSchool(schoolId, async (c) => {
    const an = (await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`)).rows[0];
    if (!an) return { annee: null, examens: [], eleves: [], taux: [] };

    /* On ne montre que les examens dont l'établissement a les classes. Un
       collège n'a pas de CM2 : lui proposer une colonne CEP vide, c'est lui
       faire chercher ce qu'il doit y mettre. */
    const niveaux = new Set((await c.query(
      `select distinct level_code from classes where academic_year_id = $1`,
      [an.id])).rows.map((r: any) => r.level_code));
    const examens = EXAMENS.filter((x) => x.niveaux.some((n) => niveaux.has(n)));

    if (examens.length === 0) {
      return { annee: an, examens: [], eleves: [], taux: [] };
    }

    const codes = examens.flatMap((x) => x.niveaux);
    const eleves = (await c.query(
      `select st.id, st.last_name, st.first_names, cl.label as classe,
              st.cep_result, st.concours_6e_result, st.bepc_result, st.bac_result
         from enrolments e
         join students st on st.id = e.student_id
         join classes cl on cl.id = e.class_id
        where cl.academic_year_id = $1 and cl.level_code = any($2)
        order by cl.label, st.last_name, st.first_names`,
      [an.id, codes])).rows;

    const taux = [];
    for (const x of examens) {
      const t = (await c.query(
        `select presentes, admis, taux from taux_reussite($1, $2)`,
        [x.code, an.id])).rows[0];
      taux.push({ code: x.code, label: x.label,
                  presentes: Number(t.presentes), admis: Number(t.admis),
                  taux: t.taux === null ? null : Number(t.taux) });
    }

    return {
      annee: an, examens,
      eleves: eleves.map((r: any) => ({
        id: r.id, nom: `${r.last_name} ${r.first_names}`, classe: r.classe,
        resultats: {
          cep: r.cep_result, concours_6e: r.concours_6e_result,
          bepc: r.bepc_result, bac: r.bac_result,
        },
      })),
      taux,
    };
  });
}

export async function enregistrer(user: SessionUser, form: URLSearchParams):
  Promise<{ flash?: string; error?: string }> {
  const vue = await loadExamens(user.schoolId!);
  if (!vue.annee) return { error: "Aucune année scolaire ouverte." };

  const valides = new Set(RESULTATS.map((r) => r.code));

  return withSchool(user.schoolId!, async (c) => {
    let modifies = 0;
    const refuses: string[] = [];

    for (const el of vue.eleves) {
      for (const x of vue.examens) {
        const champ = `r_${x.code}_${el.id}`;
        /* Un champ ABSENT veut dire « non soumis », pas « efface ». La même
           règle que pour le dossier de catégorisation, où un envoi partiel
           vidait en silence tous les critères qu'il ne mentionnait pas. */
        if (!form.has(champ)) continue;

        const brut = (form.get(champ) ?? "").trim();
        const valeur = brut === "" ? null : brut;
        if (valeur !== null && !valides.has(valeur)) {
          refuses.push(`${el.nom} — ${x.label} : « ${brut} » n'est pas un résultat.`);
          continue;
        }
        if (valeur === el.resultats[x.code]) continue;

        /* Le nom de colonne vient d'une liste fermée définie ici, jamais du
           formulaire : c'est la seule façon d'interpoler un identifiant SQL
           sans ouvrir une injection. */
        await c.query(
          `update students set ${x.colonne} = $2 where id = $1`, [el.id, valeur]);
        modifies += 1;
      }
    }

    if (modifies > 0) {
      await c.query(
        `insert into audit_log (school_id, actor_id, action, target_type, detail)
         values (current_school_id(), $1, 'examens.saisie', 'academic_year', $2)`,
        [user.userId, JSON.stringify({ annee: vue.annee!.label, modifies })]);
    }

    if (refuses.length) {
      return { error: refuses.slice(0, 3).join(" ") };
    }
    return { flash: modifies === 0
      ? "Rien n'a changé."
      : `${plural(modifies, "résultat enregistré", "résultats enregistrés")}.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function examensPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const d = await loadExamens(user.schoolId!);

  if (!d.annee) {
    return page(chrome, "Examens", `<h1>Résultats aux examens</h1>
      <div class="note warn">Aucune année scolaire ouverte.</div>`);
  }
  if (d.examens.length === 0) {
    return page(chrome, "Examens", `<h1>Résultats aux examens</h1>
      <p class="sub">Année ${esc(d.annee.label)}.</p>
      <div class="note">Aucune classe d'examen cette année : le CEP et le
      concours d'entrée en 6e se passent en CM2, le BEPC en 3e, le
      baccalauréat en terminale.</div>`);
  }

  const tuiles = d.taux.map((t) => `
    <div class="tile">
      <div class="k">${esc(t.label)}</div>
      <div class="v">${t.taux === null ? "—" : `${String(t.taux).replace(".", ",")} %`}</div>
      <div class="n">${t.presentes === 0
        ? "aucun résultat saisi"
        : `${t.admis} admis sur ${plural(t.presentes, "présenté", "présentés")}`}</div>
    </div>`).join("");

  const entetes = d.examens.map((x) => `<th>${esc(x.label)}</th>`).join("");
  const lignes = d.eleves.map((el) => `
    <tr>
      <td><b>${esc(el.nom)}</b>
        <div style="font-size:12px;color:var(--faint)">${esc(el.classe)}</div></td>
      ${d.examens.map((x) => `<td>
        <select name="r_${x.code}_${el.id}" style="width:auto;height:36px;font-size:13px">
          <option value=""${el.resultats[x.code] ? "" : " selected"}>—</option>
          ${RESULTATS.map((r) => `<option value="${r.code}"${
            el.resultats[x.code] === r.code ? " selected" : ""
          }>${esc(r.label)}</option>`).join("")}
        </select></td>`).join("")}
    </tr>`).join("");

  return page(chrome, "Examens", `
<div>
  <h1>Résultats aux examens</h1>
  <p class="sub">Année ${esc(d.annee.label)}. Ces chiffres sont ceux que
  réclame la moitié « qualité » du dossier de catégorisation — et que, sans
  logiciel, un établissement rassemble à la main chaque année.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="tiles">${tuiles}</div>

<div class="note">
  <b>« Non présenté » n'est pas « refusé ».</b> Un élève absent à l'examen ne
  compte pas dans le taux : le dénominateur est le nombre de présentés. Les
  confondre ferait baisser un chiffre qui part au ministère.
</div>

<form method="post" action="/examens">
  <div class="card"><div class="scroll"><table>
    <thead><tr><th>Élève</th>${entetes}</tr></thead>
    <tbody>${lignes}</tbody>
  </table></div></div>
  <div class="row" style="margin-top:16px">
    <button class="btn" type="submit">Enregistrer</button>
    <span style="font-size:12.5px;color:var(--muted)">${
      plural(d.eleves.length, "élève concerné", "élèves concernés")}</span>
  </div>
</form>`);
}
