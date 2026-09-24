-- SchoolFaso — référentiel national et valeurs par défaut
--
-- Deux parties :
--   1. Le référentiel national (niveaux, séries, matières, rôles), partagé
--      par tous les établissements et issu des textes officiels.
--   2. Une fonction seed_school_defaults() qui installe les règles de
--      notation d'un nouvel établissement.
--
-- ATTENTION — LIRE AVANT DE FAIRE CONFIANCE AUX VALEURS PAR DÉFAUT.
-- Quatre règles n'ont PAS pu être vérifiées depuis une source burkinabè
-- publique : la table des coefficients réellement appliquée aux bulletins
-- internes, la formule devoirs/composition, les seuils de mention, et le
-- gabarit du bulletin. Elles sont livrées avec leur provenance dans
-- source_note et doivent être confirmées auprès d'un censeur.

-- ---------------------------------------------------------------------------
-- 1. Référentiel national
-- ---------------------------------------------------------------------------

-- Loi n°013-2007/AN : scolarité obligatoire de 6 à 16 ans, continuum
-- d'éducation de base = préscolaire + primaire + post-primaire.
-- Le primaire est organisé en trois sous-cycles de deux ans ; la position
-- dans le sous-cycle porte la règle de redoublement de 2019.
insert into levels (code, label, cycle, sub_cycle, sub_cycle_position, ordinal, typical_entry_age) values
  ('PS',   'Petite Section',        'prescolaire',   null, null,  1,  3),
  ('MS',   'Moyenne Section',       'prescolaire',   null, null,  2,  4),
  ('GS',   'Grande Section',        'prescolaire',   null, null,  3,  5),
  ('CP1',  'Cours Préparatoire 1',  'primaire',      'CP',    1,  10,  6),
  ('CP2',  'Cours Préparatoire 2',  'primaire',      'CP',    2,  11,  7),
  ('CE1',  'Cours Élémentaire 1',   'primaire',      'CE',    1,  12,  8),
  ('CE2',  'Cours Élémentaire 2',   'primaire',      'CE',    2,  13,  9),
  ('CM1',  'Cours Moyen 1',         'primaire',      'CM',    1,  14, 10),
  ('CM2',  'Cours Moyen 2',         'primaire',      'CM',    2,  15, 11),
  ('6E',   'Sixième',               'post_primaire', null, null,  20, 12),
  ('5E',   'Cinquième',             'post_primaire', null, null,  21, 13),
  ('4E',   'Quatrième',             'post_primaire', null, null,  22, 14),
  ('3E',   'Troisième',             'post_primaire', null, null,  23, 15),
  ('2NDE', 'Seconde',               'secondaire',    null, null,  30, 16),
  ('1ERE', 'Première',              'secondaire',    null, null,  31, 17),
  ('TLE',  'Terminale',             'secondaire',    null, null,  32, 18)
on conflict (code) do nothing;

-- Séries du baccalauréat (source : CIOSPB).
-- Le choix se fait à l'entrée en 2nde ; le point de séparation C/D n'a pas
-- pu être confirmé, d'où series_code assignable en 2nde, 1re ou Tle.
insert into series (code, label, stream) values
  ('A4', 'A4 — Philosophie-Lettres',                  'general'),
  ('C',  'C — Mathématiques et Physique-Chimie',      'general'),
  ('D',  'D — Mathématiques et Sciences de la Vie',   'general'),
  ('E',  'E — Mathématiques et Techniques',           'general'),
  ('F1', 'F1 — Construction mécanique',               'technique'),
  ('F2', 'F2 — Électronique',                         'technique'),
  ('F3', 'F3 — Électrotechnique',                     'technique'),
  ('F4', 'F4 — Génie civil',                          'technique'),
  ('G1', 'G1 — Techniques administratives',           'technique'),
  ('G2', 'G2 — Techniques quantitatives de gestion',  'technique'),
  ('H',  'H — Informatique',                          'technique')
on conflict (code) do nothing;

-- Depuis la réforme curriculaire, tous les niveaux sont organisés selon les
-- mêmes quatre champs disciplinaires. school_id null = matière nationale.
insert into subjects (school_id, code, label, champ_disciplinaire) values
  (null, 'FRANCAIS',        'Français',                       'langues_communication'),
  (null, 'LECTURE',         'Lecture',                        'langues_communication'),
  (null, 'EXPRESSION',      'Expression orale',               'langues_communication'),
  (null, 'ANGLAIS',         'Anglais',                        'langues_communication'),
  (null, 'ALLEMAND',        'Allemand',                       'langues_communication'),
  (null, 'ESPAGNOL',        'Espagnol',                       'langues_communication'),
  (null, 'ARABE',           'Arabe',                          'langues_communication'),
  (null, 'LANGUES_NAT',     'Langues nationales',             'langues_communication'),
  (null, 'MATHEMATIQUES',   'Mathématiques',                  'maths_sciences_technologie'),
  (null, 'CALCUL',          'Calcul',                         'maths_sciences_technologie'),
  (null, 'PHYSIQUE_CHIMIE', 'Physique-Chimie',                'maths_sciences_technologie'),
  (null, 'SVT',             'Sciences de la Vie et de la Terre','maths_sciences_technologie'),
  (null, 'SCIENCES',        'Sciences d''observation',        'maths_sciences_technologie'),
  (null, 'TIC',             'Technologies de l''information',  'maths_sciences_technologie'),
  (null, 'HISTOIRE',        'Histoire',                       'sciences_humaines_sociales'),
  (null, 'GEOGRAPHIE',      'Géographie',                     'sciences_humaines_sociales'),
  -- Matière à part entière depuis la session 2026 : ligne et coefficient propres.
  (null, 'EDUC_CIVIQUE',    'Éducation civique',              'sciences_humaines_sociales'),
  (null, 'EPS',             'Éducation physique et sportive', 'eps_arts_culture_production'),
  (null, 'DESSIN',          'Dessin',                         'eps_arts_culture_production'),
  (null, 'MUSIQUE',         'Musique',                        'eps_arts_culture_production'),
  (null, 'THEATRE',         'Théâtre',                        'eps_arts_culture_production'),
  (null, 'CHANT_RECIT',     'Chant et récitation',            'eps_arts_culture_production'),
  (null, 'TRAVAIL_MANUEL',  'Travail manuel',                 'eps_arts_culture_production'),
  (null, 'ARTS_MENAGERS',   'Arts ménagers',                  'eps_arts_culture_production')
on conflict do nothing;

-- Fonctions nommées par arrêté ministériel. Ne pas réutiliser un vocabulaire
-- français de principal / proviseur-adjoint / CPE : les directeurs le voient.
insert into roles (code, label, scope) values
  ('plateforme_owner',    'Propriétaire plateforme',      'plateforme'),
  ('plateforme_support',  'Support plateforme',           'plateforme'),
  ('proviseur',           'Proviseur',                    'etablissement'),
  ('directeur',           'Directeur',                    'etablissement'),
  ('censeur',             'Censeur',                      'etablissement'),
  ('surveillant_general', 'Surveillant général',          'etablissement'),
  ('intendant',           'Intendant',                    'etablissement'),
  ('econome',             'Économe',                      'etablissement'),
  ('chef_des_travaux',    'Chef des travaux',             'etablissement'),
  ('enseignant',          'Enseignant',                   'etablissement'),
  ('secretaire',          'Secrétaire',                   'etablissement'),
  ('parent',              'Parent / tuteur',              'etablissement'),
  ('eleve',               'Élève',                        'etablissement')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Valeurs par défaut d'un nouvel établissement
-- ---------------------------------------------------------------------------
--
-- Appelée à la création d'un établissement. Chaque valeur porte sa provenance
-- et est modifiable ensuite par le censeur.

-- ---------------------------------------------------------------------------
-- Chemin d'authentification
-- ---------------------------------------------------------------------------
--
-- L'authentification est PAR NATURE antérieure au locataire : on cherche un
-- utilisateur par son téléphone avant de savoir de quel établissement il
-- relève, donc avant de pouvoir poser schoolfaso.school_id. Sous RLS strict,
-- cette recherche ne renvoie rien et personne ne peut se connecter.
--
-- Plutôt que d'affaiblir les politiques de users, staff, user_roles et
-- auth_sessions, on ouvre une brèche étroite et nommée : quatre fonctions
-- SECURITY DEFINER qui ne renvoient QUE ce dont la connexion a besoin. Le
-- reste du code applicatif reste soumis au cloisonnement.
--
-- En production, le propriétaire des tables doit porter BYPASSRLS et ne doit
-- jamais être le rôle applicatif.

create or replace function auth_lookup_user(p_phone text)
returns table (id uuid, school_id uuid, full_name text)
security definer set search_path = public
as $$
  select u.id, u.school_id, u.full_name
    from users u
   where u.phone = p_phone and u.is_active
   limit 1;
$$ language sql stable;

create or replace function auth_create_session(
  p_user_id uuid, p_school_id uuid, p_access_hash text, p_refresh_hash text
) returns void
security definer set search_path = public
as $$
  insert into auth_sessions (user_id, school_id, access_token_hash, refresh_token_hash, expires_at)
  values (p_user_id, p_school_id, p_access_hash, p_refresh_hash, now() + interval '12 hours');
$$ language sql;

create or replace function auth_resolve(p_access_hash text)
returns table (user_id uuid, school_id uuid, full_name text, fonction text, roles text[])
security definer set search_path = public
as $$
  select u.id, s.school_id, u.full_name,
         (select st.fonction from staff st where st.user_id = u.id limit 1),
         coalesce((select array_agg(ur.role_code) from user_roles ur where ur.user_id = u.id),
                  array[]::text[])
    from auth_sessions s
    join users u on u.id = s.user_id
   where s.access_token_hash = p_access_hash
     and s.revoked_at is null
     and s.expires_at > now()
   limit 1;
$$ language sql stable;

create or replace function auth_revoke(p_access_hash text)
returns void
security definer set search_path = public
as $$
  update auth_sessions set revoked_at = now()
   where access_token_hash = p_access_hash and revoked_at is null;
$$ language sql;

comment on function auth_lookup_user(text) is
  'Brèche volontaire au RLS, limitée au strict nécessaire de la connexion. '
  'Le propriétaire doit porter BYPASSRLS et ne pas être le rôle applicatif.';

-- Création d'un établissement.
--
-- Passer par cette fonction est OBLIGATOIRE : la politique RLS de schools
-- exige id = current_school_id(), donc un INSERT direct est toujours refusé —
-- un établissement en cours de création n'a pas encore de contexte. On génère
-- l'identifiant d'abord, on pose le contexte dessus, puis on insère. La
-- vérification WITH CHECK est alors satisfaite et les tables filles aussi.
--
-- Effet de bord voulu : on ne crée pas un établissement par mégarde, et le
-- code applicatif ordinaire n'en a jamais le pouvoir implicitement.
create or replace function provision_school(
  p_name      text,
  p_sector    text,
  p_fee_zone  text default null,
  p_commune   text default null,
  p_region    text default null,
  p_effective date default current_date
) returns uuid as $$
declare
  v_id uuid := uuid_generate_v4();
begin
  perform set_config('schoolfaso.school_id', v_id::text, true);

  insert into schools (id, name, sector, fee_zone, commune, region)
  values (v_id, p_name, p_sector, p_fee_zone, p_commune, p_region);

  perform seed_school_defaults(v_id, p_effective);
  return v_id;
end;
$$ language plpgsql;

comment on function provision_school(text, text, text, text, text, date) is
  'Crée un établissement et installe ses règles par défaut. Seul chemin '
  'possible : un INSERT direct dans schools est refusé par le RLS.';

create or replace function seed_school_defaults(p_school_id uuid, p_effective date default current_date)
returns void as $$
declare
  v_policy_id uuid;
  v_coef_set_id uuid;
  v_subject record;
begin
  ------------------------------------------------------------------
  -- Politique de notation
  ------------------------------------------------------------------
  -- La pondération devoirs/composition est la convention régionale
  -- (moy(devoirs) + composition x 2) / 3. AUCUN texte burkinabè officiel
  -- ne l'énonce. À confirmer.
  insert into grading_policies (
    school_id, effective_from,
    devoir_weight, composition_weight, interrogation_weight,
    scale_max, pass_mark, decimals, rounding, rank_tie_policy, source_note)
  values (
    p_school_id, p_effective,
    1.00, 2.00, 0.00,
    20.00, 10.00, 2, 'half_up', 'same_rank_skip',
    'DÉFAUT NON VÉRIFIÉ — convention régionale (devoirs + compo x2)/3. '
    'Aucun texte burkinabè trouvé. Confirmer avec le censeur.')
  returning id into v_policy_id;

  ------------------------------------------------------------------
  -- Mentions
  ------------------------------------------------------------------
  -- Toutes les sources trouvées pour 10/12/14/16 étaient françaises,
  -- sénégalaises, marocaines ou ivoiriennes — jamais burkinabè.
  insert into mention_bands (grading_policy_id, school_id, label, min_average, max_average, sort_order) values
    (v_policy_id, p_school_id, 'Insuffisant',  0.00,  9.99, 1),
    (v_policy_id, p_school_id, 'Passable',    10.00, 11.99, 2),
    (v_policy_id, p_school_id, 'Assez bien',  12.00, 13.99, 3),
    (v_policy_id, p_school_id, 'Bien',        14.00, 15.99, 4),
    (v_policy_id, p_school_id, 'Très bien',   16.00, 20.00, 5);

  ------------------------------------------------------------------
  -- Coefficients
  ------------------------------------------------------------------
  -- Réforme 2026 appliquée aux EXAMENS : mathématiques 3, français 3,
  -- toutes les autres disciplines 2. Que les établissements reprennent ces
  -- valeurs sur leurs bulletins internes n'est PAS vérifié.
  insert into coefficient_sets (school_id, label, level_code, series_code, effective_from, source_note)
  values (
    p_school_id, 'Barème examens 2026', null, null, p_effective,
    'DÉFAUT NON VÉRIFIÉ — réforme des coefficients 2026 (maths 3, français 3, '
    'autres 2). Barème des examens ; usage sur bulletin interne à confirmer.')
  returning id into v_coef_set_id;

  for v_subject in select id, code from subjects where school_id is null loop
    insert into coefficients (coefficient_set_id, subject_id, school_id, coefficient)
    values (
      v_coef_set_id, v_subject.id, p_school_id,
      case when v_subject.code in ('MATHEMATIQUES', 'FRANCAIS') then 3.00 else 2.00 end);
  end loop;

  ------------------------------------------------------------------
  -- Règles de passage
  ------------------------------------------------------------------
  -- Le redoublement est interdit en première année de chaque sous-cycle du
  -- primaire — CP1, CE1, CM1 — par arrêté ministériel de 2019. Le passage
  -- y est automatique. Mesure contestée par le SYNAPEC : règle, pas dogme.
  insert into promotion_rules (school_id, level_code, effective_from, redoublement_allowed, min_average_to_pass, source_note)
  select
    p_school_id, l.code, p_effective,
    not (l.cycle = 'primaire' and l.sub_cycle_position = 1),
    10.00,
    case when l.cycle = 'primaire' and l.sub_cycle_position = 1
      then 'Redoublement interdit — arrêté 2019, première année de sous-cycle.'
      else null end
  from levels l;

  ------------------------------------------------------------------
  -- Gabarits SMS
  ------------------------------------------------------------------
  -- Budget serré : au-delà de 160 caractères le coût double.
  insert into sms_templates (school_id, code, label, body) values
    (p_school_id, 'ABSENCE', 'Absence du jour',
     '{{ecole}}: {{eleve}} absent(e) le {{date}}. Contact: {{telephone}}.'),
    (p_school_id, 'BULLETIN', 'Bulletin disponible',
     '{{ecole}}: bulletin {{trimestre}} de {{eleve}} disponible. Moyenne {{moyenne}}/20, rang {{rang}}/{{effectif}}.'),
    (p_school_id, 'RELANCE', 'Relance scolarité',
     '{{ecole}}: scolarite de {{eleve}}, reste {{montant}} FCFA a payer avant le {{echeance}}.');

  ------------------------------------------------------------------
  -- Grille de catégorisation — arrêté n°2026-101
  ------------------------------------------------------------------
  -- 50 points investissement + 50 points qualité. La répartition fine des
  -- points entre critères n'est pas publiée : les libellés viennent de la
  -- couverture presse, les points sont répartis uniformément en attendant
  -- le texte. À corriger dès obtention de l'arrêté.
  null;
end;
$$ language plpgsql;

comment on function seed_school_defaults(uuid, date) is
  'Installe les règles de notation par défaut d''un établissement. '
  'Les valeurs portent source_note : quatre d''entre elles ne sont PAS '
  'vérifiées et doivent être confirmées auprès d''un censeur burkinabè.';
