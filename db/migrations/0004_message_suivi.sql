-- ---------------------------------------------------------------------------
-- Suivi des messages non remis.
--
-- La deuxième des trois promesses du logiciel est : « la famille est prévenue
-- le jour même de l'absence ». Jusqu'ici cette promesse n'était vraie qu'à
-- moitié. Un message refusé par l'opérateur — numéro erroné, ligne résiliée,
-- SIM sans crédit chez le destinataire — était écrit dans `sms_messages` avec
-- le statut `echoue`, et PERSONNE NE LISAIT JAMAIS CE STATUT. Aucun écran, pas
-- une requête. L'établissement croyait avoir prévenu ; la famille n'avait rien
-- reçu ; l'enfant passait la journée dehors.
--
-- Un échec n'est pas une ligne de journal : c'est une TÂCHE. Quelqu'un doit
-- appeler la famille, ou corriger le numéro, ou renoncer en connaissance de
-- cause. Ces trois colonnes disent ce qui a été fait, par qui et quand — pour
-- que l'échec se referme explicitement au lieu de s'effacer avec le temps.
--
-- `error_detail` existait depuis le premier schéma et n'était jamais renseigné.
-- Le code applicatif l'écrit désormais ; sans la raison, « échoué » ne dit pas
-- s'il faut rappeler ou corriger un chiffre.
--
-- Migration additive : elle n'enlève rien et ne change aucune valeur existante.
-- ---------------------------------------------------------------------------

alter table sms_messages
  add column if not exists resolution   text,
  add column if not exists resolved_at  timestamptz,
  add column if not exists resolved_by  uuid references staff(id);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sms_messages_resolution_check'
  ) then
    alter table sms_messages
      add constraint sms_messages_resolution_check
      check (resolution is null or resolution in ('reessaye', 'appele', 'abandonne'));
  end if;
end $$;

-- Les échecs non traités, dans l'ordre où ils sont arrivés : c'est la seule
-- requête que l'écran de suivi fait en boucle.
create index if not exists sms_messages_a_traiter
  on sms_messages (school_id, queued_at desc)
  where status = 'echoue' and resolution is null;

comment on column sms_messages.resolution is
  'Ce qui a été fait d''un message non remis : reessaye (un second envoi a '
  'été tenté), appele (la famille a été jointe par téléphone), abandonne '
  '(renoncement assumé). NULL = personne ne s''en est encore occupé.';

comment on column sms_messages.error_detail is
  'La raison donnée par l''opérateur. Sans elle, « échoué » ne dit pas s''il '
  'faut rappeler la famille ou corriger un chiffre du numéro.';
