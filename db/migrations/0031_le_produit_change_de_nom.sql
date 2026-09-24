-- ---------------------------------------------------------------------------
-- Le produit change de nom : FasoSchool devient SchoolFaso.
--
-- CE QUI EST EN JEU, ET CE QUI NE L'EST PAS. Renommer un produit est d'ordinaire
-- une affaire de texte. Ici, une chaîne de caractères porte la frontière entre
-- deux établissements :
--
--     current_setting('fasoschool.school_id')
--
-- C'est le réglage de session que lit `current_school_id()`, dont dépend CHAQUE
-- politique de row-level security. Le code applicatif le pose, la base le lit.
-- Renommer l'un sans l'autre ne provoque pas une fuite — il provoque le
-- contraire : plus aucune ligne n'est visible, et le produit s'arrête net. Bruyant
-- plutôt que silencieux, ce qui est la bonne façon d'échouer ; mais il n'y a
-- aucune raison de l'infliger à une école un mardi matin.
--
-- CE QUE FAIT CETTE MIGRATION. `current_school_id()` lit désormais le nouveau
-- nom, et RETOMBE sur l'ancien s'il ne trouve rien. Une base déjà en service
-- continue donc de fonctionner pendant que le code se met à jour, dans l'ordre
-- que l'on veut, sans fenêtre où rien ne marche.
--
-- La fonction est `create or replace` : elle est remplacée à chaque
-- déploiement, y compris sur les bases où la migration fondatrice — qui l'avait
-- créée — n'est plus rejouée.
--
-- ET ON NE RENOMME NI LES TABLES, NI LES COLONNES, NI LES POLITIQUES. Elles ne
-- portent pas le nom du produit. Le seul endroit où il apparaissait dans la
-- base était ce réglage de session, et les noms de rôles — qui, eux, sont des
-- objets d'administration, créés par `preparer-base`, et qu'une base neuve
-- reçoit déjà sous leur nouveau nom.
-- ---------------------------------------------------------------------------

create or replace function current_school_id()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('schoolfaso.school_id', true), ''),
      /* L'ANCIEN NOM, LE TEMPS QUE TOUT SOIT À JOUR. Une base en service ne
         doit pas cesser de répondre parce qu'un déploiement est passé avant
         l'autre. On garde la retombée : elle ne coûte rien, et le jour où on
         la retirera, `tests/cloisonnement.e2e.mjs` dira si quelque chose la
         lisait encore. */
      nullif(current_setting('fasoschool.school_id', true), ''),
      ''
    ), '')::uuid;
$$;

comment on function current_school_id() is
  'L''établissement de la session. C''est la seule valeur dont dépendent '
  'toutes les politiques de row-level security : sans elle, aucune ligne. Lit '
  '« schoolfaso.school_id », et retombe sur « fasoschool.school_id » — le nom '
  'd''avant — pour qu''une base en service ne s''arrête pas entre deux '
  'déploiements.';

-- ---------------------------------------------------------------------------
-- LA SOURCE DE SAISIE D'UNE NOTE, même raisonnement.
--
-- Le déclencheur qui écrit l'histoire d'une note lit d'où parle le code. Non
-- posé, il retombe sur « online » — le chemin normal — donc un décalage de
-- déploiement ne perdrait rien d'autre que la précision de l'étiquette. On le
-- traite quand même : une histoire de note qui ment sur son origine est
-- précisément ce que 0029 existe pour empêcher.
create or replace function source_de_saisie()
returns text language sql stable as $$
  select case
    when coalesce(nullif(current_setting('schoolfaso.grade_source', true), ''),
                  nullif(current_setting('fasoschool.grade_source', true), ''), '')
         in ('online', 'offline', 'import', 'correction')
      then coalesce(nullif(current_setting('schoolfaso.grade_source', true), ''),
                    nullif(current_setting('fasoschool.grade_source', true), ''))
    else 'online'
  end;
$$;

comment on function source_de_saisie() is
  'D''où vient la note qu''on écrit : le code le dit par un réglage de '
  'session, comme il dit déjà de quel établissement il parle. Lit le nouveau '
  'nom, retombe sur l''ancien, et « online » à défaut — un oubli doit tomber '
  'sur le cas le plus probable, pas sur un refus.';
