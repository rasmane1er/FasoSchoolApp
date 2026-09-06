/**
 * Dossier de catégorisation.
 *
 * L'arrêté n°2026-101 conditionne le plafond légal des frais de scolarité au
 * score de l'établissement sur 100 points : 50 pour l'investissement, 50 pour
 * la qualité. C'est le dossier qui décide de ce qu'un établissement a le droit
 * de facturer — donc le document le plus rentable de son année, et celui qu'on
 * monte dans l'urgence à partir de bouts de papier.
 *
 * CE QUI EST ICI ET CE QUI NE L'EST PAS
 *
 * Ce qui est ici : la constitution du dossier. Les critères, leurs points, la
 * pièce justificative de chacun, le total sur 100, et ce qui manque encore.
 *
 * Ce qui n'y est PAS, volontairement : la grille officielle des critères, les
 * seuils qui font passer de la catégorie 3 à la catégorie 1, et le plafond de
 * frais qui en découle par cycle. Ces tables n'ont pas pu être obtenues. Les
 * inventer aurait produit un écran d'apparence sérieuse conduisant un
 * établissement à facturer un montant illégal — c'est l'erreur la plus chère
 * que ce logiciel pourrait commettre.
 *
 * Donc : l'établissement saisit ses propres lignes de critères (celles de son
 * exemplaire de l'arrêté), le logiciel additionne, et c'est un humain qui lit
 * la catégorie et le plafond dans le texte et les inscrit. Le jour où les
 * tables sont en main, elles deviendront des données datées comme le reste.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, fcfa, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export const AXES = [
  ["investissement", "Investissement"],
  ["qualite", "Qualité"],
] as const;

export interface Criterion {
  id: string;
  axis: "investissement" | "qualite";
  code: string;
  label: string;
  maxPoints: number;
  awardedPoints: number | null;
  evidenceKey: string | null;
  note: string | null;
}

export interface Dossier {
  id: string;
  yearId: string;
  yearLabel: string;
  status: string;
  category: number | null;
  declaredCeiling: number | null;
  criteria: Criterion[];
}

/** Sommes par axe, plafonnées à 50 : le barème de l'arrêté est sur 50 + 50. */
export function scores(criteria: Criterion[]): {
  investissement: number; qualite: number; total: number;
  maxInvestissement: number; maxQualite: number;
  renseignes: number; manquants: number; sansPiece: number;
} {
  const sum = (axis: string, pick: (c: Criterion) => number) =>
    criteria.filter((c) => c.axis === axis).reduce((a, c) => a + pick(c), 0);

  const investissement = sum("investissement", (c) => c.awardedPoints ?? 0);
  const qualite = sum("qualite", (c) => c.awardedPoints ?? 0);
  return {
    investissement, qualite, total: investissement + qualite,
    maxInvestissement: sum("investissement", (c) => c.maxPoints),
    maxQualite: sum("qualite", (c) => c.maxPoints),
    renseignes: criteria.filter((c) => c.awardedPoints !== null).length,
    manquants: criteria.filter((c) => c.awardedPoints === null).length,
    // Des points accordés sans pièce justificative : c'est ce que l'inspection
    // retire en premier.
    sansPiece: criteria.filter((c) =>
      (c.awardedPoints ?? 0) > 0 && !c.evidenceKey).length,
  };
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadDossier(schoolId: string): Promise<Dossier | null> {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id, label from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return null;
    const yearId = y.rows[0].id as string;

    let a = await c.query(
      `select id, category, declared_ceiling_fcfa, status
         from category_assessments where academic_year_id = $1`, [yearId]);
    if (a.rowCount === 0) {
      a = await c.query(
        `insert into category_assessments (school_id, academic_year_id, status)
         values (current_school_id(), $1, 'brouillon')
         returning id, category, declared_ceiling_fcfa, status`, [yearId]);
    }

    const crit = await c.query(
      `select id, axis, code, label, max_points, awarded_points, evidence_key, note
         from category_criteria where category_assessment_id = $1
        order by axis, code`, [a.rows[0].id]);

    return {
      id: a.rows[0].id as string,
      yearId, yearLabel: y.rows[0].label as string,
      status: a.rows[0].status as string,
      category: a.rows[0].category as number | null,
      declaredCeiling: a.rows[0].declared_ceiling_fcfa as number | null,
      criteria: crit.rows.map((r) => ({
        id: r.id, axis: r.axis, code: r.code, label: r.label,
        maxPoints: Number(r.max_points),
        awardedPoints: r.awarded_points === null ? null : Number(r.awarded_points),
        evidenceKey: r.evidence_key, note: r.note,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const num = (raw: string | null): number | null => {
  const t = (raw ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export async function saveDossier(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const schoolId = user.schoolId!;
  const dossier = await loadDossier(schoolId);
  if (!dossier) return { error: "Aucune année scolaire ouverte." };

  return withSchool(schoolId, async (c) => {
    let modifies = 0;
    const refuses: string[] = [];

    for (const crit of dossier.criteria) {
      const points = num(form.get(`p_${crit.id}`));
      const piece = (form.get(`e_${crit.id}`) ?? "").trim() || null;

      if (points !== null && (points < 0 || points > crit.maxPoints)) {
        refuses.push(`${crit.code} : ${points} points pour un maximum de ${crit.maxPoints}.`);
        continue;
      }
      await c.query(
        `update category_criteria set awarded_points = $2, evidence_key = $3
          where id = $1`, [crit.id, points, piece]);
      modifies += 1;
    }

    // Les scores par axe sont RECALCULÉS depuis les critères, jamais saisis :
    // deux nombres qui devraient être égaux et qu'on peut saisir séparément
    // finissent toujours par diverger.
    const relu = await c.query(
      `select axis, coalesce(sum(awarded_points), 0) as pts
         from category_criteria where category_assessment_id = $1
        group by axis`, [dossier.id]);
    const parAxe = new Map(relu.rows.map((r) => [r.axis as string, Number(r.pts)]));

    const categorie = num(form.get("categorie"));
    const plafond = num(form.get("plafond"));
    if (categorie !== null && ![1, 2, 3].includes(categorie)) {
      return { error: "La catégorie est 1, 2 ou 3." };
    }

    await c.query(
      `update category_assessments
          set investment_score = $2, quality_score = $3,
              category = $4, declared_ceiling_fcfa = $5
        where id = $1`,
      [dossier.id,
       Math.min(parAxe.get("investissement") ?? 0, 50),
       Math.min(parAxe.get("qualite") ?? 0, 50),
       categorie, plafond === null ? null : Math.round(plafond)]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'categorisation.save', 'category_assessment', $2, $3)`,
      [user.userId, dossier.id, JSON.stringify({ criteres: modifies })]);

    if (refuses.length) return { error: refuses.join(" ") };
    return { flash: `${plural(modifies, "critère enregistré", "critères enregistrés")}.` };
  });
}

export async function addCriterion(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const schoolId = user.schoolId!;
  const dossier = await loadDossier(schoolId);
  if (!dossier) return { error: "Aucune année scolaire ouverte." };

  const axis = form.get("axe") === "qualite" ? "qualite" : "investissement";
  const code = (form.get("code") ?? "").trim().toUpperCase();
  const label = (form.get("intitule") ?? "").trim();
  const max = num(form.get("max"));

  if (!code || !label) return { error: "Un critère a un code et un intitulé." };
  if (max === null || max <= 0) return { error: "Indiquez le nombre de points du critère." };

  return withSchool(schoolId, async (c) => {
    const dup = await c.query(
      `select 1 from category_criteria
        where category_assessment_id = $1 and code = $2`, [dossier.id, code]);
    if (dup.rowCount! > 0) return { error: `Le critère ${code} existe déjà.` };

    await c.query(
      `insert into category_criteria
         (school_id, category_assessment_id, axis, code, label, max_points)
       values (current_school_id(), $1, $2, $3, $4, $5)`,
      [dossier.id, axis, code, label, max]);
    return { flash: `Critère ${code} ajouté.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function categorisationPage(
  user: SessionUser, chrome: PageChrome, flash?: string, error?: string,
): Promise<string> {
  const d = await loadDossier(user.schoolId!);
  if (!d) {
    return page(chrome, "Catégorisation",
      `<h1>Catégorisation</h1><div class="note warn">Aucune année scolaire ouverte.</div>`);
  }
  const s = scores(d.criteria);

  const tile = (v: string, k: string, n: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="n">${n}</div></div>`;

  const ligne = (crit: Criterion) => {
    const vide = crit.awardedPoints === null;
    const sansPiece = (crit.awardedPoints ?? 0) > 0 && !crit.evidenceKey;
    return `<tr${vide ? ' class="warn"' : sansPiece ? ' class="bad"' : ""}>
      <td><b>${esc(crit.code)}</b></td>
      <td>${esc(crit.label)}</td>
      <td class="r">
        <input type="text" name="p_${crit.id}" inputmode="decimal"
               value="${crit.awardedPoints ?? ""}"
               style="width:74px;height:36px;text-align:right;display:inline-block">
        <span style="color:var(--faint)"> / ${crit.maxPoints}</span></td>
      <td><input type="text" name="e_${crit.id}" value="${esc(crit.evidenceKey ?? "")}"
                 placeholder="référence de la pièce"
                 style="height:36px;min-width:200px;display:inline-block"></td>
      <td>${vide ? `<span class="pill p-warn">non renseigné</span>`
        : crit.awardedPoints === 0 ? `<span class="pill p-info">0 point</span>`
        : sansPiece ? `<span class="pill p-bad">sans pièce</span>`
        : `<span class="pill p-ok">justifié</span>`}</td>
    </tr>`;
  };

  const axe = (code: string, titre: string, obtenu: number, max: number) => {
    const lignes = d.criteria.filter((c) => c.axis === code);
    return `<div class="card">
      <header><b>${titre}</b>
        <span style="color:var(--muted);font-size:13px">${obtenu} / ${max} points ·
          ${plural(lignes.length, "critère", "critères")}</span></header>
      ${max > 50 ? `<div class="body" style="padding-bottom:0"><div class="note bad">
        Les critères saisis pour cet axe totalisent ${max} points, alors que
        l'arrêté le note sur 50. Le score retenu est plafonné à 50 — vérifiez
        vos lignes sur votre exemplaire du texte.</div></div>` : ""}
      ${lignes.length ? `<div class="scroll"><table>
        <thead><tr><th>Code</th><th>Critère</th><th class="r">Points</th>
          <th>Pièce justificative</th><th>État</th></tr></thead>
        <tbody>${lignes.map(ligne).join("")}</tbody>
      </table></div>` : `<div class="body"><p class="hint" style="margin:0">
        Aucun critère saisi pour cet axe.</p></div>`}
    </div>`;
  };

  const body = `
<div>
  <h1>Dossier de catégorisation</h1>
  <p class="sub">Année ${esc(d.yearLabel)}. L'arrêté n°2026-101 conditionne le
  plafond légal des frais au score de l'établissement sur 100 points.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="tiles">
  ${tile(`${s.total}`, "Score total", "sur 100 points")}
  ${tile(`${s.investissement}`, "Investissement", `sur ${s.maxInvestissement} saisis`)}
  ${tile(`${s.qualite}`, "Qualité", `sur ${s.maxQualite} saisis`)}
  ${tile(`${s.manquants}`, "À renseigner", "critères sans points")}
</div>

${s.sansPiece ? `<div class="note bad">
  ${plural(s.sansPiece, "critère porte des points sans pièce justificative",
    "critères portent des points sans pièce justificative")}.
  C'est ce qu'une inspection retire en premier.</div>` : ""}

<div class="note warn">
  <b>La grille officielle n'est pas encodée dans le logiciel.</b> Les seuils qui
  font passer d'une catégorie à l'autre, et le plafond de frais qui en découle
  par cycle, n'ont pas pu être obtenus. Les inventer produirait un écran
  d'apparence sérieuse conduisant à facturer un montant illégal. Saisissez donc
  ici les critères de votre exemplaire de l'arrêté ; le logiciel additionne, et
  c'est vous qui lisez la catégorie et le plafond dans le texte.
</div>

<form method="post" action="/categorisation">
  ${axe("investissement", "Investissement", s.investissement, s.maxInvestissement)}
  ${axe("qualite", "Qualité", s.qualite, s.maxQualite)}

  <div class="card">
    <header><b>Déclaration</b>
      <span style="color:var(--muted);font-size:13px">lue dans l'arrêté, pas calculée</span>
    </header>
    <div class="body row" style="align-items:flex-end">
      <div style="width:180px">
        <label for="categorie">Catégorie (1, 2 ou 3)</label>
        <input type="text" id="categorie" name="categorie" inputmode="numeric"
               value="${d.category ?? ""}">
      </div>
      <div style="width:240px">
        <label for="plafond">Plafond déclaré (FCFA)</label>
        <input type="text" id="plafond" name="plafond" inputmode="numeric"
               value="${d.declaredCeiling ?? ""}">
      </div>
      <div class="grow"></div>
      <button type="submit" class="btn">Enregistrer le dossier</button>
    </div>
    ${d.declaredCeiling ? `<div class="body" style="border-top:1px solid var(--rule)">
      <p class="hint" style="margin:0">Plafond déclaré :
      <b>${fcfa(d.declaredCeiling)} FCFA</b> — à confronter aux lignes de frais
      marquées « plafonné » dans la scolarité.</p></div>` : ""}
  </div>
</form>

<div class="card">
  <header><b>Ajouter un critère</b></header>
  <form method="post" action="/categorisation/critere" class="body">
    <div class="trois">
      <div><label for="axe">Axe</label>
        <select id="axe" name="axe">
          ${AXES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
        </select></div>
      <div><label for="code">Code</label>
        <input type="text" id="code" name="code" placeholder="BATI"></div>
      <div><label for="max">Points maximum</label>
        <input type="text" id="max" name="max" inputmode="decimal" placeholder="8"></div>
    </div>
    <div style="margin-top:14px">
      <label for="intitule">Intitulé</label>
      <input type="text" id="intitule" name="intitule"
             placeholder="Qualité du bâti et clôture">
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn ghost">Ajouter</button>
    </div>
  </form>
</div>`;

  return page(chrome, "Catégorisation", body);
}
