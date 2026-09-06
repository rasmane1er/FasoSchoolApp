/**
 * Encaissement et reçus.
 *
 * Espèces, virement et chèque uniquement. Orange Money et Moov Money viendront
 * derrière la même interface une fois le RCCM obtenu — le Burkina Faso n'est
 * pas couvert par l'API publique Orange Money et Moov n'en publie aucune, donc
 * le chemin passe par un agrégateur, qui exige une entreprise enregistrée.
 *
 * En attendant, ce n'est pas une amputation : la douleur d'un intendant n'est
 * pas d'encaisser, c'est de savoir qui doit quoi. Le registre vaut à lui seul
 * le déplacement.
 *
 * Règle de sûreté conservée du prototype : un paiement n'est jamais confirmé
 * par le payeur. Ici c'est l'économe qui confirme, au guichet, en enregistrant
 * l'espèce qu'il a en main — c'est pour cela que le statut est « confirmé »
 * d'emblée. Un paiement mobile, lui, restera en attente jusqu'au rappel de
 * l'opérateur.
 */

import { withSchool } from "../lib/db.ts";
import { createSmsChannel, renderTemplate, countSegments } from "../lib/sms.ts";
import { page, esc, fcfa, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export interface InvoiceLine {
  id: string; reference: string; total: number; paid: number; rest: number;
  studentId: string; lastName: string; firstNames: string; classe: string | null;
  guardianPhone: string | null;
}

export async function listInvoices(schoolId: string, filter: "tous" | "impayes") {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select i.id, i.reference, i.total_fcfa, i.student_id,
              st.last_name, st.first_names, cl.label as classe,
              coalesce((select sum(p.amount_fcfa) from payments p
                         where p.invoice_id = i.id
                           and p.status in ('confirme','rapproche')), 0) as paye,
              (select g.phone from student_guardians sg
                 join guardians g on g.id = sg.guardian_id
                where sg.student_id = st.id and sg.receives_sms
                order by sg.is_primary desc limit 1) as tuteur
         from invoices i
         join students st on st.id = i.student_id
         left join enrolments e on e.student_id = st.id
                               and e.academic_year_id = i.academic_year_id
         left join classes cl on cl.id = e.class_id
        where i.status <> 'annulee'
        order by st.last_name, st.first_names`);

    const rows: InvoiceLine[] = r.rows.map((x) => ({
      id: x.id, reference: x.reference,
      total: Number(x.total_fcfa), paid: Number(x.paye),
      rest: Number(x.total_fcfa) - Number(x.paye),
      studentId: x.student_id, lastName: x.last_name, firstNames: x.first_names,
      classe: x.classe, guardianPhone: x.tuteur,
    }));
    return filter === "impayes" ? rows.filter((x) => x.rest > 0) : rows;
  });
}

export async function financePage(
  user: SessionUser, chrome: PageChrome, url: URL, flash?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const filter = url.searchParams.get("filtre") === "tous" ? "tous" : "impayes";
  const rows = await listInvoices(schoolId, filter);

  const caps = await withSchool(schoolId, async (c) =>
    (await c.query(
      `select fs.label,
              coalesce(sum(fl.amount_fcfa) filter (where fl.cap_treatment = 'plafonne'),0) as plafonne,
              coalesce(sum(fl.amount_fcfa),0) as total
         from fee_schedules fs join fee_lines fl on fl.fee_schedule_id = fs.id
        group by fs.id, fs.label`)).rows);

  const attendu = rows.reduce((a, r) => a + r.total, 0);
  const encaisse = rows.reduce((a, r) => a + r.paid, 0);
  const reste = attendu - encaisse;
  const enRetard = rows.filter((r) => r.rest > 0);

  const body = rows.map((r) => `
    <tr${r.rest > 0 ? ' class="bad"' : ""}>
      <td><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}
        <div style="font-size:12px;color:var(--faint)" class="num">${esc(r.reference)}</div></td>
      <td>${esc(r.classe ?? "—")}</td>
      <td class="num r">${fcfa(r.total)}</td>
      <td class="num r">${fcfa(r.paid)}</td>
      <td class="num r" style="font-weight:600;color:${r.rest > 0 ? "var(--laterite)" : "var(--verdant)"}">${fcfa(r.rest)}</td>
      <td class="r">${r.rest > 0
        ? `<a class="btn ghost" style="height:36px;padding:0 14px" href="/scolarite/encaisser?facture=${esc(r.id)}">Encaisser</a>`
        : `<span class="pill p-ok">SOLDÉE</span>`}</td>
    </tr>`).join("");

  return page(chrome, "Scolarité", `
    <div class="row"><div><h1>Scolarité</h1>
      <p style="margin:0;color:var(--muted)">Espèces, virement et chèque. Orange Money et Moov Money à l'obtention du RCCM.</p></div>
      <div class="row" style="margin-left:auto">
        <a class="btn ghost" href="/scolarite?filtre=impayes"${filter === "impayes" ? ' style="border-color:var(--indigo);color:var(--indigo)"' : ""}>Impayées</a>
        <a class="btn ghost" href="/scolarite?filtre=tous"${filter === "tous" ? ' style="border-color:var(--indigo);color:var(--indigo)"' : ""}>Toutes</a>
      </div></div>

    ${flash ? `<div class="ok">${flash}</div>` : ""}

    <div class="tiles">
      <div class="tile"><div class="k">Attendu</div><div class="v" style="font-size:22px">${fcfa(attendu)} F</div></div>
      <div class="tile"><div class="k">Encaissé</div><div class="v" style="font-size:22px;color:var(--verdant)">${fcfa(encaisse)} F</div></div>
      <div class="tile"><div class="k">Reste à recouvrer</div><div class="v" style="font-size:22px;color:var(--laterite)">${fcfa(reste)} F</div>
        <div class="n">${plural(enRetard.length, "famille en retard", "familles en retard")}</div></div>
      <div class="tile"><div class="k">Taux de recouvrement</div><div class="v">${attendu === 0 ? "—" : Math.round((encaisse / attendu) * 100)}<span style="font-size:15px;color:var(--faint)"> %</span></div></div>
    </div>

    ${caps.map((c: any) => `<div class="note warn">
      <b>${esc(c.label)}</b> — ${fcfa(c.plafonne)} F comptés dans le plafond de l'arrêté n°2026-101,
      ${fcfa(Number(c.total) - Number(c.plafonne))} F hors plafond (hébergement).</div>`).join("")}

    <div class="card"><div class="scroll"><table>
      <thead><tr><th>Élève</th><th>Classe</th><th class="r">Dû</th><th class="r">Payé</th><th class="r">Reste</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="6" style="color:var(--muted)">Aucune facture.</td></tr>`}</tbody>
    </table></div></div>`);
}

export async function collectPage(
  user: SessionUser, chrome: PageChrome, invoiceId: string, error?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const rows = await listInvoices(schoolId, "tous");
  const inv = rows.find((r) => r.id === invoiceId);
  if (!inv) return page(chrome, "Encaisser", `<div class="note bad">Facture introuvable.</div>`);

  return page(chrome, "Encaisser", `
    <div><h1>Encaisser un paiement</h1>
      <p style="margin:0;color:var(--muted)">${esc(inv.lastName)} ${esc(inv.firstNames)} — ${esc(inv.classe ?? "")} — facture <span class="num">${esc(inv.reference)}</span></p></div>

    ${error ? `<div class="err">${esc(error)}</div>` : ""}

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px;align-items:start">
      <div class="card"><div class="body">
        <form method="post" action="/scolarite/encaisser">
          <input type="hidden" name="facture" value="${esc(inv.id)}">

          <label for="montant">Montant reçu (FCFA)</label>
          <input id="montant" name="montant" type="text" inputmode="numeric" required autofocus
                 value="${inv.rest}" class="num" style="font-size:19px">

          <div style="margin-top:16px">
            <label for="methode">Moyen de paiement</label>
            <select id="methode" name="methode">
              <option value="especes">Espèces</option>
              <option value="virement">Virement bancaire</option>
              <option value="cheque">Chèque</option>
            </select>
          </div>

          <div style="margin-top:16px">
            <label for="ref">Référence (facultatif)</label>
            <input id="ref" name="ref" type="text" placeholder="N° de chèque, bordereau…">
          </div>

          <label style="display:flex;align-items:center;gap:8px;margin-top:18px;text-transform:none;
                        letter-spacing:0;font-size:13.5px;color:var(--ink)">
            <input type="checkbox" name="sms" value="1"${inv.guardianPhone ? " checked" : " disabled"} style="width:auto;height:auto">
            Confirmer au tuteur par SMS
            ${inv.guardianPhone ? `<span class="num" style="color:var(--faint)">${esc(inv.guardianPhone)}</span>`
                                : `<span style="color:var(--laterite)">aucun tuteur joignable</span>`}
          </label>

          <div class="row" style="margin-top:20px">
            <button class="btn" type="submit">Enregistrer et éditer le reçu</button>
            <a class="btn ghost" href="/scolarite">Annuler</a>
          </div>
        </form>
      </div></div>

      <div class="card"><div class="body">
        <div style="display:flex;flex-direction:column;gap:10px;font-size:14px">
          <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Montant dû</span><span class="num">${fcfa(inv.total)} F</span></div>
          <div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">Déjà payé</span><span class="num">${fcfa(inv.paid)} F</span></div>
          <div style="display:flex;justify-content:space-between;padding-top:10px;border-top:1px solid var(--rule)">
            <b>Reste</b><b class="num" style="color:var(--laterite)">${fcfa(inv.rest)} F</b></div>
        </div>
        <div class="note" style="margin:18px 0 0;font-size:13px">
          Le reçu porte un numéro séquentiel et sans trou, propre à l'établissement.
          Un comptable le vérifiera.
        </div>
      </div></div>
    </div>`);
}

export async function collect(
  user: SessionUser, form: URLSearchParams,
): Promise<{ ok: true; receipt: string } | { ok: false; error: string; invoiceId: string }> {
  const schoolId = user.schoolId!;
  const invoiceId = form.get("facture") ?? "";
  const montant = Math.round(Number((form.get("montant") ?? "").replace(/[^\d.,]/g, "").replace(",", ".")));
  const methode = form.get("methode") ?? "especes";

  if (!["especes", "virement", "cheque"].includes(methode)) {
    return { ok: false, error: "Moyen de paiement inconnu.", invoiceId };
  }
  if (!Number.isFinite(montant) || montant <= 0) {
    return { ok: false, error: "Montant invalide.", invoiceId };
  }

  return withSchool(schoolId, async (c) => {
    const inv = await c.query(
      `select i.id, i.total_fcfa, i.student_id,
              coalesce((select sum(p.amount_fcfa) from payments p
                         where p.invoice_id = i.id
                           and p.status in ('confirme','rapproche')),0) as paye
         from invoices i where i.id = $1`, [invoiceId]);
    if (inv.rowCount === 0) return { ok: false as const, error: "Facture introuvable.", invoiceId };

    const rest = Number(inv.rows[0].total_fcfa) - Number(inv.rows[0].paye);
    if (montant > rest) {
      return { ok: false as const,
        error: `Le montant dépasse le reste à payer (${fcfa(rest)} F).`, invoiceId };
    }

    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    // Numérotation : on sérialise l'émission par établissement, sinon deux
    // guichets simultanés se disputent le même numéro.
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`recu:${schoolId}`]);

    const pay = await c.query(
      `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                             idempotency_key, provider_ref, recorded_by, confirmed_at)
       values ($1,$2,$3,$4,'confirme',$5,$6,$7, now()) returning id`,
      [schoolId, invoiceId, montant, methode,
       `guichet:${invoiceId}:${Date.now()}`, form.get("ref") || null, staffId]);

    // Compteur monotone porté par l'établissement. Dériver de max(sequence)
    // réutiliserait un numéro si le reçu le plus haut venait à disparaître.
    const seq = await c.query(
      `update schools set receipt_sequence = receipt_sequence + 1
        where id = $1 returning receipt_sequence`, [schoolId]);
    const n = Number(seq.rows[0].receipt_sequence);
    const year = new Date().getFullYear();
    const number = `R-${year}-${String(n).padStart(4, "0")}`;

    await c.query(
      `insert into receipts (school_id, payment_id, receipt_number, sequence, amount_fcfa)
       values ($1,$2,$3,$4,$5)`,
      [schoolId, pay.rows[0].id, number, n, montant]);

    const nouveauReste = rest - montant;
    await c.query(
      `update invoices set status = $2 where id = $1`,
      [invoiceId, nouveauReste === 0 ? "soldee" : "partielle"]);

    // Confirmation au tuteur : c'est ce qui évite la contestation trois mois plus tard.
    if (form.get("sms") === "1") {
      const g = await c.query(
        `select st.first_names, g.id as gid, g.phone
           from students st
           left join student_guardians sg on sg.student_id = st.id and sg.receives_sms
           left join guardians g on g.id = sg.guardian_id
          where st.id = $1 order by sg.is_primary desc nulls last limit 1`,
        [inv.rows[0].student_id]);
      const row = g.rows[0];
      if (row?.phone) {
        const school = await c.query(`select name from schools limit 1`);
        const body = renderTemplate(
          "{{ecole}}: paiement de {{montant}} F recu pour {{eleve}}. Reste {{reste}} F. Recu {{recu}}.",
          { ecole: school.rows[0]?.name ?? "", montant: String(montant),
            eleve: row.first_names, reste: String(nouveauReste), recu: number });
        const sms = createSmsChannel();
        const result = await sms.send({ to: row.phone, body, schoolId,
          studentId: inv.rows[0].student_id });
        await c.query(
          `insert into sms_messages (school_id, student_id, guardian_id, to_phone, body,
                                     segments, cost_fcfa, status, provider, sent_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9, case when $8 = 'envoye' then now() end)`,
          [schoolId, inv.rows[0].student_id, row.gid, row.phone, body,
           countSegments(body), result.costFcfa, result.ok ? "envoye" : "echoue", sms.name]);
        if (result.ok) {
          await c.query(
            `insert into sms_credit_ledger (school_id, direction, messages, amount_fcfa, note)
             values ($1,'consommation',1,$2,'Confirmation de paiement')`,
            [schoolId, result.costFcfa]);
        }
      }
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values ($1,$2,'payment.collect','invoice',$3,$4)`,
      [schoolId, user.userId, invoiceId,
       JSON.stringify({ montant, methode, recu: number })]);

    return { ok: true as const, receipt: number };
  });
}

/** Reçu imprimable, format A5 paysage — la moitié d'une feuille A4. */
export async function receiptPage(schoolId: string, number: string): Promise<string | null> {
  const d = await withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select rc.receipt_number, rc.amount_fcfa, rc.issued_at,
              p.method, p.provider_ref,
              i.reference, i.total_fcfa,
              st.last_name, st.first_names, st.matricule,
              cl.label as classe, s.name as ecole, s.commune,
              sf.full_name as encaisse_par,
              coalesce((select sum(p2.amount_fcfa) from payments p2
                         where p2.invoice_id = i.id
                           and p2.status in ('confirme','rapproche')),0) as paye
         from receipts rc
         join payments p on p.id = rc.payment_id
         join invoices i on i.id = p.invoice_id
         join students st on st.id = i.student_id
         left join enrolments e on e.student_id = st.id and e.academic_year_id = i.academic_year_id
         left join classes cl on cl.id = e.class_id
         left join staff sf on sf.id = p.recorded_by
         cross join schools s
        where rc.receipt_number = $1`, [number]);
    return r.rows[0] ?? null;
  });
  if (!d) return null;

  const reste = Number(d.total_fcfa) - Number(d.paye);
  const methodes: Record<string, string> = {
    especes: "Espèces", virement: "Virement bancaire", cheque: "Chèque",
    orange_money: "Orange Money", moov_money: "Moov Money",
  };

  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>Reçu ${esc(number)}</title>
<style>
  @page { size: A5 landscape; margin: 0; }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;background:#EDEBE6;color:#14161F}
  .recu{width:210mm;height:148mm;padding:14mm 16mm;background:#fff;margin:8mm auto;
        display:flex;flex-direction:column;box-shadow:0 1px 4px rgba(0,0,0,.14)}
  .num{font-family:ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
  @media print{ body{background:#fff} .recu{margin:0;box-shadow:none} }
</style></head>
<body>
<div class="recu">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;
              padding-bottom:10px;border-bottom:2px solid #14161F">
    <div>
      <div style="font-size:9pt;font-weight:600">BURKINA FASO</div>
      <div style="font-size:7.5pt;font-style:italic;color:#4E5265">Unité — Progrès — Justice</div>
      <div style="font-size:11pt;font-weight:600;margin-top:8px">${esc(d.ecole.toUpperCase())}</div>
      <div style="font-size:8pt;color:#4E5265">${esc(d.commune ?? "")}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:18pt;font-weight:700">REÇU</div>
      <div class="num" style="font-size:13pt;margin-top:2px">${esc(d.receipt_number)}</div>
      <div class="num" style="font-size:8.5pt;color:#4E5265;margin-top:4px">${new Date(d.issued_at).toLocaleDateString("fr-FR")}</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 20px;padding:14px 0;
              border-bottom:1px solid #DCD8CF">
    <div style="grid-column:span 2">
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Reçu de</div>
      <div style="font-size:13pt;font-weight:600">${esc(d.last_name)} ${esc(d.first_names)}</div>
    </div>
    <div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Classe</div>
      <div style="font-size:11pt;font-weight:600">${esc(d.classe ?? "—")}</div>
    </div>
    <div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Matricule</div>
      <div class="num" style="font-size:10pt">${esc(d.matricule)}</div>
    </div>
    <div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Facture</div>
      <div class="num" style="font-size:10pt">${esc(d.reference)}</div>
    </div>
    <div>
      <div style="font-size:7.5pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Moyen</div>
      <div style="font-size:10pt">${esc(methodes[d.method] ?? d.method)}${d.provider_ref ? ` — ${esc(d.provider_ref)}` : ""}</div>
    </div>
  </div>

  <div style="display:flex;gap:16px;margin-top:18px">
    <div style="flex-grow:1;border:2px solid #14161F;padding:14px 18px">
      <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">Montant reçu</div>
      <div class="num" style="font-size:30pt;font-weight:600;line-height:1.1">${fcfa(d.amount_fcfa)} <span style="font-size:14pt">FCFA</span></div>
    </div>
    <div style="width:38%;border:1px solid #DCD8CF;padding:14px 18px;display:flex;flex-direction:column;gap:7px">
      <div style="display:flex;justify-content:space-between;font-size:9.5pt">
        <span style="color:#4E5265">Total dû</span><span class="num">${fcfa(d.total_fcfa)} F</span></div>
      <div style="display:flex;justify-content:space-between;font-size:9.5pt">
        <span style="color:#4E5265">Total payé</span><span class="num">${fcfa(d.paye)} F</span></div>
      <div style="display:flex;justify-content:space-between;font-size:11pt;font-weight:600;
                  padding-top:7px;border-top:1px solid #DCD8CF">
        <span>Reste</span><span class="num">${fcfa(reste)} F</span></div>
    </div>
  </div>

  <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end">
    <div style="font-size:8pt;color:#6B6F80">
      ${reste === 0 ? "<b style='color:#3B6349;font-size:10pt'>SCOLARITÉ SOLDÉE</b>" : "Reçu à conserver."}
    </div>
    <div style="width:44%;border-top:1px solid #14161F;padding-top:5px;font-size:8.5pt;color:#4E5265">
      ${esc(d.encaisse_par ?? "L'économe")}
    </div>
  </div>
</div>
</body></html>`;
}
