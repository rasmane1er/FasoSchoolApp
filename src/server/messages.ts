/**
 * Suivi des messages aux familles.
 *
 * La deuxième promesse du logiciel — « la famille est prévenue le jour même de
 * l'absence » — n'était vraie qu'à moitié. Un message refusé par l'opérateur
 * était écrit dans `sms_messages` avec le statut `echoue`, et rien ne lisait
 * jamais ce statut : ni un écran, ni une requête, ni un point d'attention.
 * L'établissement croyait avoir prévenu. La famille n'avait rien reçu.
 *
 * CE QUI GUIDE CET ÉCRAN :
 *
 * 1. **Un échec n'est pas une ligne de journal, c'est une tâche.** Quelqu'un
 *    doit appeler la famille, corriger le numéro, ou renoncer en le sachant.
 *    Tant que personne ne l'a fait, l'échec reste ouvert et remonte au tableau
 *    de bord. Il ne s'efface pas avec le temps.
 *
 * 2. **Un renvoi n'écrase pas la tentative ratée.** Le registre est
 *    append-only, comme les reçus : la première tentative reste, avec sa
 *    raison et son heure. Une école qui doit prouver qu'elle a prévenu doit
 *    pouvoir montrer ce qu'elle a essayé, pas seulement ce qui a fini par
 *    marcher.
 *
 * 3. **« Appelée » est une issue de plein droit.** Au Burkina Faso, quand le
 *    SMS ne passe pas, on téléphone. Le logiciel doit pouvoir enregistrer ce
 *    geste-là, sinon la vie scolaire tient son vrai registre sur un cahier et
 *    l'écran ment.
 *
 * 4. **Un échec ne coûte rien.** Un message non parti n'est pas débité du
 *    crédit, et un renvoi qui échoue ne l'est pas davantage.
 */

import { withSchool } from "../lib/db.ts";
import { createSmsChannel } from "../lib/sms.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export type Resolution = "reessaye" | "appele" | "abandonne";

export const RESOLUTIONS: Array<[Resolution, string, string]> = [
  ["reessaye", "Renvoyé", "un second SMS a été tenté"],
  ["appele", "Famille appelée", "jointe par téléphone, hors du logiciel"],
  ["abandonne", "Abandonné", "renoncement assumé, tracé"],
];

/* `sans_objet` N'EST PAS DANS LA LISTE CI-DESSUS, ET C'EST VOULU.
 *
 * `RESOLUTIONS` sert à deux choses : dessiner les boutons de l'écran, et
 * valider ce qu'un POST a le droit de demander. `sans_objet` n'est ni l'un ni
 * l'autre — ce n'est pas un geste humain, c'est une constatation que le
 * logiciel fait tout seul quand l'absence annoncée a été corrigée. L'y mettre
 * donnerait à un agent le pouvoir de déclarer « il n'y avait rien à dire » sur
 * n'importe quelle tâche, ce qui est exactement la case cochée que ce registre
 * existe pour empêcher. Il lui faut donc un libellé, et rien d'autre. */
const LIBELLES: Record<string, string> = Object.fromEntries([
  ...RESOLUTIONS.map(([c, l]) => [c, l]),
  ["sans_objet", "Sans objet"],
]);

/** Les états qui demandent un geste. Un message `injoignable` n'a pas échoué
 *  chez l'opérateur : il n'a jamais eu de numéro à composer. */
export const EN_SOUFFRANCE = new Set(["echoue", "injoignable"]);

export type Filtre = "a_traiter" | "echecs" | "tous";

export interface Ligne {
  id: string;
  eleveId: string | null;
  eleve: string | null;
  tuteur: string | null;
  phone: string;
  body: string;
  status: string;
  raison: string | null;
  quand: string;
  resolution: Resolution | "sans_objet" | null;
  resoluLe: string | null;
  resoluPar: string | null;
  /** Ce message en dément un autre : voici l'heure de celui qu'il corrige. */
  corrige: string | null;
  /** Ce message a été démenti : voici l'heure du démenti. */
  dementiLe: string | null;
  /** …et si ce démenti est bien arrivé. Faux = la famille croit encore. */
  dementiRemis: boolean;
}

export interface Registre {
  lignes: Ligne[];
  aTraiter: number;
  echecsAujourdhui: number;
  envoyesAujourdhui: number;
  filtre: Filtre;
}

const heure = (d: Date | null) => d
  ? `${String(d.getDate()).padStart(2, "0")}/${
      String(d.getMonth() + 1).padStart(2, "0")} à ${
      String(d.getHours()).padStart(2, "0")}h${
      String(d.getMinutes()).padStart(2, "0")}`
  : "";

export async function loadRegistre(
  schoolId: string, filtre: Filtre = "a_traiter",
): Promise<Registre> {
  return withSchool(schoolId, async (c) => {
    /* `injoignable` compte comme `echoue` PARTOUT où la question est
     * « qui attend un geste ». Ce n'est pas le même geste — on ne renvoie
     * pas un message qui n'a pas de numéro — mais c'est la même attente :
     * une famille n'a pas été prévenue et quelqu'un doit s'en occuper. */
    const où = filtre === "a_traiter"
      ? "where m.status in ('echoue', 'injoignable') and m.resolution is null"
      : filtre === "echecs" ? "where m.status in ('echoue', 'injoignable')" : "";

    const r = await c.query(
      `select m.id, m.to_phone, m.body, m.status, m.error_detail, m.queued_at,
              m.resolution, m.resolved_at, m.student_id,
              st.first_names || ' ' || st.last_name as eleve,
              g.full_name as tuteur,
              rs.full_name as resolu_par,
              -- Les deux sens du démenti. Une école à qui l'on reproche
              -- d'avoir accusé un élève à tort doit pouvoir montrer les deux
              -- messages côte à côte, dans l'ordre, avec leurs heures.
              --
              -- dementi_de() et non une jointure : un démenti peut avoir
              -- été TENTÉ plusieurs fois (refusé, puis renvoyé), et une
              -- jointure dupliquerait alors la ligne d'origine dans le
              -- registre. La fonction rend celui qui est passé, sinon la
              -- dernière tentative — d'où le statut, qui décide entre
              -- « démenti à 08h10 » et « démenti NON remis ».
              orig.queued_at as corrige_le,
              (select d.queued_at from sms_messages d
                where d.id = dementi_de(m.id)) as dementi_le,
              (select d.status from sms_messages d
                where d.id = dementi_de(m.id)) as dementi_statut
         from sms_messages m
         left join sms_messages orig on orig.id = m.corrige_message_id
         left join students st on st.id = m.student_id
         left join guardians g on g.id = m.guardian_id
         left join staff sf on sf.id = m.resolved_by
         left join users rs on rs.id = sf.user_id
         ${où}
        order by (m.status in ('echoue', 'injoignable')
                    and m.resolution is null) desc,
                 m.queued_at desc
        limit 120`);

    const compte = await c.query(
      `select
         count(*) filter (
           where status in ('echoue', 'injoignable')
             and resolution is null)::int as a_traiter,
         count(*) filter (
           where status in ('echoue', 'injoignable')
             and queued_at::date = current_date)::int as echecs_jour,
         count(*) filter (
           where status = 'envoye' and queued_at::date = current_date)::int as envoyes_jour
       from sms_messages`);

    return {
      filtre,
      aTraiter: compte.rows[0].a_traiter,
      echecsAujourdhui: compte.rows[0].echecs_jour,
      envoyesAujourdhui: compte.rows[0].envoyes_jour,
      lignes: r.rows.map((x: any): Ligne => ({
        id: x.id, eleveId: x.student_id, eleve: x.eleve, tuteur: x.tuteur,
        phone: x.to_phone,
        body: x.body, status: x.status, raison: x.error_detail,
        quand: heure(x.queued_at), resolution: x.resolution,
        resoluLe: x.resolved_at ? heure(x.resolved_at) : null,
        resoluPar: x.resolu_par,
        corrige: x.corrige_le ? heure(x.corrige_le) : null,
        dementiLe: x.dementi_le ? heure(x.dementi_le) : null,
        dementiRemis: ["envoye", "livre"].includes(x.dementi_statut ?? ""),
      })),
    };
  });
}

export interface Issue { flash?: string; error?: string }

/**
 * Marquer ce qui a été fait d'un message non remis.
 *
 * On refuse de « résoudre » un message qui est parti : il n'y a rien à
 * résoudre, et laisser passer ce geste ferait d'une case cochée une preuve
 * qu'on a appelé une famille qu'on n'a jamais appelée.
 */
export async function resoudre(
  user: SessionUser, messageId: string, resolution: string,
): Promise<Issue> {
  if (!RESOLUTIONS.some(([code]) => code === resolution)) {
    return { error: "Issue inconnue." };
  }
  return withSchool(user.schoolId!, async (c) => {
    const m = await c.query(
      `select id, status, resolution from sms_messages where id = $1`, [messageId]);
    if (m.rowCount === 0) return { error: "Ce message n'existe pas." };
    if (!EN_SOUFFRANCE.has(m.rows[0].status)) {
      return { error: "Ce message est parti : il n'y a rien à traiter." };
    }
    if (m.rows[0].resolution) {
      return { error: "Ce message a déjà été traité. L'historique ne se réécrit pas." };
    }

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    await c.query(
      `update sms_messages
          set resolution = $2, resolved_at = now(), resolved_by = $3
        where id = $1`,
      [messageId, resolution, staff.rows[0]?.id ?? null]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'message.resolve', 'sms', $2, $3)`,
      [user.userId, messageId, JSON.stringify({ resolution })]);

    const libelle = RESOLUTIONS.find(([code]) => code === resolution)![1];
    return { flash: `Message marqué « ${libelle.toLowerCase()} ».` };
  });
}

/**
 * Renvoyer un message non remis.
 *
 * La tentative ratée n'est pas modifiée : elle est marquée « renvoyé » et une
 * NOUVELLE ligne porte la seconde tentative. Si celle-ci échoue aussi, elle
 * apparaît à son tour dans les messages à traiter — le problème ne disparaît
 * pas parce qu'on a cliqué dessus.
 */
export async function renvoyer(user: SessionUser, messageId: string): Promise<Issue> {
  const schoolId = user.schoolId!;
  const cible = await withSchool(schoolId, async (c) => {
    const m = await c.query(
      `select id, to_phone, body, segments, student_id, guardian_id, status,
              resolution, attendance_record_id, corrige_message_id
         from sms_messages where id = $1`, [messageId]);
    return m.rows[0] ?? null;
  });
  if (!cible) return { error: "Ce message n'existe pas." };
  /* On ne renvoie pas un message qui n'a jamais eu de numéro où aller.
   * Proposer « Renvoyer » ici serait un bouton qui ne peut pas marcher — et
   * pire, un bouton qui laisserait croire qu'on a réessayé. Le seul geste
   * qui change quelque chose est dans la fiche de l'élève. */
  if (cible.status === "injoignable") {
    return { error: "Ce message n'a pas de numéro où aller : il n'y en avait "
      + "aucun au dossier. Ajoutez-en un dans la fiche de l'élève — la "
      + "prochaine absence partira. En attendant, appelez la famille et "
      + "marquez-le ici." };
  }
  if (cible.status !== "echoue") {
    return { error: "Ce message est parti : il n'y a rien à renvoyer." };
  }
  if (cible.resolution) {
    return { error: "Ce message a déjà été traité. L'historique ne se réécrit pas." };
  }

  const sms = createSmsChannel();
  const r = await sms.send({ to: cible.to_phone, body: cible.body, schoolId,
                             studentId: cible.student_id ?? undefined });

  return withSchool(schoolId, async (c) => {
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);

    await c.query(
      /* LA SECONDE TENTATIVE EST LE MÊME MESSAGE, donc elle porte les mêmes
       * attaches : la ligne d'appel qui l'a provoquée, et — s'il s'agit d'un
       * démenti — ce qu'il dément. Sans ce report, renvoyer un démenti
       * fabriquait un message orphelin : l'écran cessait de dire que
       * l'annonce d'origine avait été corrigée, au moment précis où elle
       * venait enfin de l'être. */
      `insert into sms_messages (school_id, student_id, guardian_id, to_phone,
                                 body, segments, cost_fcfa, status, provider,
                                 provider_ref, error_detail, sent_at,
                                 attendance_record_id, corrige_message_id)
       values (current_school_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               case when $7 = 'envoye' then now() end, $11, $12)`,
      [cible.student_id, cible.guardian_id, cible.to_phone, cible.body,
       cible.segments, r.ok ? r.costFcfa : 0, r.ok ? "envoye" : "echoue",
       sms.name, r.providerRef ?? null,
       r.ok ? null : (r.error ?? "Refus de l'opérateur, sans détail"),
       cible.attendance_record_id, cible.corrige_message_id]);

    // La tentative ratée garde sa raison et son heure ; elle porte seulement
    // la trace qu'on s'en est occupé.
    await c.query(
      `update sms_messages
          set resolution = 'reessaye', resolved_at = now(), resolved_by = $2
        where id = $1`, [messageId, staff.rows[0]?.id ?? null]);

    if (r.ok) {
      await c.query(
        `insert into sms_credit_ledger (school_id, direction, messages,
                                        amount_fcfa, note)
         values (current_school_id(), 'consommation', 1, $1, 'Renvoi')`,
        [r.costFcfa]);
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'message.retry', 'sms', $2, $3)`,
      [user.userId, messageId, JSON.stringify({ abouti: r.ok })]);

    return r.ok
      ? { flash: "Renvoyé, et cette fois l'opérateur l'a accepté." }
      : { error: `Le renvoi a échoué lui aussi : ${
            r.error ?? "refus de l'opérateur"}. Il reparaît dans la liste à `
          + `traiter — appelez la famille, ou vérifiez le numéro auprès du `
          + `secrétariat.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

const FILTRES: Array<[Filtre, string]> = [
  ["a_traiter", "À traiter"],
  ["echecs", "Tous les échecs"],
  ["tous", "Tout le registre"],
];

const etat = (l: Ligne): string => {
  if (!EN_SOUFFRANCE.has(l.status)) {
    /* UN MESSAGE DÉMENTI RESTE « PARTI ». Il l'est : il a bien été remis, et
     * c'est tout le problème. On ne réécrit pas son état — le registre est
     * append-only — on dit à côté qu'un second message l'a corrigé. */
    if (l.dementiLe) {
      /* « Démenti à 08h10 » et « démenti NON remis » décrivent des situations
       * opposées : dans la première la famille sait, dans la seconde elle
       * croit encore son enfant absent. Écrire l'une pour l'autre serait pire
       * que de ne rien écrire. */
      return `<span class="pill p-ok">Parti</span>`
        + (l.dementiRemis
          ? `<span class="hint">démenti à ${esc(l.dementiLe)}</span>`
          : `<span class="hint" style="color:var(--laterite)">démenti NON remis`
            + ` — la famille croit encore</span>`);
    }
    if (l.corrige) {
      return `<span class="pill p-info">Démenti</span>`
        + `<span class="hint">corrige celui de ${esc(l.corrige)}</span>`;
    }
    return `<span class="pill p-ok">Parti</span>`;
  }
  if (!l.resolution) {
    // Deux mots différents, parce que ce sont deux gestes différents.
    return l.status === "injoignable"
      ? `<span class="pill p-bad">Sans numéro</span>`
      : `<span class="pill p-bad">Non remis</span>`;
  }
  const libelle = LIBELLES[l.resolution] ?? l.resolution;
  return `<span class="pill p-info">${esc(libelle)}</span>`
    + (l.resolution === "sans_objet"
      ? `<span class="hint">l'absence a été corrigée</span>` : "");
};

export async function messagesPage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const filtre = (url.searchParams.get("filtre") ?? "a_traiter") as Filtre;
  const r = await loadRegistre(user.schoolId!,
    FILTRES.some(([f]) => f === filtre) ? filtre : "a_traiter");

  const body = `
<div>
  <h1>Suivi des messages</h1>
  <p class="sub">Ce que les familles ont reçu, et surtout ce qu'elles n'ont pas
  reçu. Un message refusé par l'opérateur n'est pas un incident technique :
  c'est une famille qui n'a pas été prévenue. Un message « sans numéro » non
  plus — sauf que celui-là ne repartira jamais tant que la fiche de l'élève
  restera vide.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="tiles">
  <div class="tile"><div class="k">À traiter</div>
    <div class="v">${r.aTraiter}</div></div>
  <div class="tile"><div class="k">Partis aujourd'hui</div>
    <div class="v">${r.envoyesAujourdhui}</div></div>
  <div class="tile"><div class="k">Non remis aujourd'hui</div>
    <div class="v">${r.echecsAujourdhui}</div></div>
</div>

<p class="row" style="margin:20px 0 0">
  ${FILTRES.map(([f, l]) => f === r.filtre
    ? `<b>${l}</b>`
    : `<a href="/messages?filtre=${f}">${l}</a>`).join(`
  <span style="color:var(--faint)">·</span>`)}
</p>

${r.lignes.length === 0 ? `
<div class="note good">
  ${r.filtre === "a_traiter"
    ? "Aucun message en souffrance. Toutes les familles joignables ont reçu "
      + "ce qui leur était destiné, et aucune absence n'est restée sans "
      + "destinataire."
    : "Rien à afficher ici."}
</div>` : `
<div class="card">
  <header><b>${plural(r.lignes.length, "message")}</b>${
    r.filtre === "a_traiter"
      ? " — chacun demande un geste : renvoyer, appeler, ou renoncer en le disant"
      : ""}</header>
  <table>
    <thead><tr>
      <th>Quand</th><th>Élève</th><th>Famille</th><th>Numéro</th>
      <th>État</th><th>Raison</th><th></th>
    </tr></thead>
    <tbody>
      ${r.lignes.map((l) => `
      <tr>
        <td class="num">${esc(l.quand)}</td>
        <td>${l.eleveId
          // Le lien vers la fiche : c'est là que se corrige un numéro faux,
          // et c'est la seule chose que cet écran ne peut pas faire lui-même.
          ? `<a href="/eleve?id=${l.eleveId}">${esc(l.eleve ?? "la fiche")}</a>`
          : esc(l.eleve ?? "—")}
          <!-- Le texte du message, parce que « non remis » ne dit pas ce que
               la famille a manqué : une absence d'hier ou une réunion demain
               n'appellent pas la même urgence. -->
          <span class="dit">${esc(l.body.length > 96
            ? l.body.slice(0, 96) + "…" : l.body)}</span></td>
        <td>${esc(l.tuteur ?? "—")}</td>
        <td class="num">${l.phone
          ? esc(l.phone)
          : `<span class="hint">aucun au dossier</span>`}</td>
        <td>${etat(l)}</td>
        <td>${l.raison ? esc(l.raison) : ""}${
          l.resolution && l.resoluLe
            // `sans_objet` n'a pas d'auteur humain : le dire, plutôt que de
            // laisser un tiret flotter devant une heure.
            ? `<span class="hint">${esc(l.resoluPar
                ?? (l.resolution === "sans_objet"
                  ? "close par la correction de l'appel" : ""))} — ${
                esc(l.resoluLe)}</span>` : ""}</td>
        <td class="gestes">${EN_SOUFFRANCE.has(l.status) && !l.resolution ? `
          ${l.status === "injoignable" ? "" : `
          <form method="post" action="/messages/renvoyer">
            <input type="hidden" name="message" value="${l.id}">
            <button type="submit" class="btn ghost petit">Renvoyer</button>
          </form>`}
          ${RESOLUTIONS.filter(([c]) => c !== "reessaye").map(([c, lib]) => `
          <form method="post" action="/messages/resoudre">
            <input type="hidden" name="message" value="${l.id}">
            <input type="hidden" name="issue" value="${c}">
            <button type="submit" class="btn ghost petit">${esc(lib)}</button>
          </form>`).join("")}` : ""}</td>
      </tr>`).join("")}
    </tbody>
  </table>
</div>`}

<div class="note">
  <b>Ce que cet écran ne fait pas.</b> Il ne corrige pas les numéros : un
  numéro faux — ou absent — se répare dans la fiche de l'élève, au
  secrétariat, sinon le prochain message échouera pareil. Il ne rappelle pas non plus les familles à
  votre place — « appelée » est une déclaration humaine, et le logiciel la
  croit sur parole parce qu'il n'a aucun moyen de la vérifier.
</div>`;

  return page(chrome, "Suivi des messages", body);
}

/** Le compteur qu'attend le tableau de bord : combien de familles attendent. */
export async function messagesEnSouffrance(schoolId: string): Promise<number> {
  return withSchool(schoolId, async (c) =>
    Number((await c.query(
      `select count(*)::int as n from sms_messages
        where status in ('echoue', 'injoignable')
          and resolution is null`)).rows[0].n));
}
