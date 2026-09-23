-- ---------------------------------------------------------------------------
-- « Plafond déclaré » : le mot était du produit, la déclaration n'existait pas.
--
-- CE QUI A ÉTÉ TROUVÉ, EN TROIS TEMPS.
--
-- 1. L'ÉCRAN NOMME LA SANCTION, ET LE BOUTON PASSE QUAND MÊME. L'écran des
--    frais imprime en rouge : « Dépassement du plafond déclaré. Les lignes
--    comptées dans le plafond totalisent 78 000 FCFA pour un plafond déclaré
--    de 1 000 FCFA — soit 77 000 de trop. Facturer ainsi expose
--    l'établissement à une sanction. » Éprouvé : on appuie sur « Émettre les
--    factures » juste en dessous, et le produit répond « 12 factures émises. »
--    Rien d'autre. Douze factures à 118 000 F contre un plafond déclaré de
--    1 000 F, et la seule phrase qui parlait de sanction est restée sur
--    l'écran d'avant.
--
--    C'est la première règle du dépôt, prise en défaut sur le chemin de
--    l'argent : un affichage n'est jamais la protection. Ici l'affichage n'est
--    même pas un filtre — c'est un avertissement posé sur un autre écran que
--    le geste.
--
-- 2. LE CHIFFRE QUI DÉCIDE DE LA SANCTION BOUGE SANS NOM, SANS DATE, SANS
--    RAISON. Éprouvé : un POST, et le plafond passe de 1 000 à 9 999 999. Le
--    journal garde `{"criteres": 0}`. L'ancienne valeur n'existe plus nulle
--    part. Or le chemin le plus court, quand la grille dépasse, n'est pas de
--    baisser la grille : c'est de monter le plafond.
--
--    La règle est déjà écrite pour l'annulation d'une facture — retirer une
--    somme d'un total exige un nom, une date et une raison. Elle vaut d'abord
--    pour le chiffre qui rend toute la grille légale ou illégale.
--
-- 3. ET RIEN N'A JAMAIS ÉTÉ DÉCLARÉ. `category_assessments.status` est écrit
--    une fois, à la création, à `'brouillon'`, et plus jamais. `declared_on`
--    n'est écrit nulle part. Les deux écrans disent pourtant « déclaré » —
--    « Plafond déclaré : 200 000 FCFA, lu dans l'arrêté et inscrit au dossier
--    de catégorisation ». Le mot est une affirmation du produit sur un fait
--    qu'il ne connaît pas. Un dossier qui n'a jamais quitté l'établissement
--    n'a rien déclaré, et un chef d'établissement qui lit « déclaré » croit
--    que quelque chose a été fait.
--
-- ---------------------------------------------------------------------------
-- CE QUE CETTE MIGRATION POSE.
--
-- Le statut « declare » devient atteignable, et il est INDISSOCIABLE de sa
-- trace : catégorie, plafond, date et auteur, ou rien. Même forme que
-- `invoices_annulation_tracee`.
--
-- Le plafond garde son histoire dans une table à part. On n'écrase pas un
-- chiffre qui décide d'une sanction : on écrit le suivant à côté du
-- précédent, avec qui, quand et pourquoi.
--
-- Et l'émission des factures sait enfin dire non : `grilles_hors_plafond()`
-- rend, grille par grille, ce que l'écran affichait déjà — mais du côté où se
-- trouve le bouton.
-- ---------------------------------------------------------------------------

alter table category_assessments
  add column if not exists declared_by uuid references staff(id);

comment on column category_assessments.declared_on is
  'Le jour où le dossier a été déclaré. Tant qu''il est nul, aucun écran n''a '
  'le droit d''écrire « déclaré » : le dossier n''a pas quitté '
  'l''établissement.';
comment on column category_assessments.declared_by is
  'Qui a déclaré. Un plafond opposable à une famille porte un nom.';

-- ---------------------------------------------------------------------------
-- LE STATUT ET SA TRACE SONT INDISSOCIABLES.
--
-- « declare » exige une catégorie, un plafond, une date et un auteur ; et
-- aucun des deux derniers n'a de sens sur un dossier qui n'est pas déclaré.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'category_assessments_declaration_tracee') then
    alter table category_assessments
      add constraint category_assessments_declaration_tracee
      check (
        (status = 'declare') = (declared_on is not null)
        and (declared_on is null
             or (declared_by is not null
                 and category is not null
                 and declared_ceiling_fcfa is not null))
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- L'HISTOIRE DU PLAFOND.
--
-- Une ligne par mouvement, jamais un écrasement. `ancien` est nul à la
-- première saisie — c'est une naissance, pas une correction.
create table if not exists category_ceiling_changes (
  id                    uuid primary key default uuid_generate_v4(),
  school_id             uuid not null references schools(id) on delete cascade,
  category_assessment_id uuid not null
                          references category_assessments(id) on delete cascade,
  ancien_fcfa           integer,
  nouveau_fcfa          integer,
  ancienne_categorie    smallint,
  nouvelle_categorie    smallint,
  motif                 text,
  apres_declaration     boolean not null default false,
  par                   uuid references staff(id),
  quand                 timestamptz not null default now(),
  constraint category_ceiling_changes_motif_apres_declaration
    check (not apres_declaration or coalesce(btrim(motif), '') <> ''),
  constraint category_ceiling_changes_mouvement
    check (ancien_fcfa is distinct from nouveau_fcfa
           or ancienne_categorie is distinct from nouvelle_categorie)
);

comment on table category_ceiling_changes is
  'L''histoire du plafond déclaré et de la catégorie. Le chemin le plus court, '
  'quand la grille dépasse, n''est pas de baisser la grille : c''est de monter '
  'le plafond. Ce chemin-là laisse désormais une ligne, et après déclaration '
  'il exige un motif.';

create index if not exists category_ceiling_changes_dossier
  on category_ceiling_changes (school_id, category_assessment_id, quand desc);

alter table category_ceiling_changes enable row level security;
alter table category_ceiling_changes force row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'category_ceiling_changes'
                    and policyname = 'category_ceiling_changes_school') then
    create policy category_ceiling_changes_school on category_ceiling_changes
      using (school_id = current_school_id())
      with check (school_id = current_school_id());
  end if;
end $$;

grant select, insert on category_ceiling_changes to fasoschool_app;

-- ---------------------------------------------------------------------------
-- Le plafond du dossier, avec ce qu'on sait de son état.
--
-- Une seule lecture pour les deux écrans, afin qu'ils ne puissent plus dire
-- deux choses différentes du même chiffre.
create or replace function plafond_du_dossier()
returns table (assessment_id uuid, montant integer, categorie smallint,
               statut text, declare_le date, declare_par text,
               saisi_le timestamptz, mouvements integer)
language sql stable as $$
  select ca.id, ca.declared_ceiling_fcfa, ca.category, ca.status, ca.declared_on,
         (select u.full_name from staff sa
            left join users u on u.id = sa.user_id
           where sa.id = ca.declared_by),
         (select max(cc.quand) from category_ceiling_changes cc
           where cc.category_assessment_id = ca.id),
         (select count(*)::int from category_ceiling_changes cc
           where cc.category_assessment_id = ca.id)
    from category_assessments ca
    join academic_years ay on ay.id = ca.academic_year_id
   order by (ay.status = 'en_cours') desc, ay.starts_on desc
   limit 1;
$$;

comment on function plafond_du_dossier() is
  'Le plafond du dossier de l''année en cours, avec son état : déclaré ou '
  'seulement saisi, par qui, quand, et combien de fois il a bougé. Les écrans '
  'lisent celle-ci et pas la colonne, pour ne plus écrire « déclaré » sur un '
  'brouillon.';

-- ---------------------------------------------------------------------------
-- Les grilles qui dépassent le plafond.
--
-- Ce que l'écran des frais affichait déjà — mais rendu du côté où se trouve le
-- bouton « Émettre les factures ». Une phrase qui nomme une sanction et un
-- geste qui passe quand même ne sont pas deux défauts : c'est le même.
create or replace function grilles_hors_plafond(p_year uuid default null)
returns table (schedule_id uuid, libelle text, niveau text,
               plafonne integer, plafond integer, ecart integer)
language sql stable as $$
  with annee as (
    select coalesce(p_year, annee_en_cours()) as id
  ), p as (
    select montant from plafond_du_dossier()
  )
  select fs.id, fs.label, fs.level_code,
         coalesce(sum(fl.amount_fcfa) filter (where fl.cap_treatment = 'plafonne'), 0)::int,
         p.montant,
         (coalesce(sum(fl.amount_fcfa) filter (where fl.cap_treatment = 'plafonne'), 0)
            - p.montant)::int
    from fee_schedules fs
    join annee a on a.id = fs.academic_year_id
    cross join p
    left join fee_lines fl on fl.fee_schedule_id = fs.id
   where p.montant is not null
   group by fs.id, fs.label, fs.level_code, p.montant
  having coalesce(sum(fl.amount_fcfa) filter (where fl.cap_treatment = 'plafonne'), 0)
           > p.montant
   order by fs.label;
$$;

comment on function grilles_hors_plafond(uuid) is
  'Les grilles de frais dont les lignes « comptées dans le plafond » dépassent '
  'le plafond du dossier. Sans plafond renseigné, aucune ligne : le produit ne '
  'sait pas, et il ne devine pas.';

-- ---------------------------------------------------------------------------
-- Le dossier peut-il être déclaré, et sinon pourquoi ?
--
-- La raison est rendue avec la réponse : un refus muet renvoie le chef
-- d'établissement chercher à l'aveugle.
create or replace function dossier_declarable()
returns table (possible boolean, raison text)
language sql stable as $$
  select
    d.montant is not null and d.categorie is not null and d.statut <> 'declare',
    case
      when d.assessment_id is null then 'Aucun dossier pour l''année en cours.'
      when d.statut = 'declare' then 'Ce dossier est déjà déclaré.'
      when d.categorie is null and d.montant is null then
        'Renseignez la catégorie et le plafond avant de déclarer : ce sont les '
        || 'deux chiffres que l''arrêté demande.'
      when d.categorie is null then 'Renseignez la catégorie (1, 2 ou 3).'
      when d.montant is null then 'Renseignez le plafond déclaré, en FCFA.'
      else null
    end
  from (select * from plafond_du_dossier()) d
  right join (select 1) x on true
  limit 1;
$$;

comment on function dossier_declarable() is
  'Dit si le dossier de catégorisation peut être déclaré, et sinon ce qui '
  'manque. Déclarer n''est pas enregistrer : c''est affirmer que ces chiffres '
  'ont quitté l''établissement.';
