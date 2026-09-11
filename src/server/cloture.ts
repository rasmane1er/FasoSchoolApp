/**
 * Publication des bulletins et clôture du trimestre.
 *
 * LE PROBLÈME. Jusqu'ici un bulletin était recalculé à chaque affichage. Un
 * enseignant corrigeait une note en février, et le bulletin de décembre déjà
 * remis à la famille n'était plus celui que le logiciel affichait. Personne ne
 * mentait ; les deux documents disaient simplement des choses différentes, et
 * c'est exactement ainsi qu'un établissement perd la confiance d'un parent.
 *
 * LA RÈGLE. Un bulletin remis est un document, pas une vue. Le publier fige
 * ses nombres — moyenne, rang, mention, chaque ligne de discipline — dans
 * `bulletins` et `bulletin_lines`. C'est cette copie figée que la famille lit,
 * et c'est elle qu'on réimprime en juin.
 *
 * CE QUI SUIT DE LA RÈGLE :
 *
 * - Clôturer le trimestre refuse toute nouvelle saisie de notes pour ce
 *   trimestre, en ligne comme hors ligne. Un carnet fermé est fermé.
 * - Rouvrir est possible — une vraie erreur doit pouvoir être corrigée — mais
 *   c'est un acte, il est journalisé, et l'écran prévient que des bulletins
 *   circulent déjà.
 * - Si une note change après publication, le logiciel ne remplace pas
 *   silencieusement le bulletin figé : il SIGNALE l'écart et laisse le censeur
 *   décider de republier. Un écart visible vaut mieux qu'une substitution
 *   invisible.
 */

import { withSchool } from "../lib/db.ts";
import { computeClassBulletins } from "../lib/bulletin.ts";
import { loadBulletinInputs } from "../lib/repository.ts";
import { createSmsChannel, countSegments,
         COST_PER_SEGMENT_FCFA } from "../lib/sms.ts";
import { plural } from "./html.ts";
import { garderEnvoi } from "./envois.ts";
import type { SessionUser } from "./session.ts";

// ---------------------------------------------------------------------------
// État d'un trimestre
// ---------------------------------------------------------------------------

export async function termIsClosed(schoolId: string, termId: string): Promise<boolean> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(`select status from terms where id = $1`, [termId]);
    return r.rows[0]?.status !== "ouvert";
  });
}

/** Le trimestre auquel appartient une évaluation. */
export async function termOfEvaluation(
  schoolId: string, evaluationId: string,
): Promise<{ termId: string; closed: boolean } | null> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select t.id, t.status from evaluations ev
         join terms t on t.id = ev.term_id where ev.id = $1`, [evaluationId]);
    if (r.rowCount === 0) return null;
    return { termId: r.rows[0].id, closed: r.rows[0].status !== "ouvert" };
  });
}

export async function setTermStatus(
  user: SessionUser, termId: string, ouvert: boolean,
): Promise<{ flash?: string; error?: string }> {
  return withSchool(user.schoolId!, async (c) => {
    const t = await c.query(
      `update terms set status = $2 where id = $1 returning sequence`,
      [termId, ouvert ? "ouvert" : "clos"]);
    if (t.rowCount === 0) return { error: "Trimestre introuvable." };
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id)
       values (current_school_id(), $1, $2, 'term', $3)`,
      [user.userId, ouvert ? "term.reopen" : "term.close", termId]);
    return {
      flash: ouvert
        ? `Trimestre ${t.rows[0].sequence} rouvert. Les bulletins déjà remis ne `
          + `changent pas d'eux-mêmes : republiez-les si une note bouge.`
        : `Trimestre ${t.rows[0].sequence} clôturé. Plus aucune note ne peut y être saisie.`,
    };
  });
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface Frozen {
  studentId: string;
  moyenne: number | null;
  rang: number | null;
  mention: string | null;
  publishedAt: Date;
}

/** Les bulletins figés d'une classe pour un trimestre, par élève. */
export async function publishedBulletins(
  schoolId: string, classId: string, termId: string,
): Promise<Map<string, Frozen>> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select student_id, moyenne_generale, rang, mention, published_at
         from bulletins
        where class_id = $1 and term_id = $2 and status = 'publie'`,
      [classId, termId]);
    return new Map(r.rows.map((x) => [x.student_id as string, {
      studentId: x.student_id,
      moyenne: x.moyenne_generale === null ? null : Number(x.moyenne_generale),
      rang: x.rang,
      mention: x.mention,
      publishedAt: x.published_at,
    }]));
  });
}

/** Le bulletin figé d'UN élève, disciplines comprises — ce que lit la famille. */
export async function publishedFor(schoolId: string, studentId: string, termId: string) {
  return withSchool(schoolId, async (c) => {
    const b = await c.query(
      `select id, moyenne_generale, rang, effectif, mention, published_at,
              absences_count, retards_count
         from bulletins where student_id = $1 and term_id = $2 and status = 'publie'`,
      [studentId, termId]);
    if (b.rowCount === 0) return null;
    const lines = await c.query(
      `select bl.moyenne_matiere, bl.coefficient, s.label
         from bulletin_lines bl join subjects s on s.id = bl.subject_id
        where bl.bulletin_id = $1 order by bl.sort_order, s.label`, [b.rows[0].id]);
    return {
      moyenne: b.rows[0].moyenne_generale === null ? null : Number(b.rows[0].moyenne_generale),
      rang: b.rows[0].rang as number | null,
      effectif: b.rows[0].effectif as number | null,
      mention: b.rows[0].mention as string | null,
      publishedAt: b.rows[0].published_at as Date,
      lines: lines.rows.map((l) => ({
        label: l.label as string,
        coefficient: Number(l.coefficient),
        moyenne: l.moyenne_matiere === null ? null : Number(l.moyenne_matiere),
      })),
    };
  });
}

export interface PublishOutcome { publies: number; republies: number }

/**
 * Prévenir les familles qu'un bulletin est disponible.
 *
 * L'espace des familles existe depuis des semaines et RIEN, dans le logiciel,
 * n'avait jamais dit à une famille qu'il existait. Un parent aurait dû
 * l'apprendre de bouche à oreille puis taper une adresse sur un téléphone bon
 * marché : autant dire que la fonction était morte.
 *
 * Le message ne nomme pas l'enfant, à dessein : les destinataires sont
 * dédoublonnés par numéro, et un parent de trois élèves reçoit UN message. Le
 * nommer obligerait à en envoyer trois, ou à mentir.
 *
 * Sans adresse publique configurée, on REFUSE d'envoyer. Un SMS payé qui
 * renvoie vers une adresse inexistante coûte de l'argent et de la crédibilité.
 */
export interface AvisOutcome {
  envoyes: number; refuses: number; cout: number; error?: string;
  /** Vrai quand cocher « envoyer quand même » lèverait le refus. */
  forcable?: boolean;
}

export async function previenirFamilles(
  user: SessionUser, classId: string, termId: string, forcer = false,
): Promise<AvisOutcome> {
  const schoolId = user.schoolId!;
  const adresse = (process.env.FASOSCHOOL_PUBLIC_URL ?? "").trim()
    .replace(/\/+$/, "");
  if (!adresse) {
    return { envoyes: 0, refuses: 0, cout: 0,
      error: "Aucune adresse publique n'est configurée (FASOSCHOOL_PUBLIC_URL). "
        + "Un SMS payé qui renvoie vers une adresse inexistante coûte de "
        + "l'argent et de la crédibilité : rien n'a été envoyé." };
  }
  /* Et pas en http. La page que ce SMS invite à ouvrir est protégée par un
     cookie de session qui donne accès au dossier d'un enfant — notes,
     absences, discipline, numéros de la famille. En clair sur le réseau, ce
     jeton se lit. On ne demande pas à un parent d'ouvrir cela sur le wifi d'un
     cybercafé. `localhost` reste accepté : c'est le développement, pas une
     famille. */
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(adresse);
  if (!adresse.toLowerCase().startsWith("https://") && !local) {
    return { envoyes: 0, refuses: 0, cout: 0,
      error: `L'adresse publique est en http (${adresse}). La page invite le `
        + `parent à ouvrir le dossier de son enfant : son cookie de session `
        + `voyagerait en clair. Mettez le site en https avant d'envoyer ce `
        + `message — rien n'a été envoyé.` };
  }

  return withSchool(schoolId, async (c) => {
    const publies = await c.query(
      `select count(*)::int as n from bulletins
        where term_id = $1 and class_id = $2 and status = 'publie'`,
      [termId, classId]);
    if (publies.rows[0].n === 0) {
      return { envoyes: 0, refuses: 0, cout: 0,
        error: "Aucun bulletin n'est publié pour cette classe : il n'y a rien "
          + "à annoncer." };
    }

    // Dédoublonnés par numéro : un parent de trois élèves reçoit UN message.
    const gens = await c.query(
      `select distinct on (g.phone) g.id, g.phone
         from bulletins b
         join student_guardians sg on sg.student_id = b.student_id
         join guardians g on g.id = sg.guardian_id
        where b.term_id = $1 and b.class_id = $2 and b.status = 'publie'
          and sg.receives_sms and g.phone is not null and g.phone <> ''
        order by g.phone`, [termId, classId]);
    if (gens.rows.length === 0) {
      return { envoyes: 0, refuses: 0, cout: 0,
        error: "Aucune famille joignable dans cette classe. Les numéros se "
          + "corrigent dans la fiche de chaque élève." };
    }

    const ecole = await c.query(`select name from schools limit 1`);
    const tr = await c.query(`select sequence from terms where id = $1`, [termId]);
    const corps = `${ecole.rows[0]?.name ?? ""}: les bulletins du `
      + `${tr.rows[0]?.sequence ?? 1}e trimestre sont disponibles. `
      + `Consultez celui de votre enfant sur ${adresse}/famille avec ce numero.`;
    const segments = countSegments(corps);

    // Même règle que les communiqués : un envoi partiel est pire que pas
    // d'envoi. La moitié des familles prévenue, l'autre qui attend.
    const credit = Number((await c.query(
      `select coalesce(sum(case when direction = 'achat' then messages
                                else -messages end), 0)::int as n
         from sms_credit_ledger`)).rows[0].n);
    const besoin = gens.rows.length * segments;
    if (credit < besoin) {
      return { envoyes: 0, refuses: 0, cout: 0,
        error: `Crédit insuffisant : ${besoin} messages nécessaires, ${credit} `
          + `disponibles. Rien n'a été envoyé.` };
    }

    /* Les mêmes gardes que pour un communiqué : le corps est identique d'un
       envoi à l'autre pour une même classe, donc un second clic renverrait le
       message mot pour mot à toutes les familles. Et l'heure : rien
       n'empêchait d'annoncer les bulletins à 23 h. */
    const refus = await garderEnvoi(c, corps, forcer);
    if (refus) return { envoyes: 0, refuses: 0, cout: 0,
                        error: refus.message, forcable: refus.forcable };

    const sms = createSmsChannel();
    let envoyes = 0, refuses = 0;
    for (const g of gens.rows) {
      const r = await sms.send({ to: g.phone, body: corps, schoolId });
      await c.query(
        `insert into sms_messages (school_id, guardian_id, to_phone, body,
                                   segments, cost_fcfa, status, provider,
                                   provider_ref, error_detail, sent_at)
         values (current_school_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,
                 case when $6 = 'envoye' then now() end)`,
        [g.id, g.phone, corps, segments,
         r.ok ? segments * COST_PER_SEGMENT_FCFA : 0,
         r.ok ? "envoye" : "echoue", sms.name, r.providerRef ?? null,
         r.ok ? null : (r.error ?? "Refus de l'opérateur, sans détail")]);
      if (r.ok) envoyes += 1; else refuses += 1;
    }

    if (envoyes > 0) {
      await c.query(
        `insert into sms_credit_ledger (school_id, direction, messages,
                                        amount_fcfa, note)
         values (current_school_id(), 'consommation', $1, $2,
                 'Avis de disponibilité des bulletins')`,
        [envoyes * segments, envoyes * segments * COST_PER_SEGMENT_FCFA]);
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'bulletin.notify', 'class', $2, $3)`,
      [user.userId, classId, JSON.stringify({ envoyes, refuses, segments })]);

    return { envoyes, refuses,
             cout: envoyes * segments * COST_PER_SEGMENT_FCFA };
  });
}


/**
 * Fige les bulletins d'une classe. Republier écrase la copie précédente — et
 * c'est voulu : republier est une décision explicite du censeur, prise en
 * connaissance de l'écart que l'écran lui a montré.
 */
export async function publishClass(
  user: SessionUser, classId: string, termId: string,
): Promise<PublishOutcome> {
  const schoolId = user.schoolId!;
  const inputs = await loadBulletinInputs(schoolId, classId, termId);
  const klass = computeClassBulletins({
    studentIds: inputs.students.map((s) => s.id),
    grades: inputs.grades,
    coefficients: new Map(inputs.subjects.map((s) => [s.id, s.coefficient])),
    policy: inputs.policy,
    mentionBands: inputs.mentionBands,
  });

  return withSchool(schoolId, async (c) => {
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;
    const out: PublishOutcome = { publies: 0, republies: 0 };

    const ordre = new Map(inputs.subjects.map((s, i) => [s.id, i]));

    /* CE QUE LE CONSEIL A DÉCIDÉ, FIGÉ DANS LE BULLETIN.
     *
     * Le censeur passe la séance du conseil à saisir une appréciation et une
     * décision par élève. Elles partaient dans `conseil_decisions` et s'y
     * arrêtaient : le bulletin imprimait un cadre « Appréciation du conseil de
     * classe » avec deux lignes pointillées VIDES, que quelqu'un devait
     * recopier à la main, quarante fois. C'est le travail que ce produit
     * prétend supprimer.
     *
     * On les COPIE au lieu de les joindre : un bulletin remis aux familles ne
     * doit pas changer parce qu'on a corrigé la source trois mois plus tard.
     * C'est la règle déjà appliquée aux moyennes et au rang. */
    const conseil = new Map<string, { appreciation: string | null; decision: string }>();
    {
      const { rows } = await c.query(
        `select cd.student_id, cd.appreciation, cd.decision
           from conseil_decisions cd
           join terms t on t.academic_year_id = cd.academic_year_id
          where t.id = $1`, [termId]);
      for (const r of rows) {
        conseil.set(r.student_id, { appreciation: r.appreciation, decision: r.decision });
      }
    }

    /* Le NOM, pas l'identifiant : si le professeur principal quitte
       l'établissement, le bulletin déjà remis doit continuer de porter celui
       qui l'a signé. */
    const pp = (await c.query(
      `select s.full_name from classes cl
         join staff st on st.id = cl.professeur_principal_id
         join users s on s.id = st.user_id
        where cl.id = $1`, [classId])).rows[0]?.full_name ?? null;

    for (const st of klass.students) {
      const abs = inputs.absences.get(st.studentId)
        ?? { justified: 0, unjustified: 0, late: 0 };

      const b = await c.query(
        `insert into bulletins
           (school_id, student_id, term_id, class_id, grading_policy_id,
            coefficient_set_id, moyenne_generale, total_points, total_coefficients,
            rang, effectif, moyenne_de_classe, mention, absences_count,
            retards_count, appreciation_generale, decision_conseil,
            professeur_principal, status, published_at, published_by, computed_at)
         values (current_school_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                 $11, $12, $13, $14, $16, $17, $18, 'publie', now(), $15, now())
         on conflict (student_id, term_id) do update set
           class_id = excluded.class_id,
           grading_policy_id = excluded.grading_policy_id,
           coefficient_set_id = excluded.coefficient_set_id,
           moyenne_generale = excluded.moyenne_generale,
           total_points = excluded.total_points,
           total_coefficients = excluded.total_coefficients,
           rang = excluded.rang, effectif = excluded.effectif,
           moyenne_de_classe = excluded.moyenne_de_classe,
           mention = excluded.mention,
           absences_count = excluded.absences_count,
           retards_count = excluded.retards_count,
           appreciation_generale = excluded.appreciation_generale,
           decision_conseil = excluded.decision_conseil,
           professeur_principal = excluded.professeur_principal,
           status = 'publie', published_at = now(),
           published_by = excluded.published_by, computed_at = now()
         returning id, (xmax = 0) as cree`,
        [st.studentId, termId, classId, inputs.policyId, inputs.coefficientSetId,
         st.moyenneGenerale, st.totalPoints, st.totalCoefficients,
         st.rang, st.effectif, klass.moyenneDeClasse, st.mention,
         abs.justified + abs.unjustified, abs.late, staffId,
         conseil.get(st.studentId)?.appreciation ?? null,
         conseil.get(st.studentId)?.decision ?? null,
         pp]);

      const bulletinId = b.rows[0].id as string;
      if (b.rows[0].cree) out.publies += 1; else out.republies += 1;

      // Les lignes sont réécrites en entier : une discipline retirée du
      // programme ne doit pas survivre dans un bulletin republié.
      await c.query(`delete from bulletin_lines where bulletin_id = $1`, [bulletinId]);
      for (const line of st.subjects) {
        await c.query(
          `insert into bulletin_lines
             (school_id, bulletin_id, subject_id, moyenne_matiere, coefficient,
              points, moyenne_classe_matiere, rang_matiere, sort_order)
           values (current_school_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
          [bulletinId, line.subjectId, line.moyenne, line.coefficient, line.points,
           klass.moyenneParMatiere.get(line.subjectId) ?? null,
           line.rangMatiere, ordre.get(line.subjectId) ?? 0]);
      }
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'bulletins.publish', 'class', $2, $3)`,
      [user.userId, classId, JSON.stringify(out)]);

    return out;
  });
}

// ---------------------------------------------------------------------------
// Écart entre le bulletin remis et l'état actuel des notes
// ---------------------------------------------------------------------------

export interface Ecart {
  lastName: string; firstNames: string;
  publiee: number | null; actuelle: number | null;
  rangPublie: number | null; rangActuel: number | null;
}

/**
 * Compare la copie figée au calcul d'aujourd'hui. Un écart signifie qu'une
 * note a bougé depuis la remise du bulletin : la famille détient un document
 * qui ne dit plus la même chose que le logiciel.
 */
export function ecarts(
  fige: Map<string, Frozen>,
  vivant: Array<{ studentId: string; moyenneGenerale: number | null; rang: number | null }>,
  identites: Map<string, { lastName: string; firstNames: string }>,
): Ecart[] {
  const out: Ecart[] = [];
  for (const v of vivant) {
    const f = fige.get(v.studentId);
    if (!f) continue;
    // Le RANG compte autant que la moyenne. Une note corrigée chez un élève
    // reclasse toute la classe : les autres n'ont pas vu leur moyenne changer,
    // mais leur bulletin porte un rang qui n'est plus le bon.
    if (f.moyenne !== v.moyenneGenerale || f.rang !== v.rang) {
      const who = identites.get(v.studentId);
      out.push({
        lastName: who?.lastName ?? "", firstNames: who?.firstNames ?? "",
        publiee: f.moyenne, actuelle: v.moyenneGenerale,
        rangPublie: f.rang, rangActuel: v.rang,
      });
    }
  }
  return out;
}

/** Décrit un écart en une ligne, sans jargon. */
export const decrireEcart = (d: Ecart): string => {
  const parts: string[] = [];
  if (d.publiee !== d.actuelle) {
    parts.push(`moyenne remise ${fmt(d.publiee)}, aujourd'hui ${fmt(d.actuelle)}`);
  }
  if (d.rangPublie !== d.rangActuel) {
    parts.push(`rang remis ${d.rangPublie ?? "—"}, aujourd'hui ${d.rangActuel ?? "—"}`);
  }
  return parts.join(" · ");
};

const fmt = (n: number | null): string =>
  n === null ? "—" : n.toFixed(2).replace(".", ",");

/**
 * Reconstitue le résultat de classe TEL QU'IL A ÉTÉ PUBLIÉ, pour réimprimer
 * en juin exactement la feuille remise en décembre. Renvoie null si la classe
 * n'a pas de bulletins publiés : on imprime alors le calcul du jour.
 */
export async function frozenClassResult(
  schoolId: string, classId: string, termId: string,
): Promise<{
  students: Array<{
    studentId: string; subjects: Array<{
      subjectId: string; moyenne: number | null; coefficient: number;
      points: number | null; gradesCounted: number; rangMatiere: number | null;
    }>;
    moyenneGenerale: number | null; totalPoints: number; totalCoefficients: number;
    mention: string | null; rang: number | null; effectif: number;
  }>;
  moyenneDeClasse: number | null;
  moyenneParMatiere: Map<string, number | null>;
  publishedAt: Date;
} | null> {
  return withSchool(schoolId, async (c) => {
    const b = await c.query(
      `select id, student_id, moyenne_generale, total_points, total_coefficients,
              rang, effectif, moyenne_de_classe, mention, published_at
         from bulletins
        where class_id = $1 and term_id = $2 and status = 'publie'
        order by rang nulls last`, [classId, termId]);
    if (b.rowCount === 0) return null;

    const lines = await c.query(
      `select bl.bulletin_id, bl.subject_id, bl.moyenne_matiere, bl.coefficient,
              bl.points, bl.moyenne_classe_matiere, bl.rang_matiere
         from bulletin_lines bl
         join bulletins bu on bu.id = bl.bulletin_id
        where bu.class_id = $1 and bu.term_id = $2
        order by bl.sort_order`, [classId, termId]);

    const parBulletin = new Map<string, typeof lines.rows>();
    const moyenneParMatiere = new Map<string, number | null>();
    for (const l of lines.rows) {
      const arr = parBulletin.get(l.bulletin_id) ?? [];
      arr.push(l);
      parBulletin.set(l.bulletin_id, arr);
      if (!moyenneParMatiere.has(l.subject_id)) {
        moyenneParMatiere.set(l.subject_id,
          l.moyenne_classe_matiere === null ? null : Number(l.moyenne_classe_matiere));
      }
    }

    return {
      students: b.rows.map((r) => ({
        studentId: r.student_id,
        subjects: (parBulletin.get(r.id) ?? []).map((l: any) => ({
          subjectId: l.subject_id,
          moyenne: l.moyenne_matiere === null ? null : Number(l.moyenne_matiere),
          coefficient: Number(l.coefficient),
          points: l.points === null ? null : Number(l.points),
          gradesCounted: l.moyenne_matiere === null ? 0 : 1,
          rangMatiere: l.rang_matiere,
        })),
        moyenneGenerale: r.moyenne_generale === null ? null : Number(r.moyenne_generale),
        totalPoints: Number(r.total_points ?? 0),
        totalCoefficients: Number(r.total_coefficients ?? 0),
        mention: r.mention,
        rang: r.rang,
        effectif: r.effectif ?? b.rowCount,
      })),
      moyenneDeClasse: b.rows[0].moyenne_de_classe === null
        ? null : Number(b.rows[0].moyenne_de_classe),
      moyenneParMatiere,
      publishedAt: b.rows[0].published_at,
    };
  });
}

export const resumeEcarts = (n: number): string =>
  `${plural(n, "bulletin déjà remis ne correspond plus",
    "bulletins déjà remis ne correspondent plus")} aux notes actuelles.`;
