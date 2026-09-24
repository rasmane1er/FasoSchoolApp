/**
 * Rentrée : l'année scolaire, ses trimestres, ses classes.
 *
 * Jusqu'ici tout cela se posait en base à la main. Un établissement ne pouvait
 * donc rien faire seul — ni importer ses élèves, ni ouvrir un carnet de notes.
 * C'est le premier écran de la vie d'un établissement dans le logiciel.
 *
 * Deux règles burkinabè sont câblées dans la validation, pas dans un commentaire :
 *
 * 1. **Les trimestres sont inégaux.** Le troisième est tronqué par la session
 *    d'examens : en anglais 6e/5e il fait 32 heures contre 44, en maths 6e il
 *    porte deux évaluations au lieu de trois. Ce sont donc trois couples de
 *    dates saisies. Si les trois durées sortent égales à quelques jours près,
 *    l'écran le signale : c'est presque toujours le signe que quelqu'un a
 *    divisé l'année par trois.
 *
 * 2. **Le calendrier est amendable par région.** Bobo-Dioulasso a clos
 *    2025-2026 le 30 mai au lieu du 15 juillet pour la Semaine nationale de la
 *    culture. Les dates de fin ne sont donc jamais déduites d'une constante.
 */

import { withSchool, sansDoublon } from "../lib/db.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** « 12/03/2026 » ou « 2026-03-12 » → « 2026-03-12 ». Rien d'autre n'est accepté. */
export function toIso(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const fr = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  let y: number, m: number, d: number;
  if (iso) { y = +iso[1]!; m = +iso[2]!; d = +iso[3]!; }
  else if (fr) { d = +fr[1]!; m = +fr[2]!; y = +fr[3]!; }
  else return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export const jour = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
};

const days = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86400e3);

export const semaines = (a: string, b: string): number =>
  Math.max(0, Math.round(days(a, b) / 7));

// ---------------------------------------------------------------------------
// Validation d'un calendrier
// ---------------------------------------------------------------------------

export interface TermInput { sequence: number; startsOn: string; endsOn: string }

export interface CalendarCheck { errors: string[]; warnings: string[] }

/**
 * Vérifie une année et ses trimestres. Les erreurs empêchent l'enregistrement ;
 * les avertissements ne font que rendre visible ce qui est probablement une
 * erreur de saisie.
 */
export function checkCalendar(
  yearStart: string, yearEnd: string, terms: TermInput[],
): CalendarCheck {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (days(yearStart, yearEnd) <= 0) {
    errors.push("L'année se termine avant d'avoir commencé.");
    return { errors, warnings };
  }
  const longueur = days(yearStart, yearEnd);
  // Une année régionale raccourcie est légitime — Bobo-Dioulasso a clos
  // 2025-2026 fin mai pour la SNC. On ne signale que l'invraisemblable.
  if (longueur < 150) {
    warnings.push(`Année de ${Math.round(longueur / 7)} semaines seulement : vérifiez les dates.`);
  }
  if (longueur > 400) errors.push("Une année scolaire ne peut pas dépasser treize mois.");

  const ordered = [...terms].sort((a, b) => a.sequence - b.sequence);
  for (const t of ordered) {
    const n = t.sequence;
    if (days(t.startsOn, t.endsOn) <= 0) {
      errors.push(`Trimestre ${n} : la fin précède le début.`);
      continue;
    }
    if (days(yearStart, t.startsOn) < 0 || days(t.endsOn, yearEnd) < 0) {
      errors.push(`Trimestre ${n} : hors des bornes de l'année.`);
    }
    if (semaines(t.startsOn, t.endsOn) < 4) {
      errors.push(`Trimestre ${n} : moins de quatre semaines.`);
    }
  }

  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!, cur = ordered[i]!;
    if (days(prev.endsOn, cur.startsOn) < 0) {
      errors.push(`Trimestres ${prev.sequence} et ${cur.sequence} se chevauchent.`);
    }
  }

  if (errors.length === 0 && ordered.length === 3) {
    const d = ordered.map((t) => days(t.startsOn, t.endsOn));
    const ecart = Math.max(...d) - Math.min(...d);
    if (ecart <= 3) {
      warnings.push(
        "Les trois trimestres ont la même durée. Au Burkina le troisième est "
        + "tronqué par la session d'examens — vérifiez que ces dates sont bien "
        + "celles du calendrier de l'établissement, et non l'année divisée en trois.");
    }
    if (d[2]! > d[0]! && d[2]! > d[1]!) {
      warnings.push("Le troisième trimestre est le plus long : c'est inhabituel.");
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export interface YearRow {
  id: string; label: string; startsOn: string; endsOn: string; status: string;
}
export interface TermRow extends TermInput { id: string; status: string }
export interface ClassRow {
  id: string; label: string; levelCode: string; levelLabel: string;
  seriesCode: string | null; effectif: number; cycle: string;
}

const isoOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/**
 * `nouvelle` distingue « montre-moi une année vierge » de « montre-moi l'année
 * en cours ». Sans cette distinction, l'écran de création préremplit l'année
 * ouverte, et l'enregistrement la RENOMME au lieu d'en créer une autre —
 * emportant avec elle ses trimestres, ses classes et ses élèves.
 */
export async function loadYear(schoolId: string, yearId?: string, nouvelle = false) {
  return withSchool(schoolId, async (c) => {
    const ys = await c.query(
      `select id, label, starts_on, ends_on, status from academic_years
        order by starts_on desc`);
    const years: YearRow[] = ys.rows.map((r) => ({
      id: r.id, label: r.label, startsOn: isoOf(r.starts_on),
      endsOn: isoOf(r.ends_on), status: r.status,
    }));
    const current = nouvelle
      ? null
      : years.find((y) => y.id === yearId)
        ?? years.find((y) => y.status === "en_cours")
        ?? years[0] ?? null;

    let terms: TermRow[] = [];
    let classes: ClassRow[] = [];
    if (current) {
      const ts = await c.query(
        `select id, sequence, starts_on, ends_on, status from terms
          where academic_year_id = $1 order by sequence`, [current.id]);
      terms = ts.rows.map((r) => ({
        id: r.id, sequence: r.sequence, startsOn: isoOf(r.starts_on),
        endsOn: isoOf(r.ends_on), status: r.status,
      }));

      const cs = await c.query(
        `select cl.id, cl.label, cl.level_code, cl.series_code, lv.label as niveau,
                lv.cycle, lv.ordinal,
                (select count(*)::int from enrolments e
                  where e.class_id = cl.id and e.academic_year_id = cl.academic_year_id)
                  as effectif
           from classes cl join levels lv on lv.code = cl.level_code
          where cl.academic_year_id = $1
          order by lv.ordinal, cl.letter nulls first, cl.label`, [current.id]);
      classes = cs.rows.map((r) => ({
        id: r.id, label: r.label, levelCode: r.level_code, levelLabel: r.niveau,
        seriesCode: r.series_code, effectif: r.effectif, cycle: r.cycle,
      }));
    }

    const levels = (await c.query(
      `select code, label, cycle from levels order by ordinal`)).rows;
    const series = (await c.query(
      `select code, label from series order by code`)).rows;

    return { years, current, terms, classes, levels, series };
  });
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export async function saveYear(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string; yearId?: string }> {
  const schoolId = user.schoolId!;
  const label = (form.get("libelle") ?? "").trim();
  const start = toIso(form.get("debut") ?? "");
  const end = toIso(form.get("fin") ?? "");

  if (!label) return { error: "Donnez un libellé à l'année, par exemple « 2026-2027 »." };
  if (!start || !end) return { error: "Dates illisibles. Écrivez-les 01/10/2026." };

  const terms: TermInput[] = [1, 2, 3].map((n) => ({
    sequence: n,
    startsOn: toIso(form.get(`t${n}_debut`) ?? "") ?? "",
    endsOn: toIso(form.get(`t${n}_fin`) ?? "") ?? "",
  })).filter((t) => t.startsOn && t.endsOn);

  if (terms.length !== 3) {
    return { error: "Les trois trimestres doivent porter une date de début et une date de fin." };
  }

  const verdict = checkCalendar(start, end, terms);
  if (verdict.errors.length > 0) return { error: verdict.errors.join(" ") };

  const yearId = form.get("annee") || null;

  return withSchool(schoolId, async (c) => {
    let id: string;
    if (yearId) {
      const autre = await c.query(
        `select 1 from academic_years where label = $1 and id <> $2`, [label, yearId]);
      if (autre.rowCount! > 0) {
        return { error: `Une autre année porte déjà le libellé « ${label} ».`, yearId };
      }
      const up = await c.query(
        `update academic_years set label = $2, starts_on = $3::date, ends_on = $4::date
          where id = $1 returning id`, [yearId, label, start, end]);
      if (up.rowCount === 0) return { error: "Année introuvable." };
      id = up.rows[0].id;
    } else {
      const ins = await c.query(
        `insert into academic_years (school_id, label, starts_on, ends_on, status)
         values (current_school_id(), $1, $2::date, $3::date, 'planifiee')
         on conflict (school_id, label) do update set
           starts_on = excluded.starts_on, ends_on = excluded.ends_on
         returning id`, [label, start, end]);
      id = ins.rows[0].id;
    }

    for (const t of terms) {
      await c.query(
        `insert into terms (school_id, academic_year_id, sequence, starts_on, ends_on)
         values (current_school_id(), $1, $2, $3::date, $4::date)
         on conflict (academic_year_id, sequence) do update
           set starts_on = excluded.starts_on, ends_on = excluded.ends_on`,
        [id, t.sequence, t.startsOn, t.endsOn]);
    }

    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'year.save', 'academic_year', $2, $3)`,
      [user.userId, id, JSON.stringify({ label, start, end })]);

    const suite = verdict.warnings.length
      ? " " + verdict.warnings.join(" ")
      : "";
    return { flash: `Calendrier de ${label} enregistré.${suite}`, yearId: id };
  });
}

/** Une seule année peut être en cours : ouvrir celle-ci referme les autres. */
export async function openYear(
  user: SessionUser, yearId: string,
): Promise<{ flash?: string; error?: string }> {
  const schoolId = user.schoolId!;
  return withSchool(schoolId, async (c) => {
    const y = await c.query(`select label from academic_years where id = $1`, [yearId]);
    if (y.rowCount === 0) return { error: "Année introuvable." };
    const t = await c.query(
      `select count(*)::int as n from terms where academic_year_id = $1`, [yearId]);
    if (t.rows[0].n < 3) {
      return { error: "Saisissez les trois trimestres avant d'ouvrir l'année." };
    }
    await c.query(`update academic_years set status = 'close' where status = 'en_cours'`);
    await c.query(`update academic_years set status = 'en_cours' where id = $1`, [yearId]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id)
       values (current_school_id(), $1, 'year.open', 'academic_year', $2)`,
      [user.userId, yearId]);
    return { flash: `L'année ${y.rows[0].label} est ouverte.` };
  });
}

export async function addClass(
  user: SessionUser, form: URLSearchParams,
): Promise<{ flash?: string; error?: string }> {
  const schoolId = user.schoolId!;
  const yearId = form.get("annee") ?? "";
  const level = (form.get("niveau") ?? "").trim();
  const letter = (form.get("lettre") ?? "").trim().toUpperCase().slice(0, 3) || null;
  const seriesCode = (form.get("serie") ?? "").trim() || null;

  if (!yearId || !level) return { error: "Choisissez une année et un niveau." };

  /* LA LECTURE DIT « existe déjà » ; LA BASE LE REFUSE. Dix clics simultanés
   * créaient six « 6e Z » : six avaient lu avant qu'aucune n'ait écrit. La
   * garde en lecture reste — elle rend le bon message sans faire échouer une
   * transaction — et `sansDoublon` rattrape les gestes qui se croisent malgré
   * elle, avec LE MÊME message : à qui l'on répond « erreur », on ne dit pas
   * si son geste est passé, et il recommence. */
  return sansDoublon("Cette classe existe déjà.", () =>
    withSchool(schoolId, async (c) => {
    const lv = await c.query(`select code, label, cycle from levels where code = $1`, [level]);
    if (lv.rowCount === 0) return { error: "Niveau inconnu." };

    // La série ne s'assigne qu'au secondaire : le point de séparation C/D n'est
    // pas fixé nationalement, on l'autorise donc de la 2nde à la Tle.
    const cycle = lv.rows[0].cycle;
    const serie = cycle === "secondaire" ? seriesCode : null;
    if (seriesCode && cycle !== "secondaire") {
      return { error: "Une série ne s'attribue qu'en seconde, première ou terminale." };
    }

    // Usage burkinabè : « 6e A » au post-primaire, « Tle D1 » au secondaire —
    // la lettre ou le chiffre se colle à la série, il ne s'en sépare pas.
    const court = shortLevel(level);
    const label = serie
      ? `${court} ${serie}${letter ?? ""}`
      : [court, letter].filter(Boolean).join(" ");

    const exists = await c.query(
      `select 1 from classes where academic_year_id = $1 and label = $2`, [yearId, label]);
    if (exists.rowCount! > 0) return { error: `La classe ${label} existe déjà.` };

    await c.query(
      `insert into classes (school_id, academic_year_id, level_code, series_code, letter, label)
       values (current_school_id(), $1, $2, $3, $4, $5)`,
      [yearId, level, serie, letter, label]);
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, detail)
       values (current_school_id(), $1, 'class.create', 'class', $2)`,
      [user.userId, JSON.stringify({ label })]);
      return { flash: `Classe ${label} créée.` };
    }));
}

/** « 6E » → « 6e », « TLE » → « Tle », « CP1 » → « CP1 ». */
export function shortLevel(code: string): string {
  if (code === "TLE") return "Tle";
  if (code === "1ERE") return "1re";
  if (code === "2NDE") return "2nde";
  if (/^\dE$/.test(code)) return code[0] + "e";
  return code;
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function rentreePage(
  user: SessionUser, chrome: PageChrome, yearId: string | undefined,
  flash?: string, error?: string, nouvelle = false,
): Promise<string> {
  const { years, current, terms, classes, levels, series } =
    await loadYear(user.schoolId!, yearId, nouvelle);

  const t = (n: number) => terms.find((x) => x.sequence === n);
  const champ = (name: string, value: string, label: string) =>
    `<label for="${name}">${esc(label)}</label>
     <input type="text" id="${name}" name="${name}" value="${esc(value)}"
            placeholder="jj/mm/aaaa" inputmode="numeric">`;

  const verdict = current && terms.length === 3
    ? checkCalendar(current.startsOn, current.endsOn,
        terms.map((x) => ({ sequence: x.sequence, startsOn: x.startsOn, endsOn: x.endsOn })))
    : null;

  const totalEleves = classes.reduce((s, k) => s + k.effectif, 0);

  const body = `
<div>
  <h1>Année scolaire</h1>
  <p class="sub">Le calendrier de l'établissement et ses classes. Tout le reste
  — les notes, l'appel, la scolarité — s'y rattache.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

${years.length > 1 ? `<div class="row">
  ${years.map((y) => `<a class="btn ${y.id === current?.id ? "" : "ghost"}"
    href="/annee?annee=${y.id}">${esc(y.label)}${
      y.status === "en_cours" ? " ·  en cours" : ""}</a>`).join("")}
</div>` : ""}

<div class="card">
  <header>
    <b>${current ? esc(current.label) : "Nouvelle année"}</b>
    ${current ? `<span class="pill ${current.status === "en_cours" ? "p-ok" : "p-info"}">${
      esc(current.status === "en_cours" ? "en cours"
        : current.status === "close" ? "close" : "planifiée")}</span>` : ""}
    <div class="grow"></div>
    ${current && current.status !== "en_cours" ? `
      <form method="post" action="/annee/ouvrir" style="margin:0">
        <input type="hidden" name="annee" value="${current.id}">
        <button class="btn" type="submit">Ouvrir cette année</button>
      </form>` : ""}
  </header>

  <form method="post" action="/annee" class="body">
    <input type="hidden" name="annee" value="${current?.id ?? ""}">
    <div class="trois">
      <div><label for="libelle">Libellé</label>
        <input type="text" id="libelle" name="libelle"
               value="${esc(current?.label ?? "")}" placeholder="2026-2027"></div>
      <div>${champ("debut", current ? jour(current.startsOn) : "", "Début de l'année")}</div>
      <div>${champ("fin", current ? jour(current.endsOn) : "", "Fin de l'année")}</div>
    </div>

    <p class="hint" style="margin-top:16px">Les trois trimestres sont
    <b>inégaux</b> : le troisième est tronqué par la session d'examens. Saisissez
    les dates réelles du calendrier de l'établissement — ne divisez pas l'année
    en trois.</p>

    <table style="margin-top:8px">
      <thead><tr><th>Trimestre</th><th>Début</th><th>Fin</th><th>Durée</th></tr></thead>
      <tbody>
        ${[1, 2, 3].map((n) => {
          const x = t(n);
          return `<tr>
            <td><b>T${n}</b></td>
            <td><input type="text" name="t${n}_debut" placeholder="jj/mm/aaaa"
                       value="${x ? esc(jour(x.startsOn)) : ""}" style="max-width:150px"></td>
            <td><input type="text" name="t${n}_fin" placeholder="jj/mm/aaaa"
                       value="${x ? esc(jour(x.endsOn)) : ""}" style="max-width:150px"></td>
            <td class="num">${x ? plural(semaines(x.startsOn, x.endsOn), "semaine", "semaines") : "—"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>

    ${verdict && verdict.warnings.length ? verdict.warnings.map((w) =>
      `<div class="note warn" style="margin-top:14px">${esc(w)}</div>`).join("") : ""}

    <div class="row" style="margin-top:18px">
      <button type="submit" class="btn">Enregistrer le calendrier</button>
      ${current ? `<a class="btn ghost" href="/annee?nouvelle=1">Créer une autre année</a>` : ""}
    </div>
  </form>
</div>

${current ? `
<div class="card">
  <header>
    <b>Classes</b>
    <span style="color:var(--muted);font-size:13px">
      ${plural(classes.length, "classe", "classes")} ·
      ${plural(totalEleves, "élève", "élèves")}</span>
  </header>

  ${classes.length ? `<table>
    <thead><tr><th>Classe</th><th>Niveau</th><th>Série</th><th class="r">Effectif</th></tr></thead>
    <tbody>
      ${classes.map((k) => `<tr>
        <td><b>${esc(k.label)}</b></td>
        <td>${esc(k.levelLabel)}</td>
        <td>${k.seriesCode ? esc(k.seriesCode) : "—"}</td>
        <td class="r num">${k.effectif}</td>
      </tr>`).join("")}
    </tbody>
  </table>` : `<div class="body"><p class="hint" style="margin:0">Aucune classe.
    Créez-en une pour pouvoir inscrire des élèves.</p></div>`}

  <form method="post" action="/annee/classe" class="body" style="border-top:1px solid var(--rule)">
    <input type="hidden" name="annee" value="${current.id}">
    <div class="trois">
      <div><label for="niveau">Niveau</label>
        <select id="niveau" name="niveau">
          ${levels.map((l: any) => `<option value="${esc(l.code)}">${esc(l.label)}</option>`).join("")}
        </select></div>
      <div><label for="lettre">Lettre</label>
        <input type="text" id="lettre" name="lettre" placeholder="A, B, C…" maxlength="3"></div>
      <div><label for="serie">Série (secondaire)</label>
        <select id="serie" name="serie">
          <option value="">— aucune —</option>
          ${series.map((s: any) => `<option value="${esc(s.code)}">${esc(s.label)}</option>`).join("")}
        </select></div>
    </div>
    <div class="row" style="margin-top:16px">
      <button type="submit" class="btn ghost">Ajouter la classe</button>
    </div>
  </form>
</div>` : ""}`;

  return page(chrome, "Année scolaire", body);
}
