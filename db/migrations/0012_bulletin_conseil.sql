-- ---------------------------------------------------------------------------
-- Ce que le conseil de classe décide, et que le bulletin n'imprimait pas.
--
-- CE QUI ÉTAIT PERDU. L'écran du conseil de classe fait saisir, élève par
-- élève, une DÉCISION (admis, redouble, réorienté…) et une APPRÉCIATION. Le
-- censeur y passe la séance entière. Les deux partent dans
-- `conseil_decisions`, et s'y arrêtent.
--
-- Le bulletin, lui, imprime un cadre « Appréciation du conseil de classe »
-- contenant DEUX LIGNES POINTILLÉES VIDES. Autrement dit : le logiciel
-- recueille quarante appréciations, puis imprime quarante cadres vides que
-- quelqu'un doit recopier à la main. C'est exactement le travail que ce
-- produit prétend supprimer, et c'est le document sur lequel il sera jugé.
--
-- Même chose pour le professeur principal. Le bulletin porte une ligne de
-- signature « Le professeur principal » — sans nom. La colonne
-- `classes.professeur_principal_id` existe depuis le premier schéma et
-- personne ne l'a jamais renseignée : aucun écran ne le permettait.
--
-- ---------------------------------------------------------------------------
-- POURQUOI DES COPIES DANS `bulletins` ET NON UNE JOINTURE.
--
-- Un bulletin publié est un DOCUMENT REMIS AUX FAMILLES. Réimprimé six mois
-- plus tard, il doit sortir identique. Si l'appréciation était lue en direct
-- dans `conseil_decisions`, la moindre correction ultérieure changerait
-- rétroactivement un papier déjà signé et distribué — et personne ne saurait
-- que les deux exemplaires diffèrent.
--
-- C'est la règle déjà appliquée aux moyennes, au rang et à la mention : la
-- publication FIGE. Ces colonnes suivent la même règle.
-- ---------------------------------------------------------------------------

alter table bulletins
  add column if not exists decision_conseil text,
  add column if not exists professeur_principal text;

comment on column bulletins.appreciation_generale is
  'Copie figée de conseil_decisions.appreciation au moment de la publication. '
  'Un bulletin remis aux familles ne change pas quand on corrige la source.';
comment on column bulletins.decision_conseil is
  'Copie figée de la décision du conseil. Ne concerne que le bulletin qui la '
  'porte — en pratique celui du dernier trimestre.';
comment on column bulletins.professeur_principal is
  'Le NOM du professeur principal au moment de la publication, pas son '
  'identifiant : s''il quitte l''établissement, le bulletin déjà remis doit '
  'continuer de porter celui qui l''a signé.';

-- La contrainte de valeur reste celle de la source, pour qu'une décision
-- inconnue ne puisse pas se glisser dans un document imprimé.
do $$
begin
  alter table bulletins
    add constraint bulletins_decision_connue check (
      decision_conseil is null or decision_conseil in
        ('admis', 'admis_par_compensation', 'redouble', 'exclu', 'reoriente')
    );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Le professeur principal : la clé étrangère qui manquait.
--
-- `classes.professeur_principal_id` était déclarée `uuid` avec, en commentaire,
-- « FK ajoutée plus bas ». Elle ne l'a jamais été. La colonne acceptait donc
-- n'importe quel identifiant — y compris celui d'un membre du personnel d'un
-- AUTRE établissement, que le row-level security aurait ensuite rendu
-- invisible : une classe dont le professeur principal n'existe pas.
do $$
begin
  alter table classes
    add constraint classes_professeur_principal_fk
      foreign key (professeur_principal_id) references staff(id) on delete set null;
exception when duplicate_object then null;
end $$;

create index if not exists classes_par_professeur_principal
  on classes (professeur_principal_id) where professeur_principal_id is not null;
