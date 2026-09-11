-- ---------------------------------------------------------------------------
-- Les résultats aux examens — et pourquoi ils décident du plafond des frais.
--
-- CE QUI EXISTAIT SANS SERVIR. `students.cep_result` et
-- `students.concours_6e_result` sont dans le schéma depuis la première
-- migration, avec leurs contraintes de valeur. Aucune ligne de code ne les a
-- jamais lues ni écrites : il n'existe aucun écran pour saisir un résultat
-- d'examen.
--
-- POURQUOI CE N'EST PAS UN DÉTAIL. L'arrêté n°2026-101 note la qualité sur
-- 50 points, et « Résultats aux examens » est le critère le plus lourd de cet
-- axe. C'est aussi l'argument central pour lequel un établissement achète un
-- logiciel de gestion plutôt qu'un tableur : la moitié qualité de la grille
-- réclame des chiffres — résultats aux examens, effectifs par classe — qu'un
-- système de gestion produit comme sous-produit, et qu'une école sans système
-- doit rassembler à la main chaque année.
--
-- Un logiciel qui stocke les résultats d'examen sans jamais les relire ne
-- produit pas ce sous-produit. Il ne soutient donc pas l'argument qui le vend.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION AJOUTE : LE BEPC ET LE BAC.
--
-- Les deux colonnes existantes couvrent la fin du PRIMAIRE : le CEP et le
-- concours d'entrée en sixième, passés en CM2. Un collège n'en passe aucun —
-- l'établissement de démonstration est précisément un collège. Sans le BEPC,
-- l'écran des examens n'aurait rien à montrer là où il sert le plus.
--
-- Le BAC suit, pour un établissement qui va jusqu'à la terminale. Les deux
-- reprennent exactement les valeurs des colonnes existantes : trois états, et
-- `non_presente` distinct de `refuse`. Un élève qui ne s'est pas présenté ne
-- compte pas dans un taux de réussite, et confondre les deux fabriquerait un
-- chiffre faux dans un dossier remis au ministère.
-- ---------------------------------------------------------------------------

alter table students
  add column if not exists bepc_result text,
  add column if not exists bac_result text;

do $$
begin
  alter table students
    add constraint students_bepc_connu check (
      bepc_result is null or bepc_result in ('admis', 'refuse', 'non_presente'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table students
    add constraint students_bac_connu check (
      bac_result is null or bac_result in ('admis', 'refuse', 'non_presente'));
exception when duplicate_object then null;
end $$;

comment on column students.bepc_result is
  'Résultat au BEPC, passé en 3e. `non_presente` n''est PAS `refuse` : un '
  'absent ne compte pas dans un taux de réussite.';
comment on column students.bac_result is
  'Résultat au baccalauréat, passé en terminale. Mêmes valeurs que le BEPC.';

-- ---------------------------------------------------------------------------
-- Le taux de réussite, calculé à un seul endroit.
--
-- Une fonction plutôt qu'une requête recopiée dans l'écran des examens, dans
-- le dossier de catégorisation et dans les tests : trois copies d'un même
-- calcul finissent par diverger, et celle qui part au ministère est celle
-- qu'on ne relit pas.
--
-- LA RÈGLE, ÉCRITE UNE FOIS : le dénominateur est le nombre de PRÉSENTÉS,
-- jamais l'effectif de la classe. Compter les non-présentés comme des échecs
-- rendrait le taux faux — vers le bas — dans un dossier dont dépend le plafond
-- légal des frais.
create or replace function taux_reussite(
  p_examen text, p_annee uuid
) returns table (presentes int, admis int, taux numeric) language sql stable as $$
  with copies as (
    select case p_examen
             when 'cep' then st.cep_result
             when 'concours_6e' then st.concours_6e_result
             when 'bepc' then st.bepc_result
             when 'bac' then st.bac_result
           end as resultat
      from enrolments e
      join students st on st.id = e.student_id
      join classes cl on cl.id = e.class_id
     where cl.academic_year_id = p_annee
  )
  select count(*) filter (where resultat in ('admis', 'refuse'))::int,
         count(*) filter (where resultat = 'admis')::int,
         case when count(*) filter (where resultat in ('admis', 'refuse')) = 0
              then null
              else round(100.0 * count(*) filter (where resultat = 'admis')
                       / count(*) filter (where resultat in ('admis', 'refuse')), 1)
         end
    from copies;
$$;

comment on function taux_reussite(text, uuid) is
  'Taux de réussite à un examen pour une année scolaire. Le dénominateur est '
  'le nombre de PRÉSENTÉS : un élève non présenté n''est pas un échec.';

-- Les effectifs par classe — l'autre chiffre que la grille qualité réclame et
-- qu'un établissement sans logiciel recompte à la main chaque année.
create or replace function effectifs_par_classe(p_annee uuid)
returns table (classe text, effectif int) language sql stable as $$
  select cl.label, count(e.student_id)::int
    from classes cl
    left join enrolments e on e.class_id = cl.id
   where cl.academic_year_id = p_annee
   group by cl.id, cl.label
   order by cl.label;
$$;
