/**
 * Serveur applicatif FasoSchool.
 *
 * HTTP natif, rendu côté serveur, formulaires classiques. Aucune dépendance
 * hors `pg`. Une page pèse quelques dizaines de kilo-octets et fonctionne sur
 * un téléphone bon marché derrière une connexion médiocre.
 *
 *   export DATABASE_URL=postgres://...
 *   node --experimental-strip-types src/server/app.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { withSchool, pool } from "../lib/db.ts";
import { computeClassBulletins } from "../lib/bulletin.ts";
import { loadBulletinInputs } from "../lib/repository.ts";
import { renderClassBulletins } from "../lib/render.ts";
import { createSmsChannel, renderTemplate, countSegments } from "../lib/sms.ts";
import {
  startLogin, verifyLogin, resolveSession, revokeSession, can,
  type SessionUser,
} from "./session.ts";
import { page, loginPage, esc, fr, fcfa, ordinal, plural, type PageChrome } from "./html.ts";
import { settingsPage, saveSettings, type Period } from "./settings.ts";
import { financePage, collectPage, collect, receiptPage,
         annulerPaiement } from "./finance.ts";
import { parseMutations, applyMutations, conflictsPage, resolveConflict, conflictCount } from "./sync.ts";
import {
  importPage, previewPage, resultPage, runImport,
  readSubmitted, decodeRows, applyCorrections,
} from "./roster.ts";
import { isMultipart, readMultipart } from "./multipart.ts";
import { joindre as joindrePiece, retirer as retirerPiece,
         telecharger as telechargerPiece, nomSur, TAILLE_MAX } from "./pieces.ts";
import { rentreePage, saveYear, openYear, addClass } from "./rentree.ts";
import { conseilPage, saveDeliberation } from "./conseil.ts";
import { categorisationPage, saveDossier, addCriterion } from "./categorisation.ts";
import {
  fraisPage, addSchedule, addLine, removeLine, issueInvoices,
} from "./frais.ts";
import { boursesPage, grantBourse, revokeBourse } from "./bourses.ts";
import {
  listEvaluations, createEvaluation, deleteEvaluation, evaluationsCard,
} from "./evaluations.ts";
import { communiquesPage, envoyer as envoyerCommunique } from "./communiques.ts";
import { messagesPage, resoudre as resoudreMessage,
         renvoyer as renvoyerMessage } from "./messages.ts";
import { personnelPage, ajouterMembre, changerFonction,
         basculerActivite } from "./personnel.ts";
import { elevePage, elevesPage, corrigerIdentite, enregistrerTuteur,
         retirerTuteur, enregistrerUrgence, retirerUrgence } from "./eleve.ts";
import { disciplinePage, consigner, retirer as retirerIncident } from "./discipline.ts";
import { justificationsPage, decider as deciderJustification } from "./justifications.ts";
import { calendrierPage, ajouter as ajouterPeriode,
         retirer as retirerPeriode, changerSemaine,
         jourEcole, dateValide } from "./calendrier.ts";
import {
  transfertsPage, recordTransfer, addLivretEntry, certificatePage,
} from "./transferts.ts";
import { pointsDAttention, attentionCard } from "./attention.ts";
import {
  servicesPage, addService, removeService, nommerProfesseurPrincipal,
  perimetreDe, peutClasse, peutMatiere,
} from "./services.ts";
import {
  termIsClosed, setTermStatus, publishClass, publishedBulletins,
  ecarts, resumeEcarts, decrireEcart, frozenClassResult, previenirFamilles,
} from "./cloture.ts";
import {
  guardianExists, createGuardianSession, resolveGuardian, revokeGuardian,
  loadChildren, famillePage, familleLoginPage, schoolNameOf,
} from "./famille.ts";
import { issueOtp, consumeOtp } from "./session.ts";
import { withoutSchool } from "../lib/db.ts";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT ?? 4180);

// ---------------------------------------------------------------------------
// Utilitaires HTTP
// ---------------------------------------------------------------------------

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function formBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("Corps de requête trop volumineux");
    chunks.push(c as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf-8"));
}

const html = (res: ServerResponse, body: string, status = 200) => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  res.end(body);
};

const redirect = (res: ServerResponse, to: string, setCookie?: string) => {
  const h: Record<string, string> = { location: to };
  if (setCookie) h["set-cookie"] = setCookie;
  res.writeHead(303, h);
  res.end();
};

/**
 * Le drapeau `Secure` d'un cookie de session.
 *
 * Il manquait sur les DEUX cookies — celui du personnel et celui des familles.
 * Un jeton de session sans `Secure` voyage en clair dès qu'une requête part en
 * http : un lien mal formé, un portail captif, une adresse tapée sans « s », et
 * le cookie est lisible sur le réseau. Celui des familles ouvre le dossier d'un
 * enfant — notes, absences, discipline, numéros de la famille — et depuis peu
 * le logiciel envoie lui-même son adresse par SMS. Il fallait le corriger avant
 * qu'un parent ne clique.
 *
 * On ne le pose pas en dur : `Secure` empêcherait toute connexion en
 * développement local, où l'on sert en http sur 127.0.0.1. On le déduit donc de
 * la requête — un reverse proxy pose `x-forwarded-proto` — et de l'adresse
 * publique déclarée, qui est déjà la source de vérité pour les SMS.
 */
export function estSecurise(req: IncomingMessage): boolean {
  const transmis = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]!.trim().toLowerCase();
  if (transmis === "https") return true;
  if ((req.socket as any)?.encrypted === true) return true;
  return (process.env.FASOSCHOOL_PUBLIC_URL ?? "").trim()
    .toLowerCase().startsWith("https://");
}

const cookieSession = (req: IncomingMessage, nom: string, valeur: string,
                       chemin: string, maxAge: number): string =>
  `${nom}=${valeur}; Path=${chemin}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
  + (estSecurise(req) ? "; Secure" : "");

// ---------------------------------------------------------------------------
// Contexte de page
// ---------------------------------------------------------------------------

async function chromeFor(user: SessionUser, active: string, context?: string): Promise<PageChrome> {
  const schoolId = user.schoolId!;
  return withSchool(schoolId, async (c) => {
    const s = await c.query(`select name from schools limit 1`);
    const credit = await c.query(
      `select coalesce(sum(case when direction = 'achat' then messages
                                when direction = 'consommation' then -messages
                                else messages end), 0) as solde
         from sms_credit_ledger`,
    );
    return {
      user, active,
      schoolName: s.rows[0]?.name ?? "—",
      context,
      smsCredit: Number(credit.rows[0]?.solde ?? 0),
    };
  });
}

/** Année et trimestre en cours, socle de presque toutes les pages. */
async function currentPeriod(schoolId: string) {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select ay.id as year_id, ay.label as year_label,
              t.id as term_id, t.sequence, t.starts_on, t.ends_on
         from academic_years ay
         join terms t on t.academic_year_id = ay.id
        where ay.status = 'en_cours'
        order by (current_date between t.starts_on and t.ends_on) desc, t.sequence
        limit 1`,
    );
    return r.rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

async function dashboard(user: SessionUser): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, "dashboard",
    period ? `Année ${period.year_label} — Trimestre ${period.sequence}` : undefined);

  if (!period) {
    return page(chrome, "Tableau de bord", `
      <div><h1>Tableau de bord</h1></div>
      <div class="note warn">Aucune année scolaire en cours.
        <a href="/annee"><b>Ouvrez-en une</b></a> pour commencer : c'est elle qui
        porte les trimestres, les classes et tout le reste.</div>`);
  }

  const data = await withSchool(schoolId, async (c) => {
    const classes = await c.query(
      `select cl.id, cl.label, cl.level_code,
              (select count(*) from enrolments e where e.class_id = cl.id) as effectif,
              (select count(distinct ev.subject_id) from evaluations ev
                where ev.class_id = cl.id and ev.term_id = $1) as matieres_ouvertes,
              (select count(distinct ev2.subject_id) from evaluations ev2
                where ev2.class_id = cl.id and ev2.term_id = $1
                  and not exists (select 1 from grade_entries ge
                                   where ge.evaluation_id = ev2.id
                                     and ge.score is null and not ge.is_absent)) as matieres_saisies
         from classes cl
        where cl.academic_year_id = $2
        order by cl.label`,
      [period.term_id, period.year_id],
    );

    const absToday = await c.query(
      `select count(*) as n from attendance_records ar
         join attendance_sessions s on s.id = ar.attendance_session_id
        where s.session_date = current_date and ar.status = 'absent'`,
    );
    const smsToday = await c.query(
      `select count(*) as n from sms_messages
        where queued_at::date = current_date and status in ('envoye','livre')`,
    );
    const arrears = await c.query(
      // montant_regle() est la seule définition du net encaissé : elle
      // soustrait les contrepassations, qu'aucune de ces requêtes ne
      // connaissait quand chacune refaisait la somme à sa façon.
      `select coalesce(sum(i.total_fcfa),0)
              - coalesce(sum(montant_regle(i.id)),0) as reste,
              count(*) filter (where i.status in ('ouverte','partielle')) as familles
         from invoices i`,
    );
    const cat = await c.query(
      `select total_score, category from category_assessments
        where academic_year_id = $1 limit 1`,
      [period.year_id],
    );
    return {
      classes: classes.rows, absToday: Number(absToday.rows[0].n),
      smsToday: Number(smsToday.rows[0].n),
      reste: Number(arrears.rows[0]?.reste ?? 0),
      familles: Number(arrears.rows[0]?.familles ?? 0),
      cat: cat.rows[0] ?? null,
    };
  });

  const complets = data.classes.filter((c: any) =>
    Number(c.matieres_ouvertes) > 0 && c.matieres_saisies === c.matieres_ouvertes).length;

  const rows = data.classes.map((c: any) => {
    const total = Number(c.matieres_ouvertes);
    const done = Number(c.matieres_saisies);
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const state = total === 0 ? ["p-info", "AUCUNE ÉVAL."]
      : pct === 100 ? ["p-ok", "COMPLET"]
      : pct >= 50 ? ["p-warn", "EN COURS"] : ["p-bad", "EN RETARD"];
    const colour = pct === 100 ? "var(--verdant)" : pct >= 50 ? "var(--ochre)" : "var(--laterite)";
    return `<tr>
      <td><a href="/notes?classe=${esc(c.id)}"><b>${esc(c.label)}</b></a></td>
      <td class="num">${esc(c.effectif)}</td>
      <td>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="flex-grow:1;height:5px;background:var(--rule2);border-radius:3px;overflow:hidden;min-width:70px">
            <div style="width:${pct}%;height:100%;background:${colour}"></div>
          </div>
          <span class="num" style="font-size:12.5px;color:var(--muted)">${done}/${total}</span>
        </div>
      </td>
      <td class="r"><span class="pill ${state[0]}">${state[1]}</span></td>
    </tr>`;
  }).join("");

  // Ce qui demande une action passe AVANT les indicateurs : un tableau de bord
  // se lit de haut en bas, et personne ne descend jusqu'aux tableaux.
  const attention = attentionCard(
    await pointsDAttention(user, period.year_id, Number(period.sequence)));

  return page(chrome, "Tableau de bord", `
    <div>
      <h1>Bonjour ${esc(user.fullName.split(" ").slice(-1)[0])}</h1>
      <p style="margin:0;color:var(--muted)">${plural(data.classes.length, "classe")} — trimestre ${period.sequence}, clôture le ${new Date(period.ends_on).toLocaleDateString("fr-FR")}.</p>
    </div>

    ${attention}

    <div class="tiles">
      <div class="tile"><div class="k">Bulletins prêts</div>
        <div class="v">${complets}<span style="font-size:15px;color:var(--faint)"> / ${data.classes.length}</span></div>
        <div class="n">${data.classes.length - complets <= 1 ? plural(data.classes.length - complets, "classe attend") : plural(data.classes.length - complets, "classes attendent", "classes attendent")} des notes</div></div>
      <div class="tile"><div class="k">Absences aujourd'hui</div>
        <div class="v">${data.absToday}</div>
        <div class="n">${data.smsToday} SMS envoyés</div></div>
      ${can(user, "voir_scolarite") ? `<div class="tile"><div class="k">Reste à recouvrer</div>
        <div class="v" style="font-size:22px">${fcfa(data.reste)} F</div>
        <div class="n">${plural(data.familles, "facture ouverte", "factures ouvertes")}</div></div>` : ""}
      ${can(user, "voir_categorisation") ? `<div class="tile"><div class="k">Catégorisation</div>
        <div class="v">${data.cat ? fr(data.cat.total_score, 0) : "—"}<span style="font-size:15px;color:var(--faint)"> / 100</span></div>
        <div class="n">${data.cat ? `Catégorie ${data.cat.category ?? "—"}` : "Dossier non commencé"}</div></div>` : ""}
    </div>

    <div class="card">
      <header><h2>Saisie des notes — trimestre ${period.sequence}</h2></header>
      <div class="scroll"><table>
        <thead><tr><th>Classe</th><th>Effectif</th><th>Matières saisies</th><th class="r">État</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="4" style="color:var(--muted)">Aucune classe.</td></tr>`}</tbody>
      </table></div>
    </div>`);
}

async function notesPage(user: SessionUser, url: URL, flash?: string): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, "notes",
    period ? `Trimestre ${period.sequence}` : undefined);
  if (!period) return page(chrome, "Notes", `<h1>Notes</h1><div class="note warn">Aucun trimestre en cours.</div>`);

  const classId = url.searchParams.get("classe");
  const subjectId = url.searchParams.get("matiere");

  // Un enseignant ne voit que les classes de sa répartition. Le filtre porte
  // sur la LISTE ici, et sur l'écriture dans saveNotes() : masquer une option
  // n'a jamais empêché personne d'envoyer un identifiant à la main.
  const perimetre = await perimetreDe(user);
  if (classId && !peutClasse(perimetre, classId)) {
    return page(chrome, "Notes", `<h1>Notes</h1>
      <div class="note bad">Cette classe ne fait pas partie de votre
      répartition de services.</div>`);
  }

  const d = await withSchool(schoolId, async (c) => {
    const classes = await c.query(
      perimetre.classIds === null
        ? `select id, label from classes where academic_year_id = $1 order by label`
        : `select id, label from classes
            where academic_year_id = $1 and id = any($2::uuid[]) order by label`,
      perimetre.classIds === null
        ? [period.year_id] : [period.year_id, perimetre.classIds],
    );
    if (!classId) return { classes: classes.rows, subjects: [], evals: [], students: [], grades: [] };

    const toutes = await c.query(
      `select distinct sub.id, sub.label
         from evaluations ev join subjects sub on sub.id = ev.subject_id
        where ev.class_id = $1 and ev.term_id = $2
        order by sub.label`,
      [classId, period.term_id],
    );
    const subjects = { rows: toutes.rows.filter((x: any) =>
      peutMatiere(perimetre, classId, x.id)) };
    const chosen = subjectId ?? subjects.rows[0]?.id ?? null;
    if (chosen && !peutMatiere(perimetre, classId, chosen)) {
      return { classes: classes.rows, subjects: subjects.rows, evals: [], students: [], grades: [] };
    }
    /* Une matière sans aucune évaluation reste ouverte : c'est précisément là
       qu'on vient pour en créer une. Fermer l'écran laisserait l'enseignant
       sans porte d'entrée. */
    if (!chosen) {
      const toutesMatieres = await c.query(
        `select id, label from subjects
          where school_id = current_school_id() or school_id is null
          order by label`);
      const permises = toutesMatieres.rows.filter((x: any) =>
        peutMatiere(perimetre, classId, x.id));
      return { classes: classes.rows, subjects: permises, evals: [],
               students: [], grades: [],
               chosen: permises[0]?.id ?? null, aucuneEvaluation: true };
    }

    const evals = await c.query(
      `select id, eval_type, label, held_on, coalesce(bareme, 20) as bareme
         from evaluations
        where class_id = $1 and term_id = $2 and subject_id = $3
        order by held_on nulls last, eval_type`,
      [classId, period.term_id, chosen],
    );
    const students = await c.query(
      `select st.id, st.last_name, st.first_names
         from enrolments e join students st on st.id = e.student_id
        where e.class_id = $1 order by st.last_name, st.first_names`,
      [classId],
    );
    const grades = await c.query(
      `select ge.evaluation_id, ge.student_id, ge.score, ge.is_absent, ge.is_justified,
              ge.updated_at
         from grade_entries ge join evaluations ev on ev.id = ge.evaluation_id
        where ev.class_id = $1 and ev.term_id = $2 and ev.subject_id = $3`,
      [classId, period.term_id, chosen],
    );
    return { classes: classes.rows, subjects: subjects.rows, chosen, evals: evals.rows,
             students: students.rows, grades: grades.rows };
  });

  const selector = `
    <form method="get" action="/notes" class="row" style="margin-left:auto">
      <select name="classe" onchange="this.form.submit()" style="width:auto">
        <option value="">Choisir une classe…</option>
        ${d.classes.map((c: any) =>
          `<option value="${esc(c.id)}"${c.id === classId ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
      </select>
      ${d.subjects.length ? `<select name="matiere" onchange="this.form.submit()" style="width:auto">
        ${d.subjects.map((s: any) =>
          `<option value="${esc(s.id)}"${s.id === (d as any).chosen ? " selected" : ""}>${esc(s.label)}</option>`).join("")}
      </select>` : ""}
      <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
    </form>`;

  /* Aucune évaluation encore : l'écran reste ouvert, et il porte le formulaire
     de création — c'est précisément là qu'on vient. Le message de la dernière
     action est rendu ici AUSSI : sans cela, un refus de création disparaîtrait
     dans cette branche et l'enseignant croirait son évaluation créée. */
  if (!classId || d.evals.length === 0) {
    const carte = classId && (d as any).chosen
      ? evaluationsCard(user,
          await listEvaluations(schoolId, classId, period.term_id, (d as any).chosen),
          classId, (d as any).chosen, period.term_id,
          await termIsClosed(schoolId, period.term_id))
      : "";
    return page(chrome, "Notes", `
      <div class="row"><div><h1>Saisie des notes</h1>
        <p style="margin:0;color:var(--muted)">${classId
          ? "Créez une évaluation pour pouvoir saisir des notes."
          : "Choisissez une classe et une matière."}</p></div>${selector}</div>
      ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}
      ${classId && !carte ? `<div class="note warn">Aucune évaluation pour cette
        matière ce trimestre.</div>` : ""}
      ${carte}`);
  }

  const key = new Map<string, any>();
  for (const g of d.grades) key.set(`${g.evaluation_id}|${g.student_id}`, g);

  // Deux devoirs portent souvent le même intitulé : c'est la date qui les
  // distingue pour l'enseignant.
  const heads = d.evals.map((e: any) =>
    `<th class="r" style="${e.eval_type === "composition" ? "color:var(--indigo)" : ""}">
       ${esc(e.eval_type === "composition" ? "Composition" : e.label ?? "Devoir")}
       ${e.held_on ? `<div style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--faint)">${new Date(e.held_on).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}</div>` : ""}
       ${Number(e.bareme ?? 20) !== 20 ? `<div style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--ochre)">sur ${fr(Number(e.bareme), 0)}</div>` : ""}
     </th>`).join("");

  const body = d.students.map((st: any, i: number) => {
    const cells = d.evals.map((e: any) => {
      const g = key.get(`${e.id}|${st.id}`);
      const val = g?.is_absent ? "abs" : (g?.score !== undefined && g?.score !== null ? fr(Number(g.score)) : "");
      return `<td class="r"><input class="note-cell" name="n_${esc(e.id)}_${esc(st.id)}"
        value="${esc(val)}" inputmode="decimal" autocomplete="off"
        data-eval="${esc(e.id)}" data-student="${esc(st.id)}"
        data-bareme="${Number(e.bareme ?? 20)}"
        data-original="${esc(val)}"
        data-updated="${g?.updated_at ? new Date(g.updated_at).toISOString() : ""}"
        aria-label="${esc(st.last_name)} — ${esc(e.label ?? e.eval_type)}"></td>`;
    }).join("");
    return `<tr><td class="num" style="color:var(--faint)">${String(i + 1).padStart(2, "0")}</td>
      <td><b>${esc(st.last_name)}</b> ${esc(st.first_names)}</td>${cells}</tr>`;
  }).join("");

  const carteEvaluations = (d as any).chosen
    ? evaluationsCard(user,
        await listEvaluations(schoolId, classId, period.term_id, (d as any).chosen),
        classId, (d as any).chosen, period.term_id,
        await termIsClosed(schoolId, period.term_id))
    : "";

  return page(chrome, "Notes", `
    <div class="row"><div><h1>Saisie des notes</h1>
      <p style="margin:0;color:var(--muted)">${plural(d.students.length, "élève")} — saisir la note, ou <code>abs</code> pour une absence. Une colonne notée sur autre chose que 20 le dit dans son en-tête.</p>
      </div>${selector}</div>
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}
    <div class="note">La moyenne suit la règle de l'établissement : les devoirs et la composition
      sont pondérés séparément, et une composition non encore passée n'abaisse pas la moyenne.</div>
    <div id="etat-file" hidden></div>
    <form method="post" data-offline action="/notes?classe=${esc(classId)}&amp;matiere=${esc((d as any).chosen)}">
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>N°</th><th>Nom et prénoms</th>${heads}</tr></thead>
        <tbody>${body}</tbody>
      </table></div></div>
      <div class="row" style="margin-top:16px">
        <button class="btn" type="submit">Enregistrer</button>
        <a class="btn ghost" href="/bulletins?classe=${esc(classId)}">Voir les bulletins</a>
        <span style="font-size:12.5px;color:var(--muted)">Sans réseau, la saisie est conservée et repart toute seule.</span>
      </div>
    </form>
    ${carteEvaluations}
    <script src="/offline.js" defer></script>`);
}

interface SaisieRefusee { studentId: string; valeur: string; bareme: number }

async function saveNotes(
  user: SessionUser, url: URL, form: URLSearchParams,
): Promise<{ saved: number; refuses: SaisieRefusee[] }> {
  const schoolId = user.schoolId!;
  let saved = 0;
  const refuses: SaisieRefusee[] = [];
  /* Le contrôle porte sur l'ÉCRITURE, pas seulement sur ce qui a été affiché.
     Chaque évaluation est confrontée à la répartition de services : un
     identifiant envoyé à la main ne passe pas plus qu'une option masquée.
     Et à l'état du trimestre : un carnet clos est clos. */
  const perimetre = await perimetreDe(user);

  await withSchool(schoolId, async (c) => {
    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    const autorisee = new Map<string, boolean>();
    const evaluationPermise = async (evaluationId: string): Promise<boolean> => {
      const connu = autorisee.get(evaluationId);
      if (connu !== undefined) return connu;
      const ev = await c.query(
        `select ev.class_id, ev.subject_id, t.status
           from evaluations ev join terms t on t.id = ev.term_id
          where ev.id = $1`, [evaluationId]);
      const ok = ev.rowCount! > 0
        && ev.rows[0].status === "ouvert"
        && (perimetre.classIds === null
            || peutMatiere(perimetre, ev.rows[0].class_id, ev.rows[0].subject_id));
      autorisee.set(evaluationId, ok);
      return ok;
    };

    /* Le barème d'une évaluation, mis en cache : la boucle passe sur toutes les
       cases d'une classe et il n'y a que quelques évaluations. */
    const baremes = new Map<string, number>();
    const baremeDe = async (evaluationId: string): Promise<number> => {
      const connu = baremes.get(evaluationId);
      if (connu !== undefined) return connu;
      const r = await c.query(
        `select coalesce(bareme, 20) as b from evaluations where id = $1`,
        [evaluationId]);
      const b = Number(r.rows[0]?.b ?? 20);
      baremes.set(evaluationId, b > 0 ? b : 20);
      return baremes.get(evaluationId) as number;
    };

    for (const [name, raw] of form) {
      if (!name.startsWith("n_")) continue;
      const parts = name.slice(2).split("_");
      if (parts.length !== 2) continue;
      const [evaluationId, studentId] = parts as [string, string];
      if (!(await evaluationPermise(evaluationId))) continue;

      const v = raw.trim().toLowerCase().replace(",", ".");
      let score: number | null = null;
      let absent = false;

      if (v === "") {
        await c.query(
          `delete from grade_entries where evaluation_id = $1 and student_id = $2`,
          [evaluationId, studentId],
        );
        continue;
      }
      if (v === "abs" || v === "a") {
        absent = true;
      } else {
        /* Le barème de CETTE évaluation, pas 20 en dur : `evaluations.bareme`
           existait depuis le premier schéma sans être lu nulle part. */
        const bareme = await baremeDe(evaluationId);
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > bareme) {
          /* Et surtout : PLUS DE REJET EN SILENCE. Une case qui s'efface sans
             un mot fait croire à l'enseignant qu'il a mal cliqué, et il
             recommence — ou pire, il ne s'en aperçoit pas. */
          refuses.push({ studentId, valeur: raw.trim(), bareme });
          continue;
        }
        score = Math.round(n * 100) / 100;
      }

      await c.query(
        `insert into grade_entries (school_id, evaluation_id, student_id, score,
                                    is_absent, is_justified, recorded_by, updated_at)
         values ($1,$2,$3,$4,$5,false,$6, now())
         on conflict (evaluation_id, student_id) do update
           set score = excluded.score, is_absent = excluded.is_absent,
               recorded_by = excluded.recorded_by, updated_at = now()`,
        [schoolId, evaluationId, studentId, score, absent, staffId],
      );
      saved += 1;
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values ($1,$2,'grades.save','class',$3)`,
      [schoolId, user.userId, JSON.stringify({ classe: url.searchParams.get("classe"), saisies: saved })],
    );
  });
  return { saved, refuses };
}

async function bulletinsPage(user: SessionUser, url: URL, flash?: string): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, "bulletins", period ? `Trimestre ${period.sequence}` : undefined);
  if (!period) return page(chrome, "Bulletins", `<h1>Bulletins</h1><div class="note warn">Aucun trimestre en cours.</div>`);

  const classId = url.searchParams.get("classe");
  const classes = await withSchool(schoolId, async (c) =>
    (await c.query(`select id, label from classes where academic_year_id = $1 order by label`,
      [period.year_id])).rows);

  const selector = `
    <form method="get" action="/bulletins" class="row" style="margin-left:auto">
      <select name="classe" onchange="this.form.submit()" style="width:auto">
        <option value="">Choisir une classe…</option>
        ${classes.map((c: any) =>
          `<option value="${esc(c.id)}"${c.id === classId ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
      </select>
      <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
    </form>`;

  if (!classId) {
    return page(chrome, "Bulletins",
      `<div class="row"><div><h1>Bulletins</h1>
        <p style="margin:0;color:var(--muted)">Choisissez une classe.</p></div>${selector}</div>`);
  }

  const inputs = await loadBulletinInputs(schoolId, classId, period.term_id);
  const klass = computeClassBulletins({
    studentIds: inputs.students.map((s) => s.id),
    grades: inputs.grades,
    coefficients: new Map(inputs.subjects.map((s) => [s.id, s.coefficient])),
    policy: inputs.policy,
    mentionBands: inputs.mentionBands,
  });

  const byId = new Map(inputs.students.map((s) => [s.id, s]));

  // Ce qui a été REMIS aux familles, comparé à ce que disent les notes
  // d'aujourd'hui. Un écart n'est pas corrigé en silence : il est montré.
  const fige = await publishedBulletins(schoolId, classId, period.term_id);
  const divergents = ecarts(fige, klass.students, byId);
  const clos = await termIsClosed(schoolId, period.term_id);

  const rows = [...klass.students]
    .sort((a, b) => (a.rang ?? 999) - (b.rang ?? 999))
    .map((r) => {
      const st = byId.get(r.studentId)!;
      const f = fige.get(r.studentId);
      const ecart = f && f.moyenne !== r.moyenneGenerale;
      return `<tr${ecart ? ' class="bad"' : ""}>
        <td class="num r">${ordinal(r.rang)}</td>
        <td><b>${esc(st.lastName)}</b> ${esc(st.firstNames)}</td>
        <td class="num r" style="font-weight:600">${fr(r.moyenneGenerale)}</td>
        <td class="num r" style="color:var(--muted)">${fr(r.totalPoints)}</td>
        <td>${esc(r.mention ?? "—")}</td>
        <td>${f
          ? (ecart
              ? `<span class="pill p-bad">remis à ${fr(f.moyenne)}</span>`
              : `<span class="pill p-ok">publié</span>`)
          : `<span class="pill p-info">non publié</span>`}</td>
      </tr>`;
    }).join("");

  const warn = [inputs.sourceNotes.policy, inputs.sourceNotes.coefficients].filter(Boolean);

  return page(chrome, "Bulletins", `
    <div class="row"><div><h1>Bulletins — ${esc(inputs.context.className)}</h1>
      <p style="margin:0;color:var(--muted)">${inputs.subjects.length} disciplines, total des coefficients ${fr(klass.students[0]?.totalCoefficients ?? 0, 0)} — moyenne de la classe ${fr(klass.moyenneDeClasse)}.</p>
      </div>${selector}</div>

    ${flash ? `<div class="note good">${esc(flash)}</div>` : ""}
    ${warn.length ? `<div class="note warn"><b>Règles à confirmer avec le censeur.</b><br>${warn.map(esc).join("<br>")}</div>` : ""}

    ${divergents.length ? `<div class="note bad">
      <b>${esc(resumeEcarts(divergents.length))}</b><br>
      ${divergents.slice(0, 6).map((d) =>
        `${esc(d.lastName)} ${esc(d.firstNames)} — ${esc(decrireEcart(d))}`).join("<br>")}
      ${divergents.length > 6 ? `<br>…et ${divergents.length - 6} autres.` : ""}
      <br><br>Une note a bougé depuis la remise. Republier remplacera la copie
      des familles ; ne rien faire la laisse telle quelle. Les deux se
      défendent — mais il faut choisir, pas subir.
    </div>` : ""}

    ${fige.size > 0 && divergents.length === 0 ? `<div class="note good">
      Bulletins publiés : c'est cette copie figée que les familles lisent, et
      c'est elle qu'on réimprimera en juin.</div>` : ""}

    ${can(user, "publier_bulletins") ? `<div class="card"><div class="body row">
      <form method="post" action="/bulletins/publier?classe=${esc(classId)}" style="margin:0">
        <button type="submit" class="btn">${
          fige.size > 0 ? "Republier les bulletins" : "Publier les bulletins"}</button>
      </form>
      <span style="color:var(--muted);font-size:13px">Fige les moyennes, les
        rangs et les mentions. C'est ce document que la famille reçoit.</span>
      ${fige.size === 0 ? "" : `
      <form method="post" action="/bulletins/prevenir?classe=${esc(classId)}" style="margin:0">
        <button type="submit" class="btn ghost">Prévenir les familles</button>
      </form>
      <span style="color:var(--muted);font-size:13px">Un SMS par famille —
        dédoublonné par numéro — avec l'adresse de l'espace des familles. Sans
        cela, personne ne sait qu'il existe.</span>`}
      <div class="grow"></div>
      <form method="post" action="/bulletins/trimestre?classe=${esc(classId)}" style="margin:0">
        <input type="hidden" name="ouvert" value="${clos ? "1" : "0"}">
        <button type="submit" class="btn ghost">${
          clos ? "Rouvrir le trimestre" : "Clôturer le trimestre"}</button>
      </form>
    </div>
    ${clos ? `<div class="body" style="border-top:1px solid var(--rule)">
      <p class="hint" style="margin:0">Trimestre clôturé : aucune note ne peut
      plus y être saisie, en ligne comme hors ligne. Une tablette restée hors
      ligne verra ses notes refusées, avec le motif.</p></div>` : ""}
    </div>` : ""}

    <div class="card">
      <header><h2>Classement</h2>
        <a class="btn" style="margin-left:auto;height:38px" href="/bulletins/imprimer?classe=${esc(classId)}" target="_blank" rel="noopener">Imprimer ${plural(klass.students.length, "le bulletin", "les " + klass.students.length + " bulletins").replace(/^\d+ /, klass.students.length === 1 ? "" : "")}</a>
      </header>
      <div class="scroll"><table>
        <thead><tr><th class="r">Rang</th><th>Élève</th><th class="r">Moyenne</th><th class="r">Points</th><th>Mention</th><th>Bulletin</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`);
}

async function absencesPage(user: SessionUser, url: URL, flash?: string,
                            refus?: string): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, "absences", period ? `Trimestre ${period.sequence}` : undefined);
  if (!period) return page(chrome, "Absences", `<h1>Absences</h1><div class="note warn">Aucun trimestre en cours.</div>`);

  const classId = url.searchParams.get("classe");
  const dateBrute = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  /* Une date malformée ne doit pas atteindre PostgreSQL : elle en ressortait
     en 22P02 sous les yeux de l'utilisateur. On retombe sur aujourd'hui pour
     que l'écran reste utilisable, et on le dit. */
  const date = dateValide(dateBrute)
    ? dateBrute : new Date().toISOString().slice(0, 10);
  const dateCassee = !dateValide(dateBrute);

  // L'appel suit la même répartition que les notes : un enseignant fait
  // l'appel de ses classes, pas de celles des autres.
  const perimetre = await perimetreDe(user);
  if (classId && !peutClasse(perimetre, classId)) {
    return page(chrome, "Absences", `<h1>Absences</h1>
      <div class="note bad">Cette classe ne fait pas partie de votre
      répartition de services.</div>`);
  }

  const d = await withSchool(schoolId, async (c) => {
    const classes = await c.query(
      perimetre.classIds === null
        ? `select id, label from classes where academic_year_id = $1 order by label`
        : `select id, label from classes
            where academic_year_id = $1 and id = any($2::uuid[]) order by label`,
      perimetre.classIds === null
        ? [period.year_id] : [period.year_id, perimetre.classIds]);
    if (!classId) return { classes: classes.rows, students: [], marks: new Map() };

    const students = await c.query(
      `select st.id, st.last_name, st.first_names,
              (select g.phone from student_guardians sg
                 join guardians g on g.id = sg.guardian_id
                where sg.student_id = st.id and sg.receives_sms
                order by sg.is_primary desc limit 1) as tuteur_phone
         from enrolments e join students st on st.id = e.student_id
        where e.class_id = $1 order by st.last_name, st.first_names`,
      [classId]);

    const existing = await c.query(
      `select ar.student_id, ar.status from attendance_records ar
         join attendance_sessions s on s.id = ar.attendance_session_id
        where s.class_id = $1 and s.session_date = $2 and s.session_slot = 'matin'`,
      [classId, date]);

    const marks = new Map<string, string>();
    for (const r of existing.rows) marks.set(r.student_id, r.status);
    return { classes: classes.rows, students: students.rows, marks };
  });

  const selector = `
    <form method="get" action="/absences" class="row" style="margin-left:auto">
      <select name="classe" onchange="this.form.submit()" style="width:auto">
        <option value="">Choisir une classe…</option>
        ${d.classes.map((c: any) =>
          `<option value="${esc(c.id)}"${c.id === classId ? " selected" : ""}>${esc(c.label)}</option>`).join("")}
      </select>
      <input type="date" name="date" value="${esc(date)}" style="width:auto;height:44px;padding:0 10px;border:1px solid var(--line);border-radius:5px">
      <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
    </form>`;

  /* LE JOUR EST-IL UN JOUR D'ÉCOLE ?
   *
   * On le demande AVANT d'afficher la liste. Un écran d'appel ouvert un jour
   * de congés est une invitation : le surveillant coche, valide, et quarante
   * familles reçoivent « votre enfant est absent aujourd'hui » un jour où il
   * n'y avait pas école. Le vrai verrou est à l'écriture (voir saveAbsences) ;
   * celui-ci évite simplement de proposer le geste. */
  const verdict = await withSchool(schoolId, (c) => jourEcole(c, date));
  const alerte = dateCassee
    ? `<div class="note bad">Cette date n'est pas une date. Voici aujourd'hui.</div>`
    : "";

  if (!verdict.ouvert) {
    return page(chrome, "Absences", `
      <div class="row"><div><h1>Appel</h1></div>${selector}</div>
      ${alerte}
      ${refus ? `<div class="note bad">${esc(refus)}</div>` : ""}
      <div class="note warn"><b>Pas d'appel ce jour-là.</b> ${esc(verdict.raison)}
        <div style="margin-top:6px;font-size:13.5px">Aucun SMS ne partirait :
          une famille qui reçoit « votre enfant est absent » un jour sans école
          cesse de croire les messages suivants. Choisissez une autre date, ou
          corrigez le <a href="/calendrier">calendrier</a> si l'école a bien
          travaillé ce jour-là.</div></div>`);
  }

  if (!classId) {
    return page(chrome, "Absences",
      `<div class="row"><div><h1>Appel</h1>
        <p style="margin:0;color:var(--muted)">Choisissez une classe.</p></div>${selector}</div>
       ${alerte}`);
  }

  const rows = d.students.map((st: any) => {
    const cur = d.marks.get(st.id) ?? "present";
    const opt = (v: string, label: string, colour: string) => `
      <label style="display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 12px;
        border:1px solid ${cur === v ? colour : "var(--line)"};border-radius:5px;cursor:pointer;
        background:${cur === v ? colour : "var(--surface)"};color:${cur === v ? "#fff" : "var(--muted)"};
        font-size:13px;text-transform:none;letter-spacing:0;margin:0">
        <input type="radio" name="s_${esc(st.id)}" value="${v}"${cur === v ? " checked" : ""} style="margin:0">
        ${label}</label>`;
    return `<tr${cur === "absent" ? ' class="bad"' : cur === "retard" ? ' class="warn"' : ""}>
      <td><b>${esc(st.last_name)}</b> ${esc(st.first_names)}
        ${st.tuteur_phone ? `<div style="font-size:12px;color:var(--faint)" class="num">${esc(st.tuteur_phone)}</div>`
                          : `<div style="font-size:12px;color:var(--laterite)">Aucun tuteur joignable</div>`}</td>
      <td class="r"><div class="row" style="justify-content:flex-end;gap:6px">
        ${opt("present", "Présent", "var(--verdant)")}
        ${opt("absent", "Absent", "var(--laterite)")}
        ${opt("retard", "Retard", "var(--ochre)")}
      </div></td>
    </tr>`;
  }).join("");

  return page(chrome, "Absences", `
    <div class="row"><div><h1>Appel du matin</h1>
      <p style="margin:0;color:var(--muted)">${plural(d.students.length, "élève")} — ${new Date(date).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
      </div>${selector}</div>
    ${alerte}
    ${refus ? `<div class="note bad">${esc(refus)}</div>` : ""}
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}
    <form method="post" action="/absences?classe=${esc(classId)}&amp;date=${esc(date)}">
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Élève</th><th class="r">Statut</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>
      <div class="row" style="margin-top:16px">
        <button class="btn" type="submit">Valider et prévenir les parents</button>
        <span style="color:var(--muted);font-size:13px">Un SMS part pour chaque absence, au tuteur qui l'a accepté.</span>
      </div>
    </form>`);
}

async function saveAbsences(user: SessionUser, url: URL, form: URLSearchParams):
  Promise<{ absents: number; queued: number; cost: number } | { refus: string } | null> {
  // Comme pour les notes : le contrôle est à l'écriture, pas à l'affichage.
  const perimetreAppel = await perimetreDe(user);
  if (!peutClasse(perimetreAppel, url.searchParams.get("classe") ?? "")) return null;

  const schoolId = user.schoolId!;
  const classId = url.searchParams.get("classe")!;
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const sms = createSmsChannel();

  return withSchool(schoolId, async (c) => {
    /* LE JOUR OÙ L'ÉCOLE EST OUVERTE — contrôlé ICI, à l'écriture.
     *
     * L'écran refuse déjà d'afficher la liste un jour fermé, mais un écran
     * n'est pas une protection : ce POST se fabrique à la main avec la date
     * qu'on veut, et c'est exactement ce que fait le test. Sans ce contrôle,
     * `?date=xyz` remontait une erreur PostgreSQL brute, et `?date=1999-01-01`
     * enregistrait un appel — puis ENVOYAIT LES SMS. */
    const verdict = await jourEcole(c, date);
    if (!verdict.ouvert) return { refus: verdict.raison };

    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    const sess = await c.query(
      `insert into attendance_sessions (school_id, class_id, session_date, session_slot, recorded_by)
       values ($1,$2,$3,'matin',$4)
       on conflict (class_id, session_date, session_slot)
         do update set recorded_by = excluded.recorded_by
       returning id`,
      [schoolId, classId, date, staffId]);
    const sessionId = sess.rows[0].id;

    const school = await c.query(`select name from schools limit 1`);
    const tpl = await c.query(`select body from sms_templates where code = 'ABSENCE' limit 1`);
    const template = tpl.rows[0]?.body ?? "{{ecole}}: {{eleve}} absent(e) le {{date}}.";

    let absents = 0, queued = 0, cost = 0;

    for (const [name, status] of form) {
      if (!name.startsWith("s_")) continue;
      const studentId = name.slice(2);
      if (!["present", "absent", "retard"].includes(status)) continue;

      const prev = await c.query(
        `select status from attendance_records
          where attendance_session_id = $1 and student_id = $2`,
        [sessionId, studentId]);
      const wasAbsent = prev.rows[0]?.status === "absent";

      await c.query(
        `insert into attendance_records (school_id, attendance_session_id, student_id, status, updated_at)
         values ($1,$2,$3,$4, now())
         on conflict (attendance_session_id, student_id) do update
           set status = excluded.status, updated_at = now()`,
        [schoolId, sessionId, studentId, status]);

      if (status !== "absent") continue;
      absents += 1;
      if (wasAbsent) continue; // déjà signalé : on ne renvoie pas de SMS

      const g = await c.query(
        `select st.first_names, g.id as guardian_id, g.phone
           from students st
           left join student_guardians sg on sg.student_id = st.id and sg.receives_sms
           left join guardians g on g.id = sg.guardian_id
          where st.id = $1
          order by sg.is_primary desc nulls last limit 1`,
        [studentId]);
      const row = g.rows[0];
      if (!row?.phone) continue;

      const body = renderTemplate(template, {
        ecole: school.rows[0]?.name ?? "",
        eleve: row.first_names,
        date: new Date(date).toLocaleDateString("fr-FR"),
        telephone: "",
      }).replace(/\s+Contact:\s*\.$/, ".");

      const segments = countSegments(body);
      const result = await sms.send({ to: row.phone, body, schoolId, studentId });

      await c.query(
        `insert into sms_messages (school_id, student_id, guardian_id, to_phone, body,
                                   segments, cost_fcfa, status, provider, provider_ref,
                                   error_detail, sent_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 case when $8 = 'envoye' then now() end)`,
        [schoolId, studentId, row.guardian_id, row.phone, body, segments,
         result.costFcfa, result.ok ? "envoye" : "echoue", sms.name,
         result.providerRef ?? null,
         // Sans la raison, « échoué » ne dit pas s'il faut rappeler la famille
         // ou corriger un chiffre du numéro.
         result.ok ? null : (result.error ?? "Refus de l'opérateur, sans détail")]);

      if (result.ok) { queued += 1; cost += result.costFcfa; }
    }

    if (queued > 0) {
      await c.query(
        `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
         values ($1,'consommation',$2,$3,'Alertes absence')`,
        [schoolId, queued, cost]);
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values ($1,$2,'attendance.save','class',$3)`,
      [schoolId, user.userId, JSON.stringify({ classe: classId, date, absents, sms: queued })]);

    return { absents, queued, cost };
  });
}


// ---------------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const token = cookies(req).fs_session ?? null;
  const user = await resolveSession(token);

  /* Fichiers statiques : liste blanche explicite, aucune traversée possible.
   *
   * La clé est l'URL demandée, la valeur dit quel fichier servir et comment.
   * `/hors-ligne` n'a pas d'extension parce que c'est une PAGE, pas une
   * ressource : c'est elle que le service worker ouvre quand une navigation
   * échoue, et elle doit s'afficher dans la barre d'adresse comme une page.
   *
   * Les icônes sont binaires. Elles étaient impossibles à servir par l'ancien
   * chemin, qui lisait tout en utf-8 : un PNG relu en utf-8 revient corrompu,
   * sans erreur, et le navigateur affiche une image cassée. D'où `binaire`.
   */
  const STATIC: Record<string, { fichier: string; type: string; binaire?: true }> = {
    "/offline.js": { fichier: "offline.js", type: "application/javascript; charset=utf-8" },
    "/app.js": { fichier: "app.js", type: "application/javascript; charset=utf-8" },
    "/sw.js": { fichier: "sw.js", type: "application/javascript; charset=utf-8" },
    "/hors-ligne": { fichier: "hors-ligne.html", type: "text/html; charset=utf-8" },
    "/manifest.webmanifest": {
      fichier: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
    "/icones/fasoschool-32.png": {
      fichier: "icones/fasoschool-32.png", type: "image/png", binaire: true },
    "/icones/fasoschool-192.png": {
      fichier: "icones/fasoschool-192.png", type: "image/png", binaire: true },
    "/icones/fasoschool-512.png": {
      fichier: "icones/fasoschool-512.png", type: "image/png", binaire: true },
    "/icones/fasoschool-512-masquable.png": {
      fichier: "icones/fasoschool-512-masquable.png", type: "image/png", binaire: true },
    "/icones/fasoschool-apple-180.png": {
      fichier: "icones/fasoschool-apple-180.png", type: "image/png", binaire: true },
  };
  const statique = STATIC[path];
  if (req.method === "GET" && statique) {
    try {
      const cible = new URL(`../../public/${statique.fichier}`, import.meta.url);
      const body = statique.binaire
        ? await readFile(cible)
        : await readFile(cible, "utf-8");
      res.writeHead(200, {
        "content-type": statique.type,
        /* Les icônes ne changent jamais sans changer de nom ; le reste doit
           pouvoir être corrigé sans attendre l'expiration d'un cache. */
        "cache-control": statique.binaire
          ? "public, max-age=604800"
          : "no-cache",
        "x-content-type-options": "nosniff",
        // Le service worker doit pouvoir contrôler toute l'origine.
        ...(path === "/sw.js" ? { "service-worker-allowed": "/" } : {}),
      });
      return res.end(body);
    } catch { return html(res, "Introuvable.", 404); }
  }

  /* --- Espace famille -------------------------------------------------------
   *
   * Volontairement AVANT le mur d'authentification du personnel, et sur son
   * propre cookie. Une session de famille ne traverse jamais resolveSession() :
   * il n'existe aucun chemin qui la transforme en session de personnel.
   */
  const familyToken = cookies(req).fs_famille ?? null;

  if (path === "/famille" && req.method === "GET") {
    const g = await resolveGuardian(familyToken);
    if (!g) return html(res, familleLoginPage("phone"));
    const [nom, enfants] = await Promise.all([
      schoolNameOf(g.schoolId), loadChildren(g),
    ]);
    return html(res, famillePage(g, nom, enfants));
  }
  if (path === "/famille/connexion" && req.method === "POST") {
    const form = await formBody(req);
    const phone = form.get("phone") ?? "";
    // Le défi est créé même pour un numéro inconnu : répondre différemment
    // ferait de cette page un annuaire des familles de l'établissement.
    const r = await issueOtp(phone, (p, c) => guardianExists(c, p));
    return html(res, r.ok
      ? familleLoginPage("code", { phone, devCode: r.devCode })
      : familleLoginPage("phone", { phone, error: r.error }));
  }
  if (path === "/famille/verifier" && req.method === "POST") {
    const form = await formBody(req);
    const phone = form.get("phone") ?? "";
    const verdict = await withoutSchool(async (c) =>
      consumeOtp(c, phone, form.get("code") ?? ""));
    if (!verdict.ok) {
      return html(res, familleLoginPage("code", { phone, error: verdict.error }));
    }
    const tok = await createGuardianSession(phone);
    if (!tok) {
      return html(res, familleLoginPage("phone", { phone,
        error: "Ce numéro n'est rattaché à aucun élève. Voyez le secrétariat." }));
    }
    return redirect(res, "/famille",
      cookieSession(req, "fs_famille", tok, "/famille", 43200));
  }
  if (path === "/famille/sortie") {
    if (familyToken) await revokeGuardian(familyToken);
    return redirect(res, "/famille",
      cookieSession(req, "fs_famille", "", "/famille", 0));
  }

  // Connexion
  if (path === "/connexion" && req.method === "GET") {
    return html(res, loginPage({ step: "phone" }));
  }
  if (path === "/connexion" && req.method === "POST") {
    const form = await formBody(req);
    const phone = form.get("phone") ?? "";
    const r = await startLogin(phone);
    return html(res, r.ok
      ? loginPage({ step: "code", phone, devCode: r.devCode })
      : loginPage({ step: "phone", phone, error: r.error }));
  }
  if (path === "/connexion/verifier" && req.method === "POST") {
    const form = await formBody(req);
    const phone = form.get("phone") ?? "";
    const r = await verifyLogin(phone, form.get("code") ?? "");
    if (!r.ok) return html(res, loginPage({ step: "code", phone, error: r.error }));
    return redirect(res, "/",
      cookieSession(req, "fs_session", r.token ?? "", "/", 43200));
  }
  if (path === "/deconnexion") {
    if (token) await revokeSession(token);
    return redirect(res, "/connexion",
      cookieSession(req, "fs_session", "", "/", 0));
  }

  if (!user) return redirect(res, "/connexion");
  if (!user.schoolId) {
    return html(res, `<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;padding:40px">
      Ce compte n'est rattaché à aucun établissement.</p>`, 403);
  }

  try {
    if (path === "/" && req.method === "GET") return html(res, await dashboard(user));

    if (path === "/notes" && req.method === "GET") {
      if (!can(user, "voir_notes")) return html(res, "Accès refusé.", 403);
      return html(res, await notesPage(user, url));
    }
    if (path === "/notes" && req.method === "POST") {
      if (!can(user, "saisir_notes")) return html(res, "Accès refusé.", 403);
      const r = await saveNotes(user, url, await formBody(req));
      let message = `${plural(r.saved, "note enregistrée", "notes enregistrées")}.`;
      if (r.refuses.length) {
        // Nommer l'élève et la valeur tapée : « une saisie refusée » sans dire
        // laquelle oblige l'enseignant à relire trente lignes.
        const noms = await withSchool(user.schoolId!, async (c) =>
          new Map((await c.query(
            `select id, last_name || ' ' || first_names as nom from students
              where id = any($1::uuid[])`,
            [r.refuses.map((x) => x.studentId)])).rows.map(
              (x: any) => [x.id as string, x.nom as string])));
        message += ` ${plural(r.refuses.length, "saisie refusée", "saisies refusées")} : `
          + r.refuses.map((x) => `${noms.get(x.studentId) ?? "?"} « ${x.valeur} »`)
              .join(", ")
          + ` — la note doit être un nombre entre 0 et ${
              r.refuses[0]!.bareme}, ou « abs ».`;
      }
      return html(res, await notesPage(user, url, message));
    }

    if (path === "/bulletins" && req.method === "GET") {
      if (!can(user, "voir_notes")) return html(res, "Accès refusé.", 403);
      return html(res, await bulletinsPage(user, url));
    }
    if (path === "/bulletins/imprimer" && req.method === "GET") {
      if (!can(user, "voir_notes")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      const classId = url.searchParams.get("classe");
      if (!period || !classId) return redirect(res, "/bulletins");
      const inputs = await loadBulletinInputs(user.schoolId, classId, period.term_id);
      /* On réimprime la copie PUBLIÉE quand elle existe. Sans cela, le double
         ressorti en juin pour un dossier de transfert ne serait pas la feuille
         remise en décembre — et c'est le double qui ferait foi. */
      const fige = await frozenClassResult(user.schoolId, classId, period.term_id);
      const klass = fige ?? computeClassBulletins({
        studentIds: inputs.students.map((s) => s.id),
        grades: inputs.grades,
        coefficients: new Map(inputs.subjects.map((s) => [s.id, s.coefficient])),
        policy: inputs.policy,
        mentionBands: inputs.mentionBands,
      });
      return html(res, renderClassBulletins(inputs, klass));
    }

    if (path === "/absences" && req.method === "GET") {
      if (!can(user, "faire_appel")) return html(res, "Accès refusé.", 403);
      return html(res, await absencesPage(user, url));
    }
    if (path === "/absences" && req.method === "POST") {
      if (!can(user, "faire_appel")) return html(res, "Accès refusé.", 403);
      const r = await saveAbsences(user, url, await formBody(req));
      if (!r) {
        return html(res, await absencesPage(user, url,
          "Cette classe ne fait pas partie de votre répartition de services."));
      }
      if ("refus" in r) {
        // Rien n'a été écrit, aucun SMS n'est parti, et on dit pourquoi.
        return html(res, await absencesPage(user, url, undefined,
          `Appel impossible. ${r.refus}`));
      }
      return html(res, await absencesPage(user, url,
        `Appel enregistré : ${plural(r.absents, "absence")}, ${plural(r.queued, "SMS envoyé", "SMS envoyés")} pour ${r.cost} F.`));
    }

    if (path === "/api/sync/notes" && req.method === "POST") {
      if (!can(user, "saisir_notes")) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "forbidden" }));
      }
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      let payload: unknown = null;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf-8")); } catch { payload = null; }
      const results = await applyMutations(user, parseMutations(payload));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ results }));
    }

    if (path === "/conflits" && req.method === "GET") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "conflits");
      return html(res, await conflictsPage(user, chrome));
    }
    if (path === "/conflits" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const choix = form.get("choix") === "appareil" ? "appareil" : "serveur";
      const flash = await resolveConflict(user, form.get("id") ?? "", choix);
      const chrome = await chromeFor(user, "conflits");
      return html(res, await conflictsPage(user, chrome, flash));
    }

    if (path === "/parametres" && req.method === "GET") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      if (!period) return redirect(res, "/");
      const chrome = await chromeFor(user, "parametres", `Année ${period.year_label}`);
      return html(res, await settingsPage(user, chrome, period as Period));
    }
    if (path === "/parametres" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      if (!period) return redirect(res, "/");
      const flash = await saveSettings(user, period as Period, await formBody(req));
      const chrome = await chromeFor(user, "parametres", `Année ${period.year_label}`);
      return html(res, await settingsPage(user, chrome, period as Period, flash));
    }

    if (path === "/scolarite" && req.method === "GET") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "scolarite");
      const recu = url.searchParams.get("recu");
      const flash = recu
        ? `Paiement enregistré. <a href="/recus/${esc(recu)}" target="_blank" rel="noopener"><b>Ouvrir le reçu ${esc(recu)}</b></a>`
        : undefined;
      return html(res, await financePage(user, chrome, url, flash));
    }
    if (path === "/scolarite/encaisser" && req.method === "GET") {
      if (!can(user, "encaisser")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "scolarite");
      return html(res, await collectPage(user, chrome, url.searchParams.get("facture") ?? ""));
    }
    if (path === "/scolarite/encaisser" && req.method === "POST") {
      if (!can(user, "encaisser")) return html(res, "Accès refusé.", 403);
      const r = await collect(user, await formBody(req));
      if (r.ok) return redirect(res, `/scolarite?recu=${encodeURIComponent(r.receipt)}`);
      const chrome = await chromeFor(user, "scolarite");
      return html(res, await collectPage(user, chrome, r.invoiceId, r.error));
    }
    if (path === "/scolarite/annuler" && req.method === "POST") {
      if (!can(user, "encaisser")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const r = await annulerPaiement(user, form.get("paiement") ?? "",
                                      form.get("motif") ?? "");
      const chrome = await chromeFor(user, "scolarite");
      return html(res, await collectPage(user, chrome, r.invoiceId ?? "",
        r.ok ? undefined : r.error,
        r.ok ? `Paiement annulé. Le reçu de contrepartie ${r.recu} a été émis : `
             + `remettez-le à la famille, l'ancien ne vaut plus quittance.`
             : undefined));
    }
    if (path.startsWith("/recus/") && req.method === "GET") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const body = await receiptPage(user.schoolId, decodeURIComponent(path.slice(7)));
      if (!body) return html(res, "Reçu introuvable.", 404);
      return html(res, body);
    }
    if (path === "/categorisation" && req.method === "GET") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      return html(res, await categorisationPage(user, await chromeFor(user, "categorisation")));
    }
    if (path === "/categorisation" && req.method === "POST") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      const r = await saveDossier(user, await formBody(req));
      return html(res, await categorisationPage(
        user, await chromeFor(user, "categorisation"), r.flash, r.error));
    }
    /* --- Pièces justificatives ------------------------------------------
     *
     * Le téléchargement d'un fichier déposé par un utilisateur est le point le
     * plus délicat de tout le produit. Trois précautions, ensemble :
     *
     *   - `Content-Disposition: attachment` : le navigateur enregistre, il
     *     n'affiche jamais. Un document affiché depuis NOTRE origine
     *     s'exécuterait avec le cookie de session de celui qui l'ouvre — le
     *     directeur, puisque c'est lui qui relit le dossier.
     *   - `X-Content-Type-Options: nosniff` : le navigateur ne cherche pas à
     *     deviner un type plus « intéressant » que celui annoncé.
     *   - un nom de fichier reconstruit, jamais celui de l'expéditeur : un nom
     *     contenant un guillemet ou un retour à la ligne s'échapperait de
     *     l'en-tête.
     *
     * Et 404, jamais 403, quand la pièce appartient à un autre établissement :
     * un 403 confirmerait que l'identifiant existe. */
    if (path === "/categorisation/piece" && req.method === "GET") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      const p = await telechargerPiece(user, url.searchParams.get("id") ?? "");
      if (!p) return html(res, "Pièce introuvable.", 404);
      res.writeHead(200, {
        "content-type": p.type,
        "content-length": String(p.bytes.length),
        "content-disposition":
          `attachment; filename="${nomSur(p.nom, p.type)}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      return res.end(p.bytes);
    }
    if (path === "/categorisation/piece" && req.method === "POST") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "categorisation");
      if (!isMultipart(req)) {
        return html(res, await categorisationPage(user, chrome, undefined,
          "Le formulaire n'a pas envoyé de fichier."));
      }
      let r: { flash?: string; error?: string };
      try {
        const corps = await readMultipart(req, TAILLE_MAX + 65_536);
        r = await joindrePiece(user, corps.fields.get("critere") ?? "",
          corps.files.get("fichier"), corps.fields.get("label") ?? "");
      } catch (e) {
        // Dépassement de taille : `readMultipart` interrompt la lecture.
        r = { error: "Ce fichier est trop volumineux pour être joint." };
      }
      return html(res, await categorisationPage(user, chrome, r.flash, r.error));
    }
    if (path === "/categorisation/piece/retirer" && req.method === "POST") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const r = await retirerPiece(user, form.get("id") ?? "");
      return html(res, await categorisationPage(
        user, await chromeFor(user, "categorisation"), r.flash, r.error));
    }

    if (path === "/categorisation/critere" && req.method === "POST") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      const r = await addCriterion(user, await formBody(req));
      return html(res, await categorisationPage(
        user, await chromeFor(user, "categorisation"), r.flash, r.error));
    }

    // --- Conseil de classe -------------------------------------------------
    if (path === "/conseil" && req.method === "GET") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "conseil");
      return html(res, await conseilPage(user, chrome, url));
    }
    if (path === "/conseil" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const classe = url.searchParams.get("classe") ?? "";
      const out = await saveDeliberation(user, classe, await formBody(req));
      const flash = [
        out.saved ? `${plural(out.saved, "décision enregistrée", "décisions enregistrées")}.` : "",
        ...out.refused.map(esc),
      ].filter(Boolean).join(" ");
      const chrome = await chromeFor(user, "conseil");
      return html(res, await conseilPage(user, chrome, url, flash));
    }

    // --- Transferts et livret scolaire ---------------------------------------
    if (path === "/transferts" && req.method === "GET") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      return html(res, await transfertsPage(
        user, await chromeFor(user, "transferts"), url));
    }
    if (path === "/transferts" && req.method === "POST") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const r = await recordTransfer(user, await formBody(req));
      const u = new URL(url.toString());
      if (r.studentId) u.searchParams.set("eleve", r.studentId);
      return html(res, await transfertsPage(
        user, await chromeFor(user, "transferts"), u, r.flash, r.error));
    }
    if (path === "/transferts/livret" && req.method === "POST") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const r = await addLivretEntry(user, await formBody(req));
      const u = new URL(url.toString());
      if (r.studentId) u.searchParams.set("eleve", r.studentId);
      return html(res, await transfertsPage(
        user, await chromeFor(user, "transferts"), u, r.flash, r.error));
    }
    if (path === "/transferts/certificat" && req.method === "GET") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const body = await certificatePage(
        user.schoolId, url.searchParams.get("eleve") ?? "");
      if (!body) return html(res, "Élève introuvable.", 404);
      return html(res, body);
    }

    // --- Communiqués aux familles -------------------------------------------
    if (path === "/communiques" && req.method === "GET") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      return html(res, await communiquesPage(
        user, await chromeFor(user, "communiques"), url));
    }
    if (path === "/communiques" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const out = await envoyerCommunique(user, form);
      // On rejoue l'écran sur le même brouillon : en cas de refus, le message
      // saisi ne doit pas être perdu.
      const rejoue = new URL(url.toString());
      for (const k of ["titre", "corps", "cible", "classe"]) {
        rejoue.searchParams.set(k, form.get(k) ?? "");
      }
      if (!out.error) rejoue.search = "";
      return html(res, await communiquesPage(
        user, await chromeFor(user, "communiques"), rejoue,
        out.error ? undefined
          : `${plural(out.envoyes, "famille prévenue", "familles prévenues")} `
            + `pour ${out.cout} FCFA.`
            + (out.refuses
                ? ` ${plural(out.refuses, "message n'est pas parti",
                             "messages ne sont pas partis")} : voyez le suivi `
                  + `des messages pour joindre ces familles autrement.`
                : ""),
        out.error));
    }

    // --- Justifications ------------------------------------------------------
    if (path === "/justifications") {
      // Qui fait l'appel justifie : c'est la vie scolaire qui reçoit le mot
      // des parents, pas l'enseignant de mathématiques.
      if (!can(user, "faire_appel")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "justifications");
      if (req.method === "GET") {
        return html(res, await justificationsPage(user, chrome, url));
      }
      if (req.method === "POST") {
        const form = await formBody(req);
        const out = await deciderJustification(user, form);
        const retour = new URL(url.toString());
        if (out.classId) retour.searchParams.set("classe", out.classId);
        return html(res, await justificationsPage(user, chrome, retour,
          out.flash, out.error));
      }
    }

    // --- Calendrier ----------------------------------------------------------
    //
    // Le calendrier appartient au censeur, comme les règles de notation : il
    // décide quels jours l'école travaille, donc quels jours un SMS d'absence
    // peut partir. Ce n'est pas un écran d'agrément — c'est un verrou.
    if (path === "/calendrier" || path === "/calendrier/retirer"
        || path === "/calendrier/semaine") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "calendrier");
      if (path === "/calendrier" && req.method === "GET") {
        return html(res, await calendrierPage(user, chrome));
      }
      if (req.method === "POST") {
        const form = await formBody(req);
        const out = path === "/calendrier" ? await ajouterPeriode(user, form)
          : path === "/calendrier/retirer" ? await retirerPeriode(user, form)
          : await changerSemaine(user, form);
        return html(res, await calendrierPage(user, chrome, out.flash, out.error));
      }
    }

    // --- Discipline ----------------------------------------------------------
    if (path === "/discipline" || path === "/discipline/retirer") {
      if (!can(user, "tenir_discipline")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "discipline");
      if (path === "/discipline" && req.method === "GET") {
        return html(res, await disciplinePage(user, chrome, url));
      }
      if (req.method === "POST") {
        const form = await formBody(req);
        const out = path === "/discipline"
          ? await consigner(user, form)
          : await retirerIncident(user, form);
        const retour = new URL(url.toString());
        if (out.classId) retour.searchParams.set("classe", out.classId);
        return html(res, await disciplinePage(user, chrome, retour,
          out.flash, out.error));
      }
    }

    // --- Fiche de l'élève ----------------------------------------------------
    if (path === "/eleves" && req.method === "GET") {
      if (!can(user, "voir_eleve")) return html(res, "Accès refusé.", 403);
      return html(res, await elevesPage(user, await chromeFor(user, "eleves"), url));
    }
    if (path === "/eleve" && req.method === "GET") {
      if (!can(user, "voir_eleve")) return html(res, "Accès refusé.", 403);
      return html(res, await elevePage(user, await chromeFor(user, "eleves"), url));
    }
    if (path.startsWith("/eleve/") && req.method === "POST") {
      // Voir n'est pas corriger : l'écriture reste au secrétariat.
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const out =
        path === "/eleve/identite" ? await corrigerIdentite(user, form)
        : path === "/eleve/tuteur" ? await enregistrerTuteur(user, form)
        : path === "/eleve/tuteur/retirer" ? await retirerTuteur(user, form)
        : path === "/eleve/urgence" ? await enregistrerUrgence(user, form)
        : path === "/eleve/urgence/retirer" ? await retirerUrgence(user, form)
        : null;
      if (!out) return html(res, "Page introuvable.", 404);
      const retour = new URL(url.toString());
      retour.searchParams.set("id", out.studentId ?? form.get("eleve") ?? "");
      return html(res, await elevePage(user, await chromeFor(user, "eleves"),
        retour, out.flash, out.error));
    }

    // --- Personnel -----------------------------------------------------------
    if (path === "/personnel" || path === "/personnel/fonction"
        || path === "/personnel/activite") {
      // Créer un compte, c'est donner accès à tout l'établissement : le
      // contrôle est ici, pas dans la barre de navigation.
      if (!can(user, "gerer_personnel")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "personnel");

      if (path === "/personnel" && req.method === "GET") {
        return html(res, await personnelPage(user, chrome, url));
      }
      if (req.method === "POST") {
        const form = await formBody(req);
        const out =
          path === "/personnel" ? await ajouterMembre(user, form)
          : path === "/personnel/fonction"
            ? await changerFonction(user, form.get("membre") ?? "",
                                    form.get("fonction") ?? "")
          : path === "/personnel/activite"
            ? await basculerActivite(user, form.get("membre") ?? "",
                                     form.get("actif") === "1")
          : { error: undefined, flash: undefined };
        return html(res, await personnelPage(user, chrome, url,
          out.flash, out.error));
      }
    }

    // --- Suivi des messages --------------------------------------------------
    if (path === "/messages" && req.method === "GET") {
      if (!can(user, "suivre_messages")) return html(res, "Accès refusé.", 403);
      return html(res, await messagesPage(
        user, await chromeFor(user, "messages"), url));
    }
    if ((path === "/messages/resoudre" || path === "/messages/renvoyer")
        && req.method === "POST") {
      if (!can(user, "suivre_messages")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const out = path === "/messages/renvoyer"
        ? await renvoyerMessage(user, form.get("message") ?? "")
        : await resoudreMessage(user, form.get("message") ?? "",
                                form.get("issue") ?? "");
      const retour = new URL(url.toString());
      retour.searchParams.set("filtre", form.get("filtre") ?? "a_traiter");
      return html(res, await messagesPage(
        user, await chromeFor(user, "messages"), retour, out.flash, out.error));
    }

    // --- Évaluations ---------------------------------------------------------
    if (path === "/notes/evaluation" && req.method === "POST") {
      if (!can(user, "saisir_notes")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const r = await createEvaluation(user, form);
      const u = new URL(`${url.origin}/notes`);
      u.searchParams.set("classe", form.get("classe") ?? "");
      u.searchParams.set("matiere", form.get("matiere") ?? "");
      return html(res, await notesPage(user, u, r.flash ?? r.error));
    }
    if (path === "/notes/evaluation/retirer" && req.method === "POST") {
      if (!can(user, "saisir_notes")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const r = await deleteEvaluation(user, form.get("id") ?? "");
      const u = new URL(`${url.origin}/notes`);
      u.searchParams.set("classe", form.get("classe") ?? "");
      u.searchParams.set("matiere", form.get("matiere") ?? "");
      return html(res, await notesPage(user, u, r.flash ?? r.error));
    }

    // --- Bourses et remises ---------------------------------------------------
    if (path === "/bourses" && req.method === "GET") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      return html(res, await boursesPage(user, await chromeFor(user, "bourses")));
    }
    if (path === "/bourses" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const r = await grantBourse(user, await formBody(req));
      return html(res, await boursesPage(
        user, await chromeFor(user, "bourses"), r.flash, r.error));
    }
    if (path === "/bourses/retirer" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const r = await revokeBourse(user, (await formBody(req)).get("id") ?? "");
      return html(res, await boursesPage(
        user, await chromeFor(user, "bourses"), r.flash, r.error));
    }

    // --- Grille des frais et émission des factures --------------------------
    if (path === "/frais" && req.method === "GET") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      return html(res, await fraisPage(user, await chromeFor(user, "frais")));
    }
    if (path === "/frais/grille" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const r = await addSchedule(user, await formBody(req));
      return html(res, await fraisPage(user, await chromeFor(user, "frais"), r.flash, r.error));
    }
    if (path === "/frais/ligne" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const r = await addLine(user, await formBody(req));
      return html(res, await fraisPage(user, await chromeFor(user, "frais"), r.flash, r.error));
    }
    if (path === "/frais/ligne/retirer" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const r = await removeLine(user, (await formBody(req)).get("id") ?? "");
      return html(res, await fraisPage(user, await chromeFor(user, "frais"), r.flash, r.error));
    }
    if (path === "/frais/emettre" && req.method === "POST") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const out = await issueInvoices(user, (await formBody(req)).get("classe") ?? "");
      const flash = out.error ? undefined
        : `${plural(out.emises, "facture émise", "factures émises")}`
          + `${out.deja ? `, ${out.deja} élève(s) déjà facturé(s)` : ""}`
          + `${out.remisesFcfa ? `, ${fcfa(out.remisesFcfa)} FCFA de remises déduits` : ""}.`;
      return html(res, await fraisPage(
        user, await chromeFor(user, "frais"), flash, out.error));
    }

    // --- Publication et clôture ---------------------------------------------
    if (path === "/bulletins/publier" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      const classe = url.searchParams.get("classe") ?? "";
      if (!period || !classe) return redirect(res, "/bulletins");
      const out = await publishClass(user, classe, period.term_id);
      return html(res, await bulletinsPage(user, url,
        `${plural(out.publies + out.republies, "bulletin figé", "bulletins figés")}`
        + `${out.republies ? ` (dont ${out.republies} remplacés)` : ""}.`));
    }
    if (path === "/bulletins/prevenir" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      const classe = url.searchParams.get("classe") ?? "";
      if (!period || !classe) return redirect(res, "/bulletins");
      const a = await previenirFamilles(user, classe, period.term_id);
      return html(res, await bulletinsPage(user, url, a.error
        ? a.error
        : `${plural(a.envoyes, "famille prévenue", "familles prévenues")} `
          + `pour ${a.cout} FCFA.`
          + (a.refuses
              ? ` ${plural(a.refuses, "message n'est pas parti",
                           "messages ne sont pas partis")} : voyez le suivi `
                + `des messages.`
              : "")));
    }
    if (path === "/bulletins/trimestre" && req.method === "POST") {
      if (!can(user, "publier_bulletins")) return html(res, "Accès refusé.", 403);
      const period = await currentPeriod(user.schoolId);
      if (!period) return redirect(res, "/bulletins");
      const form = await formBody(req);
      const r = await setTermStatus(user, period.term_id, form.get("ouvert") === "1");
      return html(res, await bulletinsPage(user, url, r.flash ?? r.error));
    }

    // --- Répartition des services ------------------------------------------
    if (path === "/services" && req.method === "GET") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      return html(res, await servicesPage(user, await chromeFor(user, "services")));
    }
    if (path === "/services/principal" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const r = await nommerProfesseurPrincipal(user, await formBody(req));
      return html(res, await servicesPage(
        user, await chromeFor(user, "services"), r.flash, r.error));
    }
    if (path === "/services" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const r = await addService(user, await formBody(req));
      return html(res, await servicesPage(
        user, await chromeFor(user, "services"), r.flash, r.error));
    }
    if (path === "/services/retirer" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const r = await removeService(user, (await formBody(req)).get("id") ?? "");
      return html(res, await servicesPage(
        user, await chromeFor(user, "services"), r.flash, r.error));
    }

    // --- Rentrée : année, trimestres, classes ------------------------------
    if (path === "/annee" && req.method === "GET") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "annee");
      return html(res, await rentreePage(user, chrome,
        url.searchParams.get("annee") ?? undefined, undefined, undefined,
        url.searchParams.has("nouvelle")));
    }
    if (path === "/annee" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const r = await saveYear(user, await formBody(req));
      const chrome = await chromeFor(user, "annee");
      return html(res, await rentreePage(user, chrome, r.yearId, r.flash, r.error));
    }
    if (path === "/annee/ouvrir" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const annee = form.get("annee") ?? "";
      const r = await openYear(user, annee);
      const chrome = await chromeFor(user, "annee");
      return html(res, await rentreePage(user, chrome, annee, r.flash, r.error));
    }
    if (path === "/annee/classe" && req.method === "POST") {
      if (!can(user, "parametrer")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const annee = form.get("annee") ?? "";
      const r = await addClass(user, form);
      const chrome = await chromeFor(user, "annee");
      return html(res, await rentreePage(user, chrome, annee, r.flash, r.error));
    }

    // --- Inscriptions -----------------------------------------------------
    // Trois étapes séparées : déposer, voir, écrire. Rien ne s'enregistre
    // avant que le secrétaire ait vu la liste ligne par ligne.
    if (path === "/inscriptions" && req.method === "GET") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      return html(res, await importPage(user, await chromeFor(user, "inscriptions")));
    }
    if (path === "/inscriptions/lire" && req.method === "POST") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const chrome = await chromeFor(user, "inscriptions");
      let fichier: Buffer | undefined;
      let colle = "";
      let classe = "";
      try {
        if (isMultipart(req)) {
          const m = await readMultipart(req);
          fichier = m.files.get("fichier")?.bytes;
          colle = m.fields.get("colle") ?? "";
          classe = m.fields.get("classe") ?? "";
        } else {
          const f = await formBody(req);
          colle = f.get("colle") ?? "";
          classe = f.get("classe") ?? "";
        }
      } catch (e) {
        return html(res, await importPage(user, chrome, (e as Error).message));
      }
      const reading = readSubmitted(fichier, colle);
      if (!reading || reading.rows.length === 0) {
        return html(res, await importPage(user, chrome,
          "Aucune ligne lisible : choisissez un fichier ou collez le tableau."));
      }
      return html(res, await previewPage(user, chrome, reading, classe));
    }
    if (path === "/inscriptions/importer" && req.method === "POST") {
      if (!can(user, "inscrire")) return html(res, "Accès refusé.", 403);
      const form = await formBody(req);
      const rows = applyCorrections(decodeRows(form.get("lignes") ?? ""), form);
      const out = await runImport(user, rows, form.get("classe") ?? "");
      return html(res, resultPage(await chromeFor(user, "inscriptions"), out));
    }

    if (path === "/sante") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, service: "fasoschool" }));
    }
  } catch (error) {
    console.error(error);
    return html(res, `<!doctype html><meta charset="utf-8">
      <p style="font-family:sans-serif;padding:40px">Une erreur est survenue. Elle a été journalisée.</p>`, 500);
  }

  return html(res, `<!doctype html><meta charset="utf-8">
    <p style="font-family:sans-serif;padding:40px">Page introuvable. <a href="/">Retour au tableau de bord</a></p>`, 404);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end("Erreur");
  });
});

server.listen(PORT, () => {
  console.log(`FasoSchool sur http://localhost:${PORT}`);
});

const stop = async () => { server.close(); await pool.end(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
