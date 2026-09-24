-- ---------------------------------------------------------------------------
-- Une vérification n'est pas une contrainte.
--
-- CE QUI A ÉTÉ TROUVÉ, EN CLIQUANT PLUSIEURS FOIS SUR « AJOUTER LA CLASSE ».
-- Dix POST simultanés — le geste humain normal sur une connexion lente, celle
-- que ce produit vise — et la base porte :
--
--     classes « 6e Z » : 6
--
-- Six classes identiques, six identifiants différents. Le tableau de bord les
-- liste six fois, avec six effectifs distincts ; les inscriptions se
-- répartissent entre elles ; le bulletin d'un élève est calculé dans une
-- classe, l'appel se fait dans une autre, et personne ne comprend pourquoi le
-- rang de l'enfant n'a pas de sens.
--
-- LE CODE AVAIT POURTANT UNE GARDE :
--
--     select 1 from classes where academic_year_id = $1 and label = $2
--     if (exists.rowCount > 0) return { error: `La classe ${label} existe déjà.` }
--
-- Elle est correcte. Elle est même lisible. Et elle ne protège rien : entre le
-- `select` et l'`insert`, une autre requête passe. Six des dix ont lu avant
-- qu'aucune n'ait écrit. C'est très exactement la première règle du dépôt —
-- *un affichage n'est jamais la protection* — appliquée un cran plus bas :
-- **une lecture n'est jamais la protection non plus.** Ce qui protège, c'est
-- ce que la base refuse.
--
-- ---------------------------------------------------------------------------
-- ET CE N'ÉTAIT PAS LE SEUL ENDROIT.
--
-- Le dépôt a été relu à la recherche de cette forme exacte — une lecture
-- « est-ce que ça existe déjà ? » suivie d'une écriture. Sept endroits. Trois
-- avaient une contrainte d'unicité derrière eux : `academic_years`,
-- `category_criteria`, `teacher_assignments`. Quatre n'en avaient aucune :
--
--   * `classes` (année, libellé) — la classe en double, ci-dessus ;
--   * `evaluations` (classe, trimestre, matière, type, date) — le MÊME devoir
--     compté deux fois dans une moyenne, ce qui fausse un bulletin sans qu'une
--     seule note soit fausse ;
--   * `fee_schedules` (année, niveau) — deux grilles de frais pour le même
--     niveau, donc deux factures pour le même enfant ;
--   * `livret_entries` (élève, année) — deux fois la même année sur le livret
--     scolaire, qui est un document que l'élève emporte.
--
-- Quatre sur sept : la garde en code était jouée à pile ou face. C'est
-- pourquoi cette migration pose les quatre contraintes manquantes dans la
-- base, et non quatre corrections dans quatre fichiers — la même raison qui
-- met le cloisonnement dans le RLS et l'histoire d'une note dans un
-- déclencheur. Ce qui doit valoir pour tous les chemins d'écriture se pose là
-- où tous les chemins passent.
--
-- ---------------------------------------------------------------------------
-- CE QUE FAIT CETTE MIGRATION QUAND LA BASE PORTE DÉJÀ DES DOUBLONS.
--
-- Elle s'arrête, et elle dit lesquels. Elle n'en supprime aucun et n'en
-- renomme aucun.
--
-- Deux classes « 6e A » qui portent chacune des élèves, deux grilles de frais
-- qui ont chacune servi à facturer : choisir laquelle survit n'est pas une
-- décision de logiciel. En trancher une à l'aveugle, c'est effacer les
-- inscriptions d'un côté ou les factures de l'autre — et *ce qui est sorti de
-- l'établissement ne se rature pas*.
--
-- Pour que ce refus ne soit pas une découverte du jour du déploiement,
-- `doublons_a_trancher()` les liste, et DEPLOIEMENT.md dit de la lire avant.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. CE QUI EST EN DOUBLE, ET QUI DOIT ÊTRE TRANCHÉ PAR QUELQU'UN.
--
-- Rendue AVANT la pose des contraintes, pour qu'on puisse la lire sur une base
-- en service sans rien risquer. Elle reste après, et répond « rien » : c'est
-- alors la preuve que les contraintes tiennent.
create or replace function doublons_a_trancher()
returns table (quoi text, cle text, combien integer)
language sql stable as $$
  select 'classes', c.label || ' — ' || ay.label, count(*)::int
    from classes c join academic_years ay on ay.id = c.academic_year_id
   group by c.school_id, c.academic_year_id, c.label, ay.label
  having count(*) > 1
  union all
  select 'evaluations',
         coalesce(ev.label, ev.eval_type) || ' — ' || coalesce(ev.held_on::text, 'sans date'),
         count(*)::int
    from evaluations ev
   group by ev.school_id, ev.class_id, ev.term_id, ev.subject_id, ev.eval_type,
            ev.held_on, ev.label
  having count(*) > 1
  union all
  select 'fee_schedules', fs.label || ' — ' || coalesce(fs.level_code, 'tous niveaux'),
         count(*)::int
    from fee_schedules fs
   group by fs.school_id, fs.academic_year_id, fs.level_code, fs.label
  having count(*) > 1
  union all
  select 'livret_entries', le.academic_year_label, count(*)::int
    from livret_entries le
   group by le.school_id, le.student_id, le.academic_year_label
  having count(*) > 1;
$$;

comment on function doublons_a_trancher() is
  'Ce que quatre tables portent en double et qu''aucune machine ne peut '
  'trancher : choisir quelle « 6e A » survit, c''est effacer les élèves de '
  'l''autre. À lire AVANT un déploiement — la migration 0032 s''arrête si '
  'cette fonction rend quoi que ce soit.';

-- ---------------------------------------------------------------------------
-- 2. ON S'ARRÊTE PLUTÔT QUE DE CHOISIR À LA PLACE DE QUELQU'UN.
do $$
declare
  v_liste text;
begin
  select string_agg(quoi || ' : ' || cle || ' (×' || combien || ')', E'\n  ')
    into v_liste
    from doublons_a_trancher();

  if v_liste is not null then
    raise exception using
      message = 'Des doublons existent déjà et la contrainte ne peut pas être posée sans en effacer un.',
      detail  = E'\n  ' || v_liste,
      hint    = 'Aucune ligne n''a été touchée. Lisez « select * from '
                || 'doublons_a_trancher() », tranchez à la main — déplacer les '
                || 'élèves, annuler les factures — puis relancez le '
                || 'déploiement. Choisir à votre place effacerait les '
                || 'inscriptions d''un côté ou les factures de l''autre.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. LES QUATRE SERRURES.
--
-- `school_id` est en tête de chaque clé : ce n'est pas une précaution de
-- cloisonnement — le RLS s'en charge — mais la vérité de la règle. Deux écoles
-- ont chacune une « 6e A », et c'est normal.
--
-- `create unique index if not exists` : rejouable, comme tout ce qui tourne à
-- chaque déploiement.

-- 3a. Une classe par (année, libellé). Le libellé est ce que la garde du code
--     comparait déjà — c'est lui que le chef d'établissement voit et saisit.
create unique index if not exists classes_une_par_annee_et_libelle
  on classes (school_id, academic_year_id, label);

comment on index classes_une_par_annee_et_libelle is
  'Dix clics simultanés créaient six « 6e Z ». La garde était une lecture, et '
  'une lecture ne protège rien : six avaient lu avant qu''aucune n''ait écrit.';

-- 3b. Une évaluation par (classe, trimestre, matière, type, date). C'est
--     exactement le `select` que faisait le code, rendu opposable. `held_on`
--     peut être nul — deux devoirs sans date, même matière, même trimestre,
--     sont le doublon que la garde visait : `coalesce` les rend comparables,
--     là où un index nu laisserait passer deux nuls.
create unique index if not exists evaluations_une_par_classe_et_date
  on evaluations (school_id, class_id, term_id, subject_id, eval_type,
                  coalesce(held_on, '0001-01-01'::date));

comment on index evaluations_une_par_classe_et_date is
  'Le même devoir compté deux fois fausse une moyenne sans qu''une seule note '
  'soit fausse — et c''est la moyenne qu''une famille conteste.';

-- 3c. Une grille de frais par (année, niveau). `level_code` nul signifie
--     « tous niveaux » : c'est une valeur, pas une absence de valeur, et deux
--     grilles « tous niveaux » sont un doublon.
create unique index if not exists fee_schedules_une_par_annee_et_niveau
  on fee_schedules (school_id, academic_year_id, coalesce(level_code, ''));

comment on index fee_schedules_une_par_annee_et_niveau is
  'Deux grilles pour le même niveau, c''est deux factures pour le même enfant.';

-- 3d. Une ligne de livret par (élève, année).
--
--     ATTENTION, CE N'EST PAS UNE SIMPLE TRADUCTION DU CODE. Deux chemins
--     écrivaient cette table et ne disaient pas la même chose : l'import d'une
--     scolarité extérieure refusait l'année si elle existait, tandis que le
--     conseil de classe ne regardait que les lignes NON externes — il pouvait
--     donc ajouter une seconde ligne pour une année déjà portée par un
--     transfert. Le livret est un document que l'élève emporte : une année ne
--     s'y lit qu'une fois. C'est la règle du transfert qui est retenue, et le
--     conseil s'y plie.
create unique index if not exists livret_entries_une_par_eleve_et_annee
  on livret_entries (school_id, student_id, academic_year_label);

comment on index livret_entries_une_par_eleve_et_annee is
  'Le livret est un document que l''élève emporte : une année ne s''y lit '
  'qu''une fois. Deux chemins l''écrivaient avec deux règles différentes.';
