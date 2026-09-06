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
import { financePage, collectPage, collect, receiptPage } from "./finance.ts";
import { parseMutations, applyMutations, conflictsPage, resolveConflict, conflictCount } from "./sync.ts";
import {
  importPage, previewPage, resultPage, runImport,
  readSubmitted, decodeRows, applyCorrections,
} from "./roster.ts";
import { isMultipart, readMultipart } from "./multipart.ts";
import { rentreePage, saveYear, openYear, addClass } from "./rentree.ts";
import { conseilPage, saveDeliberation } from "./conseil.ts";
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
    return page(chrome, "Tableau de bord",
      `<h1>Tableau de bord</h1><div class="note warn">Aucune année scolaire en cours. Créez-en une pour commencer.</div>`);
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
      `select coalesce(sum(i.total_fcfa),0) - coalesce((
                select sum(p.amount_fcfa) from payments p
                 where p.status in ('confirme','rapproche')), 0) as reste,
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

  return page(chrome, "Tableau de bord", `
    <div>
      <h1>Bonjour ${esc(user.fullName.split(" ").slice(-1)[0])}</h1>
      <p style="margin:0;color:var(--muted)">${plural(data.classes.length, "classe")} — trimestre ${period.sequence}, clôture le ${new Date(period.ends_on).toLocaleDateString("fr-FR")}.</p>
    </div>

    <div class="tiles">
      <div class="tile"><div class="k">Bulletins prêts</div>
        <div class="v">${complets}<span style="font-size:15px;color:var(--faint)"> / ${data.classes.length}</span></div>
        <div class="n">${data.classes.length - complets <= 1 ? plural(data.classes.length - complets, "classe attend") : plural(data.classes.length - complets, "classes attendent", "classes attendent")} des notes</div></div>
      <div class="tile"><div class="k">Absences aujourd'hui</div>
        <div class="v">${data.absToday}</div>
        <div class="n">${data.smsToday} SMS envoyés</div></div>
      <div class="tile"><div class="k">Reste à recouvrer</div>
        <div class="v" style="font-size:22px">${fcfa(data.reste)} F</div>
        <div class="n">${plural(data.familles, "facture ouverte", "factures ouvertes")}</div></div>
      <div class="tile"><div class="k">Catégorisation</div>
        <div class="v">${data.cat ? fr(data.cat.total_score, 0) : "—"}<span style="font-size:15px;color:var(--faint)"> / 100</span></div>
        <div class="n">${data.cat ? `Catégorie ${data.cat.category ?? "—"}` : "Dossier non commencé"}</div></div>
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

  const d = await withSchool(schoolId, async (c) => {
    const classes = await c.query(
      `select id, label from classes where academic_year_id = $1 order by label`,
      [period.year_id],
    );
    if (!classId) return { classes: classes.rows, subjects: [], evals: [], students: [], grades: [] };

    const subjects = await c.query(
      `select distinct sub.id, sub.label
         from evaluations ev join subjects sub on sub.id = ev.subject_id
        where ev.class_id = $1 and ev.term_id = $2
        order by sub.label`,
      [classId, period.term_id],
    );
    const chosen = subjectId ?? subjects.rows[0]?.id ?? null;
    if (!chosen) return { classes: classes.rows, subjects: subjects.rows, evals: [], students: [], grades: [] };

    const evals = await c.query(
      `select id, eval_type, label, held_on from evaluations
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

  if (!classId || d.evals.length === 0) {
    return page(chrome, "Notes", `
      <div class="row"><div><h1>Saisie des notes</h1>
        <p style="margin:0;color:var(--muted)">Choisissez une classe et une matière.</p></div>${selector}</div>
      ${classId ? `<div class="note warn">Aucune évaluation pour cette matière ce trimestre.</div>` : ""}`);
  }

  const key = new Map<string, any>();
  for (const g of d.grades) key.set(`${g.evaluation_id}|${g.student_id}`, g);

  // Deux devoirs portent souvent le même intitulé : c'est la date qui les
  // distingue pour l'enseignant.
  const heads = d.evals.map((e: any) =>
    `<th class="r" style="${e.eval_type === "composition" ? "color:var(--indigo)" : ""}">
       ${esc(e.eval_type === "composition" ? "Composition" : e.label ?? "Devoir")}
       ${e.held_on ? `<div style="font-weight:400;text-transform:none;letter-spacing:0;color:var(--faint)">${new Date(e.held_on).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}</div>` : ""}
     </th>`).join("");

  const body = d.students.map((st: any, i: number) => {
    const cells = d.evals.map((e: any) => {
      const g = key.get(`${e.id}|${st.id}`);
      const val = g?.is_absent ? "abs" : (g?.score !== undefined && g?.score !== null ? fr(Number(g.score)) : "");
      return `<td class="r"><input class="note-cell" name="n_${esc(e.id)}_${esc(st.id)}"
        value="${esc(val)}" inputmode="decimal" autocomplete="off"
        data-eval="${esc(e.id)}" data-student="${esc(st.id)}"
        data-original="${esc(val)}"
        data-updated="${g?.updated_at ? new Date(g.updated_at).toISOString() : ""}"
        aria-label="${esc(st.last_name)} — ${esc(e.label ?? e.eval_type)}"></td>`;
    }).join("");
    return `<tr><td class="num" style="color:var(--faint)">${String(i + 1).padStart(2, "0")}</td>
      <td><b>${esc(st.last_name)}</b> ${esc(st.first_names)}</td>${cells}</tr>`;
  }).join("");

  return page(chrome, "Notes", `
    <div class="row"><div><h1>Saisie des notes</h1>
      <p style="margin:0;color:var(--muted)">${plural(d.students.length, "élève")} — saisir une note sur 20, ou <code>abs</code> pour une absence.</p>
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
    <script src="/offline.js" defer></script>`);
}

async function saveNotes(user: SessionUser, url: URL, form: URLSearchParams): Promise<number> {
  const schoolId = user.schoolId!;
  let saved = 0;
  await withSchool(schoolId, async (c) => {
    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    for (const [name, raw] of form) {
      if (!name.startsWith("n_")) continue;
      const parts = name.slice(2).split("_");
      if (parts.length !== 2) continue;
      const [evaluationId, studentId] = parts as [string, string];

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
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 20) continue; // saisie rejetée en silence
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
  return saved;
}

async function bulletinsPage(user: SessionUser, url: URL): Promise<string> {
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
  const rows = [...klass.students]
    .sort((a, b) => (a.rang ?? 999) - (b.rang ?? 999))
    .map((r) => {
      const st = byId.get(r.studentId)!;
      return `<tr>
        <td class="num r">${ordinal(r.rang)}</td>
        <td><b>${esc(st.lastName)}</b> ${esc(st.firstNames)}</td>
        <td class="num r" style="font-weight:600">${fr(r.moyenneGenerale)}</td>
        <td class="num r" style="color:var(--muted)">${fr(r.totalPoints)}</td>
        <td>${esc(r.mention ?? "—")}</td>
      </tr>`;
    }).join("");

  const warn = [inputs.sourceNotes.policy, inputs.sourceNotes.coefficients].filter(Boolean);

  return page(chrome, "Bulletins", `
    <div class="row"><div><h1>Bulletins — ${esc(inputs.context.className)}</h1>
      <p style="margin:0;color:var(--muted)">${inputs.subjects.length} disciplines, total des coefficients ${fr(klass.students[0]?.totalCoefficients ?? 0, 0)} — moyenne de la classe ${fr(klass.moyenneDeClasse)}.</p>
      </div>${selector}</div>

    ${warn.length ? `<div class="note warn"><b>Règles à confirmer avec le censeur.</b><br>${warn.map(esc).join("<br>")}</div>` : ""}

    <div class="card">
      <header><h2>Classement</h2>
        <a class="btn" style="margin-left:auto;height:38px" href="/bulletins/imprimer?classe=${esc(classId)}" target="_blank" rel="noopener">Imprimer ${plural(klass.students.length, "le bulletin", "les " + klass.students.length + " bulletins").replace(/^\d+ /, klass.students.length === 1 ? "" : "")}</a>
      </header>
      <div class="scroll"><table>
        <thead><tr><th class="r">Rang</th><th>Élève</th><th class="r">Moyenne</th><th class="r">Points</th><th>Mention</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>`);
}

async function absencesPage(user: SessionUser, url: URL, flash?: string): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, "absences", period ? `Trimestre ${period.sequence}` : undefined);
  if (!period) return page(chrome, "Absences", `<h1>Absences</h1><div class="note warn">Aucun trimestre en cours.</div>`);

  const classId = url.searchParams.get("classe");
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  const d = await withSchool(schoolId, async (c) => {
    const classes = await c.query(
      `select id, label from classes where academic_year_id = $1 order by label`, [period.year_id]);
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

  if (!classId) {
    return page(chrome, "Absences",
      `<div class="row"><div><h1>Appel</h1>
        <p style="margin:0;color:var(--muted)">Choisissez une classe.</p></div>${selector}</div>`);
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

async function saveAbsences(user: SessionUser, url: URL, form: URLSearchParams) {
  const schoolId = user.schoolId!;
  const classId = url.searchParams.get("classe")!;
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
  const sms = createSmsChannel();

  return withSchool(schoolId, async (c) => {
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
                                   segments, cost_fcfa, status, provider, provider_ref, sent_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $8 = 'envoye' then now() end)`,
        [schoolId, studentId, row.guardian_id, row.phone, body, segments,
         result.costFcfa, result.ok ? "envoye" : "echoue", sms.name, result.providerRef ?? null]);

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

async function simplePage(user: SessionUser, which: "scolarite" | "categorisation"): Promise<string> {
  const schoolId = user.schoolId!;
  const period = await currentPeriod(schoolId);
  const chrome = await chromeFor(user, which);

  if (which === "scolarite") {
    const d = await withSchool(schoolId, async (c) => {
      const inv = await c.query(
        `select i.reference, i.total_fcfa, i.status, st.last_name, st.first_names, cl.label as classe,
                coalesce((select sum(p.amount_fcfa) from payments p
                           where p.invoice_id = i.id and p.status in ('confirme','rapproche')),0) as paye
           from invoices i
           join students st on st.id = i.student_id
           left join enrolments e on e.student_id = st.id and e.academic_year_id = i.academic_year_id
           left join classes cl on cl.id = e.class_id
          order by st.last_name limit 50`);
      const caps = await c.query(
        `select fs.label, sum(fl.amount_fcfa) filter (where fl.cap_treatment = 'plafonne') as plafonne,
                sum(fl.amount_fcfa) as total
           from fee_schedules fs join fee_lines fl on fl.fee_schedule_id = fs.id
          group by fs.id, fs.label`);
      return { invoices: inv.rows, caps: caps.rows };
    });

    const rows = d.invoices.map((i: any) => {
      const reste = Number(i.total_fcfa) - Number(i.paye);
      return `<tr${reste > 0 ? ' class="bad"' : ""}>
        <td><b>${esc(i.last_name)}</b> ${esc(i.first_names)}</td>
        <td>${esc(i.classe ?? "—")}</td>
        <td class="num r">${fcfa(i.total_fcfa)}</td>
        <td class="num r">${fcfa(i.paye)}</td>
        <td class="num r" style="font-weight:600;color:${reste > 0 ? "var(--laterite)" : "var(--verdant)"}">${fcfa(reste)}</td>
      </tr>`;
    }).join("");

    return page(chrome, "Scolarité", `
      <div><h1>Scolarité</h1>
        <p style="margin:0;color:var(--muted)">Espèces et virement. Orange Money et Moov Money à l'obtention du RCCM.</p></div>
      ${d.caps.map((c: any) => `<div class="note warn">
        <b>${esc(c.label)}</b> — ${fcfa(c.plafonne)} F comptés dans le plafond de l'arrêté n°2026-101,
        ${fcfa(Number(c.total) - Number(c.plafonne))} F hors plafond.</div>`).join("")}
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Élève</th><th>Classe</th><th class="r">Dû</th><th class="r">Payé</th><th class="r">Reste</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="5" style="color:var(--muted)">Aucune facture émise.</td></tr>`}</tbody>
      </table></div></div>`);
  }

  const d = await withSchool(schoolId, async (c) => {
    const a = await c.query(
      `select id, investment_score, quality_score, total_score, category, status
         from category_assessments where academic_year_id = $1 limit 1`,
      [period?.year_id ?? null]);
    const crit = a.rowCount
      ? (await c.query(
          `select axis, label, max_points, awarded_points, evidence_key
             from category_criteria where category_assessment_id = $1
            order by axis, code`, [a.rows[0].id])).rows
      : [];
    return { assessment: a.rows[0] ?? null, criteria: crit };
  });

  if (!d.assessment) {
    return page(chrome, "Catégorisation", `
      <div><h1>Dossier de catégorisation</h1>
        <p style="margin:0;color:var(--muted)">Arrêté n°2026-101 du 10 juillet 2026.</p></div>
      <div class="note warn">Aucun dossier ouvert pour cette année scolaire.</div>
      <div class="note">Le score sur 100 — 50 points d'investissement, 50 de qualité éducative —
        détermine la catégorie de l'établissement, et la catégorie croisée avec la zone fixe le
        plafond légal des frais de scolarité. Une part des points se calcule à partir des registres
        déjà tenus ici : résultats aux examens, effectifs, stabilité du personnel, gouvernance.</div>`);
  }

  const byAxis = (axis: string) => d.criteria.filter((c: any) => c.axis === axis)
    .map((c: any) => `<tr>
      <td>${esc(c.label)}</td>
      <td class="num r">${fr(c.awarded_points, 0)}/${fr(c.max_points, 0)}</td>
      <td class="r">${c.evidence_key ? '<span class="pill p-ok">JUSTIFIÉ</span>' : '<span class="pill p-bad">PIÈCE MANQUANTE</span>'}</td>
    </tr>`).join("");

  return page(chrome, "Catégorisation", `
    <div><h1>Dossier de catégorisation</h1>
      <p style="margin:0;color:var(--muted)">Arrêté n°2026-101 du 10 juillet 2026.</p></div>
    <div class="tiles">
      <div class="tile"><div class="k">Score</div><div class="v">${fr(d.assessment.total_score, 0)}<span style="font-size:15px;color:var(--faint)"> / 100</span></div></div>
      <div class="tile"><div class="k">Investissement</div><div class="v">${fr(d.assessment.investment_score, 0)}<span style="font-size:15px;color:var(--faint)"> / 50</span></div></div>
      <div class="tile"><div class="k">Qualité éducative</div><div class="v">${fr(d.assessment.quality_score, 0)}<span style="font-size:15px;color:var(--faint)"> / 50</span></div></div>
      <div class="tile"><div class="k">Catégorie</div><div class="v">${esc(d.assessment.category ?? "—")}</div></div>
    </div>
    <div class="card"><header><h2>Investissement</h2></header>
      <div class="scroll"><table><tbody>${byAxis("investissement")}</tbody></table></div></div>
    <div class="card"><header><h2>Qualité éducative</h2></header>
      <div class="scroll"><table><tbody>${byAxis("qualite")}</tbody></table></div></div>`);
}

// ---------------------------------------------------------------------------
// Routage
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const token = cookies(req).fs_session ?? null;
  const user = await resolveSession(token);

  // Fichiers statiques : liste blanche explicite, aucune traversée possible.
  const STATIC: Record<string, string> = {
    "/offline.js": "application/javascript; charset=utf-8",
    "/sw.js": "application/javascript; charset=utf-8",
  };
  if (req.method === "GET" && STATIC[path]) {
    try {
      const body = await readFile(new URL(`../../public${path}`, import.meta.url), "utf-8");
      res.writeHead(200, {
        "content-type": STATIC[path]!,
        "cache-control": "no-cache",
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
      `fs_famille=${tok}; Path=/famille; HttpOnly; SameSite=Lax; Max-Age=43200`);
  }
  if (path === "/famille/sortie") {
    if (familyToken) await revokeGuardian(familyToken);
    return redirect(res, "/famille", "fs_famille=; Path=/famille; HttpOnly; Max-Age=0");
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
      `fs_session=${r.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
  }
  if (path === "/deconnexion") {
    if (token) await revokeSession(token);
    return redirect(res, "/connexion", "fs_session=; Path=/; HttpOnly; Max-Age=0");
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
      const n = await saveNotes(user, url, await formBody(req));
      return html(res, await notesPage(user, url, `${plural(n, "note enregistrée", "notes enregistrées")}.`));
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
      const klass = computeClassBulletins({
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
    if (path.startsWith("/recus/") && req.method === "GET") {
      if (!can(user, "voir_scolarite")) return html(res, "Accès refusé.", 403);
      const body = await receiptPage(user.schoolId, decodeURIComponent(path.slice(7)));
      if (!body) return html(res, "Reçu introuvable.", 404);
      return html(res, body);
    }
    if (path === "/categorisation" && req.method === "GET") {
      if (!can(user, "voir_categorisation")) return html(res, "Accès refusé.", 403);
      return html(res, await simplePage(user, "categorisation"));
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
