-- ---------------------------------------------------------------------------
-- Le registre disait « cette année » et imprimait 2024. Le tableau de bord
-- refusait de se taire sur une règle déjà confirmée.
--
-- 0023 a borné l'assiduité à l'année scolaire, là où on l'avait cherchée. Une
-- relecture systématique des autres écrans en a trouvé deux qui souffrent du
-- même mal, et l'un d'eux se contredit tout seul, à l'écran, sur une seule
-- ligne.
--
-- ---------------------------------------------------------------------------
-- I. « CE QUI REVIENT — 1 ÉLÈVE SIGNALÉ PLUSIEURS FOIS CETTE ANNÉE »
--
-- On pose dans la démonstration deux faits de discipline vieux de deux ans,
-- hors de toute année ouverte. Le registre affiche alors, mot pour mot :
--
--     Ce qui revient — 1 élève signalé plusieurs fois CETTE ANNÉE
--     BAMBARA Alizèta · 6e B · 2 faits · « 2 fois signalé, rien n'a été
--     décidé » · dernier le 16/10/2024
--
-- Le titre dit l'année. La colonne imprime 2024. La même ligne se contredit,
-- et personne ne lit la colonne de droite quand le titre a déjà répondu.
--
-- LE MÊME PIÈGE QU'EN 0023, DANS UN SECOND MODULE :
--
--     left join enrolments e on e.student_id = st.id
--                           and e.academic_year_id = $1
--
-- La borne d'année est dans le ON d'une jointure EXTERNE. Elle décide de la
-- classe affichée — et de rien d'autre. `behavior_incidents` n'est borné nulle
-- part, ni dans la liste chronologique, ni dans le décompte des récurrences.
--
-- CE QUE CELA COÛTE. Le registre existe, dit son en-tête, pour pouvoir dire au
-- conseil de classe qu'« un élève a été signalé quatre fois sans qu'on ait
-- jamais rien fait ». Sans borne, cette phrase additionne trois années
-- scolaires et la prononce sur un enfant qui avait sept ans à la première.
--
-- ---------------------------------------------------------------------------
-- II. UN POINT BLOQUANT QUE PERSONNE NE PEUT ÉTEINDRE
--
--     Les règles de notation n'ont pas été confirmées : toutes les moyennes
--     calculées restent indicatives.
--
-- Le tableau de bord le déduisait de :
--
--     select count(*) from grading_policies where source_note is not null
--
-- Toutes les lignes, toutes les dates. Or `grading_policies` est une table
-- DATÉE : `settings.ts` écrit une nouvelle ligne par année scolaire — « on
-- remplace la règle en vigueur à cette date plutôt que d'en empiler une
-- nouvelle », dit son commentaire, et c'est vrai à l'intérieur d'une année,
-- faux d'une année à l'autre — et ne touche jamais aux précédentes.
--
-- Donc : un directeur confirme ses règles en 2026. La ligne de 2026 perd sa
-- note de provenance. Celle de 2024 la garde. Le point bloquant reste allumé
-- POUR TOUJOURS, et aucun geste offert par l'écran ne peut l'éteindre —
-- confirmer de nouveau réécrit la ligne de 2026, qui est déjà propre.
--
-- Éprouvé : on ajoute une politique datée de 2024 portant une note, la
-- politique en vigueur n'en portant aucune, et le point réapparaît.
--
-- C'est la faute que le fichier `attention.ts` s'interdit dans sa première
-- phrase : « un tableau de bord qui affiche vingt indicateurs verts n'est pas
-- lu ». Un indicateur rouge que rien ne peut éteindre est pire : il apprend à
-- ne plus lire les rouges.
--
-- Le même raisonnement vaut pour les absences à justifier, comptées sur toutes
-- les années et conditionnées à l'existence d'une politique « l'absence non
-- justifiée compte zéro » — n'importe laquelle, y compris une révolue, y
-- compris une à venir.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Le prédicat, nommé une fois.
create or replace function dans_l_annee(p_date date, p_year uuid)
returns boolean language sql stable as $$
  select exists (select 1 from academic_years ay
                  where ay.id = p_year
                    and p_date between ay.starts_on and ay.ends_on);
$$;

comment on function dans_l_annee(date, uuid) is
  'Cette date tombe-t-elle dans cette année scolaire ? Écrit une fois, nommé, '
  'pour que la borne cesse d''être un `and` qu''on oublie — ou pire, qu''on '
  'place dans le ON d''une jointure externe, où il a l''apparence d''un '
  'filtre et le comportement d''un commentaire.';

-- ---------------------------------------------------------------------------
-- Les règles À CONFIRMER : celles qui gouvernent aujourd'hui, pas les autres.
--
-- Une règle révolue qui porte encore sa note de provenance n'est pas un
-- problème : c'est une archive, et elle doit rester lisible telle quelle. Ce
-- qui appelle un geste, c'est une règle EN VIGUEUR dont personne n'a confirmé
-- la source.
create or replace function regle_notation_a_confirmer(
  p_on date default current_date)
returns boolean language sql stable as $$
  select coalesce((
    select gp.source_note is not null
      from grading_policies gp
     where gp.effective_from <= p_on
     order by gp.effective_from desc
     limit 1), false);
$$;

comment on function regle_notation_a_confirmer(date) is
  'Vrai quand la politique de notation EN VIGUEUR porte encore une note de '
  'provenance non confirmée. Les politiques révolues n''entrent pas : ce sont '
  'des archives, et un point bloquant qu''aucun geste ne peut éteindre apprend '
  'à ne plus lire les points bloquants.';

create or replace function coefficients_a_confirmer(
  p_on date default current_date)
returns boolean language sql stable as $$
  select exists (
    select 1 from coefficient_sets cs
     where cs.source_note is not null
       and cs.effective_from <= p_on
       and cs.effective_from = (
         select max(x.effective_from) from coefficient_sets x
          where x.effective_from <= p_on
            and x.level_code is not distinct from cs.level_code
            and x.series_code is not distinct from cs.series_code));
$$;

comment on function coefficients_a_confirmer(date) is
  'Vrai quand au moins un jeu de coefficients EN VIGUEUR — pour son niveau et '
  'sa série — porte encore une note de provenance non confirmée.';

-- ---------------------------------------------------------------------------
-- L'absence non justifiée compte-t-elle zéro AUJOURD'HUI ?
--
-- L'ancien test était `exists (select 1 from grading_policies where
-- unjustified_absence_counts_as_zero)` : n'importe quelle ligne, de n'importe
-- quelle date, y compris une politique abandonnée depuis deux ans ou une
-- saisie d'avance pour l'an prochain.
create or replace function absence_non_justifiee_compte_zero(
  p_on date default current_date)
returns boolean language sql stable as $$
  select coalesce((
    select gp.unjustified_absence_counts_as_zero
      from grading_policies gp
     where gp.effective_from <= p_on
     order by gp.effective_from desc
     limit 1), false);
$$;

comment on function absence_non_justifiee_compte_zero(date) is
  'La politique EN VIGUEUR compte-t-elle zéro une absence non justifiée à une '
  'évaluation ? C''est ce qui rend urgent de justifier — ou pas.';

-- ---------------------------------------------------------------------------
-- Les absences à une évaluation qui attendent une explication, CETTE ANNÉE.
create or replace function absences_evaluation_a_justifier(p_year uuid)
returns integer language sql stable as $$
  select count(*)::int
    from grade_entries ge
    join evaluations ev on ev.id = ge.evaluation_id
    join terms t on t.id = ev.term_id
   where ge.is_absent and not ge.is_justified
     and t.academic_year_id = p_year;
$$;

comment on function absences_evaluation_a_justifier(uuid) is
  'Les absences à une évaluation de CETTE année qui attendent une '
  'explication. Sans la borne, un bulletin figé et remis il y a deux ans '
  'entretenait un point bloquant que plus personne ne pouvait résoudre.';
