-- ---------------------------------------------------------------------------
-- Les fêtes légales s'arrêtaient en 2028.
--
-- CE QUI A ÉTÉ TROUVÉ EN DÉPUNAISANT LA DÉMONSTRATION DE SON ANNÉE. La
-- migration 0010 sème les onze jours chômés de la loi du 9 janvier 2026 :
--
--     foreach an in array array[2026, 2027, 2028] loop
--
-- Trois années. Écrites en 2026, elles couvraient « cette année, la prochaine
-- et celle d'après » — et personne ne le remarquait, parce que le jeu de
-- démonstration était lui aussi épinglé sur 2026-2027, à l'intérieur de la
-- fenêtre.
--
-- Une école qui ouvre SchoolFaso à la rentrée 2029 n'a donc AUCUNE fête légale
-- au calendrier. Conséquences, dans l'ordre où elles se produisent :
--
--   * l'appel du matin s'ouvre le 25 décembre, le 1er janvier, le 8 mars ;
--   * le surveillant coche les absents d'une classe vide ;
--   * et quarante familles reçoivent « votre enfant est absent aujourd'hui »
--     le jour de Noël.
--
-- C'est exactement le défaut que 0010 avait été écrite pour empêcher, revenu
-- par la porte du temps qui passe.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION FAIT.
--
-- Elle prolonge la liste jusqu'en 2060, avec la même provenance. On PROJETTE
-- une loi de 2026 sur trente-quatre ans, et il faut le dire : `source_note`
-- porte le texte d'origine, de sorte qu'un directeur de 2041 voie sur quoi
-- repose la ligne qu'il lit, et puisse la corriger si la loi a changé.
--
-- Le choix est assumé, parce que l'alternative n'est pas neutre : une liste
-- qui s'arrête ne se lit pas « ces dates sont inconnues », elle se lit
-- « l'école travaille ce jour-là ». Un silence qui affirme.
--
-- Et parce qu'une liste finie finira toujours par finir, le tableau de bord
-- surveille désormais ce qu'il sait : si l'année scolaire en cours ne porte
-- AUCUNE fête nationale, il le dit, au lieu de laisser l'appel s'ouvrir un
-- 25 décembre.
-- ---------------------------------------------------------------------------

do $$
declare
  an int;
  provenance text := 'Loi du 9 janvier 2026 (ALT) — 11 jours chômés et payés. '
    || 'Sources : Assemblée législative de transition (an.bf/545), AIB. '
    || 'Ascension, Aïd el-Fitr, Tabaski et Maouloud sont chômés aussi mais '
    || 'mobiles : à saisir chaque année par l''établissement. '
    || 'Dates projetées jusqu''en 2060 par la migration 0020 : la loi de 2026 '
    || 'est reportée telle quelle sur les années à venir. Si elle change, ces '
    || 'lignes sont à corriger.';
begin
  foreach an in array array(select generate_series(2026, 2060)) loop
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

-- ---------------------------------------------------------------------------
-- Jusqu'où va le calendrier légal, et l'année en cours y est-elle ?
create or replace function fetes_legales_jusqu_a()
returns integer language sql stable as $$
  select coalesce(max(extract(year from starts_on))::int, 0)
    from calendar_events
   where school_id is null and closes_school;
$$;

comment on function fetes_legales_jusqu_a() is
  'La dernière année civile pour laquelle des fêtes légales sont inscrites. '
  'Au-delà, l''appel du matin s''ouvrirait un 25 décembre : une liste qui '
  's''arrête ne se lit pas « je ne sais pas », elle se lit « l''école '
  'travaille ».';

create or replace function annee_sans_fetes_legales(p_year uuid)
returns boolean language sql stable as $$
  select not exists (
    select 1 from calendar_events ce, academic_years ay
     where ay.id = p_year
       and ce.school_id is null and ce.closes_school
       and ce.starts_on between ay.starts_on and ay.ends_on);
$$;

comment on function annee_sans_fetes_legales(uuid) is
  'Vrai quand cette année scolaire ne porte AUCUNE fête nationale fermant '
  'l''école. C''est la forme que prend, pour une école donnée, l''expiration '
  'du calendrier légal — et c''est ce que le tableau de bord surveille.';
