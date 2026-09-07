/**
 * Écran de paramétrage des règles de notation.
 *
 * C'est la pièce qui compte le plus pour la visite de septembre. Les quatre
 * règles que rien n'a permis de vérifier — pondération devoirs/composition,
 * table des coefficients, seuils de mention, gabarit — sont des DONNÉES. Cet
 * écran permet à un censeur de les corriger lui-même, devant vous, en cinq
 * minutes, et de voir immédiatement l'effet sur un vrai bulletin.
 *
 * Cela retourne le plus gros risque du projet : au lieu d'attendre qu'on nous
 * dise la règle, on fait poser la règle par celui qui la connaît.
 *
 * Les règles restent datées. Une correction porte sur l'année scolaire en
 * cours — pas sur le passé, dont les bulletins déjà édités ne doivent pas
 * changer sous les pieds des familles.
 */

import type { PoolClient } from "pg";
import { withSchool } from "../lib/db.ts";
import { computeClassBulletins, type GradingPolicy, type MentionBand } from "../lib/bulletin.ts";
import { loadBulletinInputs } from "../lib/repository.ts";
import { page, esc, fr, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export interface Period {
  year_id: string; year_label: string; term_id: string;
  sequence: number; starts_on: Date; ends_on: Date;
}

interface Loaded {
  yearStart: string;
  policyId: string;
  policy: GradingPolicy;
  policySource: string | null;
  bands: Array<{ label: string; min: number; max: number }>;
  coefSetId: string;
  coefSource: string | null;
  subjects: Array<{ id: string; label: string; coefficient: number; champ: string; used: boolean }>;
}

async function load(c: PoolClient, period: Period): Promise<Loaded> {
  const y = await c.query(`select starts_on from academic_years where id = $1`, [period.year_id]);
  const yearStart: string = new Date(y.rows[0].starts_on).toISOString().slice(0, 10);

  const p = await c.query(
    `select * from grading_policies where effective_from <= $1
      order by effective_from desc limit 1`, [yearStart]);
  const row = p.rows[0];

  const b = await c.query(
    `select label, min_average, max_average from mention_bands
      where grading_policy_id = $1 order by sort_order`, [row.id]);

  const cs = await c.query(
    `select id, source_note from coefficient_sets where effective_from <= $1
      order by effective_from desc limit 1`, [yearStart]);

  const subs = await c.query(
    `select sub.id, sub.label, sub.champ_disciplinaire as champ, co.coefficient,
            exists (select 1 from evaluations ev
                     join classes cl on cl.id = ev.class_id
                    where ev.subject_id = sub.id and cl.academic_year_id = $2) as used
       from coefficients co join subjects sub on sub.id = co.subject_id
      where co.coefficient_set_id = $1
      order by co.coefficient desc, sub.label`, [cs.rows[0].id, period.year_id]);

  return {
    yearStart,
    policyId: row.id,
    policy: {
      interrogationWeight: Number(row.interrogation_weight),
      devoirWeight: Number(row.devoir_weight),
      compositionWeight: Number(row.composition_weight),
      scaleMax: Number(row.scale_max),
      passMark: Number(row.pass_mark),
      decimals: Number(row.decimals),
      rounding: row.rounding,
      rankTiePolicy: row.rank_tie_policy,
      unjustifiedAbsenceCountsAsZero: row.unjustified_absence_counts_as_zero,
    },
    policySource: row.source_note ?? null,
    bands: b.rows.map((r) => ({
      label: r.label, min: Number(r.min_average), max: Number(r.max_average),
    })),
    coefSetId: cs.rows[0].id,
    coefSource: cs.rows[0].source_note ?? null,
    subjects: subs.rows.map((r) => ({
      id: r.id, label: r.label, champ: r.champ,
      coefficient: Number(r.coefficient), used: r.used,
    })),
  };
}

/** Effet de la règle courante sur une classe réelle — la vérification en salle. */
async function preview(schoolId: string, period: Period) {
  const cls = await withSchool(schoolId, async (c) =>
    (await c.query(
      `select cl.id, cl.label from classes cl
        where cl.academic_year_id = $1
          and exists (select 1 from evaluations ev where ev.class_id = cl.id and ev.term_id = $2)
        order by cl.label limit 1`, [period.year_id, period.term_id])).rows[0]);
  if (!cls) return null;

  const inputs = await loadBulletinInputs(schoolId, cls.id, period.term_id);
  const klass = computeClassBulletins({
    studentIds: inputs.students.map((s) => s.id),
    grades: inputs.grades,
    coefficients: new Map(inputs.subjects.map((s) => [s.id, s.coefficient])),
    policy: inputs.policy,
    mentionBands: inputs.mentionBands,
  });
  const byId = new Map(inputs.students.map((s) => [s.id, s]));
  const top = [...klass.students].sort((a, b) => (a.rang ?? 999) - (b.rang ?? 999)).slice(0, 5);
  return { className: cls.label, moyenneDeClasse: klass.moyenneDeClasse, top, byId };
}

export async function settingsPage(
  user: SessionUser, chrome: PageChrome, period: Period, flash?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const d = await withSchool(schoolId, (c) => load(c, period));
  const pv = await preview(schoolId, period);

  const total = d.policy.interrogationWeight + d.policy.devoirWeight + d.policy.compositionWeight;
  const formule = [
    d.policy.interrogationWeight > 0 ? `interros × ${fr(d.policy.interrogationWeight, 0)}` : null,
    d.policy.devoirWeight > 0 ? `moyenne des devoirs × ${fr(d.policy.devoirWeight, 0)}` : null,
    d.policy.compositionWeight > 0 ? `composition × ${fr(d.policy.compositionWeight, 0)}` : null,
  ].filter(Boolean).join(" + ");

  const CHAMPS: Record<string, string> = {
    langues_communication: "Langues et communication",
    maths_sciences_technologie: "Mathématiques, sciences et technologie",
    sciences_humaines_sociales: "Sciences humaines et sociales",
    eps_arts_culture_production: "EPS, arts, culture et production",
  };

  const coefLine = (s: Loaded["subjects"][number]) => `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
      <span style="flex-grow:1;font-size:13.5px;${s.used ? "" : "color:var(--faint)"}">${esc(s.label)}</span>
      ${s.used ? '<span class="pill p-info">ENSEIGNÉE</span>' : ""}
      <input class="note-cell" style="width:64px;height:34px" name="c_${esc(s.id)}"
             value="${fr(s.coefficient, 0)}" inputmode="numeric"
             aria-label="Coefficient ${esc(s.label)}">
    </div>`;

  const coefBlocks = Object.entries(CHAMPS).map(([code, label]) => {
    const list = d.subjects.filter((s) => s.champ === code)
      .sort((a, b) => Number(b.used) - Number(a.used) || a.label.localeCompare(b.label, "fr"));
    if (list.length === 0) return "";
    return `<div>
      <div style="font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);
                  padding-bottom:6px;border-bottom:1px solid var(--rule);margin-bottom:4px">${esc(label)}</div>
      ${list.map(coefLine).join("")}
    </div>`;
  }).join("");

  const utilisees = d.subjects.filter((s) => s.used);

  const bandRows = d.bands.map((b, i) => `
    <tr>
      <td><input type="text" name="mlabel_${i}" value="${esc(b.label)}" style="height:38px"></td>
      <td class="r"><input class="note-cell" name="mmin_${i}" value="${fr(b.min)}" inputmode="decimal" aria-label="Minimum ${esc(b.label)}"></td>
      <td class="r"><input class="note-cell" name="mmax_${i}" value="${fr(b.max)}" inputmode="decimal" aria-label="Maximum ${esc(b.label)}"></td>
    </tr>`).join("");

  const previewBlock = pv ? `
    <div class="card">
      <header><h2>Effet sur la ${esc(pv.className)}</h2>
        <span style="margin-left:auto;font-size:13px;color:var(--muted)">Moyenne de la classe <b class="num">${fr(pv.moyenneDeClasse)}</b></span>
      </header>
      <div class="scroll"><table id="apercu">
        <thead><tr><th class="r">Rang</th><th>Élève</th><th class="r">Moyenne</th><th>Mention</th></tr></thead>
        <tbody>${pv.top.map((r) => {
          const st = pv.byId.get(r.studentId)!;
          return `<tr><td class="num r">${r.rang ?? "—"}</td>
            <td><b>${esc(st.lastName)}</b> ${esc(st.firstNames)}</td>
            <td class="num r" style="font-weight:600">${fr(r.moyenneGenerale)}</td>
            <td>${esc(r.mention ?? "—")}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>` : "";

  const unconfirmed = [d.policySource, d.coefSource].filter(Boolean).length;

  return page(chrome, "Paramètres", `
    <div><h1>Règles de notation</h1>
      <p style="margin:0;color:var(--muted)">Ces règles produisent les moyennes du bulletin. Elles s'appliquent à l'année ${esc(period.year_label)} entière.</p></div>

    ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}

    ${unconfirmed > 0 ? `<div class="note warn">
      <b>${plural(unconfirmed, "règle non confirmée", "règles non confirmées")}.</b>
      Les valeurs par défaut viennent de la réforme des examens 2026 et d'une convention régionale.
      Aucun texte burkinabè public ne les fixe pour les bulletins internes.
      Corrigez-les ci-dessous : l'effet apparaît immédiatement sur une classe réelle.
      ${d.policySource ? `<div style="margin-top:7px;font-size:12.5px;color:var(--muted)">Pondération : ${esc(d.policySource)}</div>` : ""}
      ${d.coefSource ? `<div style="margin-top:4px;font-size:12.5px;color:var(--muted)">Coefficients : ${esc(d.coefSource)}</div>` : ""}
    </div>` : `<div class="note good"><b>Règles confirmées par l'établissement.</b> Elles ne portent plus de valeur par défaut.</div>`}

    <form method="post" action="/parametres">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px;align-items:start">

        <div class="card">
          <header><h2>Pondération</h2></header>
          <div class="body">
            <p style="margin:0 0 14px;font-size:13.5px;color:var(--muted)">
              Poids de chaque type d'évaluation dans la moyenne d'une matière.
              Mettre 0 pour l'exclure.</p>
            <div style="display:grid;grid-template-columns:1fr 90px;gap:10px;align-items:center">
              <span>Interrogations</span>
              <input class="note-cell" style="width:100%" name="w_interro" value="${fr(d.policy.interrogationWeight, 0)}" inputmode="numeric" aria-label="Poids interrogations">
              <span>Devoirs</span>
              <input class="note-cell" style="width:100%" name="w_devoir" value="${fr(d.policy.devoirWeight, 0)}" inputmode="numeric" aria-label="Poids devoirs">
              <span>Composition</span>
              <input class="note-cell" style="width:100%" name="w_compo" value="${fr(d.policy.compositionWeight, 0)}" inputmode="numeric" aria-label="Poids composition">
            </div>
            <div class="note" style="margin:16px 0 0;font-size:13px">
              Actuellement : <b>( ${esc(formule)} ) ÷ ${fr(total, 0)}</b>
            </div>
          </div>
        </div>

        <div class="card">
          <header><h2>Mentions</h2></header>
          <div class="scroll"><table>
            <thead><tr><th>Libellé</th><th class="r">De</th><th class="r">À</th></tr></thead>
            <tbody>${bandRows}</tbody>
          </table></div>
        </div>

      </div>

      <div class="card" style="margin-top:18px">
        <header><h2>Absence à une évaluation</h2></header>
        <div class="body">
          <label style="display:flex;align-items:flex-start;gap:10px;text-transform:none;
                        letter-spacing:0;font-size:14px;color:var(--ink);margin:0">
            <input type="checkbox" name="zero_si_non_justifiee" value="1"${
              d.policy.unjustifiedAbsenceCountsAsZero ? " checked" : ""}
              style="width:auto;height:auto;margin-top:4px">
            <span>Une absence <b>non justifiée</b> à une évaluation compte
            <b>zéro</b> dans la moyenne.<br>
            <span style="color:var(--muted);font-size:13px">Décochez et
            l'évaluation manquée est simplement écartée du calcul. Une absence
            <b>justifiée</b> est toujours neutralisée, quel que soit ce
            réglage. Cette règle décide de moyennes réelles : une composition
            vaut coefficient 2, et un élève malade ce jour-là perd des points
            que seule une justification peut lui rendre — écran « Justifier les
            absences ».</span></span>
          </label>
        </div>
      </div>

      <div class="card" style="margin-top:18px">
        <header><h2>Coefficients</h2>
          <span style="margin-left:auto;font-size:12.5px;color:var(--muted)">
            ${plural(utilisees.length, "discipline enseignée", "disciplines enseignées")} cette année —
            total des coefficients ${fr(utilisees.reduce((a, s) => a + s.coefficient, 0), 0)}</span>
        </header>
        <div class="body">
          <p style="margin:0 0 14px;font-size:13.5px;color:var(--muted)">
            Les disciplines grisées ne sont pas encore enseignées cette année ; leur coefficient
            est conservé pour plus tard.</p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:22px 32px">
            ${coefBlocks}
          </div>
        </div>
      </div>

      <div class="row" style="margin-top:18px">
        <button class="btn" type="submit">Enregistrer et recalculer</button>
        <label style="display:flex;align-items:center;gap:8px;text-transform:none;letter-spacing:0;font-size:13.5px;color:var(--ink);margin:0">
          <input type="checkbox" name="confirme" value="1"${unconfirmed === 0 ? " checked" : ""} style="width:auto;height:auto">
          Ces règles sont celles de l'établissement
        </label>
      </div>
    </form>

    ${previewBlock}`);
}

export async function saveSettings(
  user: SessionUser, period: Period, form: URLSearchParams,
): Promise<string> {
  const schoolId = user.schoolId!;
  const num = (v: string | null, fallback: number) => {
    const n = Number((v ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  };

  return withSchool(schoolId, async (c) => {
    const d = await load(c, period);
    const confirmed = form.get("confirme") === "1";
    const note = confirmed ? null : d.policySource;

    const wi = Math.max(0, num(form.get("w_interro"), d.policy.interrogationWeight));
    const wd = Math.max(0, num(form.get("w_devoir"), d.policy.devoirWeight));
    const wc = Math.max(0, num(form.get("w_compo"), d.policy.compositionWeight));
    if (wi + wd + wc <= 0) return "Au moins un type d'évaluation doit avoir un poids.";

    // La correction porte sur l'année en cours. On remplace la règle en
    // vigueur à cette date plutôt que d'en empiler une nouvelle : c'est une
    // correction, pas un changement de politique en cours d'année.
    const pol = await c.query(
      `insert into grading_policies (school_id, effective_from, interrogation_weight,
              devoir_weight, composition_weight, scale_max, pass_mark, decimals,
              rounding, rank_tie_policy, source_note,
              unjustified_absence_counts_as_zero)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (school_id, effective_from) do update
         set interrogation_weight = excluded.interrogation_weight,
             devoir_weight = excluded.devoir_weight,
             composition_weight = excluded.composition_weight,
             unjustified_absence_counts_as_zero =
               excluded.unjustified_absence_counts_as_zero,
             source_note = excluded.source_note
       returning id`,
      [schoolId, d.yearStart, wi, wd, wc, d.policy.scaleMax, d.policy.passMark,
       d.policy.decimals, d.policy.rounding, d.policy.rankTiePolicy, note,
       form.get("zero_si_non_justifiee") === "1"]);
    const policyId = pol.rows[0].id;

    // Mentions : on réécrit la table complète, c'est une liste courte.
    await c.query(`delete from mention_bands where grading_policy_id = $1`, [policyId]);
    for (let i = 0; i < d.bands.length; i += 1) {
      const label = (form.get(`mlabel_${i}`) ?? d.bands[i]!.label).trim();
      const min = num(form.get(`mmin_${i}`), d.bands[i]!.min);
      const max = num(form.get(`mmax_${i}`), d.bands[i]!.max);
      if (!label || max < min) continue;
      await c.query(
        `insert into mention_bands (grading_policy_id, school_id, label,
                                    min_average, max_average, sort_order)
         values ($1,$2,$3,$4,$5,$6)`,
        [policyId, schoolId, label, min, max, i + 1]);
    }

    // Coefficients : même logique, on corrige le jeu en vigueur.
    const cs = await c.query(
      `update coefficient_sets set source_note = $2, effective_from = $3
        where id = $1 returning id`,
      [d.coefSetId, confirmed ? null : d.coefSource, d.yearStart]);
    const setId = cs.rows[0].id;

    let changed = 0;
    for (const s of d.subjects) {
      const v = num(form.get(`c_${s.id}`), s.coefficient);
      if (v <= 0 || v === s.coefficient) continue;
      await c.query(
        `update coefficients set coefficient = $3
          where coefficient_set_id = $1 and subject_id = $2`,
        [setId, s.id, v]);
      changed += 1;
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values ($1,$2,'grading_policy.update','school',$3)`,
      [schoolId, user.userId, JSON.stringify({
        ponderation: { interro: wi, devoir: wd, composition: wc },
        coefficients_modifies: changed, confirme: confirmed,
      })]);

    return confirmed
      ? `Règles enregistrées et confirmées. Les bulletins sont recalculés.`
      : `Règles enregistrées. Les bulletins sont recalculés.`;
  });
}
