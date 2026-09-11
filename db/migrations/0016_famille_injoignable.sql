-- ---------------------------------------------------------------------------
-- Une famille qu'on n'a pas pu prévenir doit apparaître quelque part.
--
-- CE QUI ÉTAIT SILENCIEUX. Dans `saveAbsences`, une ligne :
--
--     const row = g.rows[0];
--     if (!row?.phone) continue;              // <— ici
--
-- L'élève est marqué absent, et pour sa famille il ne se passe RIEN : aucun
-- SMS, aucune ligne dans `sms_messages`, aucune tâche dans le registre, aucun
-- nom dans le message de confirmation. L'écran répond :
--
--     « Appel enregistré : 3 absences, 2 SMS envoyés pour 16 F. »
--
-- Trois enfants absents, deux familles prévenues. La troisième n'est nulle
-- part. Le surveillant lit « appel enregistré » et ferme l'écran.
--
-- C'est la DEUXIÈME des trois promesses du produit — « la famille est
-- prévenue le jour même » — qui tombe, en silence, pour cette famille-là, et
-- tous les jours que l'élève sera absent.
--
-- ---------------------------------------------------------------------------
-- LE RESTE DU LOGICIEL SAIT DÉJÀ LE FAIRE.
--
-- Ce n'est pas une règle qui manquait, c'est un seul chemin qui l'a oubliée :
--
--   * `discipline.ts` : « Aucun numéro joignable : prévenez la famille
--     autrement, et corrigez le numéro dans la fiche de l'élève. »
--   * `cloture.ts`    : « Aucune famille joignable dans cette classe. »
--   * `eleve.ts`      : avertit quand on retire le dernier tuteur joignable.
--   * `attention.ts`  : « N élèves n'ont aucun numéro de tuteur. »
--
-- Quatre écrans disent la chose. Le cinquième — celui qui porte la promesse —
-- ne la disait pas.
--
-- Et le tableau de bord ne remplace pas ce qui manque : il annonce un ÉTAT
-- permanent (« trois élèves sans numéro »), jamais l'ÉVÉNEMENT du jour
-- (« ce matin Boukary était absent, et personne n'a pu être prévenu »). Le
-- second est une tâche avec une heure ; le premier est une statistique.
--
-- ---------------------------------------------------------------------------
-- LE SECOND DÉFAUT, PLUS DISCRET.
--
-- La requête qui choisit le destinataire ne filtrait pas sur le numéro :
--
--     order by sg.is_primary desc nulls last limit 1
--
-- Elle prend donc le tuteur PRINCIPAL, même sans numéro — et le tuteur
-- principal sans numéro MASQUE un second tuteur joignable inscrit au dossier.
-- Éprouvé : la tante au 70 99 98 88 n'a rien reçu, parce que le père listé en
-- premier avait changé de puce. Un père dont le numéro a changé et une mère
-- inscrite en second, c'est le cas ordinaire, pas le cas tordu.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE : un état `injoignable`.
--
-- Distinct de `echoue`, parce que le geste à faire n'est PAS le même :
--
--   echoue      — l'opérateur a refusé. On renvoie, ou on téléphone.
--   injoignable — il n'y avait pas de numéro à composer. On téléphone si on
--                 en trouve un, et SURTOUT on corrige la fiche de l'élève,
--                 sinon demain sera identique.
--
-- Écraser les deux sous « échec » ferait proposer « Renvoyer » sur un message
-- qui n'a aucun numéro où aller : un bouton qui ne peut pas marcher.
-- ---------------------------------------------------------------------------

do $$
begin
  -- La contrainte d'origine est anonyme (`check (status in (...))` en ligne),
  -- donc on la retrouve par son contenu plutôt que par un nom qu'elle n'a pas.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'sms_messages'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%injoignable%'
  ) then
    execute (
      select 'alter table sms_messages drop constraint ' || quote_ident(conname)
        from pg_constraint
       where conrelid = 'sms_messages'::regclass
         and contype = 'c'
         and pg_get_constraintdef(oid) like '%''echoue''%'
         and pg_get_constraintdef(oid) not like '%resolution%'
       limit 1);

    alter table sms_messages
      add constraint sms_messages_status_check
      check (status in ('file', 'envoye', 'livre', 'echoue', 'annule',
                        'injoignable'));
  end if;
end $$;

comment on column sms_messages.status is
  'file / envoye / livre / echoue / annule / injoignable. `injoignable` n''est '
  'pas un échec de l''opérateur : aucun numéro n''était au dossier, donc rien '
  'n''a été composé. Le message est conservé tel qu''il AURAIT été envoyé, '
  'pour que celui qui appelle la famille sache quoi lui dire.';

-- `to_phone` est `not null` et le reste : une ligne `injoignable` porte la
-- chaîne vide, qui se lit « il n'y avait pas de numéro » — et non un numéro
-- inventé, ni un NULL qui se confondrait avec « on n'a pas noté lequel ».

-- Ce qui demande un geste humain : les deux états, jamais résolus. C'est la
-- requête que le tableau de bord et le registre font en boucle.
drop index if exists sms_messages_a_traiter;
create index if not exists sms_messages_a_traiter
  on sms_messages (school_id, queued_at desc)
  where status in ('echoue', 'injoignable') and resolution is null;

-- ---------------------------------------------------------------------------
-- Combien de familles n'ont pas pu être prévenues, un jour donné.
--
-- Le registre répond « combien en tout » ; cette fonction répond « combien
-- CE MATIN », qui est la question du surveillant général au moment où il
-- ferme l'appel.
create or replace function familles_injoignables(p_jour date)
returns integer language sql stable as $$
  select count(*)::int from sms_messages
   where status = 'injoignable'
     and queued_at::date = p_jour;
$$;

comment on function familles_injoignables(date) is
  'Nombre de messages qu''on n''a pas pu composer faute de numéro, ce jour-là. '
  'Compte les MESSAGES, donc les élèves concernés : deux absences du même '
  'élève le même jour n''en produisent qu''un (le second envoi est retenu).';
