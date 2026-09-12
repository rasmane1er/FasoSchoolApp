/**
 * Espace des familles.
 *
 * C'est l'idée d'origine du projet : un parent qui voit les notes et les
 * absences de son enfant sans se déplacer au secrétariat, et sans qu'on lui
 * demande d'installer quoi que ce soit.
 *
 * Les contraintes qui décident de tout, ici :
 *
 * - **Le téléphone est bon marché et le réseau mauvais.** Une seule page, pas
 *   de menu latéral, pas de JavaScript, quelques kilo-octets. Le parent ouvre,
 *   lit, referme.
 * - **Le parent n'est pas du personnel.** Session séparée, cookie séparé,
 *   fonctions séparées. Une session de famille ne peut pas devenir une session
 *   de personnel, même par erreur de programmation : il n'existe aucun chemin
 *   qui la résolve en `SessionUser`.
 * - **Le périmètre est l'enfant, pas l'établissement.** Ce qui s'affiche vient
 *   de `student_guardians`. Un tuteur voit ses enfants, et rien d'autre.
 * - **Une note ne dépend jamais du paiement.** Un impayé n'efface pas les
 *   notes : il s'affiche à côté. Masquer le carnet pour faire pression sur une
 *   famille est une décision d'établissement, pas une propriété du logiciel.
 */

import { randomBytes, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withSchool, withoutSchool } from "../lib/db.ts";
import { computeClassBulletins } from "../lib/bulletin.ts";
import { loadBulletinInputs } from "../lib/repository.ts";
import { publishedFor } from "./cloture.ts";
import { esc, fr, fcfa, plural } from "./html.ts";

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

export interface GuardianSession {
  guardianId: string;
  schoolId: string;
  fullName: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Prend le client en paramètre plutôt que d'en réserver un : appelée depuis
 * l'intérieur d'une transaction d'émission de code, une réservation imbriquée
 * bloquerait sur un pool étroit.
 */
export async function guardianExists(c: PoolClient, phone: string): Promise<boolean> {
  const r = await c.query(`select id from auth_lookup_guardian($1)`, [phone]);
  return (r.rowCount ?? 0) > 0;
}

export async function createGuardianSession(phone: string): Promise<string | null> {
  return withoutSchool(async (c) => {
    const g = await c.query(`select id, school_id from auth_lookup_guardian($1)`, [phone]);
    if (g.rowCount === 0) return null;
    const token = randomBytes(32).toString("base64url");
    await c.query(`select guardian_create_session($1,$2,$3)`,
      [g.rows[0].id, g.rows[0].school_id, sha256(token)]);
    return token;
  });
}

export async function resolveGuardian(token: string | null): Promise<GuardianSession | null> {
  if (!token) return null;
  return withoutSchool(async (c) => {
    const r = await c.query(
      `select guardian_id, school_id, full_name from guardian_resolve($1)`, [sha256(token)]);
    if (r.rowCount === 0) return null;
    return {
      guardianId: r.rows[0].guardian_id,
      schoolId: r.rows[0].school_id,
      fullName: r.rows[0].full_name,
    };
  });
}

export async function revokeGuardian(token: string): Promise<void> {
  await withoutSchool(async (c) => {
    await c.query(`select guardian_revoke($1)`, [sha256(token)]);
  });
}

// ---------------------------------------------------------------------------
// Ce qu'une famille voit
// ---------------------------------------------------------------------------

export interface SubjectLine {
  label: string;
  coefficient: number;
  moyenne: number | null;
}

export interface ChildView {
  studentId: string;
  fullName: string;
  classLabel: string;
  termLabel: string;
  subjects: SubjectLine[];
  moyenne: number | null;
  mention: string | null;
  rang: number | null;
  effectif: number;
  absences: number;
  retards: number;
  justifiees: number;
  duFcfa: number;
  payeFcfa: number;
  /** Exigible à ce jour d'après l'échéancier. `null` : pas d'échéancier. */
  echuFcfa: number | null;
  /** Exigible et non versé. `null` se propage : inconnu, pas nul. */
  retardFcfa: number | null;
  /** La tranche suivante, pour dire ce qui vient plutôt qu'une somme brute. */
  prochaine: { label: string; montant: number; le: string } | null;
  rulesUnverified: boolean;
  /** Date de remise du bulletin figé, si la famille en a reçu un. */
  publishedAt: Date | null;
}

/** Une date ISO en jour lisible pour une famille : « 05/01/2027 ». */
const jourFr = (iso: string): string => {
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

export async function loadChildren(g: GuardianSession): Promise<ChildView[]> {
  const base = await withSchool(g.schoolId, async (c) => {
    const kids = await c.query(
      `select st.id, st.last_name, st.first_names, cl.id as class_id, cl.label as classe,
              ay.id as year_id
         from student_guardians sg
         join students st on st.id = sg.student_id
         left join enrolments e on e.student_id = st.id
         left join classes cl on cl.id = e.class_id
         left join academic_years ay on ay.id = e.academic_year_id
        where sg.guardian_id = $1
        order by st.last_name, st.first_names`, [g.guardianId]);

    const term = await c.query(
      `select t.id, t.sequence from terms t
         join academic_years ay on ay.id = t.academic_year_id
        where ay.status = 'en_cours'
        order by (current_date between t.starts_on and t.ends_on) desc, t.sequence
        limit 1`);

    const out = [];
    for (const k of kids.rows) {
      const abs = await c.query(
        `select count(*) filter (where ar.status = 'absent')::int as absences,
                count(*) filter (where ar.status = 'retard')::int as retards,
                count(*) filter (where ar.status = 'absent' and ar.is_justified)::int as justifiees
           from attendance_records ar where ar.student_id = $1`, [k.id]);
      /* CE QU'UNE FAMILLE A BESOIN DE SAVOIR N'EST PAS « VOUS DEVEZ 78 000 F ».
       *
       * C'est un chiffre qui effraie et qu'on ne peut pas verser d'un coup.
       * L'échéancier existait depuis le premier jour dans `invoice_instalments`
       * — une tranche par trimestre, aux dates de l'école — et aucun écran ne
       * le montrait, ni à l'économe ni ici. La famille lisait donc une somme
       * annuelle sans savoir ce qui était exigible maintenant.
       *
       * `montant_echu` renvoie null quand la facture n'a pas d'échéancier :
       * l'écran l'affiche comme tel plutôt que d'affirmer que tout est dû. */
      const sco = await c.query(
        `select coalesce(sum(i.total_fcfa), 0)::bigint as du,
                coalesce(sum(montant_regle(i.id)), 0)::bigint as paye,
                sum(montant_echu(i.id, current_date)) as echu,
                sum(retard_de(i.id, current_date)) as retard
           from invoices i
          where i.student_id = $1 and i.status <> 'annulee'`, [k.id]);
      const prochaine = await c.query(
        `select p.label, p.amount_fcfa, p.due_on::text as due_on
           from invoices i
           cross join lateral prochaine_echeance(i.id, current_date) p
          where i.student_id = $1 and i.status <> 'annulee'
          order by p.due_on limit 1`, [k.id]);
      out.push({
        id: k.id as string,
        classId: k.class_id as string | null,
        fullName: `${k.last_name} ${k.first_names}`,
        classe: (k.classe as string) ?? "—",
        absences: abs.rows[0].absences as number,
        retards: abs.rows[0].retards as number,
        justifiees: abs.rows[0].justifiees as number,
        du: Number(sco.rows[0].du),
        paye: Number(sco.rows[0].paye),
        echu: sco.rows[0].echu === null ? null : Number(sco.rows[0].echu),
        retard: sco.rows[0].retard === null ? null : Number(sco.rows[0].retard),
        prochaine: prochaine.rows[0]
          ? { label: prochaine.rows[0].label as string,
              montant: Number(prochaine.rows[0].amount_fcfa),
              le: String(prochaine.rows[0].due_on).slice(0, 10) }
          : null,
        termId: (term.rows[0]?.id as string) ?? null,
        termSequence: (term.rows[0]?.sequence as number) ?? null,
      });
    }
    return out;
  });

  const views: ChildView[] = [];
  for (const k of base) {
    let subjects: SubjectLine[] = [];
    let moyenne: number | null = null;
    let mention: string | null = null;
    let rang: number | null = null;
    let effectif = 0;
    let rulesUnverified = false;

    /* Ce que la famille lit est le bulletin PUBLIÉ quand il en existe un.
       Pas un recalcul : le document remis à la maison et l'écran doivent dire
       la même chose, même si une note a bougé depuis. Sinon un parent qui
       compare les deux ne sait plus lequel croire — et il a raison. */
    let publishedAt: Date | null = null;
    const remis = k.termId ? await publishedFor(g.schoolId, k.id, k.termId) : null;

    if (remis) {
      subjects = remis.lines;
      moyenne = remis.moyenne;
      mention = remis.mention;
      rang = remis.rang;
      effectif = remis.effectif ?? 0;
      publishedAt = remis.publishedAt;
    } else if (k.classId && k.termId) {
      const inputs = await loadBulletinInputs(g.schoolId, k.classId, k.termId);
      effectif = inputs.students.length;
      rulesUnverified = !!inputs.sourceNotes.policy || !!inputs.sourceNotes.coefficients;

      /* On passe par le moteur de bulletin, sur la classe entière : la famille
         doit lire EXACTEMENT les nombres du bulletin, rang compris. Recalculer
         ici avec une autre formule serait la garantie d'un écart un jour. */
      const klass = computeClassBulletins({
        studentIds: inputs.students.map((x) => x.id),
        grades: inputs.grades,
        coefficients: new Map(inputs.subjects.map((x) => [x.id, x.coefficient])),
        policy: inputs.policy,
        mentionBands: inputs.mentionBands,
      });
      const mine = klass.students.find((x) => x.studentId === k.id);
      if (mine) {
        const labels = new Map(inputs.subjects.map((x) => [x.id, x.label]));
        subjects = mine.subjects.map((x) => ({
          label: labels.get(x.subjectId) ?? "",
          coefficient: x.coefficient,
          moyenne: x.moyenne,
        }));
        moyenne = mine.moyenneGenerale;
        mention = mine.mention;
        rang = mine.rang;
      }
    }

    views.push({
      studentId: k.id, fullName: k.fullName, classLabel: k.classe,
      termLabel: k.termSequence ? `Trimestre ${k.termSequence}` : "Aucun trimestre en cours",
      subjects, moyenne, mention, rang, effectif,
      absences: k.absences, retards: k.retards, justifiees: k.justifiees,
      duFcfa: k.du, payeFcfa: k.paye,
      echuFcfa: k.echu, retardFcfa: k.retard, prochaine: k.prochaine,
      rulesUnverified, publishedAt,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Rendu — une page unique, sans JavaScript, quelques kilo-octets
// ---------------------------------------------------------------------------

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#F4F2ED;color:#1A1C2B;line-height:1.5;
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.bar{background:#22305C;color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px}
.bar b{font:700 20px Georgia,serif}
.bar a{margin-left:auto;color:rgba(255,255,255,.8);font-size:14px}
.wrap{max-width:640px;margin:0 auto;padding:18px 14px 44px}
.card{background:#fff;border:1px solid #E2DED5;border-radius:8px;margin-bottom:16px;overflow:hidden}
.card h2{margin:0;padding:14px 16px;font-size:17px;border-bottom:1px solid #EFECE5}
.card h2 span{display:block;font-size:13px;font-weight:400;color:#5C6072}
.big{display:flex;gap:10px;padding:14px 16px;flex-wrap:wrap}
.big div{flex:1 1 90px;background:#FBFAF7;border:1px solid #EFECE5;border-radius:6px;padding:10px 12px}
.big .k{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#7A7F90}
.big .v{font:500 24px ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:15px}
td{padding:9px 16px;border-bottom:1px solid #EFECE5}
tr:last-child td{border-bottom:none}
td.r{text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
.note{padding:12px 16px;font-size:13.5px;line-height:1.5;border-left:3px solid #9A7115;
  background:#fff;border-radius:0 6px 6px 0;margin-bottom:16px;border-top:1px solid #E2DED5;
  border-right:1px solid #E2DED5;border-bottom:1px solid #E2DED5}
.note.bad{border-left-color:#A8402A}
form{background:#fff;border:1px solid #E2DED5;border-radius:8px;padding:18px}
label{display:block;font-size:12px;letter-spacing:.05em;text-transform:uppercase;
  color:#7A7F90;margin-bottom:6px}
input{font:inherit;width:100%;height:50px;padding:0 14px;border:1px solid #CFCAC0;
  border-radius:6px;margin-bottom:14px}
button{font:inherit;font-weight:500;width:100%;height:50px;border:0;border-radius:6px;
  background:#2C3F7C;color:#fff}
.foot{text-align:center;font-size:12.5px;color:#7A7F90;margin-top:22px}
`;

/* PAS DE MANIFESTE ICI, ET C'EST VOLONTAIRE.
 *
 * Les pages du personnel déclarent un manifeste : un enseignant ou un
 * directeur pose l'application sur son écran d'accueil. L'espace famille, non.
 *
 * Un tuteur arrive ici par un lien reçu en SMS, sur le téléphone qu'il a. La
 * décision arrêtée est « SMS d'abord, application des parents reportée » : ce
 * n'est pas un oubli, c'est le produit. Proposer « installer l'application »
 * à un parent, ce serait lui promettre quelque chose que rien ne maintient —
 * et l'installation le ferait atterrir sur `/`, c'est-à-dire sur l'écran de
 * connexion du PERSONNEL, où il n'a rien à faire.
 *
 * Une icône d'onglet, en revanche, ne coûte rien et évite la page anonyme.
 */
const shell = (title: string, body: string): string => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — FasoSchool</title>
<meta name="theme-color" content="#2C3F7C">
<link rel="icon" href="/icones/fasoschool-32.png" sizes="32x32">
<style>${CSS}</style>
</head>
<body>
<div class="bar"><b>FasoSchool</b><a href="/famille/sortie">Quitter</a></div>
<div class="wrap">${body}</div>
</body></html>`;

export function famillePage(
  g: GuardianSession, schoolName: string, children: ChildView[],
): string {
  const enfant = (k: ChildView) => {
    const reste = k.duFcfa - k.payeFcfa;
    const notes = k.subjects.filter((s) => s.moyenne !== null);

    return `
<div class="card">
  <h2>${esc(k.fullName)}<span>${esc(k.classLabel)} — ${esc(k.termLabel)}${
    k.publishedAt
      ? ` · bulletin remis le ${new Date(k.publishedAt).toLocaleDateString("fr-FR")}`
      : " · notes en cours de saisie"}</span></h2>

  <div class="big">
    <div><div class="k">Moyenne</div><div class="v">${fr(k.moyenne)}</div></div>
    <div><div class="k">Rang</div><div class="v">${
      k.rang ? `${k.rang}<span style="font-size:14px">/${k.effectif}</span>` : "—"}</div></div>
    <div><div class="k">Absences</div><div class="v">${k.absences}</div></div>
  </div>

  ${k.mention ? `<div style="padding:0 16px 12px;font-size:14px;color:#5C6072">
    Mention : <b>${esc(k.mention)}</b></div>` : ""}

  ${notes.length ? `<table>
    ${notes.map((s) => `<tr>
      <td>${esc(s.label)}<span style="color:#7A7F90;font-size:13px"> · coef. ${s.coefficient}</span></td>
      <td class="r">${fr(s.moyenne)}</td>
    </tr>`).join("")}
  </table>` : `<div style="padding:0 16px 14px;color:#5C6072;font-size:14px">
    Aucune note enregistrée pour ce trimestre.</div>`}

  ${k.justifiees || k.retards ? `<table>
    ${k.justifiees ? `<tr><td>Dont absences justifiées</td>
      <td class="r">${k.justifiees}</td></tr>` : ""}
    ${k.retards ? `<tr><td>Retards</td><td class="r">${k.retards}</td></tr>` : ""}
  </table>` : ""}

  ${k.duFcfa > 0 ? `<table>
    <tr><td>Scolarité de l'année</td><td class="r">${fcfa(k.duFcfa)} F</td></tr>
    <tr><td>Déjà versé</td><td class="r">${fcfa(k.payeFcfa)} F</td></tr>
    ${k.retardFcfa === null
      // Pas d'échéancier : on ne dit ni « à jour » ni « en retard ». La
      // famille voit le solde annuel et sait que c'est tout ce qu'on sait.
      ? `<tr><td><b>${reste > 0 ? "Reste à payer" : "Solde"}</b></td>
             <td class="r"><b>${fcfa(Math.abs(reste))} F</b></td></tr>`
      : k.retardFcfa > 0
        ? `<tr><td><b>À verser maintenant</b><div style="font-size:12.5px;color:#5C6072">
               échéance dépassée</div></td>
             <td class="r"><b style="color:#A8402A">${fcfa(k.retardFcfa)} F</b></td></tr>
           <tr><td>Reste sur l'année</td>
               <td class="r">${fcfa(Math.abs(reste))} F</td></tr>`
        : `<tr><td><b>À verser maintenant</b></td>
             <td class="r"><b style="color:#3B6349">0 F — vous êtes à jour</b></td></tr>
           ${k.prochaine ? `<tr><td>${esc(k.prochaine.label)}
             <div style="font-size:12.5px;color:#5C6072">le ${
               esc(jourFr(k.prochaine.le))}</div></td>
             <td class="r">${fcfa(k.prochaine.montant)} F</td></tr>` : ""}
           <tr><td>Reste sur l'année</td>
               <td class="r">${fcfa(Math.abs(reste))} F</td></tr>`}
  </table>` : ""}
</div>`;
  };

  const nonVerifie = children.some((k) => k.rulesUnverified && !k.publishedAt);

  const body = `
<p style="margin:0 0 4px;font-size:14px;color:#5C6072">${esc(schoolName)}</p>
<h1 style="margin:0 0 18px;font:700 22px Georgia,serif">Bonjour ${esc(g.fullName)}</h1>

${children.length === 0 ? `<div class="note">Aucun élève n'est rattaché à votre
  numéro. Signalez-le au secrétariat de l'établissement.</div>` : ""}

${children.map(enfant).join("")}

${children.some((k) => !k.publishedAt && k.subjects.length > 0) ? `<div class="note">
  Un bulletin n'a pas encore été remis pour ce trimestre. Les moyennes
  ci-dessus sont celles des notes déjà saisies : elles bougeront encore.</div>` : ""}

${nonVerifie ? `<div class="note">Les moyennes affichées utilisent les règles de
  notation par défaut de l'établissement, qui n'ont pas encore été confirmées
  par le censeur. Elles sont indicatives.</div>` : ""}

<div class="foot">Ces informations sont celles enregistrées par l'établissement.
Pour toute correction, adressez-vous au secrétariat.</div>`;

  return shell("Espace famille", body);
}

export function familleLoginPage(step: "phone" | "code", opts: {
  phone?: string; error?: string; devCode?: string;
} = {}): string {
  const body = `
<h1 style="margin:0 0 6px;font:700 22px Georgia,serif">Espace famille</h1>
<p style="margin:0 0 18px;font-size:14.5px;color:#5C6072">
  Les notes et les absences de votre enfant. Entrez le numéro de téléphone que
  vous avez donné à l'établissement.</p>

${opts.error ? `<div class="note bad">${esc(opts.error)}</div>` : ""}
${opts.devCode ? `<div class="note warn">
  <b>Mode démonstration — aucun SMS n'est envoyé.</b>
  Ce code s'affiche ici parce que cette installation ne sait pas envoyer de
  message : <b class="num" id="code-demo" style="font-size:20px">${esc(opts.devCode)}</b>.
  Sur une installation réelle, il arrive par SMS et n'apparaît nulle part.
</div>` : ""}

${step === "phone" ? `
<form method="post" action="/famille/connexion">
  <label for="phone">Numéro de téléphone</label>
  <input id="phone" name="phone" type="tel" inputmode="numeric"
         autocomplete="tel" placeholder="70 12 34 56" required>
  <button type="submit">Recevoir mon code</button>
</form>` : `
<form method="post" action="/famille/verifier">
  <input type="hidden" name="phone" value="${esc(opts.phone ?? "")}">
  <label for="code">Code reçu par SMS</label>
  <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"
         maxlength="6" required>
  <button type="submit">Entrer</button>
</form>`}

<div class="foot">Vous n'avez pas de code ? Vérifiez auprès du secrétariat que
votre numéro est bien enregistré.</div>`;

  return shell("Espace famille", body);
}

export async function schoolNameOf(schoolId: string): Promise<string> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(`select name from schools limit 1`);
    return (r.rows[0]?.name as string) ?? "";
  });
}

export { plural };
