/**
 * Ce qui demande une action, et rien d'autre.
 *
 * Un tableau de bord qui affiche vingt indicateurs verts n'est pas lu. Celui-ci
 * ne montre une ligne que lorsqu'il y a quelque chose à faire, chaque ligne dit
 * quoi faire, et mène à l'écran où le faire. Quand il n'y a rien, il le dit en
 * une phrase et se tait.
 *
 * L'ordre n'est pas décoratif : ce qui fausse un bulletin passe avant ce qui
 * fait perdre du temps, et ce qui fait perdre du temps avant ce qui est
 * simplement incomplet.
 */

import { withSchool } from "../lib/db.ts";
import { verdictCanal } from "../lib/sms.ts";
import { esc, plural, accord } from "./html.ts";
import { can, type SessionUser } from "./session.ts";

export type Gravite = "bloquant" | "important" | "a_faire";

export interface Point {
  gravite: Gravite;
  texte: string;
  action: string;
  lien: string;
  /** Droit requis pour ouvrir l'écran visé. Sans droit, le point est tu. */
  droit?: Parameters<typeof can>[1];
}

const RANG: Record<Gravite, number> = { bloquant: 0, important: 1, a_faire: 2 };

export async function pointsDAttention(
  user: SessionUser, yearId: string | null, termSequence: number | null,
): Promise<Point[]> {
  const schoolId = user.schoolId!;
  const points: Point[] = [];

  await withSchool(schoolId, async (c) => {
    const un = async (sql: string, params: unknown[] = []): Promise<number> =>
      Number((await c.query(sql, params)).rows[0]?.n ?? 0);

    // --- Ce qui fausse un bulletin -----------------------------------------

    const divergentes = await un(
      `select count(*)::int as n from sync_conflicts where resolved_at is null`);
    if (divergentes > 0) {
      points.push({
        gravite: "bloquant",
        texte: `${plural(divergentes, "note divergente attend", "notes divergentes attendent")} un arbitrage.`,
        action: "Arbitrer", lien: "/conflits", droit: "publier_bulletins",
      });
    }

    /* LA RÈGLE EN VIGUEUR, PAS TOUTES CELLES QUI ONT EXISTÉ.
     *
     * `grading_policies` est une table datée : `settings.ts` écrit une ligne
     * par année scolaire et ne touche jamais aux précédentes. Le décompte
     * portait sur toutes les lignes — donc un directeur qui confirmait ses
     * règles en 2026 laissait celle de 2024 avec sa note de provenance, et le
     * point bloquant restait allumé POUR TOUJOURS. Aucun geste offert par
     * l'écran ne pouvait l'éteindre : confirmer réécrit la ligne de l'année en
     * cours, qui était déjà propre. Éprouvé.
     *
     * Une règle révolue qui porte encore sa note n'est pas un problème : c'est
     * une archive. Un point rouge que rien ne peut éteindre, si — il apprend à
     * ne plus lire les rouges, ce que la première phrase de ce fichier
     * s'interdit. */
    const reglesNonConfirmees = await un(
      `select (case when regle_notation_a_confirmer()
                      or coefficients_a_confirmer() then 1 else 0 end) as n`);
    if (reglesNonConfirmees > 0) {
      points.push({
        gravite: "bloquant",
        texte: "Les règles de notation n'ont pas été confirmées : toutes les "
          + "moyennes calculées restent indicatives.",
        action: "Confirmer", lien: "/parametres", droit: "parametrer",
      });
    }

    // --- Ce qui fait perdre du temps ou de l'argent -------------------------

    if (yearId) {
      const sansTuteur = await un(
        `select count(*)::int as n from enrolments e
          where e.academic_year_id = $1
            and not exists (
              select 1 from student_guardians sg
                join guardians g on g.id = sg.guardian_id
               where sg.student_id = e.student_id and sg.receives_sms
                 and g.phone is not null and g.phone <> '')`, [yearId]);
      if (sansTuteur > 0) {
        points.push({
          gravite: "important",
          texte: `${plural(sansTuteur, "élève n'a aucun numéro de tuteur",
            "élèves n'ont aucun numéro de tuteur")} : `
            + `${accord(sansTuteur, "sa famille ne recevra",
                        "leurs familles ne recevront")} `
            + "aucun SMS d'absence.",
          action: "Compléter", lien: "/inscriptions", droit: "inscrire",
        });
      }
    }

    /* Une absence à une évaluation qui attend une explication : tant que
       personne ne tranche, la règle en vigueur peut la compter zéro dans une
       moyenne, et c'est un bulletin faux qui part chez la famille. */
    /* Bornée à l'année, et à la règle EN VIGUEUR. L'ancienne version comptait
     * toutes les années, et se déclenchait sur l'existence de N'IMPORTE QUELLE
     * politique comptant zéro — y compris une abandonnée depuis deux ans, y
     * compris une saisie d'avance pour l'an prochain. Un bulletin figé et remis
     * il y a deux ans entretenait ainsi un point que plus personne ne pouvait
     * résoudre. */
    const aJustifier = yearId && await un(
      `select (case when absence_non_justifiee_compte_zero()
                    then absences_evaluation_a_justifier($1) else 0 end) as n`,
      [yearId]) || 0;
    if (aJustifier > 0) {
      points.push({
        gravite: "bloquant",
        texte: `${plural(aJustifier, "absence à une évaluation attend",
          "absences à une évaluation attendent")} une explication. `
          + `Sans elle, ${accord(aJustifier, "elle compte", "elles comptent")} `
          + `zéro dans la moyenne.`,
        action: "Justifier", lien: "/justifications", droit: "faire_appel",
      });
    }

    // Un message refusé par l'opérateur n'est pas un incident technique : c'est
    // une famille qui n'a pas été prévenue et qui l'ignore. Tant que personne
    // ne s'en occupe, il remonte ici.
    const nonRemis = await un(
      `select count(*)::int as n from sms_messages
        where status in ('echoue', 'injoignable') and resolution is null`);
    if (nonRemis > 0) {
      points.push({
        gravite: "important",
        texte: `${plural(nonRemis, "message n'est pas parvenu",
          "messages ne sont pas parvenus")} à la famille. `
          + `${accord(nonRemis, "Elle croit", "Elles croient")} n'avoir rien à savoir.`,
        action: "Traiter", lien: "/messages", droit: "suivre_messages",
      });
    }

    const credit = await un(
      `select coalesce(sum(case when direction = 'achat' then messages
                                else -messages end), 0)::int as n
         from sms_credit_ledger`);
    if (credit < 100) {
      points.push({
        gravite: credit <= 0 ? "bloquant" : "important",
        texte: credit <= 0
          ? "Le crédit SMS est épuisé : plus aucune famille n'est prévenue."
          : `Il reste ${credit} SMS. À ce rythme le crédit tombera pendant le trimestre.`,
        action: "Voir", lien: "/absences", droit: "faire_appel",
      });
    }

    /* LE CALENDRIER LÉGAL COUVRE-T-IL L'ANNÉE EN COURS ?
     *
     * Les fêtes nationales étaient semées pour trois années seulement, écrites
     * en 2026. Passé 2028, une école n'en avait plus AUCUNE : l'appel du matin
     * s'ouvrait le 25 décembre, et quarante familles recevaient « votre enfant
     * est absent aujourd'hui » le jour de Noël. 0020 prolonge la liste, mais
     * une liste finie finit toujours par finir — alors on surveille. */
    if (yearId) {
      const sansFetes = await un(
        `select case when annee_sans_fetes_legales($1) then 1 else 0 end as n`,
        [yearId]);
      if (sansFetes > 0) {
        points.push({
          gravite: "bloquant",
          texte: "Aucune fête nationale n'est inscrite pour cette année "
            + "scolaire : l'appel s'ouvrirait un 25 décembre, et les familles "
            + "recevraient un SMS d'absence un jour sans école.",
          action: "Voir", lien: "/calendrier", droit: "faire_appel",
        });
      }
    }

    /* UN ÉLÈVE PARTI QUI GARDE UNE FACTURE OUVERTE.
     *
     * C'est la situation qui rend l'annulation d'une facture nécessaire — et
     * jusqu'ici le statut `annulee` était lu par onze écrans et écrit par
     * aucun : la facture d'un élève transféré en octobre pesait
     * indéfiniment sur le « reste à recouvrer » et dans les relances. Le
     * geste existe maintenant ; ce point-ci dit quand s'en servir. */
    const partis = await un(
      `select count(*)::int as n from factures_d_eleves_partis()`);
    if (partis > 0) {
      points.push({
        gravite: "important",
        texte: `${partis === 1
          ? "Un élève a quitté l'établissement en gardant une facture ouverte"
          : partis + " élèves ont quitté l'établissement en gardant une facture ouverte"}`
          + " : ces sommes pèsent sur le reste à recouvrer et partent en relance.",
        action: "Voir", lien: "/scolarite", droit: "voir_scolarite",
      });
    }

    /* LES NIVEAUX ENSEIGNÉS ONT-ILS UNE RÈGLE DE PASSAGE EN VIGUEUR ?
     *
     * L'absence de règle était lue comme une permission : `?? true`. Le conseil
     * de classe affichait « redouble » en CP1 — où l'arrêté de 2019 l'interdit
     * — et l'enregistrait. On le dit désormais AVANT la séance, sur le tableau
     * de bord, et pas au milieu d'une délibération. */
    const sansRegle = await un(
      `select count(*)::int as n from niveaux_sans_regle_de_passage()`);
    if (sansRegle > 0) {
      points.push({
        gravite: "bloquant",
        texte: `${sansRegle === 1 ? "Un niveau enseigné cette année n'a"
                                  : sansRegle + " niveaux enseignés cette année n'ont"} `
          + "aucune règle de passage en vigueur : le conseil de classe ne "
          + "pourra rien y prononcer.",
        action: "Voir", lien: "/conseil", droit: "publier_bulletins",
      });
    }

    /* ET DISENT-ELLES LA MÊME CHOSE QUE LE TEXTE NATIONAL ?
     *
     * L'arrêté de 2019 est encodé deux fois : en donnée nationale
     * (`levels.sub_cycle_position`) et par école (`promotion_rules`). Rien ne
     * les comparait. Une règle d'école mal saisie laissait l'interdiction sans
     * effet, en silence, sur l'écran qui décide de l'année d'un enfant. */
    const incoherents = await un(
      `select count(*)::int as n from ban_redoublement_incoherent()`);
    if (incoherents > 0) {
      points.push({
        gravite: "important",
        texte: `${incoherents === 1 ? "Un niveau autorise" : incoherents + " niveaux autorisent"} `
          + "le redoublement alors que l'arrêté de 2019 l'interdit en première "
          + "année de sous-cycle du primaire. La règle de l'établissement et le "
          + "texte national ne disent pas la même chose.",
        action: "Voir", lien: "/conseil", droit: "publier_bulletins",
      });
    }

    /* L'INSTALLATION SAIT-ELLE ENVOYER UN SMS ?
     *
     * En mode démonstration, rien ne part : ni absence, ni communiqué, ni
     * bulletin — et pourtant le produit annonce des envois, débite du crédit,
     * et affiche le code de connexion à l'écran. Le serveur le dit à son
     * démarrage, dans une console que personne ne relit. Il faut que ce soit
     * ici aussi, sur l'écran que le directeur ouvre chaque matin, et que ce
     * soit BLOQUANT : c'est l'état où la deuxième des trois promesses du
     * produit n'existe pas. */
    if (verdictCanal().simule) {
      points.push({
        gravite: "bloquant",
        texte: "Cette installation est en mode démonstration : AUCUN SMS ne "
          + "part, et le code de connexion s'affiche à l'écran. Les envois "
          + "annoncés par les autres écrans n'ont pas lieu.",
        action: "Voir", lien: "/messages", droit: "suivre_messages",
      });
    }

    /* LES FAMILLES EN RETARD SUR CE QUI ÉTAIT DÛ.
     *
     * Pas « celles qui doivent encore quelque chose » : en mars, c'est tout le
     * monde, et un point d'attention qui désigne tout le monde ne désigne
     * personne. `retard_de` compare au seul échéancier, et renvoie null quand
     * il n'y en a pas — un null ne compte pas ici, parce qu'on ne réclame pas
     * sur une échéance qu'on ne connaît pas. */
    const retardataires = await un(
      `select count(*)::int as n from invoices i
        where i.status <> 'annulee'
          and coalesce(retard_de(i.id, current_date), 0) > 0`);
    if (retardataires > 0) {
      const montant = await un(
        `select coalesce(sum(retard_de(i.id, current_date)), 0)::int as n
           from invoices i where i.status <> 'annulee'`);
      points.push({
        gravite: "important",
        texte: `${plural(retardataires, "famille a dépassé", "familles ont dépassé")} `
          + `une échéance de scolarité : ${montant} F exigibles et non versés.`,
        action: "Voir", lien: "/scolarite", droit: "voir_scolarite",
      });
    }

    // --- Ce qui est simplement incomplet -----------------------------------

    if (yearId) {
      const classes = await un(
        `select count(*)::int as n from classes where academic_year_id = $1`, [yearId]);
      if (classes === 0) {
        points.push({
          gravite: "bloquant",
          texte: "Aucune classe n'est ouverte pour cette année.",
          action: "Créer les classes", lien: "/annee", droit: "parametrer",
        });
      } else {
        const eleves = await un(
          `select count(*)::int as n from enrolments where academic_year_id = $1`, [yearId]);
        if (eleves === 0) {
          points.push({
            gravite: "bloquant",
            texte: "Aucun élève n'est inscrit pour cette année.",
            action: "Importer la liste", lien: "/inscriptions", droit: "inscrire",
          });
        }
      }

      const sansPiece = await un(
        `select count(*)::int as n from category_criteria cc
           join category_assessments ca on ca.id = cc.category_assessment_id
          where ca.academic_year_id = $1
            and coalesce(cc.awarded_points, 0) > 0
            and (cc.evidence_key is null or cc.evidence_key = '')`, [yearId]);
      if (sansPiece > 0) {
        points.push({
          gravite: "a_faire",
          texte: `${plural(sansPiece, "critère de catégorisation porte des points",
            "critères de catégorisation portent des points")} sans pièce justificative.`,
          action: "Compléter", lien: "/categorisation", droit: "voir_categorisation",
        });
      }

      // Le conseil de classe n'a de sens qu'au troisième trimestre : le
      // rappeler en novembre serait du bruit.
      if (termSequence === 3) {
        const sansDecision = await un(
          `select count(*)::int as n from enrolments e
            where e.academic_year_id = $1
              and not exists (select 1 from conseil_decisions d
                               where d.student_id = e.student_id
                                 and d.academic_year_id = e.academic_year_id)`, [yearId]);
        if (sansDecision > 0) {
          points.push({
            gravite: "important",
            texte: `${plural(sansDecision, "élève attend", "élèves attendent")} `
              + "la décision du conseil de classe.",
            action: "Délibérer", lien: "/conseil", droit: "publier_bulletins",
          });
        }
      }
    }
  });

  /* On ne signale à quelqu'un que ce qu'il peut traiter. Annoncer au censeur
     un dossier de catégorisation qu'il ne peut pas ouvrir, c'est lui donner
     une inquiétude et aucun moyen d'agir. */
  return points
    .filter((p) => !p.droit || can(user, p.droit))
    .sort((a, b) => RANG[a.gravite] - RANG[b.gravite]);
}

const PASTILLE: Record<Gravite, [string, string]> = {
  bloquant: ["p-bad", "à traiter"],
  important: ["p-warn", "important"],
  a_faire: ["p-info", "à faire"],
};

export function attentionCard(points: Point[]): string {
  if (points.length === 0) {
    return `<div class="card">
      <header><b>Rien à signaler</b></header>
      <div class="body"><p class="hint" style="margin:0">Aucune note en attente
      d'arbitrage, aucune famille sans numéro, aucune règle à confirmer.</p></div>
    </div>`;
  }

  return `<div class="card">
    <header><b>À traiter</b>
      <span style="color:var(--muted);font-size:13px">${
        plural(points.length, "point", "points")}</span></header>
    <table>
      ${points.map((p) => {
        const [pill, mot] = PASTILLE[p.gravite];
        return `<tr>
          <td style="width:1%"><span class="pill ${pill}">${mot}</span></td>
          <td>${esc(p.texte)}</td>
          <td class="r"><a href="${p.lien}">${esc(p.action)}</a></td>
        </tr>`;
      }).join("")}
    </table>
  </div>`;
}
