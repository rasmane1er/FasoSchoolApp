/**
 * Grille des frais et émission des factures.
 *
 * Le module d'encaissement existait déjà, mais rien ne permettait de créer ce
 * qu'on encaisse : la grille et les factures ne venaient que du script de
 * démonstration. Un établissement ne pouvait donc facturer personne.
 *
 * DEUX RÈGLES DE L'ARRÊTÉ N°2026-101 SONT APPLIQUÉES ICI, PAS SEULEMENT
 * DOCUMENTÉES :
 *
 * 1. Le plafond porte sur la SOMME des lignes plafonnées, comparée au plafond
 *    que l'établissement a lu dans le texte et inscrit dans son dossier de
 *    catégorisation. L'écran affiche l'écart. Il ne l'invente pas : le plafond
 *    vient du dossier, saisi par un humain, parce que les tables par cycle
 *    n'ont pas pu être obtenues.
 *
 * 2. Un supplément autorisé EXIGE une référence d'autorisation ministérielle.
 *    Sans référence, la ligne est refusée. C'est la différence entre un
 *    établissement en règle et un établissement qui apprendra son irrégularité
 *    par une inspection.
 *
 * ET UNE RÈGLE DE PRUDENCE : une facture déjà émise n'est jamais recalculée en
 * silence. Si la grille change après émission, l'écart est montré et c'est un
 * humain qui décide. Une famille qui a payé 78 000 F ne doit pas découvrir
 * qu'elle en doit 92 000 parce qu'une ligne a bougé.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, fcfa, plural, type PageChrome } from "./html.ts";
import { remisePour } from "./bourses.ts";
import type { SessionUser } from "./session.ts";

export const TRAITEMENTS = [
  ["plafonne", "Compté dans le plafond"],
  ["autorise_supplementaire", "Supplément autorisé"],
  ["exclu", "Hors plafond (hébergement)"],
] as const;

export interface FeeLine {
  id: string; label: string; amount: number;
  capTreatment: "plafonne" | "autorise_supplementaire" | "exclu";
  authorisationRef: string | null; isMandatory: boolean;
}

export interface Schedule {
  id: string; label: string; levelCode: string | null; lines: FeeLine[];
}

export interface FraisView {
  yearId: string; yearLabel: string;
  schedules: Schedule[];
  levels: Array<{ code: string; label: string }>;
  classes: Array<{ id: string; label: string; levelCode: string; effectif: number; factures: number }>;
  /** Plafond déclaré dans le dossier de catégorisation, ou null. */
  plafond: number | null;
}

const numero = (raw: string | null): number | null => {
  const t = (raw ?? "").trim().replace(/[^\d]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/** Somme des lignes qui entrent dans le plafond de l'arrêté. */
export const totalPlafonne = (lines: FeeLine[]): number =>
  lines.filter((l) => l.capTreatment === "plafonne")
       .reduce((a, l) => a + l.amount, 0);

export const totalGrille = (lines: FeeLine[]): number =>
  lines.reduce((a, l) => a + l.amount, 0);

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadFrais(schoolId: string): Promise<FraisView | null> {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return null;
    const yearId = y.rows[0].id as string;

    const sch = await c.query(
      `select id, label, level_code from fee_schedules
        where academic_year_id = $1 order by level_code nulls first, label`, [yearId]);
    const lines = await c.query(
      `select fl.id, fl.fee_schedule_id, fl.label, fl.amount_fcfa, fl.cap_treatment,
              fl.authorisation_ref, fl.is_mandatory
         from fee_lines fl join fee_schedules fs on fs.id = fl.fee_schedule_id
        where fs.academic_year_id = $1 order by fl.sort_order, fl.label`, [yearId]);

    const parGrille = new Map<string, FeeLine[]>();
    for (const l of lines.rows) {
      const arr = parGrille.get(l.fee_schedule_id) ?? [];
      arr.push({
        id: l.id, label: l.label, amount: Number(l.amount_fcfa),
        capTreatment: l.cap_treatment, authorisationRef: l.authorisation_ref,
        isMandatory: l.is_mandatory,
      });
      parGrille.set(l.fee_schedule_id, arr);
    }

    const classes = await c.query(
      `select cl.id, cl.label, cl.level_code, lv.ordinal,
              (select count(*)::int from enrolments e
                where e.class_id = cl.id and e.academic_year_id = $1) as effectif,
              (select count(*)::int from enrolments e
                 join invoices i on i.student_id = e.student_id
                                and i.academic_year_id = e.academic_year_id
                where e.class_id = cl.id and e.academic_year_id = $1
                  and i.status <> 'annulee') as factures
         from classes cl join levels lv on lv.code = cl.level_code
        where cl.academic_year_id = $1 order by lv.ordinal, cl.label`, [yearId]);

    const cat = await c.query(
      `select declared_ceiling_fcfa from category_assessments
        where academic_year_id = $1`, [yearId]);

    return {
      yearId, yearLabel: y.rows[0].label as string,
      schedules: sch.rows.map((s) => ({
        id: s.id, label: s.label, levelCode: s.level_code,
        lines: parGrille.get(s.id) ?? [],
      })),
      levels: (await c.query(`select code, label from levels order by ordinal`)).rows,
      classes: classes.rows.map((k) => ({
        id: k.id, label: k.label, levelCode: k.level_code,
        effectif: k.effectif, factures: k.factures,
      })),
      plafond: cat.rows[0]?.declared_ceiling_fcfa ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export async function addSchedule(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const label = (form.get("libelle") ?? "").trim();
  const level = (form.get("niveau") ?? "").trim() || null;
  if (!label) return { error: "Donnez un libellé à la grille." };

  const v = await loadFrais(user.schoolId!);
  if (!v) return { error: "Aucune année scolaire ouverte." };

  return withSchool(user.schoolId!, async (c) => {
    const dup = await c.query(
      `select 1 from fee_schedules where academic_year_id = $1
         and level_code is not distinct from $2`, [v.yearId, level]);
    if (dup.rowCount! > 0) {
      return { error: level
        ? `Une grille existe déjà pour ce niveau.`
        : `Une grille « tous niveaux » existe déjà.` };
    }
    await c.query(
      `insert into fee_schedules (school_id, academic_year_id, level_code, label)
       values (current_school_id(), $1, $2, $3)`, [v.yearId, level, label]);
    return { flash: `Grille « ${label} » créée.` };
  });
}

export async function addLine(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const scheduleId = form.get("grille") ?? "";
  const label = (form.get("libelle") ?? "").trim();
  const montant = numero(form.get("montant"));
  const traitement = (form.get("traitement") ?? "plafonne") as FeeLine["capTreatment"];
  const ref = (form.get("autorisation") ?? "").trim() || null;

  if (!scheduleId || !label) return { error: "Un libellé est nécessaire." };
  if (montant === null || montant < 0) return { error: "Indiquez un montant en FCFA." };
  if (!TRAITEMENTS.some(([t]) => t === traitement)) return { error: "Traitement inconnu." };

  // L'arrêté est explicite : tout supplément exige une autorisation préalable.
  // Accepter la ligne sans référence, c'est laisser un établissement se croire
  // en règle et l'apprendre par une inspection.
  if (traitement === "autorise_supplementaire" && !ref) {
    return { error: "Un supplément autorisé exige la référence de l'autorisation "
      + "ministérielle. Sans elle, la ligne ne peut pas être enregistrée." };
  }

  return withSchool(user.schoolId!, async (c) => {
    const n = await c.query(
      `select coalesce(max(sort_order), 0) + 1 as n from fee_lines
        where fee_schedule_id = $1`, [scheduleId]);
    await c.query(
      `insert into fee_lines (school_id, fee_schedule_id, label, amount_fcfa,
                              cap_treatment, authorisation_ref, sort_order)
       values (current_school_id(), $1, $2, $3, $4, $5, $6)`,
      [scheduleId, label, montant, traitement, ref, n.rows[0].n]);
    return { flash: `Ligne « ${label} » ajoutée.` };
  });
}

export async function removeLine(
  user: SessionUser, id: string,
): Promise<{ flash?: string; error?: string }> {
  if (!id) return { error: "Ligne introuvable." };
  return withSchool(user.schoolId!, async (c) => {
    const r = await c.query(`delete from fee_lines where id = $1 returning label`, [id]);
    if (r.rowCount === 0) return { error: "Ligne introuvable." };
    return { flash: `Ligne « ${r.rows[0].label} » retirée. Les factures déjà `
      + `émises ne changent pas : elles portent le montant du jour de l'émission.` };
  });
}

// ---------------------------------------------------------------------------
// Émission
// ---------------------------------------------------------------------------

export interface IssueOutcome {
  emises: number; deja: number; sansGrille: number;
  /** Total des bourses et remises déduites au moment de l'émission. */
  remisesFcfa: number;
}

/**
 * Émet une facture par élève inscrit dans la classe, à partir de la grille de
 * son niveau (ou de la grille « tous niveaux »).
 *
 * Un élève qui a déjà une facture n'est PAS refacturé, et sa facture n'est pas
 * recalculée : elle porte le montant du jour de l'émission. Une famille qui a
 * payé ne doit pas découvrir un solde différent parce que la grille a bougé.
 *
 * Les échéances suivent les trimestres — c'est la norme au Burkina, on ne
 * modélise pas un solde unique.
 */
export async function issueInvoices(
  user: SessionUser, classId: string,
): Promise<IssueOutcome & { error?: string }> {
  const schoolId = user.schoolId!;
  const v = await loadFrais(schoolId);
  if (!v) {
    return { emises: 0, deja: 0, sansGrille: 0, remisesFcfa: 0,
      error: "Aucune année scolaire ouverte." };
  }

  return withSchool(schoolId, async (c) => {
    const k = await c.query(
      `select level_code, label from classes where id = $1`, [classId]);
    if (k.rowCount === 0) {
      return { emises: 0, deja: 0, sansGrille: 0, remisesFcfa: 0,
        error: "Classe introuvable." };
    }
    const level = k.rows[0].level_code as string;

    // Grille du niveau si elle existe, sinon la grille « tous niveaux ».
    const grille = v.schedules.find((s) => s.levelCode === level)
      ?? v.schedules.find((s) => s.levelCode === null);
    if (!grille || grille.lines.length === 0) {
      return { emises: 0, deja: 0, sansGrille: 1, remisesFcfa: 0,
        error: `Aucune grille de frais renseignée pour ${k.rows[0].label}. `
          + `Créez-la avant d'émettre les factures.` };
    }
    const total = totalGrille(grille.lines);

    const eleves = await c.query(
      `select e.student_id, st.matricule from enrolments e
         join students st on st.id = e.student_id
        where e.class_id = $1 and e.academic_year_id = $2
        order by st.last_name`, [classId, v.yearId]);

    const echeances = await c.query(
      `select sequence, starts_on from terms
        where academic_year_id = $1 order by sequence`, [v.yearId]);

    const out: IssueOutcome = { emises: 0, deja: 0, sansGrille: 0, remisesFcfa: 0 };

    for (const el of eleves.rows) {
      const existe = await c.query(
        `select id from invoices
          where student_id = $1 and academic_year_id = $2 and status <> 'annulee'`,
        [el.student_id, v.yearId]);
      if (existe.rowCount! > 0) { out.deja += 1; continue; }

      /* Les bourses et remises de l'élève sont déduites À L'ÉMISSION et
         figées dans la facture. Une remise accordée plus tard ne rabote pas
         une facture existante : l'écran des bourses signale le décalage, et
         c'est un humain qui décide de réémettre. */
      const remise = await remisePour(schoolId, el.student_id, v.yearId, total);
      const aPayer = total - remise;
      out.remisesFcfa += remise;

      const reference = `F-${v.yearLabel}-${el.matricule}`;
      const inv = await c.query(
        `insert into invoices (school_id, student_id, academic_year_id,
                               fee_schedule_id, reference, total_fcfa)
         values (current_school_id(), $1, $2, $3, $4, $5)
         on conflict (school_id, reference) do update
           set status = 'ouverte', total_fcfa = excluded.total_fcfa
         returning id`,
        [el.student_id, v.yearId, grille.id, reference, aPayer]);

      // Échéancier aligné sur les trimestres. Le reste de la division va sur
      // la première tranche : c'est l'usage, et cela évite un centime perdu.
      const n = Math.max(1, echeances.rowCount ?? 1);
      const part = Math.floor(aPayer / n);
      const reste = aPayer - part * n;
      await c.query(`delete from invoice_instalments where invoice_id = $1`, [inv.rows[0].id]);
      for (const [i, t] of echeances.rows.entries()) {
        await c.query(
          `insert into invoice_instalments (school_id, invoice_id, label,
                                            amount_fcfa, due_on, sort_order)
           values (current_school_id(), $1, $2, $3, $4::date, $5)`,
          [inv.rows[0].id, `Tranche ${t.sequence}`,
           part + (i === 0 ? reste : 0), t.starts_on, i]);
      }
      out.emises += 1;
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'invoices.issue', 'class', $2, $3)`,
      [user.userId, classId, JSON.stringify(out)]);

    return out;
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function fraisPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const v = await loadFrais(user.schoolId!);
  if (!v) {
    return page(chrome, "Frais de scolarité",
      `<h1>Frais de scolarité</h1>
       <div class="note warn">Aucune année scolaire ouverte.</div>`);
  }

  const grille = (s: Schedule) => {
    const plafonne = totalPlafonne(s.lines);
    const total = totalGrille(s.lines);
    const depasse = v.plafond !== null && plafonne > v.plafond;

    return `<div class="card">
      <header><b>${esc(s.label)}</b>
        <span style="color:var(--muted);font-size:13px">${
          s.levelCode ? esc(s.levelCode) : "tous niveaux"} ·
          ${fcfa(total)} FCFA dont ${fcfa(plafonne)} plafonnés</span></header>

      ${depasse ? `<div class="body" style="padding-bottom:0"><div class="note bad">
        <b>Dépassement du plafond déclaré.</b> Les lignes comptées dans le
        plafond totalisent ${fcfa(plafonne)} FCFA pour un plafond déclaré de
        ${fcfa(v.plafond!)} FCFA — soit ${fcfa(plafonne - v.plafond!)} de trop.
        Facturer ainsi expose l'établissement à une sanction.</div></div>` : ""}

      ${s.lines.length ? `<div class="scroll"><table>
        <thead><tr><th>Ligne</th><th class="r">Montant</th><th>Traitement</th>
          <th>Autorisation</th><th class="r"></th></tr></thead>
        <tbody>${s.lines.map((l) => `<tr>
          <td>${esc(l.label)}</td>
          <td class="r num">${fcfa(l.amount)} F</td>
          <td><span class="pill ${
            l.capTreatment === "plafonne" ? "p-info"
            : l.capTreatment === "exclu" ? "p-ok" : "p-warn"}">${
            esc(TRAITEMENTS.find(([t]) => t === l.capTreatment)?.[1] ?? "")}</span></td>
          <td style="color:var(--muted);font-size:13px">${esc(l.authorisationRef ?? "—")}</td>
          <td class="r"><form method="post" action="/frais/ligne/retirer" style="margin:0">
            <input type="hidden" name="id" value="${l.id}">
            <button class="btn ghost" type="submit"
                    style="height:32px;padding:0 12px">Retirer</button></form></td>
        </tr>`).join("")}</tbody>
      </table></div>` : `<div class="body"><p class="hint" style="margin:0">
        Grille vide.</p></div>`}

      <form method="post" action="/frais/ligne" class="body"
            style="border-top:1px solid var(--rule)">
        <input type="hidden" name="grille" value="${s.id}">
        <div class="trois">
          <div><label>Libellé</label>
            <input type="text" name="libelle" placeholder="Scolarité annuelle"></div>
          <div><label>Montant (FCFA)</label>
            <input type="text" name="montant" inputmode="numeric" placeholder="78000"></div>
          <div><label>Traitement</label>
            <select name="traitement">
              ${TRAITEMENTS.map(([t, l]) => `<option value="${t}">${l}</option>`).join("")}
            </select></div>
        </div>
        <div style="margin-top:14px;max-width:420px">
          <label>Référence d'autorisation ministérielle</label>
          <input type="text" name="autorisation" placeholder="obligatoire pour un supplément autorisé">
        </div>
        <div class="row" style="margin-top:16px">
          <button type="submit" class="btn ghost">Ajouter la ligne</button>
        </div>
      </form>
    </div>`;
  };

  const body = `
<div>
  <h1>Frais de scolarité</h1>
  <p class="sub">Année ${esc(v.yearLabel)}. La grille détermine ce que chaque
  famille doit ; les factures en découlent.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

${v.plafond === null ? `<div class="note warn">
  Aucun plafond déclaré dans le dossier de catégorisation : le logiciel ne peut
  donc pas vous dire si votre grille le dépasse.
  <a href="/categorisation"><b>Renseignez-le</b></a>.</div>`
  : `<div class="note">Plafond déclaré : <b>${fcfa(v.plafond)} FCFA</b>, lu dans
     l'arrêté et inscrit au dossier de catégorisation. Seules les lignes
     « comptées dans le plafond » y entrent — l'hébergement en est exclu.</div>`}

${v.schedules.map(grille).join("")}

<div class="card">
  <header><b>Nouvelle grille</b></header>
  <form method="post" action="/frais/grille" class="body">
    <div class="trois">
      <div><label for="libelle">Libellé</label>
        <input type="text" id="libelle" name="libelle" placeholder="Scolarité 6e"></div>
      <div><label for="niveau">Niveau</label>
        <select id="niveau" name="niveau">
          <option value="">— tous niveaux —</option>
          ${v.levels.map((l) => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join("")}
        </select></div>
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn ghost">Créer la grille</button>
    </div>
  </form>
</div>

<div class="card">
  <header><b>Émission des factures</b>
    <span style="color:var(--muted);font-size:13px">une facture par élève inscrit</span>
  </header>
  <table>
    <thead><tr><th>Classe</th><th class="r">Effectif</th><th class="r">Facturés</th>
      <th class="r"></th></tr></thead>
    <tbody>${v.classes.map((k) => `<tr${
      k.effectif > 0 && k.factures < k.effectif ? ' class="warn"' : ""}>
      <td><b>${esc(k.label)}</b></td>
      <td class="r num">${k.effectif}</td>
      <td class="r num">${k.factures}</td>
      <td class="r">${k.factures >= k.effectif && k.effectif > 0
        ? `<span class="pill p-ok">à jour</span>`
        : `<form method="post" action="/frais/emettre" style="margin:0">
             <input type="hidden" name="classe" value="${k.id}">
             <button class="btn" type="submit" style="height:32px;padding:0 14px">
               Émettre ${plural(k.effectif - k.factures, "facture", "factures")}</button>
           </form>`}</td>
    </tr>`).join("") || `<tr><td colspan="4" style="color:var(--muted)">Aucune classe.</td></tr>`}
    </tbody>
  </table>
  <div class="body" style="border-top:1px solid var(--rule)">
    <p class="hint" style="margin:0">Un élève déjà facturé n'est pas refacturé,
    et sa facture n'est pas recalculée : elle porte le montant du jour de son
    émission. Une famille qui a payé ne doit pas découvrir un autre solde parce
    que la grille a bougé. Les échéances suivent les trimestres.</p>
  </div>
</div>`;

  return page(chrome, "Frais de scolarité", body);
}
