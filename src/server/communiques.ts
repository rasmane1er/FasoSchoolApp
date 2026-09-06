/**
 * Communiqués aux familles.
 *
 * Le canal SMS existait déjà pour les absences. C'est le même tuyau, mais
 * l'usage est différent : « réunion des parents samedi 9 h », « reprise le
 * 5 janvier », « les bulletins sont disponibles ». Un directeur burkinabè
 * passe aujourd'hui ces messages par les élèves eux-mêmes, et la moitié
 * n'arrive jamais.
 *
 * TROIS CHOSES DÉCIDENT DE LA QUALITÉ DE CET ÉCRAN :
 *
 * 1. **Le coût est annoncé AVANT l'envoi, pas découvert après.** À 8 FCFA le
 *    segment, un communiqué mal écrit à 300 familles coûte trois fois le prix
 *    d'un communiqué bien écrit. L'écran montre le nombre de segments, de
 *    destinataires, le total, et ce qu'il restera de crédit.
 *
 * 2. **Un envoi partiel est pire que pas d'envoi.** Si le crédit ne suffit pas
 *    pour tout le monde, on refuse — au lieu d'informer la moitié des familles
 *    et de laisser l'autre moitié se présenter le mauvais jour.
 *
 * 3. **Un tuteur de trois enfants reçoit UN message.** Pas trois. C'est de
 *    l'argent, et c'est aussi du respect.
 */

import { withSchool } from "../lib/db.ts";
import { createSmsChannel, countSegments, COST_PER_SEGMENT_FCFA } from "../lib/sms.ts";
import { page, esc, fcfa, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export type Cible = "tous" | "classe" | "impayes";

export const CIBLES: Array<[Cible, string]> = [
  ["tous", "Toutes les familles"],
  ["classe", "Une classe"],
  ["impayes", "Les familles ayant un reste à payer"],
];

export interface Destinataire { guardianId: string; phone: string; fullName: string }

/**
 * Les tuteurs joignables pour une cible donnée, DÉDOUBLONNÉS par numéro :
 * un parent de trois enfants reçoit un message, pas trois.
 */
export async function destinataires(
  schoolId: string, cible: Cible, classId: string | null,
): Promise<Destinataire[]> {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    if (y.rowCount === 0) return [];
    const yearId = y.rows[0].id;

    const filtres: string[] = [];
    const params: unknown[] = [yearId];
    if (cible === "classe") {
      params.push(classId);
      filtres.push(`e.class_id = $${params.length}`);
    }
    if (cible === "impayes") {
      filtres.push(`exists (
        select 1 from invoices i
         where i.student_id = st.id and i.academic_year_id = e.academic_year_id
           and i.status <> 'annulee'
           and i.total_fcfa > coalesce((select sum(p.amount_fcfa) from payments p
                where p.invoice_id = i.id and p.status in ('confirme','rapproche')), 0))`);
    }

    const r = await c.query(
      `select distinct on (g.phone) g.id, g.phone, g.full_name
         from enrolments e
         join students st on st.id = e.student_id
         join student_guardians sg on sg.student_id = st.id
         join guardians g on g.id = sg.guardian_id
        where e.academic_year_id = $1
          and sg.receives_sms and g.phone is not null and g.phone <> ''
          ${filtres.length ? "and " + filtres.join(" and ") : ""}
        order by g.phone, g.full_name`, params);

    return r.rows.map((x) => ({
      guardianId: x.id, phone: x.phone, fullName: x.full_name,
    }));
  });
}

export interface Devis {
  destinataires: number;
  segments: number;
  cout: number;
  credit: number;
  resteApres: number;
  suffisant: boolean;
}

export async function devis(
  schoolId: string, corps: string, cible: Cible, classId: string | null,
): Promise<Devis> {
  const gens = await destinataires(schoolId, cible, classId);
  const segments = countSegments(corps);
  const cout = gens.length * segments * COST_PER_SEGMENT_FCFA;
  const credit = await withSchool(schoolId, async (c) =>
    Number((await c.query(
      `select coalesce(sum(case when direction = 'achat' then messages
                                else -messages end), 0)::int as n
         from sms_credit_ledger`)).rows[0].n));
  const consomme = gens.length * segments;
  return {
    destinataires: gens.length, segments, cout, credit,
    resteApres: credit - consomme,
    suffisant: credit >= consomme,
  };
}

export interface EnvoiOutcome { envoyes: number; cout: number; error?: string }

export async function envoyer(
  user: SessionUser, form: URLSearchParams,
): Promise<EnvoiOutcome> {
  const schoolId = user.schoolId!;
  const titre = (form.get("titre") ?? "").trim();
  const corps = (form.get("corps") ?? "").trim();
  const cible = (form.get("cible") ?? "tous") as Cible;
  const classId = form.get("classe") || null;

  if (!titre) return { envoyes: 0, cout: 0, error: "Donnez un objet au communiqué." };
  if (!corps) return { envoyes: 0, cout: 0, error: "Le message est vide." };
  if (cible === "classe" && !classId) {
    return { envoyes: 0, cout: 0, error: "Choisissez la classe." };
  }

  const d = await devis(schoolId, corps, cible, classId);
  if (d.destinataires === 0) {
    return { envoyes: 0, cout: 0,
      error: "Aucune famille joignable pour cette cible. Vérifiez les numéros "
        + "de tuteurs dans les inscriptions." };
  }
  // Un envoi partiel est pire que pas d'envoi : la moitié des familles
  // informées, l'autre moitié qui se présente le mauvais jour.
  if (!d.suffisant) {
    return { envoyes: 0, cout: 0,
      error: `Crédit insuffisant : ${d.destinataires * d.segments} messages `
        + `nécessaires, ${d.credit} disponibles. Rien n'a été envoyé — mieux `
        + `vaut aucun communiqué qu'un communiqué reçu par la moitié des familles.` };
  }

  const gens = await destinataires(schoolId, cible, classId);
  const sms = createSmsChannel();

  return withSchool(schoolId, async (c) => {
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);

    const ann = await c.query(
      `insert into announcements (school_id, class_id, title, body, status,
                                  published_at, created_by)
       values (current_school_id(), $1, $2, $3, 'publie', now(), $4)
       returning id`,
      [cible === "classe" ? classId : null, titre, corps, staff.rows[0]?.id ?? null]);

    let envoyes = 0;
    for (const g of gens) {
      await sms.send({ to: g.phone, schoolId, body: corps });
      await c.query(
        `insert into sms_messages (school_id, guardian_id, to_phone, body,
                                   segments, cost_fcfa, status, sent_at)
         values (current_school_id(), $1, $2, $3, $4, $5, 'envoye', now())`,
        [g.guardianId, g.phone, corps, d.segments,
         d.segments * COST_PER_SEGMENT_FCFA]);
      envoyes += 1;
    }

    await c.query(
      `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
       values (current_school_id(), 'consommation', $1, $2, $3)`,
      [envoyes * d.segments, envoyes * d.segments * COST_PER_SEGMENT_FCFA,
       `Communiqué : ${titre}`]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'communique.send', 'announcement', $2, $3)`,
      [user.userId, ann.rows[0].id,
       JSON.stringify({ destinataires: envoyes, segments: d.segments })]);

    return { envoyes, cout: envoyes * d.segments * COST_PER_SEGMENT_FCFA };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function communiquesPage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const corps = url.searchParams.get("corps") ?? "";
  const titre = url.searchParams.get("titre") ?? "";
  const cible = (url.searchParams.get("cible") ?? "tous") as Cible;
  const classId = url.searchParams.get("classe") || null;

  const { classes, historique } = await withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id from academic_years
        order by (status = 'en_cours') desc, starts_on desc limit 1`);
    const cl = y.rowCount
      ? (await c.query(
          `select cl.id, cl.label from classes cl join levels lv on lv.code = cl.level_code
            where cl.academic_year_id = $1 order by lv.ordinal, cl.label`,
          [y.rows[0].id])).rows
      : [];
    const h = await c.query(
      `select a.title, a.body, a.published_at, cl.label as classe,
              (select count(*)::int from sms_messages m
                where m.body = a.body and m.guardian_id is not null) as destinataires
         from announcements a
         left join classes cl on cl.id = a.class_id
        where a.status = 'publie'
        order by a.published_at desc limit 8`);
    return { classes: cl, historique: h.rows };
  });

  // Devis calculé sur le brouillon en cours, s'il y en a un.
  const d = corps ? await devis(schoolId, corps, cible, classId) : null;

  const body = `
<div>
  <h1>Communiquer avec les familles</h1>
  <p class="sub">Un SMS arrive sur tous les téléphones, sans application à
  installer. Le coût est annoncé avant l'envoi, jamais découvert après.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="card">
  <header><b>Nouveau communiqué</b></header>
  <form method="get" action="/communiques" class="body">
    <div class="trois">
      <div><label for="titre">Objet (interne)</label>
        <input type="text" id="titre" name="titre" value="${esc(titre)}"
               placeholder="Réunion des parents"></div>
      <div><label for="cible">Destinataires</label>
        <select id="cible" name="cible">
          ${CIBLES.map(([v, l]) => `<option value="${v}"${
            v === cible ? " selected" : ""}>${l}</option>`).join("")}
        </select></div>
      <div><label for="classe">Classe (si une seule)</label>
        <select id="classe" name="classe">
          <option value="">—</option>
          ${classes.map((k: any) => `<option value="${k.id}"${
            k.id === classId ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
        </select></div>
    </div>
    <div style="margin-top:16px">
      <label for="corps">Message</label>
      <textarea id="corps" name="corps" rows="4"
        placeholder="Reunion des parents samedi 12 septembre a 9h. College Wend-Panga.">${esc(corps)}</textarea>
      <p class="hint">Un SMS fait 160 caractères. Les accents et les caractères
      spéciaux le réduisent à 70 : écrire « Reunion » plutôt que « Réunion »
      peut diviser le coût par deux.</p>
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn ghost">Calculer le coût</button>
    </div>
  </form>
</div>

${d ? `
<div class="tiles">
  <div class="tile"><div class="k">Destinataires</div><div class="v">${d.destinataires}</div>
    <div class="n">tuteurs joignables, dédoublonnés</div></div>
  <div class="tile"><div class="k">Segments</div><div class="v">${d.segments}</div>
    <div class="n">par message</div></div>
  <div class="tile"><div class="k">Coût</div>
    <div class="v" style="font-size:22px">${fcfa(d.cout)} F</div>
    <div class="n">à ${COST_PER_SEGMENT_FCFA} F le segment</div></div>
  <div class="tile"><div class="k">Crédit après envoi</div>
    <div class="v">${d.resteApres}</div>
    <div class="n">sur ${d.credit} aujourd'hui</div></div>
</div>

${d.segments > 1 ? `<div class="note warn">
  Ce message tient en ${plural(d.segments, "segment", "segments")} : il coûte
  ${d.segments} fois le prix d'un message court. Raccourcir, ou retirer les
  accents, réduit la facture d'autant.</div>` : ""}

${!d.suffisant ? `<div class="note bad">
  <b>Crédit insuffisant.</b> ${d.destinataires * d.segments} messages seraient
  nécessaires pour ${plural(d.destinataires, "famille", "familles")}, et il en
  reste ${d.credit}. L'envoi sera refusé en bloc : mieux vaut aucun communiqué
  qu'un communiqué reçu par la moitié des familles.</div>` : ""}

${d.destinataires === 0 ? `<div class="note bad">
  Aucune famille joignable pour cette cible.
  <a href="/inscriptions"><b>Vérifiez les numéros de tuteurs</b></a>.</div>` : `
<form method="post" action="/communiques" class="card">
  <input type="hidden" name="titre" value="${esc(titre)}">
  <input type="hidden" name="corps" value="${esc(corps)}">
  <input type="hidden" name="cible" value="${esc(cible)}">
  <input type="hidden" name="classe" value="${esc(classId ?? "")}">
  <div class="body row">
    <div>Envoyer à <b>${plural(d.destinataires, "famille", "familles")}</b>
      pour <b>${fcfa(d.cout)} FCFA</b>.</div>
    <div class="grow"></div>
    <button type="submit" class="btn"${d.suffisant ? "" : " disabled"}>Envoyer</button>
  </div>
</form>`}` : ""}

${historique.length ? `<div class="card">
  <header><b>Communiqués envoyés</b></header>
  <table>
    <thead><tr><th>Objet</th><th>Destinataires</th><th>Envoyé le</th></tr></thead>
    <tbody>${historique.map((h: any) => `<tr>
      <td><b>${esc(h.title)}</b>${h.classe ? ` — ${esc(h.classe)}` : ""}
        <div class="dit" style="color:var(--muted)">${esc(h.body)}</div></td>
      <td class="num">${h.destinataires}</td>
      <td class="num">${new Date(h.published_at).toLocaleDateString("fr-FR")}</td>
    </tr>`).join("")}</tbody>
  </table>
</div>` : ""}`;

  return page(chrome, "Communiqués", body);
}
