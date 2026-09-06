/**
 * La fiche de l'élève.
 *
 * Elle manquait, et son absence rendait fausse une phrase écrite ailleurs :
 * l'écran de suivi des messages dit qu'un numéro erroné « se répare dans la
 * fiche de l'élève, au secrétariat ». Cette fiche n'existait pas. On ne
 * pouvait ni chercher un élève, ni voir ses tuteurs, ni corriger un chiffre.
 *
 * CE QUI DÉCIDE DE LA QUALITÉ DE CET ÉCRAN :
 *
 * 1. **On cherche par le numéro autant que par le nom.** Quand un SMS revient
 *    en échec, on tient un numéro et rien d'autre. Une recherche qui n'accepte
 *    que le nom oblige à deviner de quel élève il s'agit.
 *
 * 2. **Un tuteur est PARTAGÉ entre ses enfants.** Corriger son numéro le
 *    corrige pour toute la fratrie — c'est juste, et c'est exactement ce
 *    qu'une secrétaire ne devine pas. L'écran le dit avant, pas après. De
 *    même, retirer un tuteur d'un élève ne l'efface pas : ses autres enfants
 *    le gardent.
 *
 * 3. **Retirer le dernier numéro n'est pas interdit, il est annoncé.** Un
 *    élève peut réellement n'avoir aucun téléphone joignable ; le logiciel ne
 *    doit pas inventer une contrainte que la vie n'a pas. Mais il dit à voix
 *    haute que cette famille ne recevra plus rien, et le tableau de bord le
 *    rappelle.
 *
 * 4. **Le matricule ne se corrige pas ici.** Il figure sur des documents déjà
 *    délivrés et dans les états transmis. Le changer d'un clic ferait deux
 *    identités pour un enfant.
 */

import { withSchool } from "../lib/db.ts";
import { normalizePhone, normalizeDate } from "../lib/roster.ts";
import { page, esc, fr, fcfa, plural, type PageChrome } from "./html.ts";
import { can, type SessionUser } from "./session.ts";

export const LIENS = ["Père", "Mère", "Tuteur", "Tutrice", "Frère", "Sœur",
                      "Oncle", "Tante", "Grand-parent", "Autre"];

export interface Tuteur {
  guardianId: string;
  nom: string;
  phone: string;
  lien: string | null;
  principal: boolean;
  recoitSms: boolean;
  /** Nombre d'enfants inscrits qui partagent ce tuteur. */
  enfants: number;
}

export interface Urgence {
  id: string; nom: string; phone: string; lien: string | null;
}

export interface Fiche {
  id: string;
  matricule: string;
  nom: string;
  prenoms: string;
  sexe: string | null;
  naissance: string | null;
  lieuNaissance: string | null;
  classe: string | null;
  classeId: string | null;
  statut: string | null;
  tuteurs: Tuteur[];
  urgences: Urgence[];
  joignable: boolean;
  absences: number;
  moyennes: Array<{ trimestre: string; moyenne: number | null; rang: number | null }>;
  resteAPayer: number | null;
}

const iso = (d: Date | string | null): string | null => {
  if (!d) return null;
  const s = typeof d === "string" ? d : d.toISOString();
  return s.slice(0, 10);
};

export async function chercher(
  schoolId: string, q: string,
): Promise<Array<{ id: string; matricule: string; nom: string; classe: string | null }>> {
  const t = q.trim();
  if (t.length < 2) return [];
  return withSchool(schoolId, async (c) => {
    const chiffres = t.replace(/[^\d]/g, "");
    const r = await c.query(
      `select distinct st.id, st.matricule,
              st.last_name || ' ' || st.first_names as nom,
              cl.label as classe
         from students st
         left join enrolments e on e.student_id = st.id
         left join classes cl on cl.id = e.class_id
           and cl.academic_year_id = (select id from academic_years
                                       order by (status='en_cours') desc,
                                                starts_on desc limit 1)
         left join student_guardians sg on sg.student_id = st.id
         left join guardians g on g.id = sg.guardian_id
        where st.last_name || ' ' || st.first_names ilike $1
           or st.first_names || ' ' || st.last_name ilike $1
           or st.matricule ilike $1
           -- On cherche aussi par le numéro du tuteur : quand un SMS revient
           -- en échec, c'est tout ce que l'on tient.
           or ($2 <> '' and (g.phone like $3 or g.phone_alt like $3))
        order by nom limit 40`,
      [`%${t}%`, chiffres, `%${chiffres}%`]);
    return r.rows.map((x: any) => ({
      id: x.id, matricule: x.matricule, nom: x.nom, classe: x.classe,
    }));
  });
}

export async function loadFiche(
  schoolId: string, studentId: string,
): Promise<Fiche | null> {
  return withSchool(schoolId, async (c) => {
    const s = await c.query(
      `select st.*, cl.label as classe, cl.id as class_id, e.status
         from students st
         left join enrolments e on e.student_id = st.id
           and e.academic_year_id = (select id from academic_years
                                      order by (status='en_cours') desc,
                                               starts_on desc limit 1)
         left join classes cl on cl.id = e.class_id
        where st.id = $1`, [studentId]);
    if (s.rowCount === 0) return null;
    const x = s.rows[0];

    const t = await c.query(
      `select g.id, g.full_name, g.phone, sg.relationship, sg.is_primary,
              sg.receives_sms,
              (select count(*)::int from student_guardians o
                where o.guardian_id = g.id) as enfants
         from student_guardians sg
         join guardians g on g.id = sg.guardian_id
        where sg.student_id = $1
        order by sg.is_primary desc, g.full_name`, [studentId]);

    const u = await c.query(
      `select id, full_name, phone, relationship from emergency_contacts
        where student_id = $1 order by full_name`, [studentId]);

    const abs = await c.query(
      `select count(*)::int as n from attendance_records ar
         join attendance_sessions ses on ses.id = ar.attendance_session_id
        where ar.student_id = $1 and ar.status = 'absent'`, [studentId]);

    const b = await c.query(
      // Un trimestre n'a pas de libellé en base : il porte un rang, et c'est
      // ce rang qui le nomme sur un bulletin burkinabè.
      `select tr.sequence, b.moyenne_generale, b.rang
         from bulletins b join terms tr on tr.id = b.term_id
        where b.student_id = $1 and b.status = 'publie'
        order by tr.sequence`, [studentId]);

    const inv = await c.query(
      `select coalesce(sum(i.total_fcfa), 0)::int
              - coalesce((select sum(p.amount_fcfa) from payments p
                           where p.invoice_id = any(array_agg(i.id))
                             and p.status in ('confirme','rapproche')), 0)::int as reste
         from invoices i
        where i.student_id = $1 and i.status <> 'annulee'`, [studentId]);

    const tuteurs = t.rows.map((r: any): Tuteur => ({
      guardianId: r.id, nom: r.full_name, phone: r.phone,
      lien: r.relationship, principal: r.is_primary,
      recoitSms: r.receives_sms, enfants: r.enfants,
    }));

    return {
      id: x.id, matricule: x.matricule, nom: x.last_name,
      prenoms: x.first_names, sexe: x.sex,
      naissance: iso(x.date_of_birth), lieuNaissance: x.place_of_birth,
      classe: x.classe, classeId: x.class_id, statut: x.status,
      tuteurs,
      urgences: u.rows.map((r: any): Urgence => ({
        id: r.id, nom: r.full_name, phone: r.phone, lien: r.relationship,
      })),
      joignable: tuteurs.some((g) => g.recoitSms && g.phone),
      absences: abs.rows[0].n,
      moyennes: b.rows.map((r: any) => ({
        trimestre: `${r.sequence}<sup>${r.sequence === 1 ? "er" : "e"}</sup> trimestre`,
        moyenne: r.moyenne_generale === null ? null : Number(r.moyenne_generale),
        rang: r.rang,
      })),
      resteAPayer: inv.rows[0]?.reste ?? null,
    };
  });
}

export interface Issue { flash?: string; error?: string; studentId?: string }

export async function corrigerIdentite(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("eleve") ?? "";
  const nom = (form.get("nom") ?? "").trim().replace(/\s+/g, " ");
  const prenoms = (form.get("prenoms") ?? "").trim().replace(/\s+/g, " ");
  const sexe = (form.get("sexe") ?? "").trim().toUpperCase();
  const naissanceRaw = (form.get("naissance") ?? "").trim();
  const lieu = (form.get("lieu") ?? "").trim();

  if (!nom || !prenoms) {
    return { studentId: id,
      error: "Le nom et les prénoms sont l'identité de l'enfant sur son "
        + "bulletin : ni l'un ni l'autre ne peut rester vide." };
  }
  if (sexe && sexe !== "M" && sexe !== "F") {
    return { studentId: id, error: "Le sexe se note M ou F." };
  }
  let naissance: string | null = null;
  if (naissanceRaw) {
    // La date arrive d'un champ HTML en ISO ; on accepte aussi le format
    // burkinabè si quelqu'un poste le formulaire autrement.
    naissance = /^\d{4}-\d{2}-\d{2}$/.test(naissanceRaw)
      ? naissanceRaw : normalizeDate(naissanceRaw).date;
    if (!naissance) {
      return { studentId: id,
        error: `« ${naissanceRaw} » ne se lit pas comme une date. Le jour vient `
          + `en premier : 12/03/2014 est le 12 mars.` };
    }
  }

  return withSchool(user.schoolId!, async (c) => {
    const av = await c.query(
      `select last_name, first_names from students where id = $1`, [id]);
    if (av.rowCount === 0) return { error: "Cet élève n'existe pas." };

    await c.query(
      `update students set last_name = $2, first_names = $3, sex = $4,
                           date_of_birth = $5, place_of_birth = $6
        where id = $1`,
      [id, nom, prenoms, sexe || null, naissance, lieu || null]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'student.identity', 'student', $2, $3)`,
      [user.userId, id, JSON.stringify({
        de: `${av.rows[0].last_name} ${av.rows[0].first_names}`,
        vers: `${nom} ${prenoms}` })]);

    return { studentId: id, flash: "Identité corrigée. Une réimpression de "
      + "bulletin portera le nom corrigé ; l'exemplaire déjà remis à la "
      + "famille, lui, ne change pas." };
  });
}

/**
 * Ajouter un tuteur, ou corriger celui qui existe.
 *
 * Un tuteur déjà connu par son numéro est RATTACHÉ, pas dupliqué : sans cela,
 * la mère de trois élèves existerait en trois exemplaires et recevrait trois
 * SMS pour un communiqué — de l'argent, et un manque d'égard.
 */
export async function enregistrerTuteur(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("eleve") ?? "";
  const guardianId = form.get("tuteur") || null;
  const nom = (form.get("nom") ?? "").trim().replace(/\s+/g, " ");
  const lien = (form.get("lien") ?? "").trim();
  const recoitSms = form.get("sms") === "1";
  const principal = form.get("principal") === "1";

  const p = normalizePhone(form.get("telephone") ?? "");
  if (!p.phone) {
    return { studentId: id, error: p.problem
      ? `Le ${p.problem}. C'est ce numéro qui recevra les SMS d'absence.`
      : "Donnez le numéro : sans lui, ce tuteur ne sera jamais prévenu." };
  }
  if (!nom || nom.length < 3) {
    return { studentId: id, error: "Donnez le nom du tuteur." };
  }

  return withSchool(user.schoolId!, async (c) => {
    let gid = guardianId;
    if (gid) {
      await c.query(
        `update guardians set full_name = $2, phone = $3 where id = $1`,
        [gid, nom, p.phone]);
    } else {
      const connu = await c.query(
        `select id from guardians where phone = $1 limit 1`, [p.phone]);
      if (connu.rowCount) {
        gid = connu.rows[0].id;
        await c.query(`update guardians set full_name = $2 where id = $1`,
          [gid, nom]);
      } else {
        gid = (await c.query(
          `insert into guardians (school_id, full_name, phone)
           values (current_school_id(), $1, $2) returning id`,
          [nom, p.phone])).rows[0].id;
      }
    }

    if (principal) {
      await c.query(
        `update student_guardians set is_primary = false where student_id = $1`,
        [id]);
    }
    await c.query(
      `insert into student_guardians (student_id, guardian_id, school_id,
                                      relationship, is_primary, receives_sms)
       values ($1, $2, current_school_id(), $3, $4, $5)
       on conflict (student_id, guardian_id) do update
         set relationship = excluded.relationship,
             is_primary = excluded.is_primary,
             receives_sms = excluded.receives_sms`,
      [id, gid, lien || null, principal, recoitSms]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'student.guardian', 'student', $2, $3)`,
      [user.userId, id, JSON.stringify({ tuteur: gid, phone: p.phone })]);

    const autres = Number((await c.query(
      `select count(*)::int as n from student_guardians
        where guardian_id = $1 and student_id <> $2`, [gid, id])).rows[0].n);

    return { studentId: id, flash: autres > 0
      ? `Enregistré. Ce tuteur suit aussi ${plural(autres, "autre élève",
          "autres élèves")} : le numéro vaut pour ${
          autres > 1 ? "eux tous" : "lui aussi"}.`
      : "Tuteur enregistré." };
  });
}

export async function retirerTuteur(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("eleve") ?? "";
  const gid = form.get("tuteur") ?? "";
  return withSchool(user.schoolId!, async (c) => {
    const g = await c.query(`select full_name from guardians where id = $1`, [gid]);
    if (g.rowCount === 0) return { studentId: id, error: "Ce tuteur n'existe pas." };

    await c.query(
      `delete from student_guardians where student_id = $1 and guardian_id = $2`,
      [id, gid]);
    // On ne supprime PAS le tuteur : ses autres enfants le gardent, et ses
    // messages passés le référencent.
    const restant = Number((await c.query(
      `select count(*)::int as n from student_guardians sg
         join guardians gg on gg.id = sg.guardian_id
        where sg.student_id = $1 and sg.receives_sms
          and gg.phone is not null and gg.phone <> ''`, [id])).rows[0].n);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'student.guardian.remove', 'student', $2, $3)`,
      [user.userId, id, JSON.stringify({ tuteur: gid })]);

    return { studentId: id, flash: restant === 0
      // On n'interdit pas : un élève peut réellement n'avoir aucun téléphone.
      // Mais on ne laisse pas croire que la famille sera prévenue.
      ? `${g.rows[0].full_name} est détaché de cet élève. Il ne reste AUCUN `
        + `numéro joignable : sa famille ne recevra plus de SMS d'absence.`
      : `${g.rows[0].full_name} est détaché de cet élève. Ses autres enfants le `
        + `gardent.` };
  });
}

export async function enregistrerUrgence(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("eleve") ?? "";
  const nom = (form.get("nom") ?? "").trim().replace(/\s+/g, " ");
  const lien = (form.get("lien") ?? "").trim();
  const p = normalizePhone(form.get("telephone") ?? "");
  if (!nom || !p.phone) {
    return { studentId: id, error: p.problem
      ? `Le ${p.problem}.`
      : "Un contact d'urgence, c'est un nom et un numéro qui décroche." };
  }
  return withSchool(user.schoolId!, async (c) => {
    await c.query(
      `insert into emergency_contacts (school_id, student_id, full_name,
                                       phone, relationship)
       values (current_school_id(), $1, $2, $3, $4)`,
      [id, nom, p.phone, lien || null]);
    return { studentId: id, flash: `${nom} est joignable en cas d'urgence.` };
  });
}

export async function retirerUrgence(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("eleve") ?? "";
  return withSchool(user.schoolId!, async (c) => {
    await c.query(`delete from emergency_contacts where id = $1`,
      [form.get("contact") ?? ""]);
    return { studentId: id, flash: "Contact retiré." };
  });
}

// ---------------------------------------------------------------------------
// Écrans
// ---------------------------------------------------------------------------

export async function elevesPage(
  user: SessionUser, chrome: PageChrome, url: URL,
): Promise<string> {
  const q = url.searchParams.get("q") ?? "";
  const trouves = q ? await chercher(user.schoolId!, q) : [];

  return page(chrome, "Chercher un élève", `
<div>
  <h1>Chercher un élève</h1>
  <p class="sub">Par le nom, par le matricule, ou par le numéro d'un tuteur —
  parce qu'un message revenu en échec ne laisse souvent qu'un numéro.</p>
</div>

<div class="card">
  <form method="get" action="/eleves" class="body row">
    <input type="text" name="q" value="${esc(q)}" class="grow"
           placeholder="ZONGO, ou 70101011, ou WP-2026-004" autocomplete="off">
    <button type="submit" class="btn">Chercher</button>
  </form>
</div>

${!q ? "" : trouves.length === 0 ? `
<div class="note warn">Aucun élève ne répond à « ${esc(q)} ».</div>` : `
<div class="card">
  <header><b>${plural(trouves.length, "élève trouvé", "élèves trouvés")}</b></header>
  <table>
    <thead><tr><th>Nom</th><th>Matricule</th><th>Classe</th></tr></thead>
    <tbody>${trouves.map((e) => `
      <tr><td><a href="/eleve?id=${e.id}">${esc(e.nom)}</a></td>
        <td class="num">${esc(e.matricule)}</td>
        <td>${esc(e.classe ?? "—")}</td></tr>`).join("")}
    </tbody>
  </table>
</div>`}`);
}

export async function elevePage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const id = url.searchParams.get("id") ?? "";
  const f = id ? await loadFiche(user.schoolId!, id) : null;
  if (!f) {
    return page(chrome, "Élève", `
      <h1>Élève introuvable</h1>
      <p class="sub">Cette fiche n'existe pas, ou elle appartient à un autre
      établissement.</p>
      <p><a href="/eleves">Chercher un élève</a></p>`);
  }
  const modifiable = can(user, "inscrire");

  const tuteurLigne = (t: Tuteur) => `
    <tr>
      <td><b>${esc(t.nom)}</b>${t.principal
        ? ' <span class="pill p-info">Principal</span>' : ""}
        ${t.enfants > 1 ? `<span class="dit">Suit ${plural(t.enfants, "élève")}`
          + ` de l'établissement — corriger son numéro les concerne tous.</span>`
          : ""}</td>
      <td class="num">${esc(t.phone)}</td>
      <td>${esc(t.lien ?? "—")}</td>
      <td>${t.recoitSms
        ? '<span class="pill p-ok">Reçoit les SMS</span>'
        : '<span class="pill p-warn">Pas de SMS</span>'}</td>
      <td class="gestes">${modifiable ? `
        <form method="post" action="/eleve/tuteur/retirer">
          <input type="hidden" name="eleve" value="${f.id}">
          <input type="hidden" name="tuteur" value="${t.guardianId}">
          <button type="submit" class="btn ghost petit">Détacher</button>
        </form>` : ""}</td>
    </tr>`;

  const formulaireTuteur = (t: Tuteur | null) => `
    <form method="post" action="/eleve/tuteur" class="body">
      <input type="hidden" name="eleve" value="${f.id}">
      ${t ? `<input type="hidden" name="tuteur" value="${t.guardianId}">` : ""}
      <div class="trois">
        <div><label>Nom du tuteur</label>
          <input type="text" name="nom" value="${esc(t?.nom ?? "")}"
                 placeholder="ZONGO Salif" autocomplete="off"></div>
        <div><label>Téléphone</label>
          <input type="tel" name="telephone" value="${esc(t?.phone ?? "")}"
                 placeholder="70 12 34 56" autocomplete="off"></div>
        <div><label>Lien de parenté</label>
          <select name="lien">
            <option value="">—</option>
            ${LIENS.map((l) => `<option value="${l}"${
              l === t?.lien ? " selected" : ""}>${l}</option>`).join("")}
          </select></div>
      </div>
      <p class="row" style="margin:12px 0 0">
        <label style="text-transform:none;letter-spacing:0;margin:0">
          <input type="checkbox" name="sms" value="1"${
            !t || t.recoitSms ? " checked" : ""} style="width:auto;height:auto">
          Reçoit les SMS d'absence</label>
        <label style="text-transform:none;letter-spacing:0;margin:0">
          <input type="checkbox" name="principal" value="1"${
            t?.principal ? " checked" : ""} style="width:auto;height:auto">
          Tuteur principal</label>
        <button type="submit" class="btn">${t ? "Corriger" : "Rattacher"}</button>
      </p>
    </form>`;

  const body = `
<div class="row">
  <div class="grow">
    <h1>${esc(f.nom)} ${esc(f.prenoms)}</h1>
    <p class="sub">${esc(f.matricule)}${f.classe
      ? ` · ${esc(f.classe)}` : " · non inscrit cette année"}${f.statut
      ? ` · ${esc(f.statut)}` : ""}</p>
  </div>
  <a href="/eleves" class="btn ghost">Chercher un autre élève</a>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}
${f.joignable ? "" : `<div class="note bad"><b>Aucun numéro joignable.</b>
  Sa famille ne recevra aucun SMS d'absence. C'est ici que cela se répare.</div>`}

<div class="tiles">
  <div class="tile"><div class="k">Absences relevées</div>
    <div class="v">${f.absences}</div></div>
  ${f.moyennes.map((m) => `
  <div class="tile"><div class="k">${m.trimestre}</div>
    <div class="v">${fr(m.moyenne)}</div>
    ${m.rang ? `<div class="n">${m.rang}<sup>${
      m.rang === 1 ? "er" : "e"}</sup> de la classe</div>` : ""}</div>`).join("")}
  ${f.resteAPayer === null ? "" : `
  <div class="tile"><div class="k">Reste à payer</div>
    <div class="v">${fcfa(f.resteAPayer)}</div>
    <div class="n"><a href="/scolarite">Voir la scolarité</a></div></div>`}
</div>

<div class="card">
  <header><b>Les tuteurs</b> — ce sont eux qui reçoivent les SMS</header>
  ${f.tuteurs.length === 0
    ? `<div class="body"><p class="sub">Aucun tuteur n'est rattaché.</p></div>`
    : `<table>
    <thead><tr><th>Nom</th><th>Téléphone</th><th>Lien</th><th>SMS</th><th></th></tr></thead>
    <tbody>${f.tuteurs.map(tuteurLigne).join("")}</tbody>
  </table>`}
</div>

${!modifiable ? "" : `
${f.tuteurs.map((t) => `
<div class="card">
  <header><b>Corriger ${esc(t.nom)}</b>${t.enfants > 1
    ? ` — attention : ce tuteur suit ${plural(t.enfants, "élève")},`
      + ` la correction vaut pour tous` : ""}</header>
  ${formulaireTuteur(t)}
</div>`).join("")}

<div class="card">
  <header><b>Rattacher un tuteur</b></header>
  ${formulaireTuteur(null)}
  <div class="body" style="padding-top:0">
    <p class="hint">Si ce numéro est déjà connu de l'établissement, le tuteur
    existant est rattaché plutôt que recréé : une mère de trois élèves doit
    recevoir un communiqué, pas trois.</p>
  </div>
</div>

<div class="card">
  <header><b>Corriger l'identité</b></header>
  <form method="post" action="/eleve/identite" class="body">
    <input type="hidden" name="eleve" value="${f.id}">
    <div class="trois">
      <div><label>Nom</label>
        <input type="text" name="nom" value="${esc(f.nom)}"></div>
      <div><label>Prénoms</label>
        <input type="text" name="prenoms" value="${esc(f.prenoms)}"></div>
      <div><label>Sexe</label>
        <select name="sexe">
          <option value=""${!f.sexe ? " selected" : ""}>—</option>
          <option value="M"${f.sexe === "M" ? " selected" : ""}>Masculin</option>
          <option value="F"${f.sexe === "F" ? " selected" : ""}>Féminin</option>
        </select></div>
    </div>
    <div class="trois" style="margin-top:14px">
      <div><label>Date de naissance</label>
        <input type="date" name="naissance" value="${esc(f.naissance ?? "")}"
          style="height:44px;padding:0 12px;border:1px solid var(--line);border-radius:5px;width:100%"></div>
      <div><label>Lieu de naissance</label>
        <input type="text" name="lieu" value="${esc(f.lieuNaissance ?? "")}"
               placeholder="Ouagadougou"></div>
      <div><label>Matricule</label>
        <input type="text" value="${esc(f.matricule)}" disabled></div>
    </div>
    <p class="hint">Le matricule ne se corrige pas ici : il figure sur des
    documents déjà délivrés et dans les états transmis, et le changer d'un clic
    ferait deux identités pour un enfant. Corriger un nom, en revanche, change
    ce qu'affichera une <b>réimpression</b> de bulletin — l'exemplaire papier
    déjà remis à la famille, lui, ne change pas.</p>
    <div style="margin-top:14px"><button type="submit" class="btn">Corriger</button></div>
  </form>
</div>

<div class="card">
  <header><b>Contacts d'urgence</b> — qui appeler si l'enfant est malade</header>
  ${f.urgences.length === 0 ? "" : `<table>
    <thead><tr><th>Nom</th><th>Téléphone</th><th>Lien</th><th></th></tr></thead>
    <tbody>${f.urgences.map((u) => `
      <tr><td>${esc(u.nom)}</td><td class="num">${esc(u.phone)}</td>
        <td>${esc(u.lien ?? "—")}</td>
        <td class="gestes"><form method="post" action="/eleve/urgence/retirer">
          <input type="hidden" name="eleve" value="${f.id}">
          <input type="hidden" name="contact" value="${u.id}">
          <button type="submit" class="btn ghost petit">Retirer</button>
        </form></td></tr>`).join("")}</tbody>
  </table>`}
  <form method="post" action="/eleve/urgence" class="body">
    <input type="hidden" name="eleve" value="${f.id}">
    <div class="trois">
      <div><label>Nom</label><input type="text" name="nom" autocomplete="off"></div>
      <div><label>Téléphone</label><input type="tel" name="telephone" autocomplete="off"></div>
      <div><label>Lien</label>
        <select name="lien"><option value="">—</option>
          ${LIENS.map((l) => `<option value="${l}">${l}</option>`).join("")}
        </select></div>
    </div>
    <div style="margin-top:14px"><button type="submit" class="btn ghost">Ajouter</button></div>
  </form>
</div>`}`;

  return page(chrome, `${f.nom} ${f.prenoms}`, body);
}
