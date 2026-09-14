-- ---------------------------------------------------------------------------
-- La règle de passage était datée. L'écran qui décide de l'année d'un enfant
-- ne lisait pas la date.
--
-- LA PREMIÈRE RÈGLE D'INGÉNIERIE DE CE DÉPÔT, écrite dans le README depuis le
-- premier jour : « les règles pédagogiques sont des données datées. Le
-- ministère a modifié les coefficients ET la règle de redoublement en 2026. Un
-- `if` dans le code serait faux avant la fin de l'année scolaire. »
--
-- `src/lib/repository.ts` l'applique à la lettre pour les coefficients et pour
-- la politique de notation :
--
--     where effective_from <= $1
--     ...
--     if (pol.rowCount === 0) throw new Error("Aucune politique en vigueur.")
--
-- `src/server/conseil.ts` — le conseil de classe, l'écran qui prononce
-- redoublement ou passage — lisait la même famille de table ainsi :
--
--     select redoublement_allowed, min_average_to_pass, source_note
--       from promotion_rules
--      where (level_code = $1 or level_code is null)
--      order by level_code nulls last, effective_from desc limit 1
--
-- Pas de borne de date. Pas d'erreur quand il n'y a rien.
--
-- ---------------------------------------------------------------------------
-- CE QUE LA SONDE A MONTRÉ, sur la démonstration, en quatre gestes.
--
-- 1. UNE RÈGLE DE L'AN PROCHAIN GOUVERNE AUJOURD'HUI. On saisit une réforme
--    annoncée, à effet dans trois cents jours : moyenne de passage portée à
--    12/20, redoublement interdit. La délibération EN COURS bascule
--    immédiatement — les douze options « redouble » disparaissent de l'écran
--    et la barre passe à 12. Un censeur qui prépare l'année suivante change
--    l'année en cours, sans un mot.
--
-- 2. ET L'ÉCRAN EXPLIQUE CE BASCULEMENT PAR UN TEXTE QUI N'EXISTE PAS ICI.
--    Mot pour mot, pour une classe de 6e :
--
--       « Passage automatique en 6E. Le redoublement est interdit en première
--         année de chaque sous-cycle du primaire (arrêté 2019). »
--
--    La 6e n'est pas au primaire. L'arrêté de 2019 ne la concerne pas. Le
--    produit n'applique pas seulement la mauvaise règle : il lui invente une
--    justification légale, et c'est celle-là qu'un chef d'établissement
--    répétera à une famille qui conteste.
--
-- 3. LA PROVENANCE N'EST PAS AFFICHÉE. `source_note` était calculée, portée
--    jusqu'à l'objet `Deliberation`… et jamais rendue. La colonne qui existe
--    pour qu'on sache d'où sort une règle ne s'affiche nulle part sur l'écran
--    qui s'en sert.
--
-- 4. ET L'ABSENCE DE RÈGLE AUTORISE LE REDOUBLEMENT. Une seule ligne :
--
--       const redoublementAllowed = ctx.rule?.redoublement_allowed ?? true;
--
--    On supprime la ligne `promotion_rules` du CP1 — un niveau où l'arrêté de
--    2019 INTERDIT le redoublement — et les douze options réapparaissent.
--    Le POST est accepté. La base porte `redouble` pour un élève de CP1, et
--    l'écran annonce « 1 décision enregistrée ».
--
--    C'est le défaut typé « une configuration dangereuse n'a pas de valeur par
--    défaut », appliqué au seul endroit du produit où le défaut se paie en
--    année scolaire perdue.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE.
--
--   * `regle_de_passage(niveau, date)` — la règle EN VIGUEUR à cette date, et
--     rien d'autre. Un seul endroit, la même forme que `repository.ts` ;
--   * `regle_de_passage_a_venir(niveau, date)` — celle qui prendra effet plus
--     tard. Elle existe pour être DITE : une règle saisie d'avance est une
--     bonne pratique, la cacher était le défaut. L'écran annonce désormais
--     « une autre règle prend effet le 1er juillet 2027 ; elle ne s'applique
--     pas à cette délibération » ;
--   * `niveaux_sans_regle_de_passage(date)` — les niveaux réellement utilisés
--     par des classes de l'année en cours qui n'ont AUCUNE règle en vigueur.
--     Le tableau de bord le dit avant le conseil, pas pendant ;
--   * `redoublement_interdit_par_texte(niveau)` — l'interdiction nationale
--     telle qu'elle est encodée dans `levels` (primaire, première année de
--     sous-cycle). C'est la seconde écriture du même arrêté ;
--   * `ban_redoublement_incoherent(date)` — et voici pourquoi la précédente
--     existe : l'arrêté de 2019 est encodé DEUX FOIS dans ce schéma, une fois
--     en donnée nationale (`levels.sub_cycle_position`) et une fois par école
--     (`promotion_rules.redoublement_allowed`), et RIEN ne vérifiait qu'elles
--     disent la même chose. Désormais si.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- La règle en vigueur.
--
-- L'ordre est celui de `repository.ts` : la règle du niveau l'emporte sur la
-- règle générale, et à niveau égal la plus récemment entrée en vigueur
-- l'emporte. La borne `effective_from <= p_on` est ce qui manquait.
create or replace function regle_de_passage(
  p_level text, p_on date default current_date)
returns table (level_code text, effective_from date,
               redoublement_allowed boolean, min_average_to_pass numeric,
               source_note text)
language sql stable as $$
  select pr.level_code, pr.effective_from, pr.redoublement_allowed,
         pr.min_average_to_pass, pr.source_note
    from promotion_rules pr
   where pr.effective_from <= p_on
     and (pr.level_code = p_level or pr.level_code is null)
   order by (pr.level_code is not null) desc, pr.effective_from desc
   limit 1;
$$;

comment on function regle_de_passage(text, date) is
  'La règle de passage en vigueur à cette date pour ce niveau. Aucune ligne '
  'quand il n''en existe aucune : c''est un refus de délibérer, pas une '
  'permission par défaut.';

-- ---------------------------------------------------------------------------
-- La règle à venir.
--
-- Saisir à l'avance la réforme de l'an prochain est une BONNE pratique — c'est
-- même ce pour quoi `effective_from` existe. Le défaut n'était pas de la
-- saisir, c'était de l'appliquer tout de suite sans le dire. On la rend donc
-- pour l'annoncer.
create or replace function regle_de_passage_a_venir(
  p_level text, p_on date default current_date)
returns table (effective_from date, redoublement_allowed boolean,
               min_average_to_pass numeric, source_note text)
language sql stable as $$
  select pr.effective_from, pr.redoublement_allowed, pr.min_average_to_pass,
         pr.source_note
    from promotion_rules pr
   where pr.effective_from > p_on
     and (pr.level_code = p_level or pr.level_code is null)
   order by pr.effective_from asc
   limit 1;
$$;

comment on function regle_de_passage_a_venir(text, date) is
  'La prochaine règle de passage, celle qui n''est pas encore en vigueur. '
  'Existe pour être annoncée à l''écran : une règle saisie d''avance doit se '
  'voir, sans gouverner la délibération du jour.';

-- ---------------------------------------------------------------------------
-- Les niveaux qui délibèrent sans règle.
--
-- On ne liste pas les seize niveaux du pays : seulement ceux dont l'école a
-- réellement une classe cette année. Un tableau de bord qui signale un
-- problème sur un niveau que l'établissement n'enseigne pas apprend à ne plus
-- lire les tableaux de bord.
create or replace function niveaux_sans_regle_de_passage(
  p_on date default current_date)
returns table (level_code text, classes integer)
language sql stable as $$
  select cl.level_code, count(*)::int
    from classes cl
    join academic_years ay on ay.id = cl.academic_year_id
   where ay.status = 'en_cours'
     and not exists (select 1 from regle_de_passage(cl.level_code, p_on))
   group by cl.level_code
   order by cl.level_code;
$$;

comment on function niveaux_sans_regle_de_passage(date) is
  'Les niveaux enseignés cette année pour lesquels aucune règle de passage '
  'n''est en vigueur. Le conseil de classe y est impossible : mieux vaut le '
  'savoir avant la séance que pendant.';

-- ---------------------------------------------------------------------------
-- L'interdiction nationale, telle que `levels` l'encode.
--
-- L'arrêté de 2019 interdit le redoublement en première année de chaque
-- sous-cycle du primaire : CP1, CE1, CM1. `levels` le porte en donnée
-- (`cycle = 'primaire' and sub_cycle_position = 1`) ; `promotion_rules` le
-- porte une seconde fois, par école, en `redoublement_allowed`.
create or replace function redoublement_interdit_par_texte(p_level text)
returns boolean language sql stable as $$
  select coalesce(
    (select l.cycle = 'primaire' and l.sub_cycle_position = 1
       from levels l where l.code = p_level), false);
$$;

comment on function redoublement_interdit_par_texte(text) is
  'Vrai quand l''arrêté de 2019 interdit le redoublement à ce niveau, d''après '
  'ce que `levels` encode : première année d''un sous-cycle du primaire. '
  'C''est la référence nationale, celle qui ne dépend d''aucune école.';

-- ---------------------------------------------------------------------------
-- Les deux écritures disent-elles la même chose ?
--
-- Le même arrêté est encodé deux fois dans ce schéma. Rien ne les comparait :
-- une règle d'école mal saisie — ou effacée — laissait l'interdiction
-- nationale sans effet, en silence, sur l'écran qui décide de l'année d'un
-- enfant de sept ans.
create or replace function ban_redoublement_incoherent(
  p_on date default current_date)
returns table (level_code text, interdit_par_le_texte boolean,
               autorise_par_la_regle boolean)
language sql stable as $$
  select distinct cl.level_code, true, coalesce(r.redoublement_allowed, true)
    from classes cl
    join academic_years ay on ay.id = cl.academic_year_id
    left join lateral regle_de_passage(cl.level_code, p_on) r on true
   where ay.status = 'en_cours'
     and redoublement_interdit_par_texte(cl.level_code)
     and coalesce(r.redoublement_allowed, true)
   order by cl.level_code;
$$;

comment on function ban_redoublement_incoherent(date) is
  'Les niveaux où l''arrêté de 2019 interdit le redoublement alors que la '
  'règle de l''établissement l''autorise — ou n''existe pas, ce qui revient au '
  'même puisque l''absence était lue comme une permission. Deux écritures du '
  'même texte : voici celle qui les compare.';
