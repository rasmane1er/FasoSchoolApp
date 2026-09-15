-- ---------------------------------------------------------------------------
-- Entre deux trimestres, le produit disait « Trimestre 1 ».
--
-- CE QUI A ÉTÉ TROUVÉ EN DÉPLAÇANT LES DATES DES TRIMESTRES. Le socle de
-- presque toutes les pages est cette requête, et son commentaire dit ce qu'elle
-- croit faire : « Année et trimestre EN COURS » :
--
--     select ay.id as year_id, t.id as term_id, t.sequence, ...
--       from academic_years ay join terms t on t.academic_year_id = ay.id
--      where ay.status = 'en_cours'
--      order by (current_date between t.starts_on and t.ends_on) desc, t.sequence
--      limit 1
--
-- Le tri est juste : le trimestre qui contient aujourd'hui passe devant. Mais
-- quand AUCUN ne le contient, le `limit 1` prend la première ligne du second
-- critère — `t.sequence` — c'est-à-dire LE TRIMESTRE 1, toujours, quelle que
-- soit la saison.
--
-- Or une année scolaire burkinabè n'est pas une suite continue de trimestres.
-- Il y a des congés entre chacun, et le dernier se termine des semaines avant
-- la clôture de l'année. Dans le jeu de démonstration : quinze jours entre le
-- premier et le deuxième trimestre, et quarante-six jours après le troisième.
-- Soit plus de deux mois par an où le produit se trompe de trimestre, tous les
-- ans, pour toutes les écoles.
--
-- ÉPROUVÉ, TROIS FOIS :
--
--   * pendant les congés entre T1 et T2 — l'en-tête affiche « Trimestre 1 » et
--     le tableau de bord écrit « trimestre 1, CLÔTURE LE 10/09/2026 », une date
--     déjà passée. L'écran imprime une échéance révolue et l'appelle l'échéance
--     en cours ;
--   * après le dernier trimestre, l'année n'étant pas close — « Trimestre 1,
--     clôture le 27/02/2026 », SEPT MOIS en arrière. Un censeur qui revient en
--     fin d'année est silencieusement placé dans le trimestre dont les
--     bulletins ont été remis aux familles en octobre ;
--   * et même quand le trimestre 1 est CLOS, l'écran de saisie s'ouvre dessus.
--     Le refus n'arrive qu'à l'enregistrement, après que l'enseignant a saisi
--     sa colonne de notes.
--
-- CE QUE CELA COÛTE. `period.term_id` commande la saisie des notes, les
-- évaluations, les bulletins, les points d'attention et l'en-tête de chaque
-- page. Une note saisie pendant les congés d'octobre entre donc dans le
-- trimestre 1 — celui dont le bulletin est figé et distribué. Personne n'a
-- menti, personne n'a cliqué de travers, et le carnet est faux.
--
-- ---------------------------------------------------------------------------
-- LA RÈGLE. Le produit ne devine pas un trimestre.
--
-- C'est la doctrine de ce dépôt appliquée au calendrier : quand il ne sait pas,
-- il le dit, au lieu de choisir. `trimestre_du_jour()` rend NULL s'il n'y a pas
-- de trimestre aujourd'hui — pas de repli, pas de premier par défaut. Et
-- `situation_de_l_annee()` NOMME la situation, avec ce qui vient de finir et ce
-- qui va commencer, pour que l'écran puisse écrire une phrase vraie au lieu
-- d'un numéro faux.
-- ---------------------------------------------------------------------------

-- Le trimestre qui contient cette date. NULL s'il n'y en a pas — et « NULL »
-- se lit « nous ne sommes dans aucun trimestre », jamais « prenez le premier ».
create or replace function trimestre_du_jour(p_on date default current_date)
returns uuid language sql stable as $$
  select t.id
    from terms t
    join academic_years ay on ay.id = t.academic_year_id
   where ay.status = 'en_cours'
     and p_on between t.starts_on and t.ends_on
   order by t.sequence
   limit 1;
$$;

comment on function trimestre_du_jour(date) is
  'Le trimestre de l''année en cours qui contient cette date, ou NULL. Aucun '
  'repli : le repli sur `t.sequence` plaçait tout le produit dans le trimestre '
  '1 pendant les congés et après le dernier trimestre — plus de deux mois par '
  'an.';

-- ---------------------------------------------------------------------------
-- Où en est l'année, en toutes lettres.
--
--   aucune_annee      aucune année n'est ouverte
--   avant_le_premier  l'année est ouverte, le premier trimestre n'a pas commencé
--   en_trimestre      nous sommes dans un trimestre — le cas ordinaire
--   entre_trimestres  congés : l'un est fini, le suivant n'a pas commencé
--   apres_le_dernier  le dernier trimestre est terminé, l'année court encore
--   hors_annee        aujourd'hui est hors des bornes de l'année ouverte
create or replace function situation_de_l_annee(p_on date default current_date)
returns table (
  etat text,
  year_id uuid,
  term_id uuid,
  sequence smallint,
  precedent_id uuid,
  precedente_sequence smallint,
  precedente_fin date,
  suivant_id uuid,
  suivante_sequence smallint,
  suivant_debut date
) language sql stable as $$
  with an as (
    select id, starts_on, ends_on from academic_years
     where status = 'en_cours' limit 1),
  courant as (
    select t.id, t.sequence from terms t, an
     where t.academic_year_id = an.id
       and p_on between t.starts_on and t.ends_on
     order by t.sequence limit 1),
  avant as (
    select t.id, t.sequence, t.ends_on from terms t, an
     where t.academic_year_id = an.id and t.ends_on < p_on
     order by t.ends_on desc limit 1),
  apres as (
    select t.id, t.sequence, t.starts_on from terms t, an
     where t.academic_year_id = an.id and t.starts_on > p_on
     order by t.starts_on limit 1)
  select
    case
      when (select count(*) from an) = 0 then 'aucune_annee'
      when (select count(*) from courant) = 1 then 'en_trimestre'
      when p_on < (select starts_on from an)
        or p_on > (select ends_on from an) then 'hors_annee'
      when (select count(*) from avant) = 0 then 'avant_le_premier'
      when (select count(*) from apres) = 0 then 'apres_le_dernier'
      else 'entre_trimestres'
    end,
    (select id from an),
    (select id from courant), (select sequence from courant),
    (select id from avant), (select sequence from avant),
    (select ends_on from avant),
    (select id from apres), (select sequence from apres),
    (select starts_on from apres);
$$;

comment on function situation_de_l_annee(date) is
  'Où en est l''année scolaire aujourd''hui, nommé : en_trimestre, '
  'entre_trimestres, avant_le_premier, apres_le_dernier, hors_annee, '
  'aucune_annee — avec le trimestre qui vient de finir et celui qui va '
  'commencer. Un écran qui connaît sa situation peut écrire une phrase vraie ; '
  'sans elle, il écrivait « Trimestre 1 » toute l''année.';

-- ---------------------------------------------------------------------------
-- Combien de jours de l'année ne sont dans aucun trimestre ?
--
-- Pour que le tableau de bord puisse le dire à l'installation, et pour que
-- personne ne redécouvre dans trois ans que « plus de deux mois par an » n'est
-- pas une façon de parler.
create or replace function jours_hors_trimestre(p_year uuid)
returns integer language sql stable as $$
  select greatest(0, (
    select (ay.ends_on - ay.starts_on + 1)
           - coalesce((select sum(t.ends_on - t.starts_on + 1)::int
                         from terms t where t.academic_year_id = ay.id), 0)
      from academic_years ay where ay.id = p_year));
$$;

comment on function jours_hors_trimestre(uuid) is
  'Le nombre de jours de cette année scolaire qui ne tombent dans aucun '
  'trimestre : congés intercalaires et queue de l''année. Ce sont les jours '
  'pendant lesquels le produit affichait « Trimestre 1 ».';
