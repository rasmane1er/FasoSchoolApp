/**
 * Le registre de discipline.
 *
 * `behavior_incidents` dormait dans le schéma depuis le premier jour. Le
 * surveillant général — celui qui, dans un établissement burkinabè, tient le
 * cahier de discipline, convoque les parents et décide des exclusions
 * temporaires — n'avait dans ce logiciel que l'appel du matin.
 *
 * QUATRE CHOSES DÉCIDENT DE LA QUALITÉ DE CET ÉCRAN :
 *
 * 1. **L'EXCLUSION DÉFINITIVE N'APPARTIENT PAS AU SURVEILLANT.** Elle relève
 *    du conseil de discipline, présidé par le chef d'établissement. Un
 *    logiciel qui la met dans la même liste déroulante que « avertissement »
 *    déplace un pouvoir réel d'une personne à une autre, en silence. Elle est
 *    donc refusée à qui n'est pas chef d'établissement, sur le chemin
 *    d'écriture et pas seulement dans l'affichage.
 *
 * 2. **La famille est prévenue le jour même.** Une exclusion temporaire que
 *    les parents découvrent le soir, c'est un enfant dehors trois jours sans
 *    que personne le sache. Le SMS passe par le même tuyau que les absences,
 *    donc par le même suivi : si l'opérateur refuse, cela remonte dans les
 *    messages à traiter au lieu de disparaître.
 *
 * 3. **On n'efface pas un incident, on le retire en le disant.** Une trace
 *    écrite sur un enfant est lue au conseil de classe et pèse sur un passage.
 *    Elle doit pouvoir être réparée — on se trompe d'élève, on écrit sous le
 *    coup de la colère — mais rien ne doit disparaître en silence : effacer
 *    détruit aussi ce qui pouvait servir EN FAVEUR de l'élève. Un incident
 *    retiré reste écrit, barré, avec le nom de qui l'a retiré et pourquoi.
 *
 * 4. **Une description est obligatoire, une sanction ne l'est pas.** Beaucoup
 *    de faits se consignent sans être punis, et c'est précisément ce registre
 *    qui permet de dire, au conseil, qu'un élève a été signalé quatre fois
 *    sans qu'on ait jamais rien fait.
 */

import { withSchool } from "../lib/db.ts";
import { createSmsChannel, countSegments, renderTemplate,
         COST_PER_SEGMENT_FCFA } from "../lib/sms.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

/** code, libellé, qui peut la prononcer, ce qu'elle veut dire. */
export const SANCTIONS: Array<[string, string, "chef" | "vie_scolaire", string]> = [
  ["", "Aucune — fait consigné", "vie_scolaire",
   "le fait est noté, rien n'est puni"],
  ["avertissement", "Avertissement", "vie_scolaire", ""],
  ["blame", "Blâme", "vie_scolaire", ""],
  ["convocation_parents", "Convocation des parents", "vie_scolaire", ""],
  ["travail_interet_general", "Travail d'intérêt général", "vie_scolaire", ""],
  ["exclusion_temporaire", "Exclusion temporaire", "vie_scolaire",
   "la famille doit être prévenue le jour même"],
  ["exclusion_definitive", "Exclusion définitive", "chef",
   "relève du conseil de discipline, présidé par le chef d'établissement"],
];

const LIBELLE = new Map(SANCTIONS.map(([c, l]) => [c, l]));

export function estChef(user: SessionUser): boolean {
  const r = new Set([...user.roles, user.fonction ?? ""]);
  return r.has("proviseur") || r.has("directeur");
}

/** Les sanctions que CET utilisateur peut prononcer. */
export function sanctionsPour(user: SessionUser) {
  return SANCTIONS.filter(([, , qui]) => qui !== "chef" || estChef(user));
}

export interface Incident {
  id: string;
  studentId: string;
  eleve: string;
  classe: string | null;
  date: string;
  description: string;
  sanction: string | null;
  sanctionLabel: string | null;
  parQui: string | null;
  retire: boolean;
  retirePar: string | null;
  motifRetrait: string | null;
}

const jour = (d: Date | string | null): string => {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d) : d;
  return `${String(t.getDate()).padStart(2, "0")}/${
    String(t.getMonth() + 1).padStart(2, "0")}/${t.getFullYear()}`;
};

/** Un élève qui revient dans le registre, et ce qu'on en a fait. */
export interface Recurrent {
  studentId: string;
  eleve: string;
  classe: string | null;
  faits: number;
  sansSuite: number;
  dernier: string;
}

export interface Registre {
  incidents: Incident[];
  classes: Array<{ id: string; label: string }>;
  eleves: Array<{ id: string; nom: string }>;
  classId: string | null;
  ouverts: number;
  recurrents: Recurrent[];
}

/**
 * À partir de combien de faits un élève « revient » dans le registre.
 *
 * Deux, parce qu'un second fait est déjà une répétition, et parce que c'est
 * un REPÈRE DE LECTURE et non un seuil réglementaire : rien ne se déclenche à
 * ce nombre, aucune sanction ne s'y attache, il décide seulement de ce qui
 * remonte en haut de l'écran. Le registre lui-même reste entier en dessous.
 */
export const SEUIL_RECURRENCE = 2;

export async function loadRegistre(
  schoolId: string, classId: string | null,
): Promise<Registre> {
  return withSchool(schoolId, async (c) => {
    const y = await c.query(
      `select id from academic_years
        order by (status='en_cours') desc, starts_on desc limit 1`);
    const yearId = y.rows[0]?.id ?? null;

    const classes = yearId
      ? (await c.query(
          `select cl.id, cl.label from classes cl
             join levels lv on lv.code = cl.level_code
            where cl.academic_year_id = $1 order by lv.ordinal, cl.label`,
          [yearId])).rows
      : [];
    const choisie = classId && classes.some((k: any) => k.id === classId)
      ? classId : (classes[0]?.id ?? null);

    const eleves = choisie
      ? (await c.query(
          `select st.id, st.last_name || ' ' || st.first_names as nom
             from enrolments e join students st on st.id = e.student_id
            where e.class_id = $1 order by st.last_name, st.first_names`,
          [choisie])).rows
      : [];

    const r = await c.query(
      `select bi.id, bi.student_id, bi.occurred_on, bi.description,
              bi.sanction, bi.retracted_at, bi.retraction_reason,
              st.last_name || ' ' || st.first_names as eleve,
              cl.label as classe,
              auteur.full_name as par_qui,
              retire.full_name as retire_par
         from behavior_incidents bi
         join students st on st.id = bi.student_id
         left join enrolments e on e.student_id = st.id
                               and e.academic_year_id = $1
         left join classes cl on cl.id = e.class_id
         left join staff sa on sa.id = bi.recorded_by
         left join users auteur on auteur.id = sa.user_id
         left join staff sr on sr.id = bi.retracted_by
         left join users retire on retire.id = sr.user_id
        where dans_l_annee(bi.occurred_on, $1)
        order by bi.occurred_on desc, bi.created_at desc
        limit 120`, [yearId]);

    /* CE QUI REVIENT, PAR ÉLÈVE — ET CETTE ANNÉE, comme le titre le promet.
     *
     * La carte s'intitulait « signalé plusieurs fois CETTE ANNÉE » et
     * imprimait, dans sa colonne de droite, « dernier le 16/10/2024 ». La même
     * ligne se contredisait, et personne ne lit la colonne de droite quand le
     * titre a déjà répondu.
     *
     * La borne d'année était pourtant écrite — dans le ON de la jointure
     * externe vers `enrolments`, où elle décide de la classe affichée et de
     * rien d'autre. Même piège qu'en 0023, second module. La voici en clair,
     * sur la table qui porte la date.
     *
     * CE QUI REVIENT, PAR ÉLÈVE.
     *
     * Le registre est une liste chronologique de cent vingt lignes. Pour y
     * voir qu'un élève a été signalé quatre fois, il faut compter des noms à
     * la main sur une page entière — personne ne le fait. Or c'est exactement
     * ce que l'en-tête de ce fichier dit que le registre sert à montrer, et la
     * seule chose qu'il ne montrait pas.
     *
     * `sans_suite` compte les faits consignés SANS AUCUNE sanction. Ce n'est
     * pas une charge de plus contre l'élève : c'est ce que l'établissement n'a
     * pas fait, en face de ce qu'il a écrit. */
    const rec = await c.query(
      `select bi.student_id,
              st.last_name || ' ' || st.first_names as eleve,
              cl.label as classe,
              count(*)::int as faits,
              count(*) filter (where coalesce(bi.sanction, '') = '')::int as sans_suite,
              max(bi.occurred_on) as dernier
         from behavior_incidents bi
         join students st on st.id = bi.student_id
         left join enrolments e on e.student_id = st.id
                               and e.academic_year_id = $1
         left join classes cl on cl.id = e.class_id
        where bi.retracted_at is null
          and dans_l_annee(bi.occurred_on, $1)
        group by bi.student_id, st.last_name, st.first_names, cl.label
       having count(*) >= $2
        order by count(*) filter (where coalesce(bi.sanction, '') = '') desc,
                 count(*) desc, st.last_name`,
      [yearId, SEUIL_RECURRENCE]);

    return {
      classes, eleves, classId: choisie,
      ouverts: r.rows.filter((x: any) => !x.retracted_at).length,
      recurrents: rec.rows.map((x: any): Recurrent => ({
        studentId: x.student_id, eleve: x.eleve, classe: x.classe,
        faits: x.faits, sansSuite: x.sans_suite, dernier: jour(x.dernier),
      })),
      incidents: r.rows.map((x: any): Incident => ({
        id: x.id, studentId: x.student_id, eleve: x.eleve, classe: x.classe,
        date: jour(x.occurred_on), description: x.description,
        sanction: x.sanction,
        sanctionLabel: x.sanction ? (LIBELLE.get(x.sanction) ?? x.sanction) : null,
        parQui: x.par_qui, retire: Boolean(x.retracted_at),
        retirePar: x.retire_par, motifRetrait: x.retraction_reason,
      })),
    };
  });
}

export interface Issue { flash?: string; error?: string; classId?: string }

export async function consigner(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const schoolId = user.schoolId!;
  const studentId = form.get("eleve") ?? "";
  const classId = form.get("classe") || undefined;
  const description = (form.get("description") ?? "").trim().replace(/\s+/g, " ");
  const sanction = (form.get("sanction") ?? "").trim();
  const dateRaw = (form.get("date") ?? "").trim();
  const prevenir = form.get("sms") === "1";

  if (!studentId) return { classId, error: "Choisissez l'élève." };
  /* Une longueur ne suffit pas : « Indiscipline » fait douze caractères et ne
     dit rien. Ce qu'on exige, c'est une PHRASE — un fait, avec un verbe. Une
     étiquette d'un ou deux mots n'est opposable à personne, ni au conseil de
     classe ni à l'élève. */
  const mots = description.split(/\s+/).filter((m) => m.length > 1);
  if (mots.length < 4 || description.length < 15) {
    return { classId, error: "Décrivez le fait en une phrase : ce qui s'est "
      + "passé, où, et quand. Une étiquette comme « indiscipline » ne dit rien "
      + "à celui qui lira ce registre au conseil de classe, ni à l'élève à qui "
      + "on l'oppose." };
  }
  if (sanction && !SANCTIONS.some(([code]) => code === sanction)) {
    return { classId, error: "Cette sanction n'existe pas." };
  }
  // Le contrôle est ici, sur le chemin d'écriture : une liste déroulante
  // filtrée ne protège personne.
  if (sanction === "exclusion_definitive" && !estChef(user)) {
    return { classId, error: "L'exclusion définitive relève du conseil de "
      + "discipline, présidé par le chef d'établissement. Consignez le fait, "
      + "proposez une exclusion temporaire si elle s'impose, et saisissez le "
      + "chef d'établissement." };
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
    ? dateRaw : new Date().toISOString().slice(0, 10);

  return withSchool(schoolId, async (c) => {
    const st = await c.query(
      `select st.id, st.first_names from students st where st.id = $1`, [studentId]);
    if (st.rowCount === 0) return { classId, error: "Cet élève n'existe pas." };

    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    const term = await c.query(
      `select t.id from terms t
         join academic_years a on a.id = t.academic_year_id
        where $1::date between t.starts_on and t.ends_on
        order by (a.status = 'en_cours') desc limit 1`, [date]);

    const inc = await c.query(
      `insert into behavior_incidents (school_id, student_id, term_id,
                                       occurred_on, description, sanction,
                                       recorded_by)
       values (current_school_id(), $1, $2, $3, $4, $5, $6) returning id`,
      [studentId, term.rows[0]?.id ?? null, date, description,
       sanction || null, staff.rows[0]?.id ?? null]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'discipline.record', 'student', $2, $3)`,
      [user.userId, studentId, JSON.stringify({ sanction: sanction || null, date })]);

    let suite = "";
    if (prevenir) suite = await previenFamille(c, schoolId, studentId,
      st.rows[0].first_names, sanction, date);

    return { classId, flash: `Fait consigné${sanction
      ? ` — ${(LIBELLE.get(sanction) ?? sanction).toLowerCase()}` : ""}.${suite}` };
  });
}

/**
 * Prévenir la famille, par le même tuyau que les absences.
 *
 * Donc avec le même suivi : un refus de l'opérateur remonte dans les messages
 * à traiter au lieu de disparaître. Une exclusion que les parents découvrent
 * le soir, c'est un enfant dehors sans que personne le sache.
 */
async function previenFamille(
  c: any, schoolId: string, studentId: string, prenom: string,
  sanction: string, date: string,
): Promise<string> {
  const g = await c.query(
    `select g.id as gid, g.phone from student_guardians sg
       join guardians g on g.id = sg.guardian_id
      where sg.student_id = $1 and sg.receives_sms
        and g.phone is not null and g.phone <> ''
      order by sg.is_primary desc limit 1`, [studentId]);
  if (g.rowCount === 0) {
    return " Aucun numéro joignable : prévenez la famille autrement, et"
      + " corrigez le numéro dans la fiche de l'élève.";
  }

  const ecole = await c.query(`select name from schools limit 1`);
  const corps = renderTemplate(
    "{{ecole}}: {{eleve}} a fait l'objet d'une mesure de discipline le "
    + "{{date}}{{quoi}}. Merci de passer a l'etablissement.",
    { ecole: ecole.rows[0]?.name ?? "", eleve: prenom,
      date: jour(date),
      quoi: sanction ? ` (${(LIBELLE.get(sanction) ?? sanction).toLowerCase()})` : "" });

  const sms = createSmsChannel();
  const r = await sms.send({ to: g.rows[0].phone, body: corps, schoolId, studentId });
  const segments = countSegments(corps);
  await c.query(
    `insert into sms_messages (school_id, student_id, guardian_id, to_phone,
                               body, segments, cost_fcfa, status, provider,
                               provider_ref, error_detail, sent_at)
     values (current_school_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             case when $7 = 'envoye' then now() end)`,
    [studentId, g.rows[0].gid, g.rows[0].phone, corps, segments,
     r.ok ? segments * COST_PER_SEGMENT_FCFA : 0,
     r.ok ? "envoye" : "echoue", sms.name, r.providerRef ?? null,
     r.ok ? null : (r.error ?? "Refus de l'opérateur, sans détail")]);

  if (r.ok) {
    await c.query(
      `insert into sms_credit_ledger (school_id, direction, messages,
                                      amount_fcfa, note)
       values (current_school_id(), 'consommation', 1, $1, 'Discipline')`,
      [segments * COST_PER_SEGMENT_FCFA]);
    return " La famille est prévenue par SMS.";
  }
  return " Le SMS à la famille n'est PAS parti : il attend dans le suivi des"
    + " messages. Appelez-la.";
}

/**
 * Retirer un incident.
 *
 * Il reste écrit et barré. Effacer une trace détruit aussi ce qui pouvait
 * servir en faveur de l'élève, et un registre qu'on peut vider ne prouve plus
 * rien à personne.
 */
export async function retirer(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const id = form.get("incident") ?? "";
  const classId = form.get("classe") || undefined;
  const motif = (form.get("motif") ?? "").trim().replace(/\s+/g, " ");
  if (motif.length < 8) {
    return { classId, error: "Dites pourquoi cet incident est retiré : c'est "
      + "ce que lira, plus tard, celui qui se demandera pourquoi la ligne est "
      + "barrée." };
  }
  return withSchool(user.schoolId!, async (c) => {
    const i = await c.query(
      `select id, retracted_at from behavior_incidents where id = $1`, [id]);
    if (i.rowCount === 0) return { classId, error: "Cet incident n'existe pas." };
    if (i.rows[0].retracted_at) {
      return { classId, error: "Cet incident est déjà retiré." };
    }
    const staff = await c.query(
      `select id from staff where user_id = $1 limit 1`, [user.userId]);
    await c.query(
      `update behavior_incidents
          set retracted_at = now(), retracted_by = $2, retraction_reason = $3
        where id = $1`, [id, staff.rows[0]?.id ?? null, motif]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'discipline.retract', 'incident', $2, $3)`,
      [user.userId, id, JSON.stringify({ motif })]);
    return { classId, flash: "Incident retiré. Il reste au registre, barré, "
      + "avec votre nom et votre motif." };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function disciplinePage(
  user: SessionUser, chrome: PageChrome, url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const r = await loadRegistre(user.schoolId!, url.searchParams.get("classe"));
  const permises = sanctionsPour(user);
  const chef = estChef(user);
  const aujourdhui = new Date().toISOString().slice(0, 10);

  const body = `
<div class="row">
  <div class="grow">
    <h1>Registre de discipline</h1>
    <p class="sub">Ce qui a été consigné, par qui, et ce qui a été décidé. Le
    registre sert au conseil de classe — et il sert aussi à montrer qu'un élève
    a été signalé quatre fois sans que rien n'ait été fait.</p>
  </div>
  <form method="get" action="/discipline">
    <select name="classe" data-envoi-auto style="width:auto">
      ${r.classes.map((k) => `<option value="${k.id}"${
        k.id === r.classId ? " selected" : ""}>${esc(k.label)}</option>`).join("")}
    </select>
    <noscript><button class="btn ghost" type="submit">Afficher</button></noscript>
  </form>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="card">
  <header><b>Consigner un fait</b></header>
  <form method="post" action="/discipline" class="body">
    <input type="hidden" name="classe" value="${esc(r.classId ?? "")}">
    <div class="trois">
      <div><label for="eleve">Élève</label>
        <select id="eleve" name="eleve">
          ${r.eleves.map((e: any) => `<option value="${e.id}">${esc(e.nom)}</option>`).join("")}
        </select></div>
      <div><label for="date">Date du fait</label>
        <input type="date" id="date" name="date" value="${aujourdhui}"
          style="height:44px;padding:0 12px;border:1px solid var(--line);border-radius:5px;width:100%"></div>
      <div><label for="sanction">Suite donnée</label>
        <select id="sanction" name="sanction">
          ${permises.map(([c, l]) => `<option value="${c}">${l}</option>`).join("")}
        </select></div>
    </div>
    <div style="margin-top:14px">
      <label for="description">Le fait</label>
      <textarea id="description" name="description" rows="2"
        placeholder="A quitté le cours de mathématiques sans autorisation et a répondu au professeur."></textarea>
      <p class="hint">Écrivez ce qui s'est passé, pas un jugement : un fait,
      avec un verbe. Une étiquette comme « indiscipline » ne dit rien à celui
      qui lira ce registre au conseil, ni à l'élève à qui on l'oppose.${chef ? "" : " L'exclusion définitive relève "
        + "du conseil de discipline : elle n'est pas dans cette liste."}</p>
    </div>
    <p class="row" style="margin-top:14px">
      <label style="text-transform:none;letter-spacing:0;margin:0">
        <input type="checkbox" name="sms" value="1" style="width:auto;height:auto">
        Prévenir la famille par SMS</label>
      <button type="submit" class="btn">Consigner</button>
    </p>
  </form>
</div>

${r.recurrents.length === 0 ? "" : `
<div class="card">
  <header><b>Ce qui revient</b> — ${plural(r.recurrents.length,
    "élève signalé plusieurs fois", "élèves signalés plusieurs fois")}
    cette année</header>
  <div class="scroll"><table>
    <thead><tr><th>Élève</th><th class="r">Faits</th><th>Suites données</th>
      <th class="num">Dernier</th></tr></thead>
    <tbody>${r.recurrents.map((x) => `
      <tr>
        <td><a href="/eleve?id=${x.studentId}">${esc(x.eleve)}</a>
          <span class="dit">${esc(x.classe ?? "")}</span></td>
        <td class="num r">${x.faits}</td>
        <td>${x.sansSuite === 0
          // Tout a reçu une suite : le dossier est celui d'une école qui a
          // réagi. On le dit, sinon l'absence de mention se lit comme un
          // reproche par défaut.
          ? `<span class="pill p-ok">toutes</span>`
          : x.sansSuite === x.faits
            // Le cas que l'en-tête de ce fichier nomme depuis le premier jour.
            // Pas de pastille rouge : ce n'est pas une charge contre l'élève.
            ? `<span class="pill p-info">aucune</span>
               <span class="dit">${x.faits} fois signalé, rien n'a été
               décidé</span>`
            : `<span class="pill p-info">${x.faits - x.sansSuite} sur ${
                 x.faits}</span>
               <span class="dit">${x.sansSuite} ${x.sansSuite > 1
                 ? "faits sont restés" : "fait est resté"} sans suite</span>`
        }</td>
        <td class="num">${esc(x.dernier)}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>
  <div class="body" style="padding-top:0">
    <p class="hint">Un élève signalé quatre fois avec quatre convocations et un
    élève signalé quatre fois sans aucune suite ne sont pas le même dossier —
    et dans la liste chronologique ci-dessous, il fallait compter des noms à la
    main pour les distinguer. « Aucune suite » ne dit rien de plus contre
    l'élève : c'est ce que l'établissement n'a pas fait, écrit en face de ce
    qu'il a consigné. Le conseil de classe voit désormais la même chose.</p>
  </div>
</div>`}

${r.incidents.length === 0 ? `
<div class="note good">Le registre est vide pour cette année.</div>` : `
<div class="card">
  <header><b>${plural(r.ouverts, "fait consigné", "faits consignés")}</b>${
    r.incidents.length > r.ouverts
      ? ` — et ${plural(r.incidents.length - r.ouverts, "retiré", "retirés")}`
      : ""}</header>
  <div class="scroll"><table>
    <thead><tr><th>Date</th><th>Élève</th><th>Le fait</th><th>Suite</th>
      <th>Consigné par</th><th></th></tr></thead>
    <tbody>${r.incidents.map((i) => `
      <tr${i.retire ? ' class="pale"' : ""}>
        <td class="num">${esc(i.date)}</td>
        <td><a href="/eleve?id=${i.studentId}">${esc(i.eleve)}</a>
          <span class="dit">${esc(i.classe ?? "")}</span></td>
        <td style="max-width:34ch">${i.retire
          ? `<s>${esc(i.description)}</s>` : esc(i.description)}
          ${i.retire ? `<span class="dit bad">Retiré par ${
            esc(i.retirePar ?? "—")} — ${esc(i.motifRetrait ?? "")}</span>` : ""}</td>
        <td>${i.sanctionLabel
          ? `<span class="pill ${i.sanction === "exclusion_definitive"
              ? "p-bad" : "p-warn"}">${esc(i.sanctionLabel)}</span>`
          : `<span class="pill p-info">Consigné</span>`}</td>
        <td>${esc(i.parQui ?? "—")}</td>
        <td class="gestes">${i.retire ? "" : `
          <form method="post" action="/discipline/retirer" class="row">
            <input type="hidden" name="incident" value="${i.id}">
            <input type="hidden" name="classe" value="${esc(r.classId ?? "")}">
            <input type="text" name="motif" placeholder="Motif du retrait"
                   style="width:auto;height:34px;font-size:13px" required>
            <button type="submit" class="btn ghost petit">Retirer</button>
          </form>`}</td>
      </tr>`).join("")}
    </tbody>
  </table></div>
  <div class="body" style="padding-top:0">
    <p class="hint">On n'efface pas un incident : effacer une trace détruit
    aussi ce qui pouvait servir en faveur de l'élève, et un registre qu'on peut
    vider ne prouve plus rien à personne. Un fait retiré reste écrit, barré,
    avec le nom de qui l'a retiré et son motif.</p>
  </div>
</div>`}`;

  return page(chrome, "Discipline", body);
}

/** Le nombre de faits retenus contre un élève sur un trimestre. */
export async function faitsDe(
  schoolId: string, studentId: string, termId: string | null,
): Promise<number> {
  return withSchool(schoolId, async (c) =>
    Number((await c.query(
      `select count(*)::int as n from behavior_incidents
        where student_id = $1 and retracted_at is null
          and ($2::uuid is null or term_id = $2)`,
      [studentId, termId])).rows[0].n));
}
