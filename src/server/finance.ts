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

/** Une date ISO en jour lisible : « 05/01/2027 ». */
const jour = (iso: string): string => {
  const [a, m, j] = iso.split("-");
  return `${j}/${m}/${a}`;
};

export interface InvoiceLine {
  id: string; reference: string; total: number; paid: number; rest: number;
  studentId: string; lastName: string; firstNames: string; classe: string | null;
  guardianPhone: string | null;
  /** Ce qui était exigible AUJOURD'HUI. `null` : pas d'échéancier. */
  echu: number | null;
  /** Exigible et non versé. `null` se propage : inconnu, pas nul. */
  retard: number | null;
  /** La prochaine tranche, pour dire à la famille ce qui vient. */
  prochaine: { label: string; montant: number; le: string } | null;
  /** Élève arrivé après l'ouverture de l'année, et échéances antérieures. */
  arrivee: { le: string; echeances: number; montant: number } | null;
  /** Annulée : par qui, quand, pourquoi. Une somme retirée se justifie. */
  annulee: { le: string; par: string | null; motif: string } | null;
  /** Cet élève a-t-il quitté l'établissement ? C'est ce qui rend l'annulation
   *  nécessaire — et ce qui la rend lisible dans la liste. */
  parti: string | null;
}

export async function listInvoices(schoolId: string, filter: "tous" | "impayes") {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select i.id, i.reference, i.total_fcfa, i.student_id,
              st.last_name, st.first_names, cl.label as classe,
              montant_regle(i.id) as paye,
              -- « En retard » ne peut pas vouloir dire « doit quelque chose » :
              -- le jour de l'émission, cela désignerait toutes les familles.
              montant_echu(i.id, current_date) as echu,
              retard_de(i.id, current_date) as retard,
              (select row_to_json(p) from prochaine_echeance(i.id, current_date) p)
                as prochaine,
              -- Ce qui était exigible AVANT que l'élève n'arrive. Le produit
              -- ne décide pas si c'est dû ; il refuse seulement de le compter
              -- « en retard » sans le dire.
              (select row_to_json(a) from echeances_avant_arrivee(i.id) a)
                as arrivee,
              -- Le filtre sur le numéro est dans le WHERE : sans lui, un
              -- tuteur PRINCIPAL sans numéro sort en tête et masque un second
              -- tuteur joignable du même dossier. Même défaut que celui trouvé
              -- sur l'appel du matin, dans le module d'à côté.
              (select g.phone from student_guardians sg
                 join guardians g on g.id = sg.guardian_id
                where sg.student_id = st.id and sg.receives_sms
                  and g.phone is not null and g.phone <> ''
                order by sg.is_primary desc limit 1) as tuteur,
              i.annulee_le, i.motif_annulation, e.status as inscription,
              (select u.full_name from staff sa
                 left join users u on u.id = sa.user_id
                where sa.id = i.annulee_par) as annulee_par
         from invoices i
         join students st on st.id = i.student_id
         left join enrolments e on e.student_id = st.id
                               and e.academic_year_id = i.academic_year_id
         left join classes cl on cl.id = e.class_id
        -- LES FACTURES ANNULÉES RESTENT VISIBLES. Les cacher ferait douter
        -- de celles qui restent : une somme qui disparaît d'un tableau sans
        -- explication est exactement ce qu'un contrôleur vient chercher. La
        -- liste les montre barrées, avec leur motif, et les exclut des totaux.
        order by (i.status = 'annulee'), st.last_name, st.first_names`);

    const rows: InvoiceLine[] = r.rows.map((x) => ({
      id: x.id, reference: x.reference,
      total: Number(x.total_fcfa), paid: Number(x.paye),
      rest: Number(x.total_fcfa) - Number(x.paye),
      studentId: x.student_id, lastName: x.last_name, firstNames: x.first_names,
      classe: x.classe, guardianPhone: x.tuteur,
      echu: x.echu === null ? null : Number(x.echu),
      retard: x.retard === null ? null : Number(x.retard),
      prochaine: x.prochaine
        ? { label: x.prochaine.label, montant: Number(x.prochaine.amount_fcfa),
            le: String(x.prochaine.due_on).slice(0, 10) }
        : null,
      arrivee: x.arrivee
        ? { le: String(x.arrivee.arrivee).slice(0, 10),
            echeances: Number(x.arrivee.combien),
            montant: Number(x.arrivee.montant) }
        : null,
      annulee: x.annulee_le
        ? { le: String(x.annulee_le).slice(0, 10),
            par: x.annulee_par ?? null,
            motif: x.motif_annulation ?? "" }
        : null,
      parti: ["transfere_sortant", "radie", "abandon"].includes(x.inscription ?? "")
        ? (x.inscription as string) : null,
    }));
    return filter === "impayes"
      ? rows.filter((x) => x.rest > 0 && !x.annulee) : rows;
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

  /* UNE FACTURE ANNULÉE NE COMPTE DANS AUCUN TOTAL — elle reste pourtant
   * dans la liste, barrée, avec son motif. Les deux choses vont ensemble :
   * l'exclure des chiffres est la raison de l'annulation ; la garder à
   * l'écran est ce qui rend la somme retirée vérifiable. */
  const vivantes = rows.filter((r) => !r.annulee);
  const annulees = rows.filter((r) => r.annulee);
  const attendu = vivantes.reduce((a, r) => a + r.total, 0);
  const encaisse = vivantes.reduce((a, r) => a + r.paid, 0);
  const reste = attendu - encaisse;

  /* « EN RETARD » VEUT DIRE EN RETARD SUR CE QUI ÉTAIT DÛ.
   *
   * Cette ligne se lisait `rows.filter((r) => r.rest > 0)` — c'est-à-dire
   * « doit quelque chose sur l'année ». Le jour de l'émission des factures,
   * avant qu'un franc ne soit exigible, elle désignait TOUTES les familles, et
   * la tuile annonçait « 12 familles en retard ». Une famille à jour de sa
   * première tranche y était comptée comme celle qui n'a rien versé.
   *
   * C'est le mot sur lequel un établissement décide qui il renvoie chez lui. */
  const enRetard = vivantes.filter((r) => (r.retard ?? 0) > 0);
  const sansEcheancier = vivantes.filter((r) => r.retard === null && r.rest > 0);
  const partisAvecFacture = vivantes.filter((r) => r.parti && r.rest > 0);
  const arriveesTardives = enRetard.filter(
    (r) => r.arrivee !== null && r.arrivee.echeances > 0);
  const montantEnRetard = enRetard.reduce((a, r) => a + (r.retard ?? 0), 0);

  const body = rows.map((r) => {
    const enRetardCeJour = (r.retard ?? 0) > 0;
    /* Le rouge est réservé au retard réel. Une famille qui doit encore la
       tranche de janvier n'est pas en faute en octobre. */
    /* UNE FACTURE ANNULÉE RESTE À L'ÉCRAN, barrée, avec son motif, son
     * auteur et sa date. Elle ne compte dans aucun total ; la cacher ferait
     * douter de celles qui restent. */
    if (r.annulee) {
      return `
    <tr class="pale">
      <td><s><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}</s>
        <div style="font-size:12px;color:var(--faint)" class="num">${esc(r.reference)}</div>
        <span class="dit">annulée le ${jour(r.annulee.le)}${
          r.annulee.par ? ` par ${esc(r.annulee.par)}` : ""} — ${
          esc(r.annulee.motif)}</span></td>
      <td>${esc(r.classe ?? "—")}</td>
      <td class="num r"><s>${fcfa(r.total)}</s></td>
      <td class="num r">${fcfa(r.paid)}</td>
      <td class="num r"><span class="pill p-info">ANNULÉE</span></td>
      <td></td><td></td>
    </tr>`;
    }
    return `
    <tr${enRetardCeJour ? ' class="bad"' : ""}>
      <td><b>${esc(r.lastName)}</b> ${esc(r.firstNames)}
        <div style="font-size:12px;color:var(--faint)" class="num">${esc(r.reference)}</div>${
        /* L'élève est parti et sa facture court encore : c'est LA situation
           que l'annulation existe pour clore, et l'écran la nomme. */
        r.parti && r.rest > 0
          ? `<span class="dit" style="color:var(--ochre)">a quitté
             l'établissement (${esc(r.parti.replace(/_/g, " "))}) — sa facture
             court toujours</span>` : ""}</td>
      <td>${esc(r.classe ?? "—")}</td>
      <td class="num r">${fcfa(r.total)}</td>
      <td class="num r">${fcfa(r.paid)}</td>
      <td class="num r" style="font-weight:600;color:${r.rest > 0 ? "var(--laterite)" : "var(--verdant)"}">${fcfa(r.rest)}</td>
      <td class="r" style="font-size:13px">${
        r.retard === null
          // On ne tranche pas à la place de l'école : sans échéancier, le
          // retard est INCONNU, et le dire vaut mieux que de choisir.
          ? `<span class="dit">échéancier absent</span>`
          : enRetardCeJour
            ? `<b style="color:var(--laterite)" class="num">${fcfa(r.retard)} F</b>
               <span class="dit">exigible, non versé</span>${
               /* UN ÉLÈVE ARRIVÉ EN JANVIER N'ÉTAIT PAS LÀ EN OCTOBRE.
                  On ne retire pas ces tranches du retard — savoir si elles
                  sont dues est une règle d'établissement, pas une règle de
                  logiciel — mais on ne laisse pas non plus le rouge parler
                  tout seul. */
               r.arrivee && r.arrivee.echeances > 0
                 ? `<span class="dit" style="color:var(--ochre)">arrivé le ${
                     jour(r.arrivee.le)} — ${plural(r.arrivee.echeances,
                     "échéance est antérieure", "échéances sont antérieures")}
                     à son arrivée (${fcfa(r.arrivee.montant)} F)</span>`
                 : ""}`
            : r.prochaine
              ? `<span class="pill p-ok">à jour</span>
                 <span class="dit">${esc(r.prochaine.label)} : ${
                   fcfa(r.prochaine.montant)} F le ${jour(r.prochaine.le)}</span>`
              : `<span class="pill p-ok">à jour</span>`}</td>
      <td class="r">${r.rest > 0
        ? `<a class="btn ghost" style="height:36px;padding:0 14px" href="/scolarite/encaisser?facture=${esc(r.id)}">Encaisser</a>`
        : `<span class="pill p-ok">SOLDÉE</span>`}</td>
    </tr>`; }).join("");

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
        <div class="n">sur l'année entière</div></div>
      <div class="tile"><div class="k">En retard aujourd'hui</div>
        <div class="v" style="font-size:22px;color:${enRetard.length > 0 ? "var(--laterite)" : "var(--verdant)"}">${fcfa(montantEnRetard)} F</div>
        <div class="n">${plural(enRetard.length, "famille", "familles")} — exigible et non versé</div></div>
      <div class="tile"><div class="k">Taux de recouvrement</div><div class="v">${attendu === 0 ? "—" : Math.round((encaisse / attendu) * 100)}<span style="font-size:15px;color:var(--faint)"> %</span></div></div>
    </div>

    ${arriveesTardives.length === 0 ? "" : `<div class="note warn">
      <b>${plural(arriveesTardives.length, "élève est arrivé", "élèves sont arrivés")}
      en cours d'année, et ${arriveesTardives.length > 1 ? "leurs retards comptent"
        : "son retard compte"} des échéances antérieures à
      ${arriveesTardives.length > 1 ? "leur" : "son"} arrivée.</b>
      Le logiciel ne décide pas si ces tranches sont dues : au Burkina la
      facturation d'une arrivée tardive varie d'un établissement à l'autre, et
      aucun texte consulté ne la fixe. C'est à la direction de trancher — et,
      une fois tranché, de réémettre la facture depuis l'écran des frais.
      <span class="hint">Règle à confirmer, comme les six autres du README.</span>
    </div>`}

    ${sansEcheancier.length === 0 ? "" : `<div class="note">
      <b>${plural(sansEcheancier.length, "facture n'a pas d'échéancier",
                  "factures n'ont pas d'échéancier")}.</b>
      Pour celles-là le logiciel ne dit NI « à jour » NI « en retard » : il ne
      le sait pas, et choisir à votre place se verrait un jour sur la porte
      d'un élève. Réémettre la facture depuis l'écran des frais lui pose un
      échéancier aligné sur vos trimestres.</div>`}

    ${caps.map((c: any) => `<div class="note warn">
      <b>${esc(c.label)}</b> — ${fcfa(c.plafonne)} F comptés dans le plafond de l'arrêté n°2026-101,
      ${fcfa(Number(c.total) - Number(c.plafonne))} F hors plafond (hébergement).</div>`).join("")}

    <div class="card"><div class="scroll"><table>
      <thead><tr><th>Élève</th><th>Classe</th><th class="r">Dû sur l'année</th>
        <th class="r">Payé</th><th class="r">Reste</th>
        <th class="r">Où en est l'échéancier</th><th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="7" style="color:var(--muted)">Aucune facture.</td></tr>`}</tbody>
    </table></div></div>

    <div class="note">
      <b>« En retard » veut dire en retard sur ce qui était dû.</b> Ce mot
      désignait auparavant toute famille devant encore quelque chose sur
      l'année : le jour de l'émission des factures, avant qu'un franc ne soit
      exigible, il les désignait donc TOUTES. Une famille à jour de sa première
      tranche y était comptée comme celle qui n'a rien versé. C'est le mot sur
      lequel un établissement décide qui il renvoie chez lui.
    </div>`);
}

const MOYENS: Record<string, string> = {
  especes: "Espèces", virement: "Virement", cheque: "Chèque",
  orange_money: "Orange Money", moov_money: "Moov Money",
};

export async function collectPage(
  user: SessionUser, chrome: PageChrome, invoiceId: string, error?: string,
  flash?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const rows = await listInvoices(schoolId, "tous");
  const inv = rows.find((r) => r.id === invoiceId);
  if (!inv) {
    // Ceinture et bretelles : même sans facture, le message est rendu. Une
    // page qui remplace un refus par « facture introuvable » ment deux fois.
    return page(chrome, "Encaisser", `
      ${error ? `<div class="err">${esc(error)}</div>` : ""}
      ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}
      <div class="note bad">Facture introuvable.</div>
      <p><a href="/scolarite">Retour à la scolarité</a></p>`);
  }
  const lignes = await encaissements(schoolId, invoiceId);

  /* Le registre des encaissements. Les deux lignes d'une erreur corrigée y
     restent : cacher la première ferait douter de la seconde. */
  const journal = lignes.length === 0 ? "" : `
    <div class="card">
      <header><b>Ce qui a été encaissé sur cette facture</b></header>
      <div class="scroll"><table>
        <thead><tr><th>Date</th><th>Reçu</th><th>Moyen</th>
          <th class="r">Montant</th><th>Par</th><th></th></tr></thead>
        <tbody>${lignes.map((l) => `
          <tr${l.annulePar || l.annuleLeRecu ? ' class="pale"' : ""}>
            <td class="num">${new Date(l.quand).toLocaleDateString("fr-FR")}</td>
            <td class="num">${l.recu
              ? `<a href="/recus/${encodeURIComponent(l.recu)}">${esc(l.recu)}</a>`
              : "—"}</td>
            <td>${esc(MOYENS[l.methode] ?? l.methode)}</td>
            <td class="num r"${l.annuleLeRecu
              ? ' style="color:var(--laterite)"' : ""}>${
              l.annuleLeRecu ? "− " : ""}${fcfa(l.montant)} F</td>
            <td>${esc(l.par ?? "—")}
              ${l.annuleLeRecu ? `<span class="dit">Annule le reçu ${
                esc(l.annuleLeRecu)}${l.motif ? ` — ${esc(l.motif)}` : ""}</span>` : ""}
              ${l.annulePar ? `<span class="dit bad">Annulé par le reçu ${
                esc(l.annulePar)}</span>` : ""}</td>
            <td class="r">${l.annulePar || l.annuleLeRecu ? "" : `
              <form method="post" action="/scolarite/annuler" class="row"
                    style="justify-content:flex-end">
                <input type="hidden" name="paiement" value="${l.paymentId}">
                <input type="text" name="motif" placeholder="Motif de l'annulation"
                       style="width:auto;height:34px;font-size:13px" required>
                <button type="submit" class="btn ghost petit">Annuler</button>
              </form>`}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
      <div class="body" style="padding-top:0">
        <p class="hint">On n'efface pas un reçu : sa numérotation est une suite
        sans trou, et c'est ce qui la rend vérifiable. Une annulation est un
        second reçu, de contrepartie. Les deux documents circulent, et chacun
        dit ce qu'il est.</p>
      </div>
    </div>`;

  return page(chrome, "Encaisser", `
    <div><h1>Encaisser un paiement</h1>
      <p style="margin:0;color:var(--muted)">${esc(inv.lastName)} ${esc(inv.firstNames)} — ${esc(inv.classe ?? "")} — facture <span class="num">${esc(inv.reference)}</span></p></div>

    ${error ? `<div class="err">${esc(error)}</div>` : ""}
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}

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

        ${/* ANNULER LA FACTURE ELLE-MÊME.
              Le statut `annulee` était lu par onze endroits du code et écrit
              par aucun : un élève parti gardait sa facture indéfiniment dans
              le « reste à recouvrer » et dans les relances. Le geste est ici,
              sous l'encaissement, avec un motif obligatoire — et il est refusé
              si de l'argent est entré : on contre-passe d'abord, un versement
              à la fois, ce qui produit autant de reçus inverses. */ ""}
        <div style="border-top:1px solid var(--rule);margin-top:22px;padding-top:16px">
          ${inv.paid !== 0 ? `<div class="note">
            <b>Cette facture ne peut pas être annulée telle quelle.</b>
            ${fcfa(inv.paid)} F ont été encaissés. Contre-passez les versements
            un par un — chacun produit un reçu inverse que la famille garde —
            puis annulez la facture vide.
          </div>` : `
          <form method="post" action="/scolarite/facture/annuler">
            <input type="hidden" name="facture" value="${esc(inv.id)}">
            <label for="motif_facture">Annuler cette facture — pourquoi ?</label>
            <input id="motif_facture" name="motif" type="text" required
                   minlength="5"
                   placeholder="élève jamais arrivé, transféré en octobre, double émission…">
            <div class="row" style="margin-top:12px">
              <button class="btn ghost" type="submit">Annuler la facture</button>
              <span style="color:var(--muted);font-size:13px">Elle restera
                visible, barrée, avec votre nom et ce motif.</span>
            </div>
          </form>`}
        </div>
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
    </div>

    ${journal}`);
}

export async function collect(
  user: SessionUser, form: URLSearchParams,
): Promise<{ ok: true; receipt: string; deja?: boolean }
         | { ok: false; error: string; invoiceId: string }> {
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
              montant_regle(i.id) as paye
         from invoices i where i.id = $1`, [invoiceId]);
    if (inv.rowCount === 0) return { ok: false as const, error: "Facture introuvable.", invoiceId };

    const rest = Number(inv.rows[0].total_fcfa) - Number(inv.rows[0].paye);
    if (montant > rest) {
      return { ok: false as const,
        error: `Le montant dépasse le reste à payer (${fcfa(rest)} F).`, invoiceId };
    }

    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    /* LE DOUBLE-CLIC AU GUICHET.
     *
     * Deux POST identiques lancés ensemble produisaient DEUX paiements, DEUX
     * reçus et deux numéros : un billet de dix mille remis, vingt mille portés
     * au crédit de la famille, et une caisse qui manque de dix mille au soir.
     * Les deux papiers portaient même « total payé : 10 000 » — tous deux
     * avaient lu la facture avant qu'aucun n'ait écrit.
     *
     * La serrure existait pourtant depuis le premier schéma :
     * `unique (school_id, idempotency_key)`. Le code lui présentait
     * `guichet:<facture>:<Date.now()>` — une clé neuve à chaque milliseconde.
     * La serrure n'a jamais refusé personne.
     *
     * On compare donc LE GESTE, comme 0014 le fait pour les envois en masse :
     * cette facture, ce montant, ce moyen, ce guichetier. Un jeton de
     * formulaire n'attraperait que le double-clic ; le geste attrape aussi le
     * retour arrière, le rechargement et le re-clic après une attente jugée
     * trop longue. */
    const deja = await c.query(
      `select * from encaissement_deja_enregistre($1, $2, $3, $4)`,
      [invoiceId, montant, methode, staffId]);
    if (deja.rowCount! > 0 && deja.rows[0].receipt_number) {
      /* On rend LE MÊME REÇU, pas une erreur. Un guichetier à qui l'on répond
       * « erreur » après deux clics ne sait pas si l'argent est passé, et
       * recommence — ce qui est exactement le geste qu'on voulait empêcher. */
      return { ok: true as const, receipt: deja.rows[0].receipt_number as string,
               deja: true as const };
    }

    // Numérotation : on sérialise l'émission par établissement, sinon deux
    // guichets simultanés se disputent le même numéro.
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`recu:${schoolId}`]);

    /* SOUS LE VERROU, ON REGARDE DE NOUVEAU. La garde ci-dessus est lue avant
     * le verrou : deux requêtes VRAIMENT simultanées la franchissent toutes
     * les deux. C'est ce cas-là qui produisait les deux reçus. */
    const dejaVerrou = await c.query(
      `select * from encaissement_deja_enregistre($1, $2, $3, $4)`,
      [invoiceId, montant, methode, staffId]);
    if (dejaVerrou.rowCount! > 0 && dejaVerrou.rows[0].receipt_number) {
      return { ok: true as const,
               receipt: dejaVerrou.rows[0].receipt_number as string,
               deja: true as const };
    }

    /* Et la clé déterministe, pour que la contrainte d'unicité de la base soit
     * la dernière ligne de défense — celle qui tient même si deux serveurs
     * répondent en parallèle. `on conflict do nothing` : si elle refuse, c'est
     * que le geste est déjà enregistré.
     *
     * Le RANG, et pas un créneau de temps. Une première version datait la clé
     * par `epoch / fenêtre` : un versement légitime dix minutes plus tard
     * tombait dans le même créneau absolu et était refusé, et la fenêtre mise à
     * zéro ne désactivait rien. Le rang — combien de versements identiques ont
     * déjà été acceptés — ne dépend d'aucune horloge : deux clics simultanés le
     * calculent pareil, un vrai second versement en obtient un autre. */
    const cle = (await c.query(
      `select cle_encaissement($1,$2,$3,$4,
                rang_encaissement($1,$2,$3,$4)) as cle`,
      [invoiceId, montant, methode, staffId])).rows[0].cle;

    const pay = await c.query(
      `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                             idempotency_key, provider_ref, recorded_by, confirmed_at)
       values ($1,$2,$3,$4,'confirme',$5,$6,$7, now())
       on conflict (school_id, idempotency_key) do nothing
       returning id`,
      [schoolId, invoiceId, montant, methode, cle, form.get("ref") || null, staffId]);

    if (pay.rowCount === 0) {
      const r = await c.query(
        `select r.receipt_number from payments p
           join receipts r on r.payment_id = p.id
          where p.school_id = $1 and p.idempotency_key = $2`, [schoolId, cle]);
      return r.rowCount! > 0
        ? { ok: true as const, receipt: r.rows[0].receipt_number as string,
            deja: true as const }
        : { ok: false as const,
            error: "Ce versement vient d'être enregistré ailleurs. Rechargez la "
              + "page : le reçu s'y trouve.", invoiceId };
    }

    // Compteur monotone porté par l'établissement. Dériver de max(sequence)
    // réutiliserait un numéro si le reçu le plus haut venait à disparaître.
    const seq = await c.query(
      `update schools set receipt_sequence = receipt_sequence + 1
        where id = $1 returning receipt_sequence`, [schoolId]);
    const n = Number(seq.rows[0].receipt_sequence);
    const year = new Date().getFullYear();
    const number = `R-${year}-${String(n).padStart(4, "0")}`;

    /* L'ÉTAT DE LA FACTURE EST FIGÉ AVEC LE REÇU.
     *
     * Le cartouche « Total dû / Total payé / Reste » était calculé à
     * l'impression : le même reçu, réimprimé après un versement ultérieur,
     * affichait « SCOLARITÉ SOLDÉE » alors que le papier remis à la famille
     * disait « Reste 68 000 F ». Deux papiers, un numéro, deux affirmations
     * contradictoires. */
    await c.query(
      `insert into receipts (school_id, payment_id, receipt_number, sequence,
                             amount_fcfa, total_du_fcfa, total_paye_fcfa)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [schoolId, pay.rows[0].id, number, n, montant,
       Number(inv.rows[0].total_fcfa),
       Number(inv.rows[0].paye) + montant]);

    const nouveauReste = rest - montant;
    await c.query(
      `update invoices set status = $2 where id = $1`,
      [invoiceId, nouveauReste === 0 ? "soldee" : "partielle"]);

    // Confirmation au tuteur : c'est ce qui évite la contestation trois mois plus tard.
    if (form.get("sms") === "1") {
      /* MÊME REQUÊTE QUE PARTOUT AILLEURS, ENFIN.
       *
       * Celle-ci prenait le tuteur principal MÊME SANS NUMÉRO, qui masquait
       * alors un second tuteur joignable du même dossier : la confirmation de
       * paiement ne partait pour personne. C'est le défaut trouvé sur l'appel
       * du matin, resté ici parce que le module est un autre fichier. */
      const nom = await c.query(
        `select first_names from students where id = $1`,
        [inv.rows[0].student_id]);
      const g = await c.query(
        `select g.id as gid, g.phone
           from student_guardians sg
           join guardians g on g.id = sg.guardian_id
          where sg.student_id = $1 and sg.receives_sms
            and g.phone is not null and g.phone <> ''
          order by sg.is_primary desc limit 1`,
        [inv.rows[0].student_id]);
      const row = g.rows[0];
      if (row?.phone) {
        const school = await c.query(`select name from schools limit 1`);
        /* « Reste 38 000 F » sur un échéancier en trois tranches se lit comme
           une somme exigible tout de suite. On dit donc ce qui reste À VERSER
           MAINTENANT quand l'échéancier le permet, et le solde annuel ensuite.
           Sans échéancier, la phrase d'origine, inchangée. */
        const du = await c.query(
          `select retard_de($1, current_date) as retard`, [invoiceId]);
        const retard = du.rows[0]?.retard === null || du.rows[0]?.retard === undefined
          ? null : Number(du.rows[0].retard);
        const body = retard === null
          ? renderTemplate(
              "{{ecole}}: paiement de {{montant}} F recu pour {{eleve}}. "
              + "Reste {{reste}} F. Recu {{recu}}.",
              { ecole: school.rows[0]?.name ?? "", montant: String(montant),
                eleve: nom.rows[0]?.first_names ?? "", reste: String(nouveauReste), recu: number })
          : retard > 0
            ? renderTemplate(
                "{{ecole}}: paiement de {{montant}} F recu pour {{eleve}}. "
                + "Reste {{retard}} F echu, {{reste}} F sur l annee. Recu {{recu}}.",
                { ecole: school.rows[0]?.name ?? "", montant: String(montant),
                  eleve: nom.rows[0]?.first_names ?? "", retard: String(retard),
                  reste: String(nouveauReste), recu: number })
            : renderTemplate(
                "{{ecole}}: paiement de {{montant}} F recu pour {{eleve}}. "
                + "Vous etes a jour. Reste {{reste}} F sur l annee. Recu {{recu}}.",
                { ecole: school.rows[0]?.name ?? "", montant: String(montant),
                  eleve: nom.rows[0]?.first_names ?? "", reste: String(nouveauReste), recu: number });
        const sms = createSmsChannel();
        const result = await sms.send({ to: row.phone, body, schoolId,
          studentId: inv.rows[0].student_id });
        await c.query(
          `insert into sms_messages (school_id, student_id, guardian_id, to_phone, body,
                                     segments, cost_fcfa, status, provider,
                                     error_detail, sent_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   case when $8 = 'envoye' then now() end)`,
          [schoolId, inv.rows[0].student_id, row.gid, row.phone, body,
           countSegments(body), result.costFcfa, result.ok ? "envoye" : "echoue",
           sms.name,
           result.ok ? null : (result.error ?? "Refus de l'opérateur, sans détail")]);
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

/**
 * Les encaissements d'une facture, annulations comprises.
 *
 * C'est le registre qu'un économe ouvre quand une famille conteste. Il montre
 * les deux lignes d'une erreur corrigée — le paiement et sa contrepassation —
 * parce que cacher la première ferait douter de la seconde.
 */
export interface Encaissement {
  paymentId: string;
  recu: string | null;
  montant: number;
  methode: string;
  quand: Date;
  par: string | null;
  /** Numéro du reçu que cette ligne annule, si c'en est une. */
  annuleLeRecu: string | null;
  /** Numéro du reçu qui annule cette ligne, si elle l'a été. */
  annulePar: string | null;
  motif: string | null;
}

export async function encaissements(
  schoolId: string, invoiceId: string,
): Promise<Encaissement[]> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select p.id, p.amount_fcfa, p.method, p.confirmed_at, p.initiated_at,
              p.reverses_payment_id, p.reversal_reason,
              rc.receipt_number,
              sf.full_name as par,
              (select rc2.receipt_number from receipts rc2
                where rc2.payment_id = p.reverses_payment_id) as annule_le_recu,
              (select rc3.receipt_number from receipts rc3
                 join payments p3 on p3.id = rc3.payment_id
                where p3.reverses_payment_id = p.id) as annule_par
         from payments p
         left join receipts rc on rc.payment_id = p.id
         left join staff sf on sf.id = p.recorded_by
        where p.invoice_id = $1 and p.status in ('confirme','rapproche')
        order by coalesce(p.confirmed_at, p.initiated_at)`, [invoiceId]);
    return r.rows.map((x: any): Encaissement => ({
      paymentId: x.id, recu: x.receipt_number,
      montant: Number(x.amount_fcfa), methode: x.method,
      quand: x.confirmed_at ?? x.initiated_at, par: x.par,
      annuleLeRecu: x.annule_le_recu, annulePar: x.annule_par,
      motif: x.reversal_reason,
    }));
  });
}

/**
 * Annuler un paiement.
 *
 * Un économe encaisse debout, devant une file de parents. Il tape 50 000 au
 * lieu de 5 000. Rien ne pouvait le rattraper : le seul recours était psql.
 *
 * ON N'EFFACE PAS UN REÇU, et on ne diminue pas le montant du paiement. Un
 * reçu est un document remis à une famille et sa numérotation est une suite
 * sans trou — c'est ce qui la rend vérifiable. L'annulation est donc un
 * SECOND paiement, de contrepartie, avec son propre numéro de reçu. Les deux
 * documents circulent, et chacun dit ce qu'il est.
 *
 * Le motif est obligatoire : une annulation sans raison est exactement ce que
 * produirait un caissier malhonnête, et c'est la seule chose qu'un contrôle
 * puisse lire ensuite.
 */
/**
 * Annuler une FACTURE — pas un versement.
 *
 * CE QUI MANQUAIT. Le statut `annulee` était lu par onze endroits du code et
 * écrit par aucun. Un élève inscrit en septembre qui ne revient pas en octobre
 * laissait une facture de 78 000 F que rien ne pouvait retirer : elle restait
 * dans le « reste à recouvrer », dans les relances, et dans l'espace de sa
 * famille, indéfiniment. Les seuls contournements étaient pires — mettre le
 * total à zéro, qu'aucun écran n'offre, ou enregistrer un versement fictif,
 * qui falsifierait le registre des reçus.
 *
 * DEUX RÈGLES, TOUTES DEUX POSÉES EN BASE parce qu'un écran se contourne :
 *
 *   1. on n'annule pas en changeant un mot. La contrainte
 *      `invoices_annulation_tracee` exige que le statut et sa trace — qui,
 *      quand, pourquoi — aillent ensemble ;
 *   2. on n'annule pas une facture sur laquelle de l'argent est entré. Le
 *      chemin propre existe déjà : contre-passer les versements un par un,
 *      chacun produisant un reçu inverse, puis annuler la facture vide.
 *      Annuler par le haut ferait disparaître d'un clic la contrepartie de
 *      reçus remis à des familles.
 */
export async function annulerFacture(
  user: SessionUser, invoiceId: string, motif: string,
): Promise<{ ok: boolean; error?: string; flash?: string }> {
  const schoolId = user.schoolId!;
  const raison = motif.trim().replace(/\s+/g, " ");

  /* LE MOTIF EST OBLIGATOIRE, et refusé ici avant d'atteindre la base : le
   * message doit dire quoi écrire, pas rendre une violation de contrainte. */
  if (raison.length < 5) {
    return { ok: false, error: "Dites pourquoi cette facture est annulée — "
      + "« élève jamais arrivé », « transféré en octobre », « double "
      + "émission ». C'est la phrase que lira l'économe de l'an prochain." };
  }

  return withSchool(schoolId, async (c) => {
    const verdict = await c.query(
      `select * from facture_annulable($1)`, [invoiceId]);
    if (!verdict.rows[0]?.possible) {
      return { ok: false,
               error: verdict.rows[0]?.raison ?? "Annulation impossible." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const inv = await c.query(
      `update invoices
          set status = 'annulee', annulee_le = now(), annulee_par = $2,
              motif_annulation = $3
        where id = $1 and status <> 'annulee'
        returning reference, total_fcfa`,
      [invoiceId, staff.rows[0]?.id ?? null, raison]);
    if (inv.rowCount === 0) return { ok: false, error: "Elle est déjà annulée." };

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type,
                              target_id, detail)
       values (current_school_id(), $1, 'invoice.cancel', 'invoice', $2, $3)`,
      [user.userId, invoiceId,
       JSON.stringify({ reference: inv.rows[0].reference,
                        total: inv.rows[0].total_fcfa, motif: raison })]);

    return { ok: true,
      flash: `Facture ${inv.rows[0].reference} annulée : ${raison}. Elle reste `
        + `visible, barrée, avec son motif — une somme qui disparaît d'un `
        + `tableau sans explication est ce qu'un contrôleur vient chercher.` };
  });
}

export async function annulerPaiement(
  user: SessionUser, paymentId: string, motif: string,
): Promise<{ ok: boolean; error?: string; recu?: string; invoiceId?: string }> {
  const schoolId = user.schoolId!;
  const raison = motif.trim().replace(/\s+/g, " ");

  return withSchool(schoolId, async (c) => {
    const p = await c.query(
      `select p.id, p.invoice_id, p.amount_fcfa, p.method, p.status,
              p.reverses_payment_id,
              (select count(*)::int from payments r
                where r.reverses_payment_id = p.id) as deja
         from payments p where p.id = $1`, [paymentId]);
    if (p.rowCount === 0) return { ok: false, error: "Ce paiement n'existe pas." };
    const pay = p.rows[0];

    if (!["confirme", "rapproche"].includes(pay.status)) {
      return { ok: false, error: "Ce paiement n'a jamais été encaissé : il n'y "
        + "a rien à annuler.", invoiceId: pay.invoice_id };
    }
    if (pay.reverses_payment_id) {
      return { ok: false, error: "Ceci est déjà une annulation. On n'annule pas "
        + "une annulation : si le premier paiement doit être réenregistré, "
        + "encaissez-le de nouveau.", invoiceId: pay.invoice_id };
    }
    if (pay.deja > 0) {
      return { ok: false, error: "Ce paiement a déjà été annulé. Deux "
        + "contrepassations rendraient la facture créditrice.",
        invoiceId: pay.invoice_id };
    }
    /* Le motif est contrôlé APRÈS avoir retrouvé la facture, et jamais avant :
       un refus qui ne sait pas sur quelle facture il porte ne peut pas se
       réafficher, et l'économe lit « facture introuvable » au lieu de la
       raison du refus. C'est ainsi qu'un refus devient invisible. */
    if (raison.length < 8) {
      return { ok: false, invoiceId: pay.invoice_id,
        error: "Dites pourquoi ce paiement est annulé, en une phrase : c'est "
          + "la seule chose qu'un contrôle pourra lire ensuite. « Erreur de "
          + "saisie : 50 000 au lieu de 5 000 », par exemple." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);

    // Même sérialisation que l'émission : deux guichets ne se disputent pas
    // un numéro de reçu.
    await c.query(`select pg_advisory_xact_lock(hashtext($1))`, [`recu:${schoolId}`]);

    const contre = await c.query(
      `insert into payments (school_id, invoice_id, amount_fcfa, method, status,
                             idempotency_key, recorded_by, confirmed_at,
                             reverses_payment_id, reversal_reason)
       values ($1,$2,$3,$4,'confirme',$5,$6, now(), $7, $8) returning id`,
      [schoolId, pay.invoice_id, pay.amount_fcfa, pay.method,
       `annulation:${paymentId}`, staff.rows[0]?.id ?? null, paymentId, raison]);

    const seq = await c.query(
      `update schools set receipt_sequence = receipt_sequence + 1
        where id = $1 returning receipt_sequence`, [schoolId]);
    const n = Number(seq.rows[0].receipt_sequence);
    const numero = `R-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
    // La facture retrouve son état réel — on le lit AVANT d'écrire le reçu de
    // contrepartie, qui doit porter ce que ce papier-là affirme.
    const i = await c.query(
      `select total_fcfa, montant_regle(id) as paye from invoices where id = $1`,
      [pay.invoice_id]);

    await c.query(
      `insert into receipts (school_id, payment_id, receipt_number, sequence,
                             amount_fcfa, total_du_fcfa, total_paye_fcfa)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [schoolId, contre.rows[0].id, numero, n, pay.amount_fcfa,
       Number(i.rows[0].total_fcfa), Number(i.rows[0].paye)]);
    const reste = Number(i.rows[0].total_fcfa) - Number(i.rows[0].paye);
    await c.query(
      `update invoices set status = $2 where id = $1`,
      [pay.invoice_id, reste <= 0 ? "soldee"
        : Number(i.rows[0].paye) > 0 ? "partielle" : "ouverte"]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values ($1,$2,'payment.reverse','payment',$3,$4)`,
      [schoolId, user.userId, paymentId,
       JSON.stringify({ montant: Number(pay.amount_fcfa), motif: raison,
                        recu: numero })]);

    return { ok: true, recu: numero, invoiceId: pay.invoice_id };
  });
}

/** Reçu imprimable, format A5 paysage — la moitié d'une feuille A4. */
export async function receiptPage(schoolId: string, number: string): Promise<string | null> {
  const d = await withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select rc.receipt_number, rc.amount_fcfa, rc.issued_at,
              -- L'état de la facture AU MOMENT DE CE REÇU, figé. Null pour un
              -- reçu antérieur à la migration 0018 : l'impression le dit.
              rc.total_du_fcfa as fige_du, rc.total_paye_fcfa as fige_paye,
              p.method, p.provider_ref, p.reverses_payment_id,
              p.reversal_reason,
              -- Le reçu qu'annule celui-ci, ou celui qui l'annule : un
              -- document remis à une famille doit dire lui-même s'il vaut
              -- encore, sinon deux papiers contradictoires circulent.
              (select rc2.receipt_number from receipts rc2
                where rc2.payment_id = p.reverses_payment_id) as annule_le_recu,
              (select rc3.receipt_number from receipts rc3
                 join payments p3 on p3.id = rc3.payment_id
                where p3.reverses_payment_id = p.id) as annule_par,
              i.reference, i.total_fcfa,
              st.last_name, st.first_names, st.matricule,
              cl.label as classe, s.name as ecole, s.commune,
              sf.full_name as encaisse_par,
              montant_regle(i.id) as paye
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

  /* CE QUE LE PAPIER AFFIRME NE BOUGE PAS.
   *
   * On lit ce qui a été figé à l'émission, jamais l'état actuel de la facture.
   * Sans cela, un reçu de 10 000 F réimprimé après le solde annonçait
   * « SCOLARITÉ SOLDÉE » sous le même numéro que le papier de la famille. */
  const restituable = d.fige_du !== null && d.fige_paye !== null;
  const totalDu = restituable ? Number(d.fige_du) : null;
  const totalPaye = restituable ? Number(d.fige_paye) : null;
  const reste = restituable ? (totalDu as number) - (totalPaye as number) : null;
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
<div class="recu"${d.annule_par ? ' style="opacity:.97"' : ""}>
  ${d.annule_par ? `<div style="border:2px solid #A8402A;color:#A8402A;padding:8px 14px;
      margin-bottom:10px;font-weight:700;font-size:10pt;letter-spacing:.04em">
      CE REÇU EST ANNULÉ — voir le reçu ${esc(d.annule_par)}</div>` : ""}
  ${d.annule_le_recu ? `<div style="border:2px solid #A8402A;color:#A8402A;padding:8px 14px;
      margin-bottom:10px;font-weight:700;font-size:10pt;letter-spacing:.04em">
      ANNULATION du reçu ${esc(d.annule_le_recu)}${d.reversal_reason
        ? ` — ${esc(d.reversal_reason)}` : ""}</div>` : ""}
  <div style="display:flex;justify-content:space-between;align-items:flex-start;
              padding-bottom:10px;border-bottom:2px solid #14161F">
    <div>
      <div style="font-size:9pt;font-weight:600">BURKINA FASO</div>
      <div style="font-size:7.5pt;font-style:italic;color:#4E5265">Unité — Progrès — Justice</div>
      <div style="font-size:11pt;font-weight:600;margin-top:8px">${esc(d.ecole.toUpperCase())}</div>
      <div style="font-size:8pt;color:#4E5265">${esc(d.commune ?? "")}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:18pt;font-weight:700">${d.annule_le_recu
        ? "ANNULATION" : "REÇU"}</div>
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
      <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#6B6F80">${
        d.annule_le_recu ? "Montant restitué" : "Montant reçu"}</div>
      <div class="num" style="font-size:30pt;font-weight:600;line-height:1.1${
        d.annule_le_recu ? ";color:#A8402A" : ""}">${d.annule_le_recu ? "− " : ""}${
        fcfa(d.amount_fcfa)} <span style="font-size:14pt">FCFA</span></div>
    </div>
    <div style="width:38%;border:1px solid #DCD8CF;padding:14px 18px;display:flex;flex-direction:column;gap:7px">
      ${restituable ? `
      <div style="display:flex;justify-content:space-between;font-size:9.5pt">
        <span style="color:#4E5265">Total dû</span><span class="num">${fcfa(totalDu)} F</span></div>
      <div style="display:flex;justify-content:space-between;font-size:9.5pt">
        <span style="color:#4E5265">Total payé</span><span class="num">${fcfa(totalPaye)} F</span></div>
      <div style="display:flex;justify-content:space-between;font-size:11pt;font-weight:600;
                  padding-top:7px;border-top:1px solid #DCD8CF">
        <span>Reste</span><span class="num">${fcfa(reste)} F</span></div>
      <div style="font-size:7pt;color:#6B6F80;line-height:1.35">
        Situation au jour de ce reçu. Elle ne change pas si la facture bouge
        ensuite.</div>`
      : `
      <div style="font-size:8.5pt;color:#4E5265;line-height:1.4">
        <b>Solde non restituable.</b><br>
        Ce reçu est antérieur à la mise à jour qui fige la situation du compte.
        Le montant reçu ci-contre fait foi ; pour le solde, voyez
        l'établissement.</div>`}
    </div>
  </div>

  <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end">
    <div style="font-size:8pt;color:#6B6F80">
      ${d.annule_par ? "Ce document ne vaut plus quittance."
        : reste === 0 ? "<b style='color:#3B6349;font-size:10pt'>SCOLARITÉ SOLDÉE</b>"
        : "Reçu à conserver."}
    </div>
    <div style="width:44%;border-top:1px solid #14161F;padding-top:5px;font-size:8.5pt;color:#4E5265">
      ${esc(d.encaisse_par ?? "L'économe")}
    </div>
  </div>
</div>
</body></html>`;
}
