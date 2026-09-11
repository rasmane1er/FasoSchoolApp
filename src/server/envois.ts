/**
 * Deux gardes sur les envois EN MASSE.
 *
 * TROUVÉ EN ÉPROUVANT L'ENVOI. Le même communiqué, envoyé deux fois de suite,
 * PARTAIT DEUX FOIS : 11 familles × 2, 22 messages, 176 FCFA, et chaque parent
 * recevait le texte identique en double. Les deux envois annonçaient
 * « 11 familles prévenues » : le directeur ne voyait rien.
 *
 * Ce n'est pas un cas tordu, c'est le double-clic. Sur une connexion lente —
 * la connexion visée — la page met plusieurs secondes à répondre, et cliquer
 * une seconde fois est le comportement humain normal.
 *
 * Le coût est double : le crédit, et la crédibilité du canal. Une famille qui
 * reçoit deux fois le même message cesse de les lire, et c'est le SMS
 * d'absence qui meurt avec.
 *
 * SECONDE GARDE : L'HEURE. Rien n'empêchait un envoi en masse à 23 h. Un
 * communiqué scolaire qui réveille trois cents foyers est un incident, et
 * c'est le logiciel qu'on accuse.
 *
 * ---------------------------------------------------------------------------
 * CE QUE CES GARDES NE COUVRENT PAS, ET POURQUOI.
 *
 * Elles ne s'appliquent QU'AUX ENVOIS EN MASSE. Un SMS d'absence et une
 * confirmation de paiement répondent à un geste qui vient d'avoir lieu : les
 * retenir jusqu'à 6 h du matin les rendrait faux. L'appel est déjà borné par
 * le calendrier scolaire, qui interdit de le faire un jour sans école.
 *
 * ---------------------------------------------------------------------------
 * POURQUOI LE CORPS ET NON UN JETON DE FORMULAIRE.
 *
 * Un jeton attrape le double-clic, et rien d'autre. Comparer le CORPS attrape
 * aussi le retour arrière, le rechargement de page et le re-clic après une
 * attente jugée trop longue — c'est-à-dire tous les gestes qui produisent
 * réellement un doublon. Et comme un établissement peut vouloir renvoyer le
 * même texte le lendemain, le refus est TOUJOURS forçable : on ne bloque pas,
 * on demande de confirmer.
 */

import { esc } from "./html.ts";

export interface Refus {
  /** Ce qu'on dit à l'utilisateur. */
  message: string;
  /** Vrai si cocher « envoyer quand même » lèverait le refus. */
  forcable: boolean;
}

const hhmm = (t: string) => String(t).slice(0, 5).replace(":", " h ");

/**
 * `c` est un client déjà placé dans le contexte de l'établissement.
 * Retourne `null` quand l'envoi peut partir.
 */
export async function garderEnvoi(
  c: any, corps: string, forcer: boolean,
): Promise<Refus | null> {
  /* L'heure d'abord : c'est la garde qu'on ne peut pas contourner par
     inadvertance, et celle dont le motif est le plus simple à comprendre. */
  const silence = (await c.query(
    `select heures_de_silence() as silence,
            sms_quiet_from::text as debut, sms_quiet_to::text as fin,
            to_char(timezone('Africa/Ouagadougou', now()), 'HH24:MI') as maintenant
       from schools limit 1`)).rows[0];

  if (silence?.silence && !forcer) {
    return {
      forcable: true,
      message: `Il est ${hhmm(silence.maintenant + ":00")} à Ouagadougou, et `
        + `l'établissement ne texte pas les familles entre `
        + `${hhmm(silence.debut)} et ${hhmm(silence.fin)}. Un communiqué qui `
        + `réveille trois cents foyers est un incident.`,
    };
  }

  const deja = Number((await c.query(
    `select envoi_deja_parti($1) as n`, [corps])).rows[0].n);

  if (deja > 0 && !forcer) {
    return {
      forcable: true,
      message: `Ce texte exact est déjà parti à ${deja} `
        + `destinataire${deja > 1 ? "s" : ""} il y a moins de trente minutes. `
        + `Rien n'a été renvoyé. Si c'était un double-clic, tout va bien : les `
        + `familles l'ont reçu.`,
    };
  }

  return null;
}

/** La case à cocher qui lève un refus forçable, et rien d'autre. */
export function caseForcer(motif: string): string {
  return `<div class="note warn" style="margin-bottom:14px">
    ${esc(motif)}
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;
                  text-transform:none;letter-spacing:0;font-size:14px;color:var(--ink)">
      <input type="checkbox" name="forcer" value="1"
             style="width:auto;height:auto">
      Envoyer quand même
    </label>
  </div>`;
}
