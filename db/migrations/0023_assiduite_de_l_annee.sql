-- ---------------------------------------------------------------------------
-- « Assiduité et conduite DE L'ANNÉE ». Ce n'était l'année de personne.
--
-- CE QUI A ÉTÉ TROUVÉ EN DONNANT UN PASSÉ À UN ÉLÈVE. On ajoute au jeu de
-- démonstration une année scolaire close — l'élève avait redoublé — avec six
-- absences et deux faits de discipline, tous vieux de deux ans. Puis on relit
-- les écrans d'aujourd'hui, sans rien toucher d'autre :
--
--   * LE CONSEIL DE CLASSE passe de « 0 0 0 » à « 6 dont 6 non justifiées / 0 /
--     2 aucune suite donnée ». Six absences et deux faits d'une année close
--     depuis deux ans s'installent sur l'écran qui décide de CETTE année — et
--     au-delà de dix jours, le chiffre passe en laterite pour que le conseil
--     le regarde ;
--   * LA FICHE DE L'ÉLÈVE affiche « Absences relevées : 6 » pour un élève qui
--     n'en a aucune cette année ;
--   * L'ESPACE FAMILLE affiche l'enfant dans la classe de l'an dernier, sous le
--     libellé du trimestre en cours, avec les six absences.
--
-- LE COMMENTAIRE, DANS `conseil.ts`, AU-DESSUS DE LA REQUÊTE :
--
--     /* Assiduité et conduite DE L'ANNÉE, par élève. Un conseil de classe
--        burkinabè délibère sur « travail, assiduité et conduite » : ne montrer
--        que la moyenne, c'est délibérer sur un tiers du dossier. */
--
-- L'intention était juste et écrite. La requête ne la tenait pas.
--
-- ---------------------------------------------------------------------------
-- POURQUOI LE FILTRE NE FILTRAIT PAS. Il était là, pourtant :
--
--     from enrolments e
--     left join attendance_records ar on ar.student_id = e.student_id
--     left join attendance_sessions ses on ses.id = ar.attendance_session_id
--                                      and ses.class_id = e.class_id
--     where e.class_id = $1
--
-- `ses.class_id = e.class_id` est dans le ON d'une jointure EXTERNE. Il ne
-- retire aucune ligne de `ar` : il met `ses` à NULL quand il n'est pas
-- satisfait, et `ar` reste, et `count(*) filter (where ar.status = 'absent')`
-- la compte. Le filtre a l'apparence d'un filtre et le comportement d'un
-- commentaire.
--
-- Les deux autres écrans ne prétendaient même pas filtrer :
--
--     select count(*) from attendance_records ar where ar.student_id = $1
--
-- ET DANS LA MÊME FONCTION QUE LA FICHE. `loadFiche` choisit la classe avec un
-- soin visible — « l'inscription de l'année en cours, sinon la plus récente » —
-- puis compte les absences et lit les bulletins sans aucune borne d'année,
-- trente lignes plus bas. Un élève de deuxième année y voyait deux tuiles
-- « 1er trimestre », côte à côte, sans rien pour les distinguer.
--
-- QUI CELA TOUCHE. Le redoublant — c'est-à-dire précisément l'élève dont on
-- délibère le cas, et celui dont le dossier pèse le plus lourd. Ses chiffres
-- doublent, dans le sens qui l'accable, sur les trois écrans à la fois.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE. Un seul endroit où l'assiduité d'une année se
-- compte, et un seul où sa conduite se compte — de sorte que les quatre écrans
-- ne puissent plus diverger, et qu'ajouter un cinquième ne rouvre pas la
-- question.
--
-- Et `annees_anterieures()`, qui est le vrai remède : le passé d'un élève n'est
-- pas à jeter, il est à DATER. La fiche le montre désormais année par année,
-- nommée, au lieu de l'additionner en silence au présent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- L'année scolaire dont parlent les écrans quand ils ne disent rien.
create or replace function annee_en_cours()
returns uuid language sql stable as $$
  select id from academic_years
   order by (status = 'en_cours') desc, starts_on desc limit 1;
$$;

comment on function annee_en_cours() is
  'L''année scolaire en cours — celle que tout écran désigne implicitement. '
  'Les requêtes qui l''écrivaient chacune à leur façon finissaient par ne plus '
  'parler de la même.';

-- ---------------------------------------------------------------------------
-- L'assiduité d'un élève SUR UNE ANNÉE.
--
-- La borne passe par la classe : une séance d'appel appartient à une classe,
-- une classe à une année. C'est un JOIN interne, pas un LEFT JOIN — c'est toute
-- la différence entre filtrer et commenter.
create or replace function assiduite_de_l_annee(p_student uuid, p_year uuid)
returns table (absences integer, non_justifiees integer, retards integer)
language sql stable as $$
  select count(*) filter (where ar.status = 'absent')::int,
         count(*) filter (where ar.status = 'absent'
                            and not ar.is_justified)::int,
         count(*) filter (where ar.status = 'retard')::int
    from attendance_records ar
    join attendance_sessions ses on ses.id = ar.attendance_session_id
    join classes cl on cl.id = ses.class_id
   where ar.student_id = p_student
     and cl.academic_year_id = p_year;
$$;

comment on function assiduite_de_l_annee(uuid, uuid) is
  'Absences, absences non justifiées et retards d''un élève SUR CETTE '
  'ANNÉE-LÀ. La borne passe par la classe de la séance : c''est une jointure '
  'interne, et c''est toute la différence avec le ON d''une jointure externe, '
  'qui a l''apparence d''un filtre et le comportement d''un commentaire.';

-- ---------------------------------------------------------------------------
-- La conduite d'un élève SUR UNE ANNÉE.
--
-- `behavior_incidents` porte `term_id`, souvent nul, et `occurred_on`, jamais
-- nul. On borne donc par la date, entre l'ouverture et la clôture de l'année —
-- la seule information dont on soit sûr.
create or replace function conduite_de_l_annee(p_student uuid, p_year uuid)
returns table (incidents integer, lourdes integer, sans_suite integer)
language sql stable as $$
  select count(*)::int,
         count(*) filter (where bi.sanction in
           ('exclusion_temporaire', 'exclusion_definitive'))::int,
         count(*) filter (where coalesce(bi.sanction, '') = '')::int
    from behavior_incidents bi
    join academic_years ay on ay.id = p_year
   where bi.student_id = p_student
     and bi.retracted_at is null
     and bi.occurred_on between ay.starts_on and ay.ends_on;
$$;

comment on function conduite_de_l_annee(uuid, uuid) is
  'Faits consignés, sanctions lourdes et faits restés sans suite d''un élève '
  'SUR CETTE ANNÉE-LÀ. Borné par `occurred_on` : `term_id` est souvent nul, '
  'la date ne l''est jamais.';

-- ---------------------------------------------------------------------------
-- Le passé, DATÉ.
--
-- C'est le vrai remède, et pas seulement le correctif. Le passé d'un élève
-- n'est pas à jeter : il est à nommer. La fiche le montre année par année, avec
-- sa classe et son niveau, au lieu de l'additionner en silence au présent —
-- comme le fait déjà `livret_entries` pour les décisions de conseil.
create or replace function annees_anterieures(p_student uuid, p_year uuid)
returns table (annee text, classe text, level_code text,
               absences integer, incidents integer)
language sql stable as $$
  select ay.label, cl.label, cl.level_code,
         (select a.absences from assiduite_de_l_annee(p_student, ay.id) a),
         (select k.incidents from conduite_de_l_annee(p_student, ay.id) k)
    from enrolments e
    join classes cl on cl.id = e.class_id
    join academic_years ay on ay.id = e.academic_year_id
   where e.student_id = p_student
     and e.academic_year_id is distinct from p_year
   order by ay.starts_on desc;
$$;

comment on function annees_anterieures(uuid, uuid) is
  'Les années que cet élève a déjà passées dans l''établissement, chacune avec '
  'sa classe et ses chiffres. Un redoublant en a une ; ses absences d''alors '
  'étaient comptées dans celles d''aujourd''hui, sur l''écran qui décide de '
  'son année.';

-- ---------------------------------------------------------------------------
-- L'inscription de l'élève POUR UNE ANNÉE.
--
-- L'espace famille joignait toutes les inscriptions sans borne : un enfant de
-- deuxième année y figurait deux fois, dont une sous la classe d'une année
-- close, avec le libellé du trimestre en cours au-dessus. Un parent lisait la
-- classe de l'an dernier comme la classe d'aujourd'hui.
create or replace function inscription_de_l_annee(p_student uuid, p_year uuid)
returns table (class_id uuid, classe text, level_code text, statut text)
language sql stable as $$
  select cl.id, cl.label, cl.level_code, e.status
    from enrolments e
    join classes cl on cl.id = e.class_id
   where e.student_id = p_student
     and e.academic_year_id = p_year
   limit 1;
$$;

comment on function inscription_de_l_annee(uuid, uuid) is
  'La classe de cet élève pour cette année-là, s''il y est inscrit. Aucune '
  'ligne sinon — et « aucune ligne » doit se lire « pas inscrit cette année », '
  'jamais « voici sa classe de l''an dernier ».';
