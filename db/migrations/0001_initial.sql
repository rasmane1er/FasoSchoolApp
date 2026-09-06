-- FasoSchool — schéma initial
-- PostgreSQL 14+
--
-- Remplace les 87 migrations du prototype. Aucune donnée de production
-- n'existait, donc l'historique a été écrasé plutôt que migré.
--
-- Principes:
--   1. school_id sur toute table multi-locataire + row-level security.
--   2. Vocabulaire burkinabè (niveau, classe, série, matière, trimestre).
--   3. Les règles pédagogiques changent par arrêté ministériel : elles sont
--      des DONNÉES datées, jamais du code. Voir grading_policies,
--      coefficient_sets, mention_bands, promotion_rules.
--   4. Pas de colonnes external_id. Les UUID sont les identifiants.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Contexte de sécurité
-- ---------------------------------------------------------------------------

-- Renvoie l'établissement du contexte de session, posé au checkout de
-- connexion via  set_config('fasoschool.school_id', $1, false).
create or replace function current_school_id() returns uuid as $$
  select nullif(current_setting('fasoschool.school_id', true), '')::uuid;
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- Établissement
-- ---------------------------------------------------------------------------

create table school_groups (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  created_at    timestamptz not null default now()
);

-- L'établissement EST le locataire. L'autorisation d'ouverture est délivrée
-- par site et par promoteur : un réseau de trois campus détient trois
-- autorisations, d'où school_groups au-dessus plutôt qu'un champ ici.
create table schools (
  id                    uuid primary key default uuid_generate_v4(),
  school_group_id       uuid references school_groups(id),
  name                  text not null,
  -- Catégories statistiques du ministère.
  sector                text not null check (sector in (
                          'public',
                          'prive_laic', 'prive_catholique',
                          'prive_protestant', 'prive_franco_arabe')),
  -- Zone tarifaire de l'arrêté n°2026-101.
  fee_zone              text check (fee_zone in ('ouaga_bobo', 'chef_lieu', 'rural')),
  commune               text,
  region                text,
  -- Autorisations MEBAPLN / MESFPT.
  autorisation_creation text,
  autorisation_ouverture text,
  phone                 text,
  default_locale        text not null default 'fr-BF',
  -- Compteur monotone des reçus. On ne dérive PAS le numéro de max(sequence) :
  -- si le reçu le plus haut disparaissait, le suivant réutiliserait son numéro.
  -- Un livre de reçus d'un comptable ne réutilise jamais un numéro.
  receipt_sequence      integer not null default 0,
  created_at            timestamptz not null default now()
);

create table campuses (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  name        text not null,
  commune     text,
  created_at  timestamptz not null default now()
);
create index on campuses (school_id);

create table academic_years (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  label       text not null,                       -- '2027-2028'
  starts_on   date not null,
  ends_on     date not null,
  status      text not null default 'planifiee'
                check (status in ('planifiee', 'en_cours', 'close')),
  created_at  timestamptz not null default now(),
  unique (school_id, label)
);

-- Trois trimestres, et ils sont INÉGAUX : le T3 est tronqué par la session
-- d'examens (32 h contre 44 h en anglais 6e/5e ; 2 évaluations contre 3 en
-- maths 6e). Ne jamais calculer les bornes en divisant l'année par trois.
create table terms (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  sequence          smallint not null check (sequence between 1 and 3),
  starts_on         date not null,
  ends_on           date not null,
  status            text not null default 'ouvert'
                      check (status in ('ouvert', 'clos', 'verrouille')),
  unique (academic_year_id, sequence)
);
create index on terms (school_id);

-- Le calendrier est amendable par région : Bobo-Dioulasso a terminé
-- l'année 2025-2026 le 30 mai au lieu du 15 juillet pour la SNC. Les fêtes
-- musulmanes sont mobiles — ce sont des données, jamais des décalages fixes.
create table calendar_events (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid references schools(id) on delete cascade,  -- null = national
  region      text,                                           -- null = tous
  label       text not null,
  event_type  text not null check (event_type in
                ('rentree_administrative', 'rentree_pedagogique', 'conges',
                 'fete', 'composition', 'examen', 'conseil_de_classe', 'autre')),
  starts_on   date not null,
  ends_on     date not null
);
create index on calendar_events (school_id, starts_on);

-- ---------------------------------------------------------------------------
-- Structure pédagogique
-- ---------------------------------------------------------------------------

-- Référentiel national, partagé par tous les établissements.
-- sub_cycle_position porte la règle de redoublement : l'arrêté de 2019
-- interdit le redoublement en première année de chaque sous-cycle du
-- primaire (CP1, CE1, CM1).
create table levels (
  code                 text primary key,           -- 'CP1', '6E', 'TLE'
  label                text not null,
  cycle                text not null check (cycle in
                         ('prescolaire', 'primaire', 'post_primaire', 'secondaire')),
  sub_cycle            text,                       -- 'CP', 'CE', 'CM'
  sub_cycle_position   smallint,                   -- 1 = première année
  ordinal              smallint not null,          -- ordre de progression
  typical_entry_age    smallint
);

create table series (
  code        text primary key,                    -- 'A4', 'C', 'D', 'F2', 'G1'
  label       text not null,
  stream      text not null check (stream in ('general', 'technique'))
);

-- Les quatre champs disciplinaires officiels structurent tous les niveaux
-- depuis la réforme curriculaire.
create table subjects (
  id                  uuid primary key default uuid_generate_v4(),
  school_id           uuid references schools(id) on delete cascade, -- null = national
  code                text not null,
  label               text not null,
  champ_disciplinaire text not null check (champ_disciplinaire in (
                        'langues_communication',
                        'maths_sciences_technologie',
                        'sciences_humaines_sociales',
                        'eps_arts_culture_production')),
  unique (school_id, code)
);

create table classes (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  campus_id         uuid references campuses(id),
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  level_code        text not null references levels(code),
  series_code       text references series(code),  -- assignable en 2nde, 1re ou Tle
  letter            text,                          -- 'A', 'B'
  label             text not null,                 -- '6e B', 'Tle D'
  professeur_principal_id uuid,                    -- -> staff, FK ajoutée plus bas
  created_at        timestamptz not null default now()
);
create index on classes (school_id, academic_year_id);

-- ---------------------------------------------------------------------------
-- Personnes
-- ---------------------------------------------------------------------------

create table users (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid references schools(id) on delete cascade, -- null = plateforme
  full_name         text not null,
  phone             text not null,                 -- le téléphone EST l'identité
  email             text,
  preferred_locale  text not null default 'fr-BF',
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (school_id, phone)
);

-- Fonctions burkinabè, nommées par arrêté ministériel.
-- Lycée : proviseur, censeur, surveillant général, intendant, chef des travaux.
-- Collège : directeur, surveillant général, économe.
create table staff (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  user_id     uuid references users(id),
  full_name   text not null,
  phone       text,
  fonction    text not null check (fonction in (
                'proviseur', 'censeur', 'surveillant_general', 'intendant',
                'chef_des_travaux', 'directeur', 'econome',
                'enseignant', 'secretaire', 'autre')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index on staff (school_id);

alter table classes
  add constraint classes_prof_principal_fk
  foreign key (professeur_principal_id) references staff(id);

create table students (
  id                  uuid primary key default uuid_generate_v4(),
  school_id           uuid not null references schools(id) on delete cascade,
  matricule           text not null,
  last_name           text not null,
  first_names         text not null,
  sex                 char(1) check (sex in ('M', 'F')),
  date_of_birth       date,
  place_of_birth      text,
  photo_key           text,
  -- Identifiant national. Aucune API publique n'existe : on conserve le champ
  -- et on exporte un fichier que le chef d'établissement saisit lui-même.
  fiue_bf_id          text,
  -- Le CEP et le concours d'entrée en 6e sont deux résultats distincts.
  -- Réussir le CEP ne donne pas accès à la 6e.
  cep_result          text check (cep_result in ('admis', 'refuse', 'non_presente')),
  concours_6e_result  text check (concours_6e_result in ('admis', 'refuse', 'non_presente')),
  created_at          timestamptz not null default now(),
  unique (school_id, matricule)
);
create index on students (school_id, last_name);

create table guardians (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  user_id     uuid references users(id),
  full_name   text not null,
  phone       text not null,
  phone_alt   text,
  created_at  timestamptz not null default now()
);
create index on guardians (school_id, phone);

-- Plusieurs tuteurs par élève et plusieurs élèves par tuteur : la gestion
-- des fratries en découle sans cas particulier.
create table student_guardians (
  student_id    uuid not null references students(id) on delete cascade,
  guardian_id   uuid not null references guardians(id) on delete cascade,
  school_id     uuid not null references schools(id) on delete cascade,
  relationship  text,
  is_primary    boolean not null default false,
  receives_sms  boolean not null default true,
  primary key (student_id, guardian_id)
);
create index on student_guardians (school_id);

create table emergency_contacts (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  full_name   text not null,
  phone       text not null,
  relationship text
);
create index on emergency_contacts (school_id);

-- ---------------------------------------------------------------------------
-- Inscription et parcours
-- ---------------------------------------------------------------------------

-- Une ligne par élève et par année : c'est le parcours de l'élève.
-- Ne jamais muter la classe sur la fiche élève.
create table enrolments (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  student_id        uuid not null references students(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  class_id          uuid references classes(id),
  status            text not null default 'inscrit' check (status in
                      ('inscrit', 'reinscrit', 'transfere_entrant',
                       'transfere_sortant', 'sorti', 'exclu')),
  is_redoublant     boolean not null default false,
  enrolled_on       date not null default current_date,
  created_at        timestamptz not null default now(),
  unique (student_id, academic_year_id)
);
create index on enrolments (school_id, class_id);

create table teacher_assignments (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  staff_id    uuid not null references staff(id) on delete cascade,
  class_id    uuid not null references classes(id) on delete cascade,
  subject_id  uuid not null references subjects(id),
  unique (class_id, subject_id, staff_id)
);
create index on teacher_assignments (school_id, staff_id);

-- Continuité du parcours en cas de déplacement ou de fermeture d'école.
create table student_transfers (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  student_id        uuid not null references students(id) on delete cascade,
  direction         text not null check (direction in ('entrant', 'sortant')),
  other_school_name text,
  reason            text,
  requested_on      date not null default current_date,
  decided_on        date,
  status            text not null default 'en_attente'
                      check (status in ('en_attente', 'accepte', 'refuse')),
  packet_key        text
);
create index on student_transfers (school_id, student_id);

-- ---------------------------------------------------------------------------
-- Règles de notation — DONNÉES DATÉES, PAS DU CODE
-- ---------------------------------------------------------------------------
--
-- Tout ce qui suit a été impossible à vérifier depuis une source burkinabè
-- publique. Les valeurs par défaut sont livrées avec leur provenance dans
-- source_note et DOIVENT être confirmées auprès d'un censeur avant usage.

create table grading_policies (
  id                    uuid primary key default uuid_generate_v4(),
  school_id             uuid not null references schools(id) on delete cascade,
  effective_from        date not null,
  -- moyenne_matiere = (moy(devoirs) * devoir_weight
  --                    + composition * composition_weight) / (somme des poids)
  devoir_weight         numeric(4,2) not null default 1.00,
  composition_weight    numeric(4,2) not null default 2.00,
  interrogation_weight  numeric(4,2) not null default 0.00,
  scale_max             numeric(4,2) not null default 20.00,
  pass_mark             numeric(4,2) not null default 10.00,
  decimals              smallint not null default 2,
  rounding              text not null default 'half_up'
                          check (rounding in ('half_up', 'half_even', 'truncate')),
  -- Départage des ex aequo au classement.
  rank_tie_policy       text not null default 'same_rank_skip'
                          check (rank_tie_policy in ('same_rank_skip', 'same_rank_dense')),
  source_note           text,
  created_at            timestamptz not null default now(),
  unique (school_id, effective_from)
);

create table mention_bands (
  id                uuid primary key default uuid_generate_v4(),
  grading_policy_id uuid not null references grading_policies(id) on delete cascade,
  school_id         uuid not null references schools(id) on delete cascade,
  label             text not null,                 -- 'Passable', 'Bien'
  min_average       numeric(4,2) not null,
  max_average       numeric(4,2) not null,
  sort_order        smallint not null
);
create index on mention_bands (school_id, grading_policy_id);

-- La réforme de 2026 a fixé, aux EXAMENS : maths 3, français 3, toutes les
-- autres disciplines 2, et l'éducation civique devient une matière à part
-- entière. Que les établissements reprennent ces coefficients sur leurs
-- bulletins internes n'est PAS vérifié.
create table coefficient_sets (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  label           text not null,
  level_code      text references levels(code),    -- null = tous niveaux
  series_code     text references series(code),    -- null = toutes séries
  effective_from  date not null,
  source_note     text,
  created_at      timestamptz not null default now()
);
create index on coefficient_sets (school_id, effective_from);

create table coefficients (
  coefficient_set_id  uuid not null references coefficient_sets(id) on delete cascade,
  subject_id          uuid not null references subjects(id) on delete cascade,
  school_id           uuid not null references schools(id) on delete cascade,
  coefficient         numeric(4,2) not null check (coefficient > 0),
  primary key (coefficient_set_id, subject_id)
);
create index on coefficients (school_id);

-- Le redoublement est interdit en CP1, CE1 et CM1 (arrêté 2019). Le SYNAPEC
-- conteste la mesure : c'est une règle modifiable, pas une contrainte figée.
create table promotion_rules (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  level_code      text references levels(code),    -- null = tous niveaux
  effective_from  date not null,
  redoublement_allowed boolean not null default true,
  min_average_to_pass  numeric(4,2),
  source_note     text
);
create index on promotion_rules (school_id);

-- ---------------------------------------------------------------------------
-- Évaluation
-- ---------------------------------------------------------------------------

-- Les compositions sont « harmonisées » : le sujet est arrêté au niveau du
-- district ou de la région, pas par l'enseignant de la classe. scope permet
-- à une évaluation de dépasser une seule classe.
create table evaluations (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  term_id       uuid not null references terms(id) on delete cascade,
  class_id      uuid references classes(id) on delete cascade,
  subject_id    uuid not null references subjects(id),
  eval_type     text not null check (eval_type in
                  ('interrogation', 'devoir', 'composition', 'examen_blanc')),
  scope         text not null default 'classe'
                  check (scope in ('classe', 'etablissement', 'district', 'region')),
  label         text,
  bareme        numeric(5,2) not null default 20.00,
  held_on       date,
  created_by    uuid references staff(id),
  created_at    timestamptz not null default now()
);
create index on evaluations (school_id, term_id, class_id);

-- L'unité de synchronisation hors-ligne. Une ligne par élève et par
-- évaluation ; mutation_id rend le rejeu de la file d'attente idempotent.
create table grade_entries (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  evaluation_id uuid not null references evaluations(id) on delete cascade,
  student_id    uuid not null references students(id) on delete cascade,
  score         numeric(5,2),
  is_absent     boolean not null default false,
  is_justified  boolean not null default false,
  mutation_id   uuid,
  device_id     text,
  recorded_by   uuid references staff(id),
  updated_at    timestamptz not null default now(),
  unique (evaluation_id, student_id)
);
create index on grade_entries (school_id, student_id);
create unique index on grade_entries (mutation_id) where mutation_id is not null;

-- Append-only. On n'écrase jamais en silence : c'est à la fois le substrat de
-- résolution de conflit et la réponse quand un parent conteste une note.
create table grade_entry_revisions (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  grade_entry_id  uuid not null references grade_entries(id) on delete cascade,
  score           numeric(5,2),
  is_absent       boolean,
  source          text not null check (source in ('online', 'offline', 'import', 'correction')),
  device_id       text,
  recorded_by     uuid references staff(id),
  recorded_at     timestamptz not null default now()
);
create index on grade_entry_revisions (school_id, grade_entry_id);

-- ---------------------------------------------------------------------------
-- Présence
-- ---------------------------------------------------------------------------

create table attendance_sessions (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  class_id      uuid not null references classes(id) on delete cascade,
  session_date  date not null,
  session_slot  text not null default 'matin'
                  check (session_slot in ('matin', 'apres_midi', 'cours')),
  subject_id    uuid references subjects(id),
  recorded_by   uuid references staff(id),
  created_at    timestamptz not null default now(),
  unique (class_id, session_date, session_slot)
);
create index on attendance_sessions (school_id, session_date);

create table attendance_records (
  id                    uuid primary key default uuid_generate_v4(),
  school_id             uuid not null references schools(id) on delete cascade,
  attendance_session_id uuid not null references attendance_sessions(id) on delete cascade,
  student_id            uuid not null references students(id) on delete cascade,
  status                text not null check (status in
                          ('present', 'absent', 'retard', 'renvoye')),
  minutes_late          smallint,
  justification         text,
  is_justified          boolean not null default false,
  mutation_id           uuid,
  device_id             text,
  sms_sent_at           timestamptz,
  updated_at            timestamptz not null default now(),
  unique (attendance_session_id, student_id)
);
create index on attendance_records (school_id, student_id);
create unique index on attendance_records (mutation_id) where mutation_id is not null;

create table behavior_incidents (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  student_id  uuid not null references students(id) on delete cascade,
  term_id     uuid references terms(id),
  occurred_on date not null default current_date,
  description text not null,
  sanction    text,
  recorded_by uuid references staff(id),
  created_at  timestamptz not null default now()
);
create index on behavior_incidents (school_id, student_id);

-- ---------------------------------------------------------------------------
-- Bulletin
-- ---------------------------------------------------------------------------

create table bulletins (
  id                  uuid primary key default uuid_generate_v4(),
  school_id           uuid not null references schools(id) on delete cascade,
  student_id          uuid not null references students(id) on delete cascade,
  term_id             uuid not null references terms(id) on delete cascade,
  class_id            uuid not null references classes(id),
  grading_policy_id   uuid references grading_policies(id),
  coefficient_set_id  uuid references coefficient_sets(id),
  moyenne_generale    numeric(5,2),
  total_points        numeric(8,2),                -- somme(note x coeff)
  total_coefficients  numeric(6,2),
  rang                smallint,
  effectif            smallint,
  moyenne_de_classe   numeric(5,2),
  mention             text,
  absences_count      smallint not null default 0,
  retards_count       smallint not null default 0,
  appreciation_generale text,
  status              text not null default 'brouillon'
                        check (status in ('brouillon', 'valide', 'publie')),
  published_at        timestamptz,
  published_by        uuid references staff(id),
  document_key        text,
  computed_at         timestamptz,
  unique (student_id, term_id)
);
create index on bulletins (school_id, term_id, class_id);

create table bulletin_lines (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  bulletin_id     uuid not null references bulletins(id) on delete cascade,
  subject_id      uuid not null references subjects(id),
  moyenne_matiere numeric(5,2),
  coefficient     numeric(4,2) not null,
  points          numeric(8,2),                    -- moyenne x coefficient
  moyenne_classe_matiere numeric(5,2),
  rang_matiere    smallint,
  appreciation    text,
  sort_order      smallint not null default 0,
  unique (bulletin_id, subject_id)
);
create index on bulletin_lines (school_id, bulletin_id);

-- Le conseil de classe décide du passage. Sa composition et ses seuils n'ont
-- pas pu être établis depuis un texte officiel : enum configurable plutôt
-- que moteur de règles.
create table conseil_decisions (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  student_id        uuid not null references students(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  decision          text not null check (decision in
                      ('admis', 'admis_par_compensation', 'redouble',
                       'exclu', 'reoriente')),
  appreciation      text,
  decided_on        date,
  recorded_by       uuid references staff(id),
  unique (student_id, academic_year_id)
);
create index on conseil_decisions (school_id);

-- Le livret scolaire : dossier cumulatif pluriannuel, distinct du bulletin
-- trimestriel. C'est ce qui rend réelle la continuité du parcours.
create table livret_entries (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  student_id        uuid not null references students(id) on delete cascade,
  academic_year_label text not null,
  level_code        text,
  school_name       text not null,
  moyenne_annuelle  numeric(5,2),
  decision          text,
  is_external       boolean not null default false, -- saisi depuis un autre établissement
  created_at        timestamptz not null default now()
);
create index on livret_entries (school_id, student_id);

-- Le gabarit du bulletin est une donnée : chaque établissement veut son
-- en-tête, son ordre de colonnes et son vocabulaire d'appréciation.
create table bulletin_templates (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  label         text not null,
  header_html   text,
  field_map     jsonb not null default '{}'::jsonb,
  appreciations text[] not null default array[]::text[],
  is_default    boolean not null default false,
  created_at    timestamptz not null default now()
);
create index on bulletin_templates (school_id);

-- ---------------------------------------------------------------------------
-- Scolarité
-- ---------------------------------------------------------------------------

create table fee_schedules (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  level_code        text references levels(code),
  label             text not null,
  created_at        timestamptz not null default now()
);
create index on fee_schedules (school_id);

-- cap_treatment porte l'arrêté n°2026-101. « Plafonné » couvre la scolarité,
-- les évaluations, l'inscription, les frais de dossier, le laboratoire, la
-- délivrance de diplômes, la carte scolaire, la bibliothèque et la
-- contribution papier. L'hébergement est exclu. Tout supplément exige une
-- autorisation ministérielle préalable.
create table fee_lines (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  fee_schedule_id uuid not null references fee_schedules(id) on delete cascade,
  label           text not null,
  amount_fcfa     integer not null check (amount_fcfa >= 0),
  cap_treatment   text not null default 'plafonne' check (cap_treatment in
                    ('plafonne', 'autorise_supplementaire', 'exclu')),
  authorisation_ref text,                          -- si autorise_supplementaire
  is_mandatory    boolean not null default true,
  sort_order      smallint not null default 0
);
create index on fee_lines (school_id, fee_schedule_id);

create table invoices (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  student_id        uuid not null references students(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  fee_schedule_id   uuid references fee_schedules(id),
  reference         text not null,
  total_fcfa        integer not null default 0,
  status            text not null default 'ouverte'
                      check (status in ('ouverte', 'partielle', 'soldee', 'annulee')),
  issued_on         date not null default current_date,
  created_at        timestamptz not null default now(),
  unique (school_id, reference)
);
create index on invoices (school_id, student_id);

-- Les échéanciers sont la norme : on modélise des dates d'exigibilité, pas
-- un solde unique.
create table invoice_instalments (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  invoice_id    uuid not null references invoices(id) on delete cascade,
  label         text not null,
  amount_fcfa   integer not null,
  due_on        date not null,
  sort_order    smallint not null default 0
);
create index on invoice_instalments (school_id, invoice_id, due_on);

-- Machine à états, pas un booléen : la confirmation mobile money est
-- asynchrone et le client ne peut jamais confirmer lui-même.
create table payments (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  invoice_id        uuid not null references invoices(id) on delete cascade,
  amount_fcfa       integer not null check (amount_fcfa > 0),
  method            text not null check (method in
                      ('especes', 'virement', 'cheque', 'orange_money', 'moov_money')),
  status            text not null default 'initie' check (status in
                      ('initie', 'attente_client', 'en_cours_operateur',
                       'confirme', 'echoue', 'expire', 'rapproche')),
  idempotency_key   text not null,
  provider          text,
  provider_ref      text,
  payer_phone       text,
  recorded_by       uuid references staff(id),
  initiated_at      timestamptz not null default now(),
  confirmed_at      timestamptz,
  unique (school_id, idempotency_key)
);
create index on payments (school_id, invoice_id, status);

create table payment_events (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  payment_id  uuid not null references payments(id) on delete cascade,
  from_status text,
  to_status   text not null,
  detail      jsonb,
  occurred_at timestamptz not null default now()
);
create index on payment_events (school_id, payment_id);

-- Numérotation séquentielle et sans trou par établissement : un comptable
-- vérifiera. Émis uniquement à la confirmation, et une seule fois.
-- Append-only par nature : un paiement annulé produit un reçu d'annulation,
-- jamais la suppression de l'original.
create table receipts (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  payment_id      uuid not null references payments(id) on delete cascade,
  receipt_number  text not null,
  sequence        integer not null,
  amount_fcfa     integer not null,
  document_key    text,
  issued_at       timestamptz not null default now(),
  unique (school_id, receipt_number),
  unique (school_id, sequence),
  unique (payment_id)
);

create table scholarships (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  student_id    uuid not null references students(id) on delete cascade,
  academic_year_id uuid not null references academic_years(id) on delete cascade,
  label         text not null,
  kind          text not null check (kind in ('bourse', 'remise')),
  percent       numeric(5,2),
  amount_fcfa   integer,
  granted_on    date not null default current_date
);
create index on scholarships (school_id, student_id);

-- ---------------------------------------------------------------------------
-- Conformité — arrêté n°2026-101
-- ---------------------------------------------------------------------------
--
-- Grille sur 100 points : 50 pour l'investissement (bâti, clôture, eau
-- potable, assainissement, énergie, sport, ÉQUIPEMENT INFORMATIQUE,
-- bibliothèque, cantine) et 50 pour la qualité éducative (qualification des
-- enseignants, spécialistes, TIC / anglais / langues nationales, résultats
-- aux examens, stabilité du personnel, effectifs, formation, GOUVERNANCE).
-- La catégorie obtenue, croisée avec la zone, fixe le plafond légal.

create table category_assessments (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  investment_score  numeric(5,2) check (investment_score between 0 and 50),
  quality_score     numeric(5,2) check (quality_score between 0 and 50),
  total_score       numeric(5,2) generated always as
                      (coalesce(investment_score,0) + coalesce(quality_score,0)) stored,
  category          smallint check (category between 1 and 3),
  declared_ceiling_fcfa integer,
  status            text not null default 'brouillon'
                      check (status in ('brouillon', 'complet', 'declare')),
  declared_on       date,
  created_at        timestamptz not null default now(),
  unique (school_id, academic_year_id)
);

create table category_criteria (
  id                      uuid primary key default uuid_generate_v4(),
  school_id               uuid not null references schools(id) on delete cascade,
  category_assessment_id  uuid not null references category_assessments(id) on delete cascade,
  axis                    text not null check (axis in ('investissement', 'qualite')),
  code                    text not null,
  label                   text not null,
  max_points              numeric(5,2) not null,
  awarded_points          numeric(5,2),
  evidence_key            text,
  note                    text,
  unique (category_assessment_id, code)
);
create index on category_criteria (school_id);

-- Deux retours statutaires : rapport de rentrée dans le mois suivant la
-- rentrée, rapport de fin d'année dans le mois suivant les congés.
create table ministry_reports (
  id                uuid primary key default uuid_generate_v4(),
  school_id         uuid not null references schools(id) on delete cascade,
  academic_year_id  uuid not null references academic_years(id) on delete cascade,
  report_type       text not null check (report_type in
                      ('rapport_rentree', 'rapport_fin_annee',
                       'statistiques', 'declaration_frais')),
  due_on            date,
  submitted_on      date,
  document_key      text,
  status            text not null default 'a_produire'
                      check (status in ('a_produire', 'genere', 'depose')),
  unique (school_id, academic_year_id, report_type)
);

-- ---------------------------------------------------------------------------
-- Communication
-- ---------------------------------------------------------------------------

create table announcements (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  class_id      uuid references classes(id),        -- null = tout l'établissement
  title         text not null,
  body          text not null,
  status        text not null default 'brouillon'
                  check (status in ('brouillon', 'publie', 'archive')),
  published_at  timestamptz,
  created_by    uuid references staff(id),
  created_at    timestamptz not null default now()
);
create index on announcements (school_id, status);

create table sms_templates (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  code        text not null,
  label       text not null,
  body        text not null,                        -- {{eleve}}, {{date}}
  unique (school_id, code)
);

-- Crédit SMS par établissement. À 8 FCFA le message, un établissement de 300
-- élèves brûle 16 à 27 % d'un abonnement à 500 FCFA/élève : le coût doit être
-- mesuré, pas supposé.
create table sms_credit_ledger (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  direction   text not null check (direction in ('achat', 'consommation', 'ajustement')),
  messages    integer not null,
  amount_fcfa integer,
  note        text,
  occurred_at timestamptz not null default now()
);
create index on sms_credit_ledger (school_id, occurred_at);

create table sms_messages (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  template_id   uuid references sms_templates(id),
  student_id    uuid references students(id),
  guardian_id   uuid references guardians(id),
  to_phone      text not null,
  body          text not null,
  segments      smallint not null default 1,
  cost_fcfa     integer,
  status        text not null default 'file' check (status in
                  ('file', 'envoye', 'livre', 'echoue', 'annule')),
  provider      text,
  provider_ref  text,
  error_detail  text,
  queued_at     timestamptz not null default now(),
  sent_at       timestamptz
);
create index on sms_messages (school_id, status, queued_at);

create table notification_preferences (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  sms_enabled   boolean not null default true,
  quiet_from    time,
  quiet_to      time,
  unique (user_id)
);
create index on notification_preferences (school_id);

create table documents (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  student_id    uuid references students(id) on delete cascade,
  label         text not null,
  doc_type      text not null check (doc_type in
                  ('bulletin', 'recu', 'certificat', 'attestation',
                   'transfert', 'declaration', 'autre')),
  storage_key   text,
  content_type  text,
  byte_size     integer,
  status        text not null default 'actif' check (status in ('actif', 'archive')),
  created_by    uuid references staff(id),
  created_at    timestamptz not null default now()
);
create index on documents (school_id, student_id, status);

-- ---------------------------------------------------------------------------
-- Accès et audit
-- ---------------------------------------------------------------------------

create table roles (
  code  text primary key,
  label text not null,
  scope text not null check (scope in ('plateforme', 'etablissement'))
);

create table user_roles (
  user_id   uuid not null references users(id) on delete cascade,
  role_code text not null references roles(code),
  school_id uuid references schools(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (user_id, role_code, school_id)
);
create index on user_roles (school_id);

create table auth_sessions (
  id                  uuid primary key default uuid_generate_v4(),
  user_id             uuid not null references users(id) on delete cascade,
  school_id           uuid references schools(id) on delete cascade,
  access_token_hash   text not null,
  refresh_token_hash  text not null,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now()
);
create index on auth_sessions (access_token_hash);
create index on auth_sessions (user_id);

create table auth_otp_challenges (
  id          uuid primary key default uuid_generate_v4(),
  phone       text not null,
  code_hash   text not null,
  attempts    smallint not null default 0,
  expires_at  timestamptz not null,
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);
create index on auth_otp_challenges (phone, expires_at);

create table auth_rate_limits (
  id            uuid primary key default uuid_generate_v4(),
  bucket_key    text not null,
  window_start  timestamptz not null,
  hits          integer not null default 1,
  unique (bucket_key, window_start)
);

create table audit_log (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid references schools(id) on delete cascade,
  actor_id    uuid references users(id),
  action      text not null,
  target_type text,
  target_id   uuid,
  detail      jsonb,
  request_id  text,
  occurred_at timestamptz not null default now()
);
create index on audit_log (school_id, occurred_at desc);
create index on audit_log (action);

-- ---------------------------------------------------------------------------
-- Synchronisation hors-ligne
-- ---------------------------------------------------------------------------

create table devices (
  id          uuid primary key default uuid_generate_v4(),
  school_id   uuid not null references schools(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  device_key  text not null,
  label       text,
  last_seen_at timestamptz,
  unique (device_key)
);
create index on devices (school_id, user_id);

create table sync_mutations (
  id            uuid primary key default uuid_generate_v4(),
  school_id     uuid not null references schools(id) on delete cascade,
  mutation_id   uuid not null,                     -- généré par le client
  device_id     text,
  actor_id      uuid references users(id),
  entity_type   text not null,
  entity_id     uuid,
  operation     text not null check (operation in ('upsert', 'delete')),
  payload       jsonb not null,
  applied_at    timestamptz,
  outcome       text not null default 'recu'
                  check (outcome in ('recu', 'applique', 'conflit', 'rejete')),
  received_at   timestamptz not null default now(),
  unique (mutation_id)
);
create index on sync_mutations (school_id, received_at);

-- On enregistre les deux versions et on signale ; on ne choisit pas de
-- gagnant. Une note contestée mérite un humain, pas un algorithme de fusion.
create table sync_conflicts (
  id              uuid primary key default uuid_generate_v4(),
  school_id       uuid not null references schools(id) on delete cascade,
  mutation_id     uuid references sync_mutations(mutation_id),
  entity_type     text not null,
  entity_id       uuid,
  server_payload  jsonb,
  device_payload  jsonb,
  status          text not null default 'ouvert'
                    check (status in ('ouvert', 'resolu_serveur', 'resolu_appareil')),
  resolved_by     uuid references staff(id),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);
create index on sync_conflicts (school_id, status);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Une requête exécutée sans fasoschool.school_id posé ne voit rien. C'est la
-- base de données qui refuse, pas le code qui doit se souvenir.

-- Deux régimes.
--
-- 1. Cloisonnement strict : school_id = current_school_id(). Une ligne dont
--    school_id vaut NULL n'est JAMAIS visible — la comparaison rend NULL, donc
--    faux. C'est voulu pour users et audit_log, dont les lignes sans
--    établissement appartiennent à la plateforme.
--
-- 2. Référentiel partagé : subjects et calendar_events portent des lignes
--    nationales (school_id NULL) que tout établissement doit LIRE — les 24
--    matières officielles, le calendrier national. Sans la clause « or
--    school_id is null », le catalogue des matières est invisible et aucun
--    bulletin ne sort. En écriture, le régime reste strict : un établissement
--    ne peut pas créer de ligne nationale.

do $$
declare t text;
begin
  foreach t in array array[
    'campuses','academic_years','terms','classes',
    'users','staff','students','guardians','student_guardians','emergency_contacts',
    'enrolments','teacher_assignments','student_transfers',
    'grading_policies','mention_bands','coefficient_sets','coefficients','promotion_rules',
    'evaluations','grade_entries','grade_entry_revisions',
    'attendance_sessions','attendance_records','behavior_incidents',
    'bulletins','bulletin_lines','conseil_decisions','livret_entries','bulletin_templates',
    'fee_schedules','fee_lines','invoices','invoice_instalments','payments',
    'payment_events','receipts','scholarships',
    'category_assessments','category_criteria','ministry_reports',
    'announcements','sms_templates','sms_credit_ledger','sms_messages',
    'notification_preferences','documents',
    'user_roles','audit_log','devices','sync_mutations','sync_conflicts'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_tenant_isolation on %I using (school_id = current_school_id())'
      || ' with check (school_id = current_school_id())', t, t);
  end loop;

  -- Régime 2 : lecture du référentiel national, écriture cloisonnée.
  foreach t in array array['subjects', 'calendar_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy %I_tenant_read on %I for select'
      || ' using (school_id = current_school_id() or school_id is null)', t, t);
    execute format(
      'create policy %I_tenant_write on %I for insert'
      || ' with check (school_id = current_school_id())', t, t);
    execute format(
      'create policy %I_tenant_update on %I for update'
      || ' using (school_id = current_school_id())'
      || ' with check (school_id = current_school_id())', t, t);
    execute format(
      'create policy %I_tenant_delete on %I for delete'
      || ' using (school_id = current_school_id())', t, t);
  end loop;
end $$;

-- schools elle-même : on ne voit que le sien.
alter table schools enable row level security;
alter table schools force row level security;
create policy schools_tenant_isolation on schools
  using (id = current_school_id()) with check (id = current_school_id());
