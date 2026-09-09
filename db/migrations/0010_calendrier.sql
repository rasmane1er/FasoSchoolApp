-- ---------------------------------------------------------------------------
-- Le calendrier scolaire — la table que personne ne lisait.
--
-- `calendar_events` existe depuis la migration 0001. Aucune ligne de code
-- applicative ne l'a jamais ouverte. Pendant ce temps, l'appel acceptait
-- n'importe quelle date :
--
--   ?date=xyz          → erreur PostgreSQL brute à l'écran (22P02)
--   ?date=             → idem
--   ?date=1999-01-01   → accepté, appel enregistré
--   ?date=2027-12-25   → accepté, six mois APRÈS la fin de l'année scolaire
--   ?date=2026-12-25   → accepté, jour de Noël
--
-- Ce n'est pas un défaut d'affichage. L'appel ENVOIE UN SMS à chaque famille
-- d'élève absent, à 8 FCFA le message. « Votre enfant est absent aujourd'hui »
-- un dimanche, ou pendant les congés, est le message le plus destructeur que
-- ce produit puisse émettre : le parent sait, lui, que son enfant n'avait pas
-- école. Une fois suffit pour que plus personne ne croie les suivants.
--
-- Cette migration donne au produit de quoi savoir quel jour l'école est
-- ouverte. Trois pièces :
--
--   1. `schools.school_days` — quels jours de la semaine l'école travaille.
--      Une DONNÉE, pas une constante dans le code : la semaine varie d'un
--      établissement à l'autre, et personne ici ne peut la deviner.
--   2. `calendar_events.closes_school` — un événement ferme-t-il l'école ?
--      Une composition n'est pas un congé ; une journée commémorative non
--      chômée non plus.
--   3. Les sept fêtes légales à date fixe, en lignes nationales.
--
-- ---------------------------------------------------------------------------
-- SUR LES FÊTES LÉGALES : LA LISTE A CHANGÉ EN JANVIER 2026.
--
-- La loi adoptée le 9 janvier 2026 par l'Assemblée législative de transition
-- fait passer les jours chômés et payés de 15 à 11, et sépare désormais les
-- « fêtes légales » (chômées) des « journées commémoratives » (célébrées sans
-- interruption du travail).
--
-- Ont CESSÉ d'être chômés : le 3 janvier (soulèvement de 1966), les 4 et
-- 5 août (proclamation de l'Indépendance), le 15 octobre, le 31 octobre
-- (Journée des martyrs) et le 1er novembre (Toussaint). La loi supprime aussi
-- le lundi de rattrapage quand une fête tombe un dimanche.
--
-- Toute liste antérieure à 2026 est fausse aujourd'hui — y compris celle que
-- l'on croit connaître. Elles sont donc seedées avec leur provenance.
--
-- LES QUATRE FÊTES MOBILES NE SONT PAS SEEDÉES. Ascension, Aïd el-Fitr,
-- Tabaski et Maouloud sont chômées, mais leurs dates ne se calculent pas
-- d'ici : les deux dernières dépendent de l'observation de la lune au Burkina
-- et sont annoncées chaque année. Les inventer serait pire que les omettre —
-- une école fermée un jour où le logiciel la croit ouverte se voit reprocher
-- des absences qui n'existent pas. L'écran du calendrier les réclame donc à
-- l'établissement, année par année, et dit lesquelles manquent.
-- ---------------------------------------------------------------------------

-- 1. La semaine de l'établissement -------------------------------------------
--
-- Numérotation ISO : 1 = lundi … 7 = dimanche. Le défaut lundi-vendredi est
-- une supposition, pas une source : beaucoup d'établissements burkinabè
-- travaillent aussi le samedi matin. D'où le source_note, comme pour les
-- autres règles non vérifiées — et une sixième ligne dans la liste des règles
-- à faire confirmer par un censeur.
alter table schools
  add column if not exists school_days smallint[] not null default '{1,2,3,4,5}',
  add column if not exists school_days_note text;

update schools set school_days_note =
  'DÉFAUT NON VÉRIFIÉ — lundi à vendredi. Beaucoup d''établissements '
  || 'travaillent le samedi matin. À confirmer auprès de l''établissement.'
 where school_days_note is null;

do $$
begin
  alter table schools
    add constraint schools_school_days_valides check (
      array_length(school_days, 1) between 1 and 7
      and school_days <@ '{1,2,3,4,5,6,7}'::smallint[]
    );
exception when duplicate_object then null;  -- migration rejouable
end $$;

-- 2. Un événement ferme-t-il l'école ? ---------------------------------------
alter table calendar_events
  add column if not exists closes_school boolean not null default true,
  add column if not exists source_note text,
  add column if not exists created_at timestamptz not null default now();

comment on column calendar_events.closes_school is
  'Vrai : ce jour-là, pas d''appel et pas de SMS. Faux : le jour est signalé '
  'dans le calendrier mais l''école travaille — une composition, un conseil '
  'de classe, ou une journée commémorative non chômée.';

-- Deux fois la même fête pour la même école le même jour n'a pas de sens, et
-- rejouer la migration ne doit pas en créer une seconde. `coalesce` parce
-- qu'un index unique ignore les lignes dont une colonne est nulle — et les
-- lignes nationales ont précisément school_id à null.
create unique index if not exists calendar_events_sans_doublon
  on calendar_events (coalesce(school_id, '00000000-0000-0000-0000-000000000000'::uuid),
                      starts_on, label);

-- 3. Les sept fêtes légales à date fixe, pour trois années scolaires ---------
--
-- Lignes nationales (school_id null) : la politique RLS
-- `calendar_events_tenant_read` les rend lisibles par tous, et
-- `calendar_events_tenant_delete` empêche une école de supprimer celles d'une
-- autre — ou les nationales.
do $$
declare
  an int;
  provenance text := 'Loi du 9 janvier 2026 (ALT) — 11 jours chômés et payés. '
    || 'Sources : Assemblée législative de transition (an.bf/545), AIB. '
    || 'Ascension, Aïd el-Fitr, Tabaski et Maouloud sont chômés aussi mais '
    || 'mobiles : à saisir chaque année par l''établissement.';
begin
  foreach an in array array[2026, 2027, 2028] loop
    insert into calendar_events
      (school_id, region, label, event_type, starts_on, ends_on,
       closes_school, source_note)
    values
      (null, null, 'Jour de l''An', 'fete',
        make_date(an, 1, 1), make_date(an, 1, 1), true, provenance),
      (null, null, 'Journée internationale de la femme', 'fete',
        make_date(an, 3, 8), make_date(an, 3, 8), true, provenance),
      (null, null, 'Fête du Travail', 'fete',
        make_date(an, 5, 1), make_date(an, 5, 1), true, provenance),
      (null, null, 'Journée des coutumes et traditions', 'fete',
        make_date(an, 5, 15), make_date(an, 5, 15), true, provenance),
      (null, null, 'Assomption', 'fete',
        make_date(an, 8, 15), make_date(an, 8, 15), true, provenance),
      (null, null, 'Fête nationale', 'fete',
        make_date(an, 12, 11), make_date(an, 12, 11), true, provenance),
      (null, null, 'Noël', 'fete',
        make_date(an, 12, 25), make_date(an, 12, 25), true, provenance)
    on conflict do nothing;

    -- Les journées commémoratives. Elles NE ferment PAS l'école depuis la loi
    -- de 2026 — c'est tout l'objet de la réforme. On les inscrit quand même :
    -- un directeur qui voit « 31 octobre — Journée des martyrs (l'école
    -- travaille) » sait que le logiciel n'a pas oublié la date, et peut
    -- décider de fermer lui-même. Une absence de ligne se lit comme un oubli.
    insert into calendar_events
      (school_id, region, label, event_type, starts_on, ends_on,
       closes_school, source_note)
    values
      (null, null, 'Soulèvement populaire de 1966 (commémoration)', 'autre',
        make_date(an, 1, 3), make_date(an, 1, 3), false, provenance),
      (null, null, 'Proclamation de l''Indépendance (commémoration)', 'autre',
        make_date(an, 8, 5), make_date(an, 8, 5), false, provenance),
      (null, null, 'Journée nationale des martyrs (commémoration)', 'autre',
        make_date(an, 10, 31), make_date(an, 10, 31), false, provenance),
      (null, null, 'Toussaint (commémoration)', 'autre',
        make_date(an, 11, 1), make_date(an, 11, 1), false, provenance)
    on conflict do nothing;
  end loop;
end $$;

-- 4. Les quatre fêtes mobiles qu'il faut réclamer ----------------------------
--
-- Une fonction plutôt qu'une liste en dur dans l'écran : ce que
-- l'établissement doit saisir est une règle du domaine, et l'écran comme les
-- tests doivent lire la MÊME liste.
create or replace function fetes_mobiles_manquantes(p_debut date, p_fin date)
returns table (label text) language sql stable as $$
  select f.label
    from (values ('Ascension'), ('Aïd el-Fitr'), ('Tabaski'), ('Maouloud'))
         as f(label)
   where not exists (
     select 1 from calendar_events ce
      where ce.starts_on between p_debut and p_fin
        and ce.closes_school
        and lower(ce.label) like '%' || lower(f.label) || '%')
   order by f.label;
$$;

comment on function fetes_mobiles_manquantes(date, date) is
  'Les fêtes chômées dont la date ne se calcule pas d''ici — Tabaski et '
  'Aïd el-Fitr dépendent de l''observation de la lune au Burkina. L''écran '
  'du calendrier les réclame à l''établissement, année par année.';
