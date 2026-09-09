-- ---------------------------------------------------------------------------
-- Les pièces justificatives du dossier de catégorisation.
--
-- CE QUI ÉTAIT FAUX. `category_criteria.evidence_key` est un champ de texte
-- libre. L'écran l'appelait « pièce justificative », comptait les critères
-- « sans pièce » et les affichait en rouge, et annonçait le reste comme
-- « justifié ». Or il suffisait de TAPER quelque chose dans la case pour que
-- le critère devienne justifié. Rien n'était joint, rien n'était vérifié.
--
-- La démonstration aggravait la chose : elle semait des valeurs de la forme
-- `evidence/bati.pdf`, qui ressemblent à des chemins de fichiers réels et
-- apprennent à l'utilisateur que la case veut dire « un document est attaché ».
-- Aucun de ces fichiers n'existait nulle part.
--
-- POURQUOI CELA COMPTE PLUS QU'AILLEURS. L'arrêté n°2026-101 fait dépendre le
-- PLAFOND LÉGAL des frais de scolarité du score sur 100. Un dossier qui
-- s'annonce justifié à l'écran et se présente vide devant l'inspection, c'est
-- le score revu à la baisse, donc le plafond revu à la baisse, sur une année
-- déjà facturée. Les points accordés sans pièce sont d'ailleurs la première
-- chose qu'une inspection retire.
--
-- ---------------------------------------------------------------------------
-- POURQUOI LES OCTETS VONT DANS LA BASE ET NON SUR LE DISQUE.
--
-- `documents.storage_key` suggérait un stockage objet. Il n'y en a pas, et il
-- n'y en aura pas : le produit tourne sur un seul VPS.
--
-- Restaient deux options. Un répertoire à côté de la base — et alors la
-- sauvegarde éprouvée (`scripts/sauvegarde.sh`, qui chiffre un `pg_dump` et
-- dont la restauration est vérifiée) ne couvre plus qu'une moitié du dossier.
-- Ce serait la SECONDE chose à sauvegarder, celle dont personne ne se souvient
-- le jour où le disque meurt, et on l'apprendrait en restaurant un dossier de
-- catégorisation dont toutes les pièces ont disparu.
--
-- Ou les octets dans la base, en `bytea`. `pg_dump --format=custom` les
-- emporte sans qu'on ait rien à ajouter, et la procédure de restauration déjà
-- éprouvée les ramène. Un dossier de catégorisation, c'est une quinzaine de
-- photos et de PDF : quelques mégaoctets. Le coût est nul, la garantie est
-- entière. C'est la deuxième option.
-- ---------------------------------------------------------------------------

alter table documents
  add column if not exists category_criterion_id uuid
    references category_criteria(id) on delete cascade,
  add column if not exists content bytea,
  add column if not exists sha256 text,
  add column if not exists uploaded_by_user uuid references users(id);

comment on column documents.content is
  'Les octets du fichier. Dans la base, et non sur le disque, pour que la '
  'sauvegarde déjà éprouvée les emporte — voir l''en-tête de 0011.';

-- Une pièce sans contenu n'est pas une pièce. La contrainte ne vaut que pour
-- les lignes rattachées à un critère : les autres usages de `documents`
-- (bulletins, reçus) n'existent pas encore et garderont leur liberté.
do $$
begin
  alter table documents
    add constraint documents_piece_a_un_contenu check (
      category_criterion_id is null
      or (content is not null and byte_size is not null and sha256 is not null)
    );
exception when duplicate_object then null;
end $$;

-- Cinq mégaoctets. Assez pour une photo de téléphone ou un PDF scanné,
-- assez peu pour qu'un dossier complet tienne dans une sauvegarde qu'on
-- transporte sur une clé USB.
do $$
begin
  alter table documents
    add constraint documents_taille_raisonnable check (
      byte_size is null or byte_size between 1 and 5242880
    );
exception when duplicate_object then null;
end $$;

create index if not exists documents_par_critere
  on documents (category_criterion_id) where category_criterion_id is not null;

-- Le même fichier joint deux fois au même critère est une erreur de manipulation,
-- pas une intention. On l'empêche plutôt que de le dédoublonner après coup.
create unique index if not exists documents_pas_deux_fois_la_meme_piece
  on documents (category_criterion_id, sha256)
  where category_criterion_id is not null and status = 'actif';

-- ---------------------------------------------------------------------------
-- `evidence_key` cesse d'être une preuve.
--
-- La colonne reste, mais elle redevient ce qu'elle aurait toujours dû être :
-- une DESCRIPTION de ce que la pièce doit montrer, écrite par l'établissement
-- pour lui-même. Ce qui justifie un critère, désormais, est l'existence d'un
-- document attaché — quelque chose que l'on ne peut pas obtenir en tapant.
comment on column category_criteria.evidence_key is
  'Description en clair de la pièce attendue (« photo du bâtiment principal »). '
  'N''EST PAS une preuve : un critère n''est justifié que s''il porte au moins '
  'un document dans `documents`. Voir l''en-tête de 0011.';

-- Les faux chemins semés par la démonstration sont remplacés par ce qu'ils
-- auraient dû être : la description de la pièce, sans faire croire à un
-- fichier. On ne touche qu'aux valeurs qui ont exactement cette forme.
update category_criteria
   set evidence_key = null
 where evidence_key ~ '^evidence/[a-z]+\.pdf$';

-- ---------------------------------------------------------------------------
-- Combien de pièces porte un critère.
--
-- Une fonction plutôt qu'un compte recopié dans chaque requête : l'écran, le
-- calcul du « sans pièce » et les tests doivent compter la MÊME chose.
create or replace function pieces_du_critere(p_critere uuid)
returns integer language sql stable as $$
  select count(*)::int from documents
   where category_criterion_id = p_critere and status = 'actif';
$$;
