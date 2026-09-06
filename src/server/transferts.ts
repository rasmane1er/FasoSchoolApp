/**
 * Transferts et livret scolaire.
 *
 * POURQUOI CET ÉCRAN EXISTE. Au Burkina Faso, un enfant change d'école pour
 * des raisons qui n'ont rien de scolaire : la famille déménage, l'école ferme,
 * l'insécurité déplace un village entier. L'enfant arrive alors dans un
 * établissement qui ne sait rien de lui — souvent sans un papier.
 *
 * LA RÈGLE QUI COMPTE : **un enfant sans papiers s'inscrit quand même.**
 * Refuser une inscription faute de bulletin, c'est exactement le mécanisme qui
 * met un enfant déplacé hors de l'école pour de bon. Le logiciel accepte donc
 * un parcours DÉCLARÉ PAR LA FAMILLE, et le marque comme tel. Une information
 * imparfaite et honnêtement étiquetée vaut mieux qu'une case vide, et vaut
 * infiniment mieux qu'un enfant refusé.
 *
 * Dans l'autre sens, un élève qui part emporte un **certificat de transfert**
 * imprimable qui contient son livret : années, niveaux, moyennes, décisions.
 * C'est ce document qui permet à l'école suivante de le placer correctement au
 * lieu de le faire redoubler par défaut.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, fr, plural, accord, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export const MOTIFS = [
  "Déménagement de la famille",
  "Fermeture de l'établissement d'origine",
  "Déplacement lié à l'insécurité",
  "Rapprochement familial",
  "Autre",
] as const;

export interface LivretLigne {
  id: string;
  yearLabel: string;
  levelCode: string | null;
  schoolName: string;
  moyenne: number | null;
  decision: string | null;
  isExternal: boolean;
}

export interface Transfert {
  id: string; direction: "entrant" | "sortant";
  otherSchool: string | null; reason: string | null;
  requestedOn: string; status: string;
  lastName: string; firstNames: string; matricule: string; studentId: string;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "").slice(0, 10);

export const jour = (s: string): string => {
  const [y, m, d] = s.split("-");
  return y && m && d ? `${d}/${m}/${y}` : s;
};

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function loadTransferts(schoolId: string, studentId: string | null) {
  return withSchool(schoolId, async (c) => {
    const eleves = await c.query(
      `select st.id, st.matricule, st.last_name, st.first_names, cl.label as classe
         from students st
         left join enrolments e on e.student_id = st.id
         left join classes cl on cl.id = e.class_id
        order by st.last_name, st.first_names`);

    const mouvements = await c.query(
      `select t.id, t.direction, t.other_school_name, t.reason, t.requested_on,
              t.status, st.id as student_id, st.last_name, st.first_names, st.matricule
         from student_transfers t join students st on st.id = t.student_id
        order by t.requested_on desc limit 20`);

    let livret: LivretLigne[] = [];
    let eleve: any = null;
    if (studentId) {
      const e = await c.query(
        `select st.id, st.matricule, st.last_name, st.first_names,
                to_char(st.date_of_birth,'DD/MM/YYYY') as naissance,
                st.place_of_birth, cl.label as classe
           from students st
           left join enrolments e on e.student_id = st.id
           left join classes cl on cl.id = e.class_id
          where st.id = $1`, [studentId]);
      eleve = e.rows[0] ?? null;
      const l = await c.query(
        `select id, academic_year_label, level_code, school_name,
                moyenne_annuelle, decision, is_external
           from livret_entries where student_id = $1
          order by academic_year_label`, [studentId]);
      livret = l.rows.map((r) => ({
        id: r.id, yearLabel: r.academic_year_label, levelCode: r.level_code,
        schoolName: r.school_name,
        moyenne: r.moyenne_annuelle === null ? null : Number(r.moyenne_annuelle),
        decision: r.decision, isExternal: r.is_external,
      }));
    }

    return {
      eleves: eleves.rows,
      mouvements: mouvements.rows.map((m) => ({
        id: m.id, direction: m.direction, otherSchool: m.other_school_name,
        reason: m.reason, requestedOn: iso(m.requested_on), status: m.status,
        studentId: m.student_id, lastName: m.last_name,
        firstNames: m.first_names, matricule: m.matricule,
      })) as Transfert[],
      eleve, livret,
    };
  });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export async function recordTransfer(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string; studentId?: string }> {
  const studentId = form.get("eleve") ?? "";
  const direction = form.get("sens") === "sortant" ? "sortant" : "entrant";
  const autre = (form.get("etablissement") ?? "").trim() || null;
  const motif = (form.get("motif") ?? "").trim() || null;

  if (!studentId) return { error: "Choisissez l'élève." };

  return withSchool(user.schoolId!, async (c) => {
    await c.query(
      `insert into student_transfers (school_id, student_id, direction,
                                      other_school_name, reason, status, decided_on)
       values (current_school_id(), $1, $2, $3, $4, 'accepte', current_date)`,
      [studentId, direction, autre, motif]);

    // Un départ change le statut d'inscription ; une arrivée ne touche à rien
    // d'autre, l'inscription se fait par l'écran d'inscriptions.
    if (direction === "sortant") {
      await c.query(
        `update enrolments set status = 'transfere_sortant'
          where student_id = $1 and status in ('inscrit', 'reinscrit')`, [studentId]);
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'transfer.record', 'student', $2, $3)`,
      [user.userId, studentId, JSON.stringify({ direction, autre, motif })]);

    return {
      flash: direction === "sortant"
        ? "Départ enregistré. Imprimez le certificat de transfert : sans lui, "
          + "l'école suivante n'aura aucun moyen de placer l'élève."
        : "Arrivée enregistrée. Saisissez le parcours antérieur ci-dessous, même "
          + "incomplet.",
      studentId,
    };
  });
}

/**
 * Ajoute une année au livret, venue d'un autre établissement.
 *
 * `is_external` vaut toujours `true` ici, et la provenance est nommée. Une
 * ligne déclarée par la famille et une ligne établie par ce collège ne doivent
 * jamais se confondre : le censeur qui décide d'un placement doit savoir sur
 * quoi il s'appuie.
 */
export async function addLivretEntry(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string; studentId?: string }> {
  const studentId = form.get("eleve") ?? "";
  const annee = (form.get("annee") ?? "").trim();
  const niveau = (form.get("niveau") ?? "").trim() || null;
  const ecole = (form.get("ecole") ?? "").trim();
  const moyenneRaw = (form.get("moyenne") ?? "").trim().replace(",", ".");
  const decision = (form.get("decision") ?? "").trim() || null;

  /* Chaque refus renvoie l'identifiant de l'élève : sans lui, l'écran se
     rechargerait sans dossier ouvert, et le secrétaire perdrait sa saisie en
     même temps que le message d'erreur. Un refus doit corriger, pas punir. */
  if (!studentId) return { error: "Élève introuvable." };
  if (!annee) {
    return { error: "Indiquez l'année scolaire, par exemple 2025-2026.", studentId };
  }
  if (!ecole) {
    return { studentId,
      error: "Nommez l'établissement d'origine. « Inconnu » est une "
        + "réponse acceptable, mais la case ne doit pas rester vide." };
  }

  let moyenne: number | null = null;
  if (moyenneRaw !== "") {
    const n = Number(moyenneRaw);
    if (!Number.isFinite(n) || n < 0 || n > 20) {
      return { error: "La moyenne doit être comprise entre 0 et 20, ou laissée vide.",
        studentId };
    }
    moyenne = n;
  }

  return withSchool(user.schoolId!, async (c) => {
    const dup = await c.query(
      `select 1 from livret_entries
        where student_id = $1 and academic_year_label = $2`, [studentId, annee]);
    if (dup.rowCount! > 0) {
      return { error: `Le livret porte déjà l'année ${annee}.`, studentId };
    }
    await c.query(
      `insert into livret_entries (school_id, student_id, academic_year_label,
                                   level_code, school_name, moyenne_annuelle,
                                   decision, is_external)
       values (current_school_id(), $1, $2, $3, $4, $5, $6, true)`,
      [studentId, annee, niveau, ecole, moyenne, decision]);
    return { flash: `Année ${annee} ajoutée au livret.`, studentId };
  });
}

// ---------------------------------------------------------------------------
// Certificat imprimable
// ---------------------------------------------------------------------------

const CERT_CSS = `
@page { size: A4; margin: 18mm 16mm }
body{margin:0;font:12pt/1.5 Georgia,"Times New Roman",serif;color:#111}
.entete{text-align:center;margin-bottom:22px}
.entete .pays{font-size:11pt;letter-spacing:.08em;text-transform:uppercase}
.entete .devise{font-size:9.5pt;font-style:italic;color:#444}
.entete h1{font-size:16pt;margin:18px 0 4px;letter-spacing:.02em}
.ident{margin:18px 0;border:1px solid #999;padding:12px 14px}
.ident div{margin:3px 0}
table{width:100%;border-collapse:collapse;font-size:11pt;margin-top:8px}
th,td{border:1px solid #999;padding:6px 8px;text-align:left}
th{background:#f0efec;font-size:9.5pt;text-transform:uppercase;letter-spacing:.04em}
td.r{text-align:right;font-variant-numeric:tabular-nums}
.note{margin-top:14px;font-size:10pt;font-style:italic;color:#444}
.sign{margin-top:44px;display:flex;justify-content:space-between;font-size:11pt}
`;

export async function certificatePage(
  schoolId: string, studentId: string,
): Promise<string | null> {
  const d = await loadTransferts(schoolId, studentId);
  if (!d.eleve) return null;

  const ecole = await withSchool(schoolId, async (c) =>
    (await c.query(`select name, commune, region from schools limit 1`)).rows[0]);

  const declares = d.livret.filter((l) => l.isExternal).length;

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Certificat de transfert — ${esc(d.eleve.last_name)} ${esc(d.eleve.first_names)}</title>
<style>${CERT_CSS}</style></head><body>

<div class="entete">
  <div class="pays">Burkina Faso</div>
  <div class="devise">Unité — Progrès — Justice</div>
  <div style="margin-top:10px">${esc(ecole?.name ?? "")}${
    ecole?.commune ? ` — ${esc(ecole.commune)}` : ""}</div>
  <h1>Certificat de transfert</h1>
</div>

<div class="ident">
  <div><b>Élève :</b> ${esc(d.eleve.last_name)} ${esc(d.eleve.first_names)}</div>
  <div><b>Matricule :</b> ${esc(d.eleve.matricule)}</div>
  <div><b>Né(e) le :</b> ${esc(d.eleve.naissance ?? "non renseigné")}${
    d.eleve.place_of_birth ? ` à ${esc(d.eleve.place_of_birth)}` : ""}</div>
  <div><b>Dernière classe fréquentée :</b> ${esc(d.eleve.classe ?? "non inscrite")}</div>
</div>

<h2 style="font-size:13pt;margin-bottom:0">Parcours scolaire</h2>
${d.livret.length ? `<table>
  <thead><tr><th>Année</th><th>Niveau</th><th>Établissement</th>
    <th class="r">Moyenne</th><th>Décision</th><th>Source</th></tr></thead>
  <tbody>${d.livret.map((l) => `<tr>
    <td>${esc(l.yearLabel)}</td>
    <td>${esc(l.levelCode ?? "—")}</td>
    <td>${esc(l.schoolName)}</td>
    <td class="r">${fr(l.moyenne)}</td>
    <td>${esc(l.decision ?? "—")}</td>
    <td>${l.isExternal ? "déclarée" : "établie ici"}</td>
  </tr>`).join("")}</tbody>
</table>` : `<p>Aucune année enregistrée à ce jour.</p>`}

${declares > 0 ? `<p class="note">
  ${plural(declares, "ligne de ce parcours a été déclarée",
    "lignes de ce parcours ont été déclarées")} par la famille et
  ${accord(declares, "n'a pas pu être vérifiée", "n'ont pas pu être vérifiées")}
  auprès de l'établissement d'origine.
  ${accord(declares, "Elle est reproduite ici telle que transmise",
    "Elles sont reproduites ici telles que transmises")}.</p>` : ""}

<p class="note">Ce certificat est délivré pour servir et valoir ce que de droit.
Il ne préjuge pas de la décision de placement de l'établissement d'accueil.</p>

<div class="sign">
  <div>Fait à ${esc(ecole?.commune ?? "")}, le ${new Date().toLocaleDateString("fr-FR")}</div>
  <div>Le chef d'établissement</div>
</div>

</body></html>`;
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function transfertsPage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const studentId = url.searchParams.get("eleve") || null;
  const d = await loadTransferts(user.schoolId!, studentId);

  const options = d.eleves.map((e: any) =>
    `<option value="${e.id}"${e.id === studentId ? " selected" : ""}>${
      esc(e.last_name)} ${esc(e.first_names)}${e.classe ? ` — ${esc(e.classe)}` : ""}</option>`
  ).join("");

  const body = `
<div>
  <h1>Transferts et livret scolaire</h1>
  <p class="sub">Un enfant change d'école pour des raisons qui n'ont rien de
  scolaire. Ce qu'il emporte de son parcours décide de la classe où on le
  placera.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="note">
  <b>Un enfant sans papiers s'inscrit quand même.</b> Refuser une inscription
  faute de bulletin met un enfant déplacé hors de l'école pour de bon. Saisissez
  le parcours tel que la famille le déclare : il sera marqué « déclaré », et le
  censeur saura sur quoi il s'appuie.
</div>

<div class="card">
  <header><b>Enregistrer un mouvement</b></header>
  <form method="post" action="/transferts" class="body">
    <div class="trois">
      <div><label for="eleve">Élève</label>
        <select id="eleve" name="eleve">${options}</select></div>
      <div><label for="sens">Sens</label>
        <select id="sens" name="sens">
          <option value="entrant">Arrivée dans l'établissement</option>
          <option value="sortant">Départ de l'établissement</option>
        </select></div>
      <div><label for="etablissement">Autre établissement</label>
        <input type="text" id="etablissement" name="etablissement"
               placeholder="École B de Kaya"></div>
    </div>
    <div style="margin-top:14px;max-width:420px">
      <label for="motif">Motif</label>
      <select id="motif" name="motif">
        ${MOTIFS.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}
      </select>
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn">Enregistrer</button>
    </div>
  </form>
</div>

${d.eleve ? `
<div class="card">
  <header>
    <b>Livret de ${esc(d.eleve.last_name)} ${esc(d.eleve.first_names)}</b>
    <span style="color:var(--muted);font-size:13px">${
      plural(d.livret.length, "année enregistrée", "années enregistrées")}</span>
    <div class="grow"></div>
    <a class="btn ghost" style="height:34px" target="_blank" rel="noopener"
       href="/transferts/certificat?eleve=${esc(d.eleve.id)}">Certificat de transfert</a>
  </header>

  ${d.livret.length ? `<div class="scroll"><table>
    <thead><tr><th>Année</th><th>Niveau</th><th>Établissement</th>
      <th class="r">Moyenne</th><th>Décision</th><th>Source</th></tr></thead>
    <tbody>${d.livret.map((l) => `<tr${l.isExternal ? ' class="warn"' : ""}>
      <td><b>${esc(l.yearLabel)}</b></td>
      <td>${esc(l.levelCode ?? "—")}</td>
      <td>${esc(l.schoolName)}</td>
      <td class="r num">${fr(l.moyenne)}</td>
      <td>${esc(l.decision ?? "—")}</td>
      <td>${l.isExternal
        ? `<span class="pill p-warn">déclarée</span>`
        : `<span class="pill p-ok">établie ici</span>`}</td>
    </tr>`).join("")}</tbody>
  </table></div>` : `<div class="body"><p class="hint" style="margin:0">
    Aucune année au livret. Saisissez ce que la famille déclare.</p></div>`}

  <form method="post" action="/transferts/livret" class="body"
        style="border-top:1px solid var(--rule)">
    <input type="hidden" name="eleve" value="${esc(d.eleve.id)}">
    <div class="trois">
      <div><label>Année scolaire</label>
        <input type="text" name="annee" placeholder="2025-2026"></div>
      <div><label>Niveau</label>
        <input type="text" name="niveau" placeholder="CM2"></div>
      <div><label>Établissement d'origine</label>
        <input type="text" name="ecole" placeholder="École B de Kaya"></div>
    </div>
    <div class="trois" style="margin-top:14px">
      <div><label>Moyenne annuelle</label>
        <input type="text" name="moyenne" inputmode="decimal" placeholder="12,40"></div>
      <div><label>Décision</label>
        <input type="text" name="decision" placeholder="admis"></div>
    </div>
    <p class="hint">Une case vide est acceptable : mieux vaut une année sans
    moyenne qu'une moyenne inventée.</p>
    <div class="row" style="margin-top:14px">
      <button type="submit" class="btn ghost">Ajouter au livret</button>
    </div>
  </form>
</div>` : `<div class="card"><div class="body"><p class="hint" style="margin:0">
  Choisissez un élève et enregistrez un mouvement pour voir son livret.</p></div></div>`}

${d.mouvements.length ? `<div class="card">
  <header><b>Mouvements récents</b></header>
  <table>
    <thead><tr><th>Élève</th><th>Sens</th><th>Établissement</th><th>Motif</th>
      <th>Date</th></tr></thead>
    <tbody>${d.mouvements.map((m) => `<tr>
      <td><a href="/transferts?eleve=${esc(m.studentId)}"><b>${esc(m.lastName)}</b>
        ${esc(m.firstNames)}</a></td>
      <td><span class="pill ${m.direction === "entrant" ? "p-ok" : "p-info"}">${
        m.direction}</span></td>
      <td>${esc(m.otherSchool ?? "—")}</td>
      <td>${esc(m.reason ?? "—")}</td>
      <td class="num">${jour(m.requestedOn)}</td>
    </tr>`).join("")}</tbody>
  </table>
</div>` : ""}`;

  return page(chrome, "Transferts", body);
}
