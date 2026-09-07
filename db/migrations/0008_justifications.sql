-- ---------------------------------------------------------------------------
-- Justifier une absence.
--
-- `is_justified` existe sur `attendance_records` ET sur `grade_entries` depuis
-- le premier schéma. AUCUNE ligne du logiciel ne l'a jamais mise à `true`.
-- Pourtant :
--
--   - le bulletin imprime « Absences justifiées » et « Absences non
--     justifiées ». La première ligne valait donc zéro pour tout le monde, et
--     la seconde portait toutes les absences — y compris celles pour
--     lesquelles la famille avait apporté un certificat. C'est une accusation
--     imprimée sur un document officiel remis aux parents ;
--   - l'espace des familles affichait le même compte de « justifiées »,
--     toujours nul ;
--   - le conseil de classe lisait « dont N non justifiées », toujours égal au
--     total ;
--   - et surtout, `computeClassBulletins` compte une absence NON JUSTIFIÉE à
--     une évaluation comme un ZÉRO. Un élève malade le jour de la composition
--     — coefficient 2 — voyait donc sa moyenne effondrée par un zéro que rien,
--     dans le logiciel, ne pouvait lever. Avec certificat médical ou sans.
--
-- Ce qui suit rend la justification possible, et sort de `repository.ts` la
-- règle qui y était écrite en dur.
--
-- LA RÈGLE N'EST PAS UN `if`. `unjustified_absence_counts_as_zero` était
-- codée `true` dans `repository.ts`, en contradiction avec le principe tenu
-- partout ailleurs : une règle qui décide d'une moyenne vit dans une table,
-- avec sa date d'effet et sa provenance. Elle rejoint donc `grading_policies`
-- — et comme les cinq autres, elle est marquée NON VÉRIFIÉE tant qu'un censeur
-- burkinabè ne l'a pas confirmée.
--
-- Migration additive.
-- ---------------------------------------------------------------------------

alter table grading_policies
  add column if not exists unjustified_absence_counts_as_zero boolean
    not null default true;

comment on column grading_policies.unjustified_absence_counts_as_zero is
  'Une absence non justifiée à une évaluation compte-t-elle 0 ? Une absence '
  'JUSTIFIÉE est toujours neutralisée, jamais comptée. Règle non vérifiée : '
  'elle attend la confirmation d''un censeur burkinabè.';

-- Qui a justifié, et quand. Le motif (`justification`) existait déjà.
alter table attendance_records
  add column if not exists justified_by uuid references staff(id),
  add column if not exists justified_at timestamptz;

alter table grade_entries
  add column if not exists justification text,
  add column if not exists justified_by  uuid references staff(id),
  add column if not exists justified_at  timestamptz;

comment on column attendance_records.justification is
  'Le motif retenu : « certificat médical du 12/11 », « décès dans la '
  'famille ». Sans motif écrit, une justification n''est qu''une case cochée.';
comment on column grade_entries.justification is
  'Le motif de l''absence à cette évaluation. Justifier neutralise '
  'l''évaluation ; ne pas justifier peut la compter zéro selon la règle de '
  'notation en vigueur.';

-- Les absences qui attendent encore une décision : la seule requête que
-- l'écran de justification fait en boucle.
create index if not exists attendance_a_justifier
  on attendance_records (school_id, updated_at desc)
  where status = 'absent' and not is_justified;
