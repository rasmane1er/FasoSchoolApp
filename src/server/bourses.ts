/**
 * Bourses et remises.
 *
 * Un établissement privé burkinabè scolarise presque toujours des enfants qui
 * ne paient pas le plein tarif : orphelins, enfants du personnel, familles
 * déplacées, fratries nombreuses, boursiers d'une association ou de l'État.
 * Jusqu'ici rien ne l'enregistrait — l'économe accordait la remise de tête,
 * et personne ne savait, à la fin de l'année, ce que l'établissement avait
 * donné ni à qui.
 *
 * TROIS DÉCISIONS :
 *
 * 1. **Une remise est nominative, motivée et datée.** Pas un rabais anonyme
 *    sur une facture. Le jour où un bailleur, un conseil d'administration ou
 *    un contrôleur demande « combien, et pour qui », la réponse existe.
 *
 * 2. **Une facture déjà émise n'est jamais rabotée en silence.** Accorder une
 *    bourse après l'émission ne change pas la facture : l'écran signale que la
 *    facture ne reflète plus les remises, et c'est un humain qui décide de la
 *    réémettre. C'est la même règle que pour les bulletins et pour la grille.
 *
 * 3. **Le total donné est affiché en permanence.** Une remise se décide en
 *    trente secondes et se paie toute l'année. Un établissement qui accorde
 *    plus qu'il ne peut ferme ; celui qui n'ose plus rien accorder trahit sa
 *    raison d'être. Les deux erreurs viennent de la même cause : ne pas voir
 *    le total.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, fcfa, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export const MOTIFS = [
  "Orphelin",
  "Enfant du personnel",
  "Fratrie",
  "Famille déplacée",
  "Bourse d'une association",
  "Bourse de l'État",
  "Difficulté passagère",
  "Autre",
] as const;

export interface Bourse {
  id: string;
  studentId: string; matricule: string; lastName: string; firstNames: string;
  classe: string | null;
  label: string; kind: "bourse" | "remise";
  percent: number | null; amountFcfa: number | null;
  grantedOn: string;
  /** Ce que la remise retire réellement, une fois appliquée à la facture. */
  effetFcfa: number;
  /** La facture de l'élève tient-elle déjà compte de cette remise ? */
  factureAJour: boolean;
}

/**
 * Ce qu'une remise retire d'un montant.
 * Un pourcentage ET un montant sur la même ligne n'auraient pas de sens : le
 * formulaire n'en accepte qu'un, et le calcul ne lit que celui qui est posé.
 */
export function effet(brut: number, percent: number | null, amount: number | null): number {
  if (percent !== null) return Math.min(brut, Math.round(brut * percent / 100));
  if (amount !== null) return Math.min(brut, amount);
  return 0;
}

/** Le total des remises d'un élève, plafonné au montant dû. */
export function effetCumule(
  brut: number, lignes: Array<{ percent: number | null; amountFcfa: number | null }>,
): number {
  let reste = brut;
  let total = 0;
  for (const l of lignes) {
    const e = effet(reste, l.percent, l.amountFcfa);
    total += e;
    reste -= e;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadBourses(schoolId: string) {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return null;
    const yearId = y.rows[0].id as string;

    const rows = await c.query(
      `select s.id, s.student_id, s.label, s.kind, s.percent, s.amount_fcfa,
              s.granted_on, st.matricule, st.last_name, st.first_names,
              cl.label as classe,
              (select i.total_fcfa from invoices i
                where i.student_id = s.student_id
                  and i.academic_year_id = s.academic_year_id
                  and i.status <> 'annulee' limit 1) as facture,
              (select fs.id from fee_schedules fs
                where fs.academic_year_id = s.academic_year_id
                  and (fs.level_code = cl.level_code or fs.level_code is null)
                order by fs.level_code nulls last limit 1) as grille
         from scholarships s
         join students st on st.id = s.student_id
         left join enrolments e on e.student_id = st.id
                               and e.academic_year_id = s.academic_year_id
         left join classes cl on cl.id = e.class_id
        where s.academic_year_id = $1
        order by st.last_name, st.first_names`, [yearId]);

    // Montant brut de la grille applicable à chaque élève.
    const bruts = new Map<string, number>();
    const grilles = await c.query(
      `select fs.id, coalesce(sum(fl.amount_fcfa), 0)::int as total
         from fee_schedules fs left join fee_lines fl on fl.fee_schedule_id = fs.id
        where fs.academic_year_id = $1 group by fs.id`, [yearId]);
    for (const g of grilles.rows) bruts.set(g.id, g.total);

    // Toutes les remises d'un élève comptent ensemble : deux remises de 50 %
    // ne font pas 100 %, elles font 75 %.
    const parEleve = new Map<string, typeof rows.rows>();
    for (const r of rows.rows) {
      const arr = parEleve.get(r.student_id) ?? [];
      arr.push(r);
      parEleve.set(r.student_id, arr);
    }

    /* L'effet de CHAQUE ligne se calcule sur ce qui reste après les
       précédentes, dans l'ordre où elles ont été accordées — jamais sur le
       montant brut. Sinon deux remises de 50 % totaliseraient 100 %, et
       l'établissement croirait avoir donné le double de ce qu'il a donné. */
    const bourses: Bourse[] = [];
    for (const [studentId, lignes] of parEleve) {
      const brut = bruts.get(lignes[0]!.grille) ?? 0;
      let reste = brut;

      for (const r of lignes) {
        const percent = r.percent === null ? null : Number(r.percent);
        const e = effet(reste, percent, r.amount_fcfa);
        reste -= e;

        bourses.push({
          id: r.id, studentId, matricule: r.matricule,
          lastName: r.last_name, firstNames: r.first_names, classe: r.classe,
          label: r.label, kind: r.kind,
          percent, amountFcfa: r.amount_fcfa,
          grantedOn: r.granted_on instanceof Date
            ? r.granted_on.toISOString().slice(0, 10)
            : String(r.granted_on).slice(0, 10),
          effetFcfa: e,
          // `reste` est le montant attendu une fois TOUTES les lignes passées :
          // on ne peut donc trancher qu'après la boucle.
          factureAJour: true,
        });
      }

      // Une facture est à jour si elle porte exactement ce qui reste dû.
      const attendu = reste;
      const facture = lignes[0]!.facture;
      const aJour = facture === null || Number(facture) === attendu;
      for (const b of bourses) {
        if (b.studentId === studentId) b.factureAJour = aJour;
      }
    }
    bourses.sort((a, b) =>
      a.lastName.localeCompare(b.lastName, "fr") ||
      a.firstNames.localeCompare(b.firstNames, "fr"));

    const eleves = await c.query(
      `select st.id, st.last_name, st.first_names, cl.label as classe
         from enrolments e join students st on st.id = e.student_id
         left join classes cl on cl.id = e.class_id
        where e.academic_year_id = $1
        order by st.last_name, st.first_names`, [yearId]);

    return {
      yearId, yearLabel: y.rows[0].label as string,
      bourses, eleves: eleves.rows,
      totalDonne: bourses.reduce((a, b) => a + b.effetFcfa, 0),
      beneficiaires: new Set(bourses.map((b) => b.studentId)).size,
    };
  });
}

/** Total des remises d'un élève — appelé par l'émission des factures. */
export async function remisePour(
  schoolId: string, studentId: string, yearId: string, brut: number,
): Promise<number> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select percent, amount_fcfa from scholarships
        where student_id = $1 and academic_year_id = $2 order by granted_on`,
      [studentId, yearId]);
    return effetCumule(brut, r.rows.map((x) => ({
      percent: x.percent === null ? null : Number(x.percent),
      amountFcfa: x.amount_fcfa,
    })));
  });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const entier = (raw: string | null): number | null => {
  const t = (raw ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export async function grantBourse(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const d = await loadBourses(user.schoolId!);
  if (!d) return { error: "Aucune année scolaire ouverte." };

  const studentId = form.get("eleve") ?? "";
  const motif = (form.get("motif") ?? "").trim();
  const kind = form.get("nature") === "bourse" ? "bourse" : "remise";
  const pourcent = entier(form.get("pourcent"));
  const montant = entier(form.get("montant"));

  if (!studentId) return { error: "Choisissez l'élève." };
  if (!motif) return { error: "Un motif est nécessaire : c'est lui qui justifiera la remise." };

  // Un pourcentage ET un montant sur la même ligne ne veulent rien dire.
  if (pourcent === null && montant === null) {
    return { error: "Indiquez soit un pourcentage, soit un montant en FCFA." };
  }
  if (pourcent !== null && montant !== null) {
    return { error: "Un pourcentage OU un montant, pas les deux : "
      + "sinon personne ne saura lequel a été appliqué." };
  }
  if (pourcent !== null && (pourcent <= 0 || pourcent > 100)) {
    return { error: "Le pourcentage doit être compris entre 1 et 100." };
  }
  if (montant !== null && montant <= 0) {
    return { error: "Le montant doit être positif." };
  }

  return withSchool(user.schoolId!, async (c) => {
    await c.query(
      `insert into scholarships (school_id, student_id, academic_year_id, label,
                                 kind, percent, amount_fcfa)
       values (current_school_id(), $1, $2, $3, $4, $5, $6)`,
      [studentId, d.yearId, motif, kind, pourcent, montant === null ? null : Math.round(montant)]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'bourse.grant', 'student', $2, $3)`,
      [user.userId, studentId, JSON.stringify({ motif, kind, pourcent, montant })]);
    return { flash: `${kind === "bourse" ? "Bourse" : "Remise"} accordée : ${motif}.` };
  });
}

export async function revokeBourse(
  user: SessionUser, id: string,
): Promise<{ flash?: string; error?: string }> {
  if (!id) return { error: "Remise introuvable." };
  return withSchool(user.schoolId!, async (c) => {
    const r = await c.query(
      `delete from scholarships where id = $1 returning label, student_id`, [id]);
    if (r.rowCount === 0) return { error: "Remise introuvable." };
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'bourse.revoke', 'student', $2, $3)`,
      [user.userId, r.rows[0].student_id, JSON.stringify({ label: r.rows[0].label })]);
    return { flash: `Remise « ${r.rows[0].label} » retirée. Les factures déjà `
      + `émises ne changent pas d'elles-mêmes.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function boursesPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const d = await loadBourses(user.schoolId!);
  if (!d) {
    return page(chrome, "Bourses et remises",
      `<h1>Bourses et remises</h1>
       <div class="note warn">Aucune année scolaire ouverte.</div>`);
  }

  const decalees = d.bourses.filter((b) => !b.factureAJour);
  const tile = (v: string, k: string, n: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="n">${n}</div></div>`;

  const body = `
<div>
  <h1>Bourses et remises</h1>
  <p class="sub">Année ${esc(d.yearLabel)}. Une remise est nominative, motivée
  et datée : le jour où l'on demande « combien, et pour qui », la réponse
  existe.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="tiles">
  ${tile(fcfa(d.totalDonne) + " F", "Accordé cette année", "sur les frais de scolarité")}
  ${tile(String(d.beneficiaires), "Bénéficiaires", "élèves concernés")}
  ${tile(String(d.bourses.length), "Lignes", "bourses et remises")}
  ${tile(String(decalees.length), "Factures décalées", "à réémettre")}
</div>

${decalees.length ? `<div class="note bad">
  ${plural(decalees.length, "remise n'est pas reflétée", "remises ne sont pas reflétées")}
  dans la facture de l'élève : celle-ci a été émise avant, ou après un
  changement. Une facture déjà émise n'est jamais rabotée en silence — allez
  la réémettre depuis <a href="/frais"><b>Frais</b></a> si c'est ce que vous
  voulez.</div>` : ""}

<div class="card">
  <header><b>Remises en cours</b>
    <span style="color:var(--muted);font-size:13px">${
      plural(d.bourses.length, "ligne", "lignes")}</span></header>
  ${d.bourses.length ? `<div class="scroll"><table>
    <thead><tr><th>Élève</th><th>Classe</th><th>Motif</th><th>Nature</th>
      <th class="r">Remise</th><th class="r">Effet</th><th>Facture</th>
      <th class="r"></th></tr></thead>
    <tbody>${d.bourses.map((b) => `<tr${b.factureAJour ? "" : ' class="bad"'}>
      <td><b>${esc(b.lastName)}</b> ${esc(b.firstNames)}</td>
      <td>${esc(b.classe ?? "—")}</td>
      <td>${esc(b.label)}</td>
      <td><span class="pill ${b.kind === "bourse" ? "p-info" : "p-ok"}">${b.kind}</span></td>
      <td class="r num">${b.percent !== null ? `${b.percent} %` : fcfa(b.amountFcfa) + " F"}</td>
      <td class="r num">${fcfa(b.effetFcfa)} F</td>
      <td>${b.factureAJour
        ? `<span class="pill p-ok">à jour</span>`
        : `<span class="pill p-bad">décalée</span>`}</td>
      <td class="r"><form method="post" action="/bourses/retirer" style="margin:0">
        <input type="hidden" name="id" value="${b.id}">
        <button class="btn ghost" type="submit"
                style="height:32px;padding:0 12px">Retirer</button></form></td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="body"><p class="hint" style="margin:0">
    Aucune remise accordée cette année.</p></div>`}

  <form method="post" action="/bourses" class="body" style="border-top:1px solid var(--rule)">
    <div class="trois">
      <div><label for="eleve">Élève</label>
        <select id="eleve" name="eleve">
          ${d.eleves.map((e: any) => `<option value="${e.id}">${esc(e.last_name)} ${
            esc(e.first_names)}${e.classe ? ` — ${esc(e.classe)}` : ""}</option>`).join("")}
        </select></div>
      <div><label for="motif">Motif</label>
        <select id="motif" name="motif">
          ${MOTIFS.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}
        </select></div>
      <div><label for="nature">Nature</label>
        <select id="nature" name="nature">
          <option value="remise">Remise de l'établissement</option>
          <option value="bourse">Bourse (financée par un tiers)</option>
        </select></div>
    </div>
    <div class="trois" style="margin-top:14px">
      <div><label for="pourcent">Pourcentage</label>
        <input type="text" id="pourcent" name="pourcent" inputmode="numeric"
               placeholder="50"></div>
      <div><label for="montant">ou montant (FCFA)</label>
        <input type="text" id="montant" name="montant" inputmode="numeric"
               placeholder="20000"></div>
    </div>
    <p class="hint">Un pourcentage <b>ou</b> un montant, pas les deux. Plusieurs
    remises pour un même élève s'appliquent l'une après l'autre : deux fois
    50 % font 75 %, pas la gratuité.</p>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn">Accorder</button>
    </div>
  </form>
</div>`;

  return page(chrome, "Bourses et remises", body);
}
