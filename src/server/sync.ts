/**
 * Saisie hors-ligne des notes.
 *
 * Périmètre volontairement étroit. Un moteur de synchronisation générique sur
 * un schéma relationnel est un trimestre de travail et une source permanente
 * de bugs. Ce qu'il faut réellement, c'est qu'un enseignant saisisse quarante
 * notes sur un téléphone sans réseau et qu'elles arrivent intactes.
 *
 * Le mécanisme :
 *   1. la page /notes est mise en cache par le service worker ;
 *   2. hors ligne, chaque saisie part dans une file persistante (IndexedDB) ;
 *   3. au retour du réseau, la file est rejouée ; mutation_id rend le rejeu
 *      idempotent, donc un double envoi ne fait aucun mal ;
 *   4. le serveur n'écrase jamais en silence : si la cellule a bougé depuis
 *      que l'appareil l'a lue, il écrit une révision et signale au censeur.
 *
 * Une cellule de note a un propriétaire unique — l'enseignant de cette matière
 * dans cette classe — donc les vrais conflits sont rares. Et quand il y en a
 * un, une note contestée mérite un humain, pas un algorithme de fusion.
 */

import { withSchool } from "../lib/db.ts";
import { page, esc, fr, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

export interface Mutation {
  mutationId: string;
  deviceId: string;
  evaluationId: string;
  studentId: string;
  score: number | null;
  isAbsent: boolean;
  capturedAt: string;
  /** updated_at de la cellule au moment où l'appareil l'a lue. */
  baseUpdatedAt: string | null;
}

export interface SyncOutcome {
  mutationId: string;
  outcome: "applique" | "conflit" | "rejete" | "deja_applique";
  reason?: string;
}

const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function parseMutations(payload: unknown): Mutation[] {
  if (!payload || typeof payload !== "object") return [];
  const list = (payload as any).mutations;
  if (!Array.isArray(list)) return [];

  const out: Mutation[] = [];
  for (const m of list.slice(0, 500)) {
    if (!isUuid(m?.mutationId) || !isUuid(m?.evaluationId) || !isUuid(m?.studentId)) continue;
    const absent = m.isAbsent === true;
    let score: number | null = null;
    if (!absent) {
      const n = Number(m.score);
      if (m.score === null || m.score === undefined || m.score === "") score = null;
      /* Borne haute large à ce stade : le barème réel de l'évaluation n'est
         connu qu'en base, et `applyMutations` la contrôle une fois la ligne
         retrouvée — avec un MOTIF qui remonte à l'enseignant. Rejeter ici sans
         rien dire ferait disparaître sa saisie en silence, ce qui est
         exactement le défaut qu'on corrige. */
      else if (!Number.isFinite(n) || n < 0 || n > 100) continue;
      else score = Math.round(n * 100) / 100;
    }
    out.push({
      mutationId: m.mutationId, deviceId: String(m.deviceId ?? "inconnu").slice(0, 120),
      evaluationId: m.evaluationId, studentId: m.studentId,
      score, isAbsent: absent,
      capturedAt: typeof m.capturedAt === "string" ? m.capturedAt : new Date().toISOString(),
      baseUpdatedAt: typeof m.baseUpdatedAt === "string" ? m.baseUpdatedAt : null,
    });
  }
  return out;
}

export async function applyMutations(
  user: SessionUser, mutations: Mutation[],
): Promise<SyncOutcome[]> {
  const schoolId = user.schoolId!;
  if (mutations.length === 0) return [];

  return withSchool(schoolId, async (c) => {
    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;
    const results: SyncOutcome[] = [];

    for (const m of mutations) {
      // Idempotence : un rejeu de la file ne doit rien refaire.
      const seen = await c.query(
        `select outcome from sync_mutations where mutation_id = $1`, [m.mutationId]);
      if ((seen.rowCount ?? 0) > 0) {
        results.push({ mutationId: m.mutationId, outcome: "deja_applique" });
        continue;
      }

      /* L'évaluation doit appartenir à cet établissement — le RLS s'en charge —
         et son trimestre doit être ouvert. C'est le cas qui compte ici : une
         tablette restée hors ligne trois semaines revient avec des notes d'un
         trimestre entre-temps clôturé. Les accepter ferait bouger des bulletins
         déjà remis aux familles, sans que personne ne l'ait décidé. */
      const ev = await c.query(
        `select ev.id, t.status, coalesce(ev.bareme, 20) as bareme
           from evaluations ev
           join terms t on t.id = ev.term_id where ev.id = $1`, [m.evaluationId]);
      const inconnue = ev.rowCount === 0;
      const close = !inconnue && ev.rows[0].status !== "ouvert";
      // Hors barème : refusé AVEC son motif, jamais avalé en silence.
      const horsBareme = !inconnue && m.score !== null
        && Number(m.score) > Number(ev.rows[0].bareme);
      if (inconnue || close || horsBareme) {
        await c.query(
          `insert into sync_mutations (school_id, mutation_id, device_id, actor_id,
                                       entity_type, entity_id, operation, payload, outcome)
           values ($1,$2,$3,$4,'grade_entry',$5,'upsert',$6,'rejete')`,
          [schoolId, m.mutationId, m.deviceId, user.userId, m.studentId, JSON.stringify(m)]);
        results.push({
          mutationId: m.mutationId, outcome: "rejete",
          reason: inconnue
            ? "Évaluation inconnue."
            : close
              ? "Trimestre clôturé : cette note arrive trop tard. Voyez le censeur."
              : `Cette évaluation est notée sur ${ev.rows[0].bareme} : `
                + `${m.score} n'est pas une note possible.`,
        });
        continue;
      }

      const current = await c.query(
        `select id, score, is_absent, updated_at from grade_entries
          where evaluation_id = $1 and student_id = $2`,
        [m.evaluationId, m.studentId]);
      const existing = current.rows[0];

      // Divergence : la cellule a bougé depuis que l'appareil l'a lue.
      const diverged = existing && m.baseUpdatedAt
        && new Date(existing.updated_at).getTime() > new Date(m.baseUpdatedAt).getTime()
        && (Number(existing.score) !== m.score || existing.is_absent !== m.isAbsent);

      if (diverged) {
        await c.query(
          `insert into sync_mutations (school_id, mutation_id, device_id, actor_id,
                                       entity_type, entity_id, operation, payload, outcome)
           values ($1,$2,$3,$4,'grade_entry',$5,'upsert',$6,'conflit')`,
          [schoolId, m.mutationId, m.deviceId, user.userId, existing.id, JSON.stringify(m)]);
        await c.query(
          `insert into sync_conflicts (school_id, mutation_id, entity_type, entity_id,
                                       server_payload, device_payload)
           values ($1,$2,'grade_entry',$3,$4,$5)`,
          [schoolId, m.mutationId, existing.id,
           JSON.stringify({ score: existing.score, isAbsent: existing.is_absent,
                            updatedAt: existing.updated_at }),
           JSON.stringify({ score: m.score, isAbsent: m.isAbsent, capturedAt: m.capturedAt,
                            deviceId: m.deviceId })]);
        // On n'écrase pas. Le censeur tranchera.
        results.push({ mutationId: m.mutationId, outcome: "conflit" });
        continue;
      }

      /* D'OÙ PARLE CE CODE : une note remontée d'un appareil. Le déclencheur
       * `tracer_note()` lit ce réglage comme le RLS lit `school_id`. */
      await c.query(`select set_config('fasoschool.grade_source', 'offline', true)`);
      const up = await c.query(
        `insert into grade_entries (school_id, evaluation_id, student_id, score, is_absent,
                                    is_justified, mutation_id, device_id, recorded_by, updated_at)
         values ($1,$2,$3,$4,$5,false,$6,$7,$8, now())
         on conflict (evaluation_id, student_id) do update
           set score = excluded.score, is_absent = excluded.is_absent,
               mutation_id = excluded.mutation_id, device_id = excluded.device_id,
               recorded_by = excluded.recorded_by, updated_at = now()
         returning id`,
        [schoolId, m.evaluationId, m.studentId, m.score, m.isAbsent,
         m.mutationId, m.deviceId, staffId]);

      /* L'HISTOIRE N'EST PLUS ÉCRITE ICI. Elle l'était, et c'était justement le
       * défaut : deux chemins d'écriture sur trois la tenaient, et le
       * troisième — l'écran des notes, par lequel passe la quasi-totalité des
       * notes d'une année — ne la tenait pas. Le déclencheur `tracer_note()`
       * s'en charge désormais pour tous les chemins, y compris ceux qu'on
       * écrira l'an prochain. Le code ne fait plus que DIRE D'OÙ IL PARLE,
       * ci-dessus, comme il dit déjà de quel établissement il parle. */

      await c.query(
        `insert into sync_mutations (school_id, mutation_id, device_id, actor_id,
                                     entity_type, entity_id, operation, payload,
                                     outcome, applied_at)
         values ($1,$2,$3,$4,'grade_entry',$5,'upsert',$6,'applique', now())`,
        [schoolId, m.mutationId, m.deviceId, user.userId, up.rows[0].id, JSON.stringify(m)]);

      results.push({ mutationId: m.mutationId, outcome: "applique" });
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values ($1,$2,'sync.push','grade_entry',$3)`,
      [schoolId, user.userId, JSON.stringify({
        recues: mutations.length,
        appliquees: results.filter((r) => r.outcome === "applique").length,
        conflits: results.filter((r) => r.outcome === "conflit").length,
      })]);

    return results;
  });
}

export async function conflictCount(schoolId: string): Promise<number> {
  return withSchool(schoolId, async (c) =>
    Number((await c.query(
      `select count(*) as n from sync_conflicts where status = 'ouvert'`)).rows[0].n));
}

export async function conflictsPage(
  user: SessionUser, chrome: PageChrome, flash?: string,
): Promise<string> {
  const schoolId = user.schoolId!;
  const rows = await withSchool(schoolId, async (c) =>
    (await c.query(
      `-- borne: volontairement toutes les années. La liste part de
       -- sync_conflicts — des arbitrages OUVERTS, qui n'appartiennent à aucune
       -- année tant que personne ne les a tranchés — et ne joint grade_entries
       -- que pour nommer l'élève et la matière. Fermer sans arbitrer les
       -- conflits d'une année close serait perdre des notes.
       select sc.id, sc.server_payload, sc.device_payload, sc.created_at,
              st.last_name, st.first_names, sub.label as matiere,
              ev.eval_type, ev.label as eval_label, cl.label as classe
         from sync_conflicts sc
         join grade_entries ge on ge.id = sc.entity_id
         join evaluations ev on ev.id = ge.evaluation_id
         join subjects sub on sub.id = ev.subject_id
         join students st on st.id = ge.student_id
         left join classes cl on cl.id = ev.class_id
        where sc.status = 'ouvert'
        order by sc.created_at`)).rows);

  const body = rows.map((r: any) => {
    const s = r.server_payload, d = r.device_payload;
    const show = (v: any) => v.isAbsent || v.is_absent ? "absent" : fr(Number(v.score));
    return `<tr>
      <td><b>${esc(r.last_name)}</b> ${esc(r.first_names)}
        <div style="font-size:12px;color:var(--faint)">${esc(r.classe ?? "")} — ${esc(r.matiere)} — ${esc(r.eval_label ?? r.eval_type)}</div></td>
      <td class="num r" style="font-weight:600">${show(s)}</td>
      <td class="num r" style="font-weight:600;color:var(--indigo)">${show(d)}
        <div style="font-size:11.5px;color:var(--faint);font-family:var(--sans)">${esc(d.deviceId ?? "")}</div></td>
      <td class="r"><form method="post" action="/conflits" class="row" style="justify-content:flex-end;gap:6px">
        <input type="hidden" name="id" value="${esc(r.id)}">
        <button class="btn ghost" style="height:36px;padding:0 12px" name="choix" value="serveur" type="submit">Garder le serveur</button>
        <button class="btn" style="height:36px;padding:0 12px" name="choix" value="appareil" type="submit">Garder l'appareil</button>
      </form></td>
    </tr>`;
  }).join("");

  return page(chrome, "Conflits", `
    <div><h1>Notes divergentes</h1>
      <p style="margin:0;color:var(--muted)">Deux saisies de la même note ne concordent pas. Rien n'a été écrasé.</p></div>
    ${flash ? `<div class="ok">${esc(flash)}</div>` : ""}
    ${rows.length === 0
      ? `<div class="note good">Aucune divergence en attente.</div>`
      : `<div class="note warn">${plural(rows.length, "note demande", "notes demandent")} un arbitrage avant la clôture du trimestre.</div>
         <div class="card"><div class="scroll"><table>
           <thead><tr><th>Élève</th><th class="r">Sur le serveur</th><th class="r">Depuis l'appareil</th><th></th></tr></thead>
           <tbody>${body}</tbody>
         </table></div></div>`}`);
}

export async function resolveConflict(
  user: SessionUser, conflictId: string, choice: "serveur" | "appareil",
): Promise<string> {
  const schoolId = user.schoolId!;
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select entity_id, device_payload from sync_conflicts
        where id = $1 and status = 'ouvert'`, [conflictId]);
    if (r.rowCount === 0) return "Conflit déjà arbitré.";

    const staff = await c.query(`select id from staff where user_id = $1 limit 1`, [user.userId]);
    const staffId = staff.rows[0]?.id ?? null;

    if (choice === "appareil") {
      const d = r.rows[0].device_payload;
      /* D'OÙ PARLE CE CODE : un arbitrage de conflit par le censeur. */
      await c.query(`select set_config('fasoschool.grade_source', 'correction', true)`);
      await c.query(
        `update grade_entries set score = $2, is_absent = $3, updated_at = now()
          where id = $1`, [r.rows[0].entity_id, d.score, d.isAbsent === true]);
      /* Idem : c'est `tracer_note()` qui écrit, et la source a été déclarée
       * juste avant l'`update`. */
    }

    await c.query(
      `update sync_conflicts set status = $2, resolved_by = $3, resolved_at = now()
        where id = $1`,
      [conflictId, choice === "appareil" ? "resolu_appareil" : "resolu_serveur", staffId]);

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values ($1,$2,'sync.resolve','sync_conflict',$3,$4)`,
      [schoolId, user.userId, conflictId, JSON.stringify({ choix: choice })]);

    return choice === "appareil"
      ? "Valeur de l'appareil retenue. L'ancienne reste dans l'historique."
      : "Valeur du serveur conservée.";
  });
}
