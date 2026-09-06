/**
 * Le personnel de l'établissement.
 *
 * C'est le premier geste d'une installation — avant l'année scolaire, avant
 * les classes, avant les élèves. Il n'existait pas : seule `scripts/demo.ts`
 * créait des comptes, et un établissement réel devait ouvrir psql pour
 * inscrire son propre proviseur.
 *
 * CE QUI COMPTE ICI, ET POURQUOI :
 *
 * 1. **Créer un compte, c'est donner accès à tout l'établissement.** Le geste
 *    appartient donc au chef d'établissement seul. Un censeur qui pourrait
 *    ajouter du personnel pourrait se nommer proviseur ; le contrôle est dans
 *    la route, et la suite le force avec un POST fabriqué à la main.
 *
 * 2. **Le numéro de téléphone EST l'identifiant de connexion.** Deux comptes
 *    ne peuvent pas le partager, sinon l'un des deux ne se connecte jamais et
 *    personne ne comprend pourquoi. Huit chiffres, préfixe burkinabè.
 *
 * 3. **On n'efface personne.** Un membre du personnel porte des notes, des
 *    reçus, des décisions de conseil. Le supprimer arracherait le nom au bas
 *    d'un bulletin déjà remis. On le désactive : son compte ne s'ouvre plus,
 *    ses sessions en cours tombent, et tout ce qu'il a signé reste signé.
 *
 * 4. **Le dernier chef d'établissement ne peut pas être écarté.** Ni
 *    désactivé, ni rétrogradé. Sans lui, plus personne ne gère le personnel et
 *    il n'existe aucune console pour rattraper l'erreur : l'établissement
 *    serait fermé à clé. La règle est aussi en base (`chefs_en_exercice`).
 */

import { withSchool } from "../lib/db.ts";
import { normalizePhone } from "../lib/roster.ts";
import { page, esc, plural, type PageChrome } from "./html.ts";
import type { SessionUser } from "./session.ts";

/**
 * Les fonctions d'un établissement burkinabè. La fonction porte le rôle du
 * même nom : deux notions parallèles feraient un écran où l'on est
 * « enseignant » sans pouvoir saisir de notes.
 */
export const FONCTIONS: Array<[string, string, string]> = [
  ["directeur", "Directeur", "chef d'établissement — tout, y compris le personnel"],
  ["proviseur", "Proviseur", "chef d'établissement — tout, y compris le personnel"],
  ["censeur", "Censeur", "notes, bulletins, conseil, règles de notation"],
  ["surveillant_general", "Surveillant général", "appel, absences, suivi des messages"],
  ["enseignant", "Enseignant", "ses classes et ses matières, et rien d'autre"],
  ["econome", "Économe", "frais, factures, encaissement, bourses"],
  ["intendant", "Intendant", "frais, factures, encaissement"],
  ["secretaire", "Secrétaire", "inscriptions, transferts, suivi des messages"],
  ["chef_des_travaux", "Chef des travaux", "consultation"],
  ["autre", "Autre", "aucun droit — un compte pour figurer à l'organigramme"],
];

const LIBELLE = new Map(FONCTIONS.map(([c, l]) => [c, l]));
const CHEFS = new Set(["proviseur", "directeur"]);

export interface Membre {
  staffId: string;
  userId: string | null;
  nom: string;
  phone: string | null;
  fonction: string;
  fonctionLabel: string;
  actif: boolean;
  chef: boolean;
  /** Ce qu'il perdrait si on l'écartait : classes suivies, notes posées. */
  services: number;
  notes: number;
}

export interface Personnel {
  membres: Membre[];
  chefsEnExercice: number;
}

export async function loadPersonnel(schoolId: string): Promise<Personnel> {
  return withSchool(schoolId, async (c) => {
    const r = await c.query(
      `select st.id as staff_id, st.user_id, st.full_name, st.fonction,
              st.is_active and coalesce(u.is_active, false) as actif,
              u.phone,
              (select count(*)::int from teacher_assignments ta
                where ta.staff_id = st.id) as services,
              (select count(*)::int from grade_entries ge
                where ge.recorded_by = st.id) as notes
         from staff st
         left join users u on u.id = st.user_id
        order by st.is_active desc, st.full_name`);

    const chefs = Number((await c.query(
      `select chefs_en_exercice() as n`)).rows[0].n);

    return {
      chefsEnExercice: chefs,
      membres: r.rows.map((x: any): Membre => ({
        staffId: x.staff_id, userId: x.user_id, nom: x.full_name,
        phone: x.phone, fonction: x.fonction,
        fonctionLabel: LIBELLE.get(x.fonction) ?? x.fonction,
        actif: x.actif, chef: CHEFS.has(x.fonction),
        services: x.services, notes: x.notes,
      })),
    };
  });
}

export interface Issue { flash?: string; error?: string }

function valider(nom: string, tel: string, fonction: string): string | null {
  if (!nom || nom.length < 3) {
    return "Donnez le nom complet, tel qu'il figurera au bas d'un bulletin.";
  }
  if (!FONCTIONS.some(([code]) => code === fonction)) {
    return "Cette fonction n'existe pas dans un établissement burkinabè.";
  }
  const p = normalizePhone(tel);
  if (!p.phone) {
    return p.problem
      ? `Le ${p.problem}. C'est ce numéro qui servira à se connecter.`
      : "Le numéro de téléphone est obligatoire : c'est l'identifiant de "
        + "connexion, il n'y a pas de mot de passe.";
  }
  return null;
}

export async function ajouterMembre(
  user: SessionUser, form: URLSearchParams,
): Promise<Issue> {
  const nom = (form.get("nom") ?? "").trim().replace(/\s+/g, " ");
  const tel = (form.get("telephone") ?? "").trim();
  const fonction = (form.get("fonction") ?? "").trim();

  const faute = valider(nom, tel, fonction);
  if (faute) return { error: faute };
  const phone = normalizePhone(tel).phone as string;

  return withSchool(user.schoolId!, async (c) => {
    // Le numéro est unique en base, mais un refus de contrainte affiche une
    // erreur SQL ; le dire ici permet de nommer la personne déjà inscrite.
    const dejala = await c.query(
      `select full_name from users where phone = $1`, [phone]);
    if (dejala.rowCount) {
      return { error: `Le ${phone} est déjà celui de ${
        dejala.rows[0].full_name}. Un numéro ouvre un seul compte : `
        + `à deux, l'un des deux ne se connecterait jamais.` };
    }

    const u = await c.query(
      `insert into users (school_id, full_name, phone)
       values (current_school_id(), $1, $2) returning id`, [nom, phone]);
    const st = await c.query(
      `insert into staff (school_id, user_id, full_name, fonction)
       values (current_school_id(), $1, $2, $3) returning id`,
      [u.rows[0].id, nom, fonction]);

    // « Autre » ne porte aucun rôle : c'est un compte d'organigramme, et lui
    // donner un rôle vide serait plus trompeur que de n'en donner aucun.
    if (fonction !== "autre") {
      await c.query(
        `insert into user_roles (user_id, role_code, school_id)
         values ($1, $2, current_school_id())
         on conflict do nothing`, [u.rows[0].id, fonction]);
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'staff.create', 'staff', $2, $3)`,
      [user.userId, st.rows[0].id, JSON.stringify({ fonction, phone })]);

    return { flash: `${nom} peut se connecter avec le ${phone}. `
      + `Aucun mot de passe : un code à usage unique arrive par SMS.` };
  });
}

/**
 * Changer la fonction de quelqu'un.
 *
 * Rétrograder le dernier chef d'établissement est refusé pour la même raison
 * que le désactiver : l'établissement se retrouverait sans personne pour
 * gérer le personnel.
 */
export async function changerFonction(
  user: SessionUser, staffId: string, fonction: string,
): Promise<Issue> {
  if (!FONCTIONS.some(([code]) => code === fonction)) {
    return { error: "Cette fonction n'existe pas." };
  }
  return withSchool(user.schoolId!, async (c) => {
    const st = await c.query(
      `select id, user_id, full_name, fonction from staff where id = $1`, [staffId]);
    if (st.rowCount === 0) return { error: "Ce membre du personnel n'existe pas." };
    const avant = st.rows[0];
    if (avant.fonction === fonction) {
      return { error: `${avant.full_name} occupe déjà cette fonction.` };
    }

    if (CHEFS.has(avant.fonction) && !CHEFS.has(fonction)) {
      const restants = Number((await c.query(
        `select chefs_en_exercice($1) as n`, [staffId])).rows[0].n);
      if (restants === 0) {
        return { error: "C'est le dernier chef d'établissement en exercice. "
          + "Le rétrograder fermerait l'établissement à clé : plus personne ne "
          + "pourrait gérer le personnel. Nommez d'abord son successeur." };
      }
    }

    await c.query(`update staff set fonction = $2 where id = $1`, [staffId, fonction]);
    if (avant.user_id) {
      await c.query(
        `delete from user_roles where user_id = $1 and role_code = $2`,
        [avant.user_id, avant.fonction]);
      if (fonction !== "autre") {
        await c.query(
          `insert into user_roles (user_id, role_code, school_id)
           values ($1, $2, current_school_id()) on conflict do nothing`,
          [avant.user_id, fonction]);
      }
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, 'staff.role', 'staff', $2, $3)`,
      [user.userId, staffId, JSON.stringify({ de: avant.fonction, vers: fonction })]);

    return { flash: `${avant.full_name} est désormais ${
      (LIBELLE.get(fonction) ?? fonction).toLowerCase()}.` };
  });
}

/**
 * Écarter quelqu'un, ou le réintégrer.
 *
 * Jamais une suppression : ses notes, ses reçus et ses décisions de conseil
 * portent son nom, et l'effacer arracherait la signature au bas d'un bulletin
 * déjà remis. La désactivation révoque en outre ses sessions ouvertes — sans
 * quoi il continuerait de travailler depuis son téléphone jusqu'à expiration.
 */
export async function basculerActivite(
  user: SessionUser, staffId: string, actif: boolean,
): Promise<Issue> {
  return withSchool(user.schoolId!, async (c) => {
    const st = await c.query(
      `select st.id, st.user_id, st.full_name, st.fonction, st.is_active
         from staff st where st.id = $1`, [staffId]);
    if (st.rowCount === 0) return { error: "Ce membre du personnel n'existe pas." };
    const m = st.rows[0];

    if (!actif) {
      if (m.user_id === user.userId) {
        return { error: "Vous ne pouvez pas vous désactiver vous-même : "
          + "l'écran se refermerait sur vous au clic suivant." };
      }
      const restants = Number((await c.query(
        `select chefs_en_exercice($1) as n`, [staffId])).rows[0].n);
      if (CHEFS.has(m.fonction) && restants === 0) {
        return { error: "C'est le dernier chef d'établissement en exercice. "
          + "L'écarter fermerait l'établissement à clé : plus personne ne "
          + "pourrait gérer le personnel, et il n'existe aucune console pour "
          + "rattraper l'erreur." };
      }
    }

    await c.query(`update staff set is_active = $2 where id = $1`, [staffId, actif]);
    if (m.user_id) {
      await c.query(`update users set is_active = $2 where id = $1`,
        [m.user_id, actif]);
      if (!actif) {
        // Un compte fermé dont la session vit encore n'est pas fermé.
        await c.query(
          `update auth_sessions set revoked_at = now()
            where user_id = $1 and revoked_at is null`, [m.user_id]);
      }
    }
    await c.query(
      `insert into audit_log (school_id, actor_id, action, target_type, target_id, detail)
       values (current_school_id(), $1, $2, 'staff', $3, $4)`,
      [user.userId, actif ? "staff.reinstate" : "staff.deactivate", staffId,
       JSON.stringify({ fonction: m.fonction })]);

    return { flash: actif
      ? `${m.full_name} peut de nouveau se connecter.`
      : `${m.full_name} n'a plus accès. Ses sessions ouvertes sont fermées, et `
        + `tout ce qu'il a signé reste signé.` };
  });
}

// ---------------------------------------------------------------------------
// Écran
// ---------------------------------------------------------------------------

export async function personnelPage(
  user: SessionUser, chrome: PageChrome, _url: URL,
  flash?: string, error?: string,
): Promise<string> {
  const p = await loadPersonnel(user.schoolId!);
  const actifs = p.membres.filter((m) => m.actif);
  const ecartes = p.membres.filter((m) => !m.actif);

  const ligne = (m: Membre) => `
    <tr${m.actif ? "" : ' class="pale"'}>
      <td><b>${esc(m.nom)}</b>${m.services || m.notes ? `
        <span class="dit">${[
          m.services ? plural(m.services, "service") : "",
          m.notes ? plural(m.notes, "note posée", "notes posées") : "",
        ].filter(Boolean).join(", ")}</span>` : ""}</td>
      <td class="num">${esc(m.phone ?? "—")}</td>
      <td>${m.actif ? `
        <form method="post" action="/personnel/fonction" class="row">
          <input type="hidden" name="membre" value="${m.staffId}">
          <select name="fonction" style="width:auto;height:34px">
            ${FONCTIONS.map(([c, l]) => `<option value="${c}"${
              c === m.fonction ? " selected" : ""}>${l}</option>`).join("")}
          </select>
          <button type="submit" class="btn ghost petit">Changer</button>
        </form>` : esc(m.fonctionLabel)}</td>
      <td class="gestes">
        <form method="post" action="/personnel/activite">
          <input type="hidden" name="membre" value="${m.staffId}">
          <input type="hidden" name="actif" value="${m.actif ? "0" : "1"}">
          <button type="submit" class="btn ghost petit">${
            m.actif ? "Écarter" : "Réintégrer"}</button>
        </form></td>
    </tr>`;

  const body = `
<div>
  <h1>Le personnel</h1>
  <p class="sub">Qui travaille ici, et ce que chacun peut ouvrir. Un compte se
  crée avec un numéro de téléphone : il n'y a pas de mot de passe, un code à
  usage unique arrive par SMS à chaque connexion.</p>
</div>

${error ? `<div class="note bad">${esc(error)}</div>` : ""}
${flash ? `<div class="note good">${esc(flash)}</div>` : ""}

<div class="card">
  <header><b>Ajouter quelqu'un</b></header>
  <form method="post" action="/personnel" class="body">
    <div class="trois">
      <div><label for="nom">Nom complet</label>
        <input type="text" id="nom" name="nom" placeholder="OUEDRAOGO Awa"
               autocomplete="off"></div>
      <div><label for="telephone">Téléphone</label>
        <input type="tel" id="telephone" name="telephone" placeholder="70 12 34 56"
               autocomplete="off"></div>
      <div><label for="fonction">Fonction</label>
        <select id="fonction" name="fonction">
          ${FONCTIONS.map(([c, l]) => `<option value="${c}"${
            c === "enseignant" ? " selected" : ""}>${l}</option>`).join("")}
        </select></div>
    </div>
    <p class="hint">La fonction décide de ce que la personne voit. Un
    enseignant ne voit que les classes et les matières qui lui sont attribuées
    dans la répartition des services — l'ajouter ici ne lui donne encore
    aucune classe.</p>
    <div style="margin-top:14px">
      <button type="submit" class="btn">Créer le compte</button>
    </div>
  </form>
</div>

<div class="card">
  <header><b>${plural(actifs.length, "personne en poste", "personnes en poste")}</b></header>
  <table>
    <thead><tr><th>Nom</th><th>Téléphone</th><th>Fonction</th><th></th></tr></thead>
    <tbody>${actifs.map(ligne).join("")}</tbody>
  </table>
</div>

${ecartes.length ? `
<div class="card">
  <header><b>${plural(ecartes.length, "personne écartée", "personnes écartées")}</b>
    — leur compte ne s'ouvre plus, mais tout ce qu'elles ont signé reste signé
  </header>
  <table>
    <thead><tr><th>Nom</th><th>Téléphone</th><th>Fonction</th><th></th></tr></thead>
    <tbody>${ecartes.map(ligne).join("")}</tbody>
  </table>
</div>` : ""}

<div class="note${p.chefsEnExercice <= 1 ? " warn" : ""}">
  <b>${p.chefsEnExercice <= 1
    ? "Un seul chef d'établissement en exercice."
    : `${plural(p.chefsEnExercice, "chef d'établissement en exercice",
                "chefs d'établissement en exercice")}.`}</b>
  Le dernier ne peut être ni écarté ni rétrogradé : sans lui, plus personne ne
  pourrait gérer le personnel, et il n'existe aucune console pour rattraper
  l'erreur.${p.chefsEnExercice <= 1
    ? " Nommer un second chef d'établissement est la seule façon de se donner "
      + "une porte de sortie." : ""}
</div>`;

  return page(chrome, "Le personnel", body);
}
