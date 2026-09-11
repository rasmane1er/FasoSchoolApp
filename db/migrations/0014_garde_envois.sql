-- ---------------------------------------------------------------------------
-- Deux gardes sur les envois en masse.
--
-- CE QUI A ÉTÉ TROUVÉ EN ÉPROUVANT L'ENVOI. Le même communiqué, envoyé deux
-- fois de suite, PART DEUX FOIS : 11 familles × 2, 22 messages, 176 FCFA, et
-- chaque parent reçoit le texte identique en double. Rien ne s'y opposait.
--
-- Ce n'est pas un cas tordu. C'est le double-clic. Sur une connexion lente —
-- la connexion visée — la page met plusieurs secondes à répondre, et cliquer
-- une deuxième fois est le comportement humain normal. Le directeur ne voit
-- rien : les deux envois annoncent « 11 familles prévenues ».
--
-- Le coût est double : le crédit, et la crédibilité du canal. Une famille qui
-- reçoit deux fois le même message cesse de les lire, et c'est tout le SMS
-- d'absence qui meurt avec.
--
-- SECONDE GARDE : L'HEURE. Rien n'empêchait un envoi en masse à 23 h ou à 5 h.
-- Un communiqué scolaire qui réveille trois cents foyers est un incident, et
-- c'est le logiciel qu'on accuse.
--
-- ---------------------------------------------------------------------------
-- POURQUOI PAS `notification_preferences`.
--
-- La table existe depuis le premier schéma, avec `quiet_from` et `quiet_to` —
-- et elle porte `user_id not null unique` : elle décrit les préférences d'un
-- membre du PERSONNEL. Or la question n'est pas quand un agent veut être
-- dérangé, mais quand on a le droit de texter les FAMILLES. Les deux n'ont
-- rien à voir, et plier la table à un usage qui n'est pas le sien produirait
-- une ligne par agent pour une règle qui vaut pour l'établissement entier.
--
-- Elle reste donc intacte et vide, et la règle va sur `schools`.
-- ---------------------------------------------------------------------------

alter table schools
  add column if not exists sms_quiet_from time not null default '21:00',
  add column if not exists sms_quiet_to   time not null default '06:00';

comment on column schools.sms_quiet_from is
  'Début des heures où l''on n''envoie pas d''envoi EN MASSE aux familles. '
  'Heure locale de Ouagadougou, pas celle du serveur.';
comment on column schools.sms_quiet_to is
  'Fin de ces heures. La fenêtre peut traverser minuit (21:00 → 06:00), et '
  'c''est le cas par défaut.';

-- ---------------------------------------------------------------------------
-- Sommes-nous dans les heures de silence ?
--
-- LE FUSEAU EST NOMMÉ, jamais celui du serveur. Le conteneur tourne en UTC et
-- le Burkina Faso est à UTC+0 toute l'année : aujourd'hui les deux coïncident,
-- et c'est exactement le genre de coïncidence qui casse le jour où la machine
-- déménage en Europe. `timezone('Africa/Ouagadougou', now())` reste juste
-- partout.
create or replace function heures_de_silence(p_moment timestamptz default now())
returns boolean language sql stable as $$
  select case
    when s.sms_quiet_from = s.sms_quiet_to then false      -- fenêtre vide
    when s.sms_quiet_from < s.sms_quiet_to then
      h.maintenant >= s.sms_quiet_from and h.maintenant < s.sms_quiet_to
    else                                                    -- traverse minuit
      h.maintenant >= s.sms_quiet_from or h.maintenant < s.sms_quiet_to
  end
  from schools s,
       lateral (select (timezone('Africa/Ouagadougou', p_moment))::time) as h(maintenant)
  limit 1;
$$;

comment on function heures_de_silence(timestamptz) is
  'Vrai si l''heure de Ouagadougou tombe dans la fenêtre de silence de '
  'l''établissement. Ne concerne QUE les envois en masse : un SMS d''absence '
  'ou une confirmation de paiement répond à un geste qui vient d''avoir lieu.';

-- ---------------------------------------------------------------------------
-- Le même message est-il déjà parti tout à l'heure ?
--
-- On compare le CORPS, pas un jeton de formulaire. Un jeton attrape le
-- double-clic et rien d'autre ; le corps attrape aussi le retour arrière, le
-- rechargement de page, et le re-clic après une attente jugée trop longue —
-- c'est-à-dire tous les gestes qui produisent réellement un doublon.
create or replace function envoi_deja_parti(p_corps text, p_minutes int default 30)
returns integer language sql stable as $$
  select count(*)::int from sms_messages
   where body = p_corps
     and status in ('envoye', 'livre')
     and queued_at > now() - make_interval(mins => p_minutes);
$$;

create index if not exists sms_messages_doublon_recent
  on sms_messages (school_id, queued_at desc)
  where status in ('envoye', 'livre');
