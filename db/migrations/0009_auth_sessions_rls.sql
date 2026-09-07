-- ---------------------------------------------------------------------------
-- Le row-level security manquant sur `auth_sessions`.
--
-- Trouvé en écrivant `scripts/preparer-base.sh`, qui refuse de déclarer une
-- base prête tant qu'une table portant `school_id` n'a pas le RLS activé ET
-- forcé. Une seule table manquait, et c'était celle-ci.
--
-- `auth_sessions` porte l'empreinte du jeton de session de chaque membre du
-- personnel, de TOUS les établissements. Sans politique, une requête faite
-- dans le contexte d'une école lisait et modifiait les sessions des autres.
--
-- La table jumelle, `guardian_sessions`, avait été protégée dès la migration
-- 0003 — avec ce commentaire : « c'est la table dont une fuite serait la plus
-- grave ». La règle était donc connue et appliquée à la porte ouverte vers
-- l'extérieur ; celle du personnel, héritée du premier schéma, était restée
-- sans politique. C'est le mode d'échec ordinaire d'une règle de sûreté :
-- elle tient là où on y pense.
--
-- CE QUI CONTINUE DE FONCTIONNER, ET POURQUOI. Les quatre fonctions
-- d'authentification (`auth_create_session`, `auth_resolve`, `auth_revoke`,
-- `auth_lookup_user`) sont `security definer` : elles s'exécutent avec les
-- droits du PROPRIÉTAIRE des tables. La connexion a lieu avant tout contexte
-- d'établissement — il n'existe pas encore — donc ces fonctions doivent
-- traverser le RLS. C'est précisément pourquoi le projet exige depuis le
-- début que le propriétaire des tables porte BYPASSRLS et ne soit JAMAIS le
-- rôle applicatif : `force row level security` s'applique au propriétaire
-- aussi, sans cet attribut.
--
-- En revanche, une requête directe de l'application — révoquer les sessions
-- de quelqu'un qu'on écarte, par exemple — est désormais bornée à son propre
-- établissement, ce qu'elle n'était pas.
--
-- Migration additive.
-- ---------------------------------------------------------------------------

alter table auth_sessions enable row level security;
alter table auth_sessions force row level security;

drop policy if exists auth_sessions_tenant_isolation on auth_sessions;
create policy auth_sessions_tenant_isolation on auth_sessions
  using (school_id = current_school_id())
  with check (school_id = current_school_id());

comment on table auth_sessions is
  'Sessions du personnel. Sous RLS depuis la migration 0009 : elle ne l''était '
  'pas, alors que sa jumelle `guardian_sessions` l''était depuis 0003. Les '
  'fonctions d''authentification la traversent parce qu''elles sont security '
  'definer et que le propriétaire des tables porte BYPASSRLS.';
