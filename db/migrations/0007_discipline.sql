-- ---------------------------------------------------------------------------
-- Le registre de discipline.
--
-- `behavior_incidents` existe depuis le premier schéma et n'a jamais été ni
-- écrite ni lue. Le surveillant général — celui qui, dans un établissement
-- burkinabè, tient le cahier de discipline et convoque les parents — n'avait
-- dans ce logiciel que l'appel du matin.
--
-- POURQUOI CES TROIS COLONNES.
--
-- Un incident est une trace écrite sur un enfant. Elle est lue au conseil de
-- classe, elle pèse sur une décision de passage, elle peut suivre l'élève dans
-- son livret. Deux exigences contraires se rencontrent donc ici :
--
--   - une erreur doit pouvoir être réparée — on se trompe d'élève, on écrit
--     sous le coup de la colère ;
--   - et rien ne doit disparaître en silence, sinon le registre ne prouve plus
--     rien, ni contre l'élève ni EN SA FAVEUR.
--
-- Un incident retiré reste donc écrit, barré, avec le nom de qui l'a retiré et
-- pourquoi. C'est la même règle que les reçus et les bulletins : on n'efface
-- pas, on annule en le disant.
--
-- Migration additive.
-- ---------------------------------------------------------------------------

alter table behavior_incidents
  add column if not exists retracted_at     timestamptz,
  add column if not exists retracted_by     uuid references staff(id),
  add column if not exists retraction_reason text;

-- Le vocabulaire des sanctions d'un établissement burkinabè. En base, parce
-- qu'un texte libre finit par contenir « exclusion » écrit de six façons, et
-- qu'aucune statistique ne se fait plus dessus.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'behavior_incidents_sanction_check'
  ) then
    alter table behavior_incidents
      add constraint behavior_incidents_sanction_check
      check (sanction is null or sanction in (
        'avertissement', 'blame', 'convocation_parents',
        'travail_interet_general', 'exclusion_temporaire',
        'exclusion_definitive'));
  end if;
end $$;

create index if not exists behavior_incidents_ouverts
  on behavior_incidents (school_id, occurred_on desc)
  where retracted_at is null;

comment on column behavior_incidents.retraction_reason is
  'Un incident retiré reste écrit et barré : effacer une trace détruit aussi '
  'ce qui pouvait servir EN FAVEUR de l''élève.';
comment on column behavior_incidents.sanction is
  'Vocabulaire fermé. L''exclusion définitive relève du conseil de discipline '
  'et n''est ouverte qu''au chef d''établissement.';
