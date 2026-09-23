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
import { piecesParCritere, blocPieces, TYPES_ACCEPTES } from "./pieces.ts";
import { loadExamens } from "./examens.ts";

/** Une date ISO en jour français. */
const jourFr = (iso: string): string => {
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

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
  /** Description en clair de la pièce attendue. N'EST PAS une preuve. */
  evidenceKey: string | null;
  /** Le nombre de documents RÉELLEMENT joints. C'est cela, la preuve. */
  pieces: number;
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
  /* CE QU'ON SAIT DE L'ÉTAT DU PLAFOND, et rien de plus.
   *
   * Les deux écrans écrivaient « plafond déclaré » sur un chiffre qu'un
   * humain venait de taper dans un brouillon. Le mot affirmait qu'une
   * déclaration avait eu lieu ; rien dans le produit ne pouvait le savoir,
   * parce que rien ne l'écrivait. */
  declaration: Declaration;
  /** L'histoire du plafond : on n'écrase pas un chiffre qui décide d'une
   *  sanction, on écrit le suivant à côté du précédent. */
  mouvements: Mouvement[];
  /** Les grilles dont les lignes plafonnées dépassent le plafond. */
  horsPlafond: HorsPlafond[];
}

export interface Declaration {
  statut: string;
  declareLe: string | null;
  declarePar: string | null;
  saisiLe: string | null;
  possible: boolean;
  raison: string | null;
}

export interface Mouvement {
  ancien: number | null;
  nouveau: number | null;
  ancienneCategorie: number | null;
  nouvelleCategorie: number | null;
  motif: string | null;
  apresDeclaration: boolean;
  par: string | null;
  quand: string;
}

export interface HorsPlafond {
  scheduleId: string;
  libelle: string;
  niveau: string | null;
  plafonne: number;
  plafond: number;
  ecart: number;
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
    /* Des points accordés sans pièce justificative : c'est ce que l'inspection
       retire en premier.

       Ce compte portait sur `evidenceKey`, un champ de TEXTE LIBRE. Il
       suffisait donc de taper quelque chose pour qu'un critère cesse d'être
       « sans pièce » et devienne « justifié ». Il porte désormais sur le
       nombre de documents réellement joints — ce qu'on ne peut pas obtenir en
       tapant. */
    sansPiece: criteria.filter((c) =>
      (c.awardedPoints ?? 0) > 0 && c.pieces === 0).length,
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
      `select id, axis, code, label, max_points, awarded_points, evidence_key,
              note, pieces_du_critere(id) as pieces
         from category_criteria where category_assessment_id = $1
        order by axis, code`, [a.rows[0].id]);

    /* L'ÉTAT DU PLAFOND SE LIT EN UN SEUL ENDROIT — `plafond_du_dossier()` —
     * pour que l'écran des frais et celui du dossier ne puissent plus dire
     * deux choses différentes du même chiffre. */
    const etat = (await c.query(`select * from plafond_du_dossier()`)).rows[0];
    const verdict = (await c.query(`select * from dossier_declarable()`)).rows[0];

    const mvt = await c.query(
      `select cc.ancien_fcfa, cc.nouveau_fcfa, cc.ancienne_categorie,
              cc.nouvelle_categorie, cc.motif, cc.apres_declaration,
              cc.quand,
              (select u.full_name from staff sa
                 left join users u on u.id = sa.user_id
                where sa.id = cc.par) as par
         from category_ceiling_changes cc
        where cc.category_assessment_id = $1
        order by cc.quand desc limit 12`, [a.rows[0].id]);

    const hors = await c.query(
      `select schedule_id, libelle, niveau, plafonne, plafond, ecart
         from grilles_hors_plafond($1)`, [yearId]);

    return {
      id: a.rows[0].id as string,
      yearId, yearLabel: y.rows[0].label as string,
      status: a.rows[0].status as string,
      category: a.rows[0].category as number | null,
      declaredCeiling: a.rows[0].declared_ceiling_fcfa as number | null,
      declaration: {
        statut: etat?.statut ?? "brouillon",
        declareLe: etat?.declare_le === null || etat?.declare_le === undefined
          ? null : String(etat.declare_le),
        declarePar: etat?.declare_par ?? null,
        saisiLe: etat?.saisi_le ? new Date(etat.saisi_le).toISOString() : null,
        possible: verdict?.possible === true,
        raison: verdict?.raison ?? null,
      },
      mouvements: mvt.rows.map((r) => ({
        ancien: r.ancien_fcfa === null ? null : Number(r.ancien_fcfa),
        nouveau: r.nouveau_fcfa === null ? null : Number(r.nouveau_fcfa),
        ancienneCategorie: r.ancienne_categorie === null ? null : Number(r.ancienne_categorie),
        nouvelleCategorie: r.nouvelle_categorie === null ? null : Number(r.nouvelle_categorie),
        motif: r.motif, apresDeclaration: r.apres_declaration === true,
        par: r.par, quand: new Date(r.quand).toISOString(),
      })),
      horsPlafond: hors.rows.map((r) => ({
        scheduleId: r.schedule_id, libelle: r.libelle, niveau: r.niveau,
        plafonne: Number(r.plafonne), plafond: Number(r.plafond),
        ecart: Number(r.ecart),
      })),
      criteria: crit.rows.map((r) => ({
        id: r.id, axis: r.axis, code: r.code, label: r.label,
        maxPoints: Number(r.max_points),
        awardedPoints: r.awarded_points === null ? null : Number(r.awarded_points),
        evidenceKey: r.evidence_key, pieces: Number(r.pieces), note: r.note,
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
      /* UN CHAMP ABSENT VEUT DIRE « NON SOUMIS », PAS « EFFACE ».
       *
       * Cette boucle lisait `form.get(...)`, qui renvoie null aussi bien pour
       * une case vidée que pour une case ABSENTE de l'envoi. Un POST partiel
       * — un formulaire rendu avant l'ajout d'un critère, une requête
       * fabriquée, un écran rechargé à moitié — effaçait donc en silence les
       * points de TOUS les critères qu'il ne mentionnait pas. Le dossier qui
       * décide du plafond légal des frais se vidait sans un mot.
       *
       * Trouvé parce qu'une autre suite envoyait un POST ne portant qu'un
       * critère, et que les douze autres se sont retrouvés à null. */
      const aPoints = form.has(`p_${crit.id}`);
      const aPiece = form.has(`e_${crit.id}`);
      if (!aPoints && !aPiece) continue;

      const points = aPoints ? num(form.get(`p_${crit.id}`)) : crit.awardedPoints;
      const piece = aPiece
        ? ((form.get(`e_${crit.id}`) ?? "").trim() || null)
        : crit.evidenceKey;

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

    /* MÊME RÈGLE QUE POUR LES CRITÈRES, À L'ÉTAGE DU DESSUS : un champ ABSENT
     * de l'envoi veut dire « non soumis », pas « efface ». Elle avait été
     * posée pour les points et pas pour les deux chiffres qui décident du
     * plafond légal — un POST partiel effaçait donc en silence la catégorie
     * et le plafond de tout l'établissement. */
    const aCategorie = form.has("categorie");
    const aPlafond = form.has("plafond");
    const categorie = aCategorie ? num(form.get("categorie")) : dossier.category;
    const plafondBrut = aPlafond ? num(form.get("plafond")) : dossier.declaredCeiling;
    const plafond = plafondBrut === null ? null : Math.round(plafondBrut);
    if (categorie !== null && ![1, 2, 3].includes(categorie)) {
      return { error: "La catégorie est 1, 2 ou 3." };
    }
    if (plafond !== null && plafond < 0) {
      return { error: "Un plafond ne peut pas être négatif." };
    }

    /* LE PLAFOND NE BOUGE PAS SANS TRACE.
     *
     * C'est le chiffre qui rend toute la grille légale ou illégale, et le
     * chemin le plus court quand la grille dépasse n'est pas de baisser la
     * grille : c'est de monter le plafond. Éprouvé : un POST le faisait
     * passer de 1 000 à 9 999 999, et le journal n'en gardait rien.
     *
     * Après déclaration, le mouvement exige en plus un MOTIF : ce chiffre est
     * alors censé être sorti de l'établissement, et le corriger est un acte,
     * pas une saisie. */
    const bouge = plafond !== dossier.declaredCeiling
      || categorie !== dossier.category;
    const dejaDeclare = dossier.declaration.statut === "declare";
    const motif = (form.get("motif_plafond") ?? "").trim();
    if (bouge && dejaDeclare && motif.length < 5) {
      return { error: "Ce dossier est déclaré. Dites pourquoi le plafond ou la "
        + "catégorie change — « erreur de lecture de l'arrêté », « nouvelle "
        + "notification du ministère » — avant d'enregistrer. Rien n'a été "
        + "modifié." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    await c.query(
      `update category_assessments
          set investment_score = $2, quality_score = $3,
              category = $4, declared_ceiling_fcfa = $5
        where id = $1`,
      [dossier.id,
       Math.min(parAxe.get("investissement") ?? 0, 50),
       Math.min(parAxe.get("qualite") ?? 0, 50),
       categorie, plafond]);

    if (bouge) {
      await c.query(
        `insert into category_ceiling_changes
           (school_id, category_assessment_id, ancien_fcfa, nouveau_fcfa,
            ancienne_categorie, nouvelle_categorie, motif, apres_declaration, par)
         values (current_school_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
        [dossier.id, dossier.declaredCeiling, plafond,
         dossier.category, categorie, motif || null, dejaDeclare, staffId]);
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'categorisation.save', 'category_assessment', $2, $3)`,
      [user.userId, dossier.id, JSON.stringify({
        criteres: modifies,
        plafond: bouge ? { de: dossier.declaredCeiling, a: plafond } : undefined,
        categorie: bouge ? { de: dossier.category, a: categorie } : undefined,
        motif: motif || undefined,
      })]);

    if (refuses.length) return { error: refuses.join(" ") };
    const dit = bouge
      ? ` Plafond : ${dossier.declaredCeiling === null
            ? "non renseigné" : `${fcfa(dossier.declaredCeiling)} F`} → ${
            plafond === null ? "non renseigné" : `${fcfa(plafond)} F`}.`
      : "";
    return { flash: `${plural(modifies, "critère enregistré", "critères enregistrés")}.${dit}` };
  });
}

/* ---------------------------------------------------------------------------
 * DÉCLARER LE DOSSIER.
 *
 * `category_assessments.status` était écrit une fois, à la création, à
 * `'brouillon'`, et plus jamais ; `declared_on` n'était écrit nulle part. Les
 * deux écrans disaient pourtant « plafond déclaré ». Le mot était une
 * affirmation du produit sur un fait qu'il ne connaissait pas.
 *
 * Déclarer n'est pas enregistrer : c'est dire que ces chiffres ont quitté
 * l'établissement. Le produit ne peut pas le vérifier — aucun canal ne le
 * relie au ministère — mais il peut savoir QUI l'a affirmé et QUAND, et ne
 * plus écrire le mot avant.
 */
export async function declarerDossier(
  user: SessionUser,
): Promise<{ flash?: string; error?: string }> {
  const schoolId = user.schoolId!;
  const dossier = await loadDossier(schoolId);
  if (!dossier) return { error: "Aucune année scolaire ouverte." };
  if (!dossier.declaration.possible) {
    return { error: dossier.declaration.raison ?? "Ce dossier ne peut pas être déclaré." };
  }

  return withSchool(schoolId, async (c) => {
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;
    if (!staffId) {
      return { error: "Seul un membre du personnel peut déclarer un dossier." };
    }

    await c.query(
      `update category_assessments
          set status = 'declare', declared_on = current_date, declared_by = $2
        where id = $1 and status <> 'declare'`, [dossier.id, staffId]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'categorisation.declare', 'category_assessment', $2, $3)`,
      [user.userId, dossier.id, JSON.stringify({
        categorie: dossier.category, plafond: dossier.declaredCeiling })]);

    return { flash: `Dossier déclaré : catégorie ${dossier.category}, plafond `
      + `${fcfa(dossier.declaredCeiling!)} FCFA. À partir d'aujourd'hui, les `
      + `écrans peuvent écrire « déclaré » — et tout changement de ce plafond `
      + `demandera un motif.` };
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
  const dec = d.declaration;
  const pieces = await piecesParCritere(user.schoolId!);

  /* LES CHIFFRES QUE LE LOGICIEL ÉTABLIT DÉJÀ.
   *
   * C'est l'argument central pour lequel un établissement achète un système de
   * gestion plutôt qu'un tableur : la moitié qualité de la grille réclame des
   * chiffres qu'un système produit comme sous-produit — effectifs par classe,
   * résultats aux examens — et qu'une école sans système rassemble à la main
   * chaque année.
   *
   * LE LOGICIEL NE LES NOTE PAS. Il les établit et dit à quel critère ils se
   * rapportent. La grille de l'arrêté n'a pas pu être obtenue ; convertir un
   * taux en points serait inventer le barème dont dépend ce qu'une école a le
   * droit de facturer. */
  const examens = await loadExamens(user.schoolId!);
  const effectifs = await withSchool(user.schoolId!, async (c) => {
    if (!examens.annee) return [];
    return (await c.query(
      `select classe, effectif from effectifs_par_classe($1)`,
      [examens.annee.id])).rows as Array<{ classe: string; effectif: number }>;
  });

  const tile = (v: string, k: string, n: string) =>
    `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>
       <div class="n">${n}</div></div>`;

  const ligne = (crit: Criterion) => {
    const vide = crit.awardedPoints === null;
    const sansPiece = (crit.awardedPoints ?? 0) > 0 && crit.pieces === 0;
    return `<tr${vide ? ' class="warn"' : sansPiece ? ' class="bad"' : ""}>
      <td><b>${esc(crit.code)}</b></td>
      <td>${esc(crit.label)}
        <div style="margin-top:4px">
          <input type="text" name="e_${crit.id}" form="dossier"
                 value="${esc(crit.evidenceKey ?? "")}"
                 placeholder="ce que la pièce doit montrer"
                 style="height:32px;font-size:12.5px;min-width:220px;display:inline-block"></div></td>
      <td class="r">
        <input type="text" name="p_${crit.id}" form="dossier" inputmode="decimal"
               value="${crit.awardedPoints ?? ""}"
               style="width:74px;height:36px;text-align:right;display:inline-block">
        <span style="color:var(--faint)"> / ${crit.maxPoints}</span></td>
      <td style="min-width:260px">${blocPieces(crit.id, pieces.get(crit.id) ?? [])}</td>
      <td>${vide ? `<span class="pill p-warn">non renseigné</span>`
        : crit.awardedPoints === 0 ? `<span class="pill p-info">0 point</span>`
        : sansPiece ? `<span class="pill p-bad">sans pièce</span>`
        : `<span class="pill p-ok">${plural(crit.pieces, "pièce")}</span>`}</td>
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
        <thead><tr><th>Code</th><th>Critère et pièce attendue</th><th class="r">Points</th>
          <th>Pièces jointes</th><th>État</th></tr></thead>
        <tbody>${lignes.map(ligne).join("")}</tbody>
      </table></div>` : `<div class="body"><p class="hint" style="margin:0">
        Aucun critère saisi pour cet axe.</p></div>`}
    </div>`;
  };

  const nb = effectifs.map((e) => Number(e.effectif));
  const chiffres = `
<div class="card" style="margin-bottom:18px">
  <header><b>Ce que le logiciel établit déjà</b>
    <span style="color:var(--muted);font-size:13px">chiffres, pas points</span></header>
  <div class="body">
    <p class="hint" style="margin:0 0 12px">La moitié « qualité » de la grille
    réclame des chiffres qu'un établissement sans logiciel recompte à la main
    chaque année. Les voici, tirés de vos propres données. <b>Le logiciel ne
    les convertit pas en points</b> : la grille de l'arrêté n'a pas pu être
    obtenue, et l'inventer conduirait à facturer un montant illégal.</p>

    <div class="tiles">
      ${nb.length ? `<div class="tile">
        <div class="k">Effectif par classe</div>
        <div class="v">${Math.min(...nb)}&ndash;${Math.max(...nb)}</div>
        <div class="n">${plural(nb.length, "classe")} ·
          moyenne ${Math.round(nb.reduce((a, b) => a + b, 0) / nb.length)}
          · critère « Effectifs par classe »</div>
      </div>` : ""}
      ${examens.taux.map((t) => `<div class="tile">
        <div class="k">${esc(t.label)}</div>
        <div class="v">${t.taux === null ? "—" : `${String(t.taux).replace(".", ",")}&nbsp;%`}</div>
        <div class="n">${t.presentes === 0
          ? `<a href="/examens">à saisir</a>`
          : `${t.admis} admis sur ${t.presentes} présentés`}
          · critère « Résultats aux examens »</div>
      </div>`).join("")}
    </div>

    ${examens.taux.some((t) => t.presentes === 0) ? `<div class="note warn"
      style="margin-top:14px">Des résultats d'examen ne sont pas saisis. Tant
      qu'ils manquent, le critère le plus lourd de l'axe qualité n'a aucun
      chiffre à l'appui — <a href="/examens">les saisir</a>.</div>` : ""}
  </div>
</div>
`;

  const body = `
<div>
  <h1>Dossier de catégorisation</h1>
  <p class="sub">Année ${esc(d.yearLabel)}. L'arrêté n°2026-101 conditionne le
  plafond légal des frais au score de l'établissement sur 100 points.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}
${chiffres}

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

<!-- LE FORMULAIRE DU DOSSIER EST VIDE, ET C'EST VOULU.
     Les champs qui lui appartiennent le désignent par form="dossier". La
     raison : chaque critère porte son propre formulaire d'envoi de fichier,
     dans une cellule du tableau. Un formulaire DANS un formulaire est interdit
     en HTML — le navigateur ferme celui du dehors en rencontrant celui du
     dedans, et tout ce qui suit se retrouve à l'extérieur. Écran de dossier
     entier cassé : le bouton « Enregistrer » n'appartenait plus à rien et ne
     soumettait rien. Trouvé par le parcours navigateur, jamais en relisant le
     HTML. L'attribut form= fait ce travail, sans une ligne de script. -->
<form method="post" action="/categorisation" id="dossier"></form>

  ${axe("investissement", "Investissement", s.investissement, s.maxInvestissement)}
  ${axe("qualite", "Qualité", s.qualite, s.maxQualite)}

  <div class="card">
    <header><b>Catégorie et plafond</b>
      <span style="color:var(--muted);font-size:13px">lus dans l'arrêté, pas calculés</span>
    </header>
    <div class="body row" style="align-items:flex-end">
      <div style="width:180px">
        <label for="categorie">Catégorie (1, 2 ou 3)</label>
        <input type="text" id="categorie" name="categorie" form="dossier" inputmode="numeric"
               value="${d.category ?? ""}">
      </div>
      <div style="width:240px">
        <label for="plafond">Plafond (FCFA)</label>
        <input type="text" id="plafond" name="plafond" form="dossier" inputmode="numeric"
               value="${d.declaredCeiling ?? ""}">
      </div>
      ${dec.statut === "declare" ? `<div class="grow">
        <label for="motif_plafond">Motif du changement</label>
        <input type="text" id="motif_plafond" name="motif_plafond" form="dossier"
               placeholder="nouvelle notification du ministère">
      </div>` : `<div class="grow"></div>`}
      <button type="submit" class="btn" form="dossier">Enregistrer le dossier</button>
    </div>

    ${dec.statut === "declare" ? `<div class="body" style="border-top:1px solid var(--rule)">
      <p class="hint" style="margin:0"><b>Dossier déclaré le
      ${jourFr(dec.declareLe!)}</b>${dec.declarePar ? ` par ${esc(dec.declarePar)}` : ""} :
      catégorie ${d.category}, plafond <b>${fcfa(d.declaredCeiling!)} FCFA</b>.
      Ce chiffre est celui auquel la scolarité compare votre grille. Le
      changer demande désormais un motif — il est censé être sorti
      d'ici.</p></div>`

    /* LE MOT « DÉCLARÉ » ÉTAIT ÉCRIT PARTOUT, ET RIEN N'AVAIT ÉTÉ DÉCLARÉ.
     * `status` restait « brouillon » à vie, `declared_on` n'était écrit nulle
     * part, et les deux écrans affirmaient pourtant qu'une déclaration avait
     * eu lieu. Le produit ne peut pas vérifier qu'un dossier est parti au
     * ministère ; il peut savoir qui l'a affirmé, et quand. */
    : `<div class="body" style="border-top:1px solid var(--rule)">
      <div class="note ${dec.possible ? "warn" : ""}">
        <b>Ce dossier n'a pas été déclaré.</b> Tant qu'il ne l'est pas, la
        scolarité parle d'un plafond « renseigné », pas « déclaré » : le
        logiciel n'a aucun moyen de savoir qu'un dossier a quitté
        l'établissement, et il ne l'écrira pas à votre place.
        ${dec.possible
          ? `Quand les chiffres ci-dessus sont ceux que vous avez transmis,
             dites-le ici.`
          : `<br><b>${esc(dec.raison ?? "")}</b>`}
        ${d.declaredCeiling !== null
          ? `<br>Ce plafond est à confronter aux lignes de frais marquées
             « plafonné » dans la scolarité : ce sont les seules qui y entrent.`
          : ""}
      </div>
      ${dec.possible ? `<form method="post" action="/categorisation/declarer"
             style="margin:12px 0 0">
        <button type="submit" class="btn">Déclarer le dossier
          — catégorie ${d.category}, plafond ${fcfa(d.declaredCeiling!)} F</button>
      </form>` : ""}
    </div>`}

    ${d.horsPlafond.length > 0 ? `<div class="body" style="border-top:1px solid var(--rule)">
      <div class="note bad"><b>${plural(d.horsPlafond.length,
        "grille de frais dépasse ce plafond", "grilles de frais dépassent ce plafond")}.</b>
        ${d.horsPlafond.map((g) => `<br>${esc(g.libelle)} :
          ${fcfa(g.plafonne)} F de lignes plafonnées, soit ${fcfa(g.ecart)} F de
          trop.`).join("")}
        <br>L'émission des factures de ces niveaux est refusée tant que l'écart
        demeure. <a href="/frais"><b>Voir la grille</b></a>.</div>
    </div>` : ""}

    ${d.mouvements.length > 0 ? `<div class="body" style="border-top:1px solid var(--rule)">
      <p class="hint" style="margin:0 0 8px"><b>L'histoire de ce plafond.</b>
      On n'écrase pas un chiffre qui décide d'une sanction : le chemin le plus
      court, quand la grille dépasse, n'est pas de baisser la grille.</p>
      <div class="scroll"><table><thead><tr>
        <th>Quand</th><th>Plafond</th><th>Catégorie</th><th>Par</th><th>Motif</th>
      </tr></thead><tbody>${d.mouvements.map((m) => `<tr>
        <td>${jourFr(m.quand.slice(0, 10))}</td>
        <td class="num">${m.ancien === null ? "—" : `${fcfa(m.ancien)} F`}
          → <b>${m.nouveau === null ? "—" : `${fcfa(m.nouveau)} F`}</b></td>
        <td class="num">${m.ancienneCategorie ?? "—"} → ${m.nouvelleCategorie ?? "—"}</td>
        <td>${m.par ? esc(m.par) : "—"}</td>
        <td>${m.motif ? esc(m.motif)
          : `<span style="color:var(--faint)">${m.apresDeclaration
              ? "—" : "avant déclaration"}</span>`}</td>
      </tr>`).join("")}</tbody></table></div>
    </div>` : ""}
  </div>

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
