#!/usr/bin/env bash
#
# Préparer la base d'un serveur FasoSchool.
#
# POURQUOI CE SCRIPT EXISTE. Le README disait :
#
#     createdb fasoschool
#     createuser fasoschool_app --pwprompt        # PAS superutilisateur
#     export DATABASE_URL=postgres://fasoschool_app@localhost/fasoschool
#     npm run db:migrate
#
# Suivi à la lettre, cela ne marche pas — et échoue de deux façons dont la
# seconde est bien pire que la première :
#
#   1. `npm run db:migrate` lancé avec le rôle applicatif s'arrête à la
#      première ligne : « permission denied to create extension "uuid-ossp" ».
#      Un rôle ordinaire ne crée ni extension ni table dans une base qu'il ne
#      possède pas.
#
#   2. Si on lui donnait ce droit pour « débloquer », il DEVIENDRAIT
#      PROPRIÉTAIRE DES TABLES. Or un propriétaire peut modifier, désactiver ou
#      supprimer les politiques de row-level security qui sont l'unique
#      frontière entre deux établissements. Le cloisonnement du produit
#      reposerait alors sur la bonne conduite du compte le plus exposé.
#
# Et même en réussissant les migrations, le rôle applicatif n'aurait AUCUN
# droit sur les tables : rien dans le chemin documenté ne les lui accordait.
# La première requête de l'application aurait échoué.
#
#   ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
#   APP_ROLE=fasoschool_app APP_PASSWORD='...' \
#   ./scripts/preparer-base.sh fasoschool
#
# Le script est idempotent : on peut le relancer sur une base existante pour
# appliquer les migrations ajoutées depuis.
#
set -euo pipefail

BASE="${1:-fasoschool}"
APP_ROLE="${APP_ROLE:-fasoschool_app}"

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  echo "ADMIN_DATABASE_URL n'est pas défini." >&2
  echo "C'est la connexion d'ADMINISTRATION (superutilisateur ou propriétaire)," >&2
  echo "pas celle de l'application. Les migrations créent des extensions et des" >&2
  echo "tables : le rôle applicatif ne le peut pas, et ne doit pas le pouvoir." >&2
  exit 2
fi

# On dérive l'URL de la base cible depuis l'URL d'administration en changeant
# seulement le nom de la base : même hôte, même rôle, même socket.
CIBLE="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#(://[^/]*)/[^?]*#\1/${BASE}#")"

echo "--- base ---"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -tAc \
  "select 1 from pg_database where datname = '${BASE}'" | grep -q 1 \
  || psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c "create database \"${BASE}\""
echo "base « ${BASE} » présente"

echo
echo "--- rôle applicatif ---"
if [ -z "${APP_PASSWORD:-}" ]; then
  # Sans mot de passe on suppose une connexion par socket (peer/trust). C'est
  # le cas d'un serveur unique, qui est la cible du produit ; on le dit plutôt
  # que de fabriquer un mot de passe que personne ne notera.
  echo "APP_PASSWORD non défini : le rôle est créé sans mot de passe."
  echo "Cela ne convient QU'À une connexion par socket locale."
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "do \$\$ begin
       if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
         execute 'create role ${APP_ROLE} login';
       end if;
     end \$\$;"
else
  psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
    "do \$\$ begin
       if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
         execute format('create role ${APP_ROLE} login password %L', '${APP_PASSWORD}');
       else
         execute format('alter role ${APP_ROLE} password %L', '${APP_PASSWORD}');
       end if;
     end \$\$;"
fi

# Un superutilisateur CONTOURNE ENTIÈREMENT le row-level security. Si le rôle
# applicatif en est un, le produit n'a aucune frontière entre établissements et
# il vaut mieux s'arrêter ici que de le découvrir en production.
SUPER="$(psql "$ADMIN_DATABASE_URL" -tAc \
  "select rolsuper or rolbypassrls from pg_roles where rolname = '${APP_ROLE}'")"
if [ "$SUPER" = "t" ]; then
  echo >&2
  echo "REFUS : ${APP_ROLE} est superutilisateur ou porte BYPASSRLS." >&2
  echo "Il contournerait tout le row-level security, et un établissement" >&2
  echo "verrait les élèves des autres. Retirez-lui ces attributs." >&2
  exit 1
fi
echo "rôle « ${APP_ROLE} » présent, non privilégié"

echo
echo "--- migrations ---"
psql "$CIBLE" -v ON_ERROR_STOP=1 -q \
  -f db/migrations/0001_initial.sql \
  -f db/migrations/0002_reference_data.sql \
  -f db/migrations/0003_guardian_access.sql \
  -f db/migrations/0004_message_suivi.sql \
  -f db/migrations/0005_personnel.sql \
  -f db/migrations/0006_annulation_paiement.sql \
  -f db/migrations/0007_discipline.sql \
  -f db/migrations/0008_justifications.sql \
  -f db/migrations/0009_auth_sessions_rls.sql \
  -f db/migrations/0010_calendrier.sql \
  -f db/migrations/0011_pieces_justificatives.sql \
  -f db/migrations/0012_bulletin_conseil.sql \
  -f db/migrations/0013_examens.sql \
  -f db/migrations/0014_garde_envois.sql \
  -f db/migrations/0015_bulletin_complet.sql \
  -f db/migrations/0016_famille_injoignable.sql
echo "migrations appliquées"

echo
echo "--- droits de l'application ---"
# Le rôle applicatif lit et écrit les lignes. Il ne possède rien, ne crée rien,
# n'altère aucune politique. C'est ce qui fait que le RLS s'applique à lui.
psql "$CIBLE" -v ON_ERROR_STOP=1 -q <<SQL
grant connect on database "${BASE}" to ${APP_ROLE};
grant usage on schema public to ${APP_ROLE};
grant select, insert, update, delete on all tables in schema public to ${APP_ROLE};
grant usage, select on all sequences in schema public to ${APP_ROLE};
grant execute on all functions in schema public to ${APP_ROLE};
-- Les tables ajoutées par une migration future héritent des mêmes droits,
-- sans quoi la première d'entre elles casserait l'application en silence.
alter default privileges in schema public
  grant select, insert, update, delete on tables to ${APP_ROLE};
alter default privileges in schema public
  grant usage, select on sequences to ${APP_ROLE};
alter default privileges in schema public
  grant execute on functions to ${APP_ROLE};
SQL
echo "droits accordés (lecture-écriture des lignes, rien de plus)"

echo
echo "--- vérifications ---"
psql "$CIBLE" -v ON_ERROR_STOP=1 -q <<SQL
do \$\$
declare
  v_sans_rls int;
  v_possedees int;
  v_politiques int;
begin
  -- Toute table portant school_id doit avoir le RLS activé ET forcé. « Forcé »
  -- compte autant : sans lui, le propriétaire des tables échappe aux
  -- politiques, et une maintenance faite avec ce compte verrait tout.
  select count(*) into v_sans_rls
    from information_schema.columns c
    join pg_class t on t.relname = c.table_name
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
   where c.table_schema = 'public' and c.column_name = 'school_id'
     and (not t.relrowsecurity or not t.relforcerowsecurity);
  if v_sans_rls > 0 then
    raise exception 'ECHEC: % tables portant school_id sans RLS activé et forcé.', v_sans_rls;
  end if;

  select count(*) into v_possedees
    from pg_class t
    join pg_namespace n on n.oid = t.relnamespace and n.nspname = 'public'
    join pg_roles r on r.oid = t.relowner
   where t.relkind = 'r' and r.rolname = '${APP_ROLE}';
  if v_possedees > 0 then
    raise exception 'ECHEC: le role applicatif possede % tables. Un proprietaire peut supprimer les politiques qui separent les etablissements.', v_possedees;
  end if;

  select count(*) into v_politiques from pg_policies where schemaname = 'public';
  if v_politiques < 50 then
    raise exception 'ECHEC: seulement % politiques RLS. Le cloisonnement est incomplet.', v_politiques;
  end if;

  raise notice 'OK  % politiques RLS, RLS force partout, aucune table possedee par l applicatif', v_politiques;
end \$\$;
SQL

echo
echo "--- base prête ---"
echo "DATABASE_URL de l'application :"
echo "  postgres://${APP_ROLE}@.../${BASE}      (sans droit de créer quoi que ce soit)"
echo
echo "Ensuite, pour installer un établissement — avec le rôle APPLICATIF,"
echo "pas celui d'administration : l'installateur n'a besoin d'aucun privilège"
echo "particulier, et il vaut mieux qu'il n'en ait pas."
echo "  DATABASE_URL=... npm run installer -- --nom ... --chef ... --telephone ..."
