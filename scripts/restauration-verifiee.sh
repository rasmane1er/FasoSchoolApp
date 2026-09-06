#!/usr/bin/env bash
#
# Restauration d'épreuve.
#
# UNE SAUVEGARDE JAMAIS RESTAURÉE N'EST PAS UNE SAUVEGARDE. C'est la seule
# phrase de ce dépôt qui mérite des majuscules. Le mode d'échec ordinaire n'est
# pas l'absence de sauvegarde : c'est une sauvegarde quotidienne, fidèle, qui
# depuis huit mois écrit un fichier vide, et dont personne ne le sait.
#
# Ce script restaure réellement l'archive dans une base jetable et COMPARE :
# les tables attendues sont-elles là, portent-elles des lignes, et l'empreinte
# du fichier est-elle celle du jour de la sauvegarde.
#
#   ADMIN_DATABASE_URL='postgres://postgres@/postgres' \
#   FASOSCHOOL_PASSPHRASE='...' \
#   ./scripts/restauration-verifiee.sh sauvegardes/fasoschool-20260906-1400.dump.gpg
#
set -euo pipefail

ARCHIVE="${1:-}"

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "Usage : $0 <archive.dump.gpg>" >&2
  exit 2
fi
if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  echo "ADMIN_DATABASE_URL n'est pas défini (droit de créer une base)." >&2
  exit 2
fi
if [ -z "${FASOSCHOOL_PASSPHRASE:-}" ]; then
  echo "FASOSCHOOL_PASSPHRASE n'est pas défini." >&2
  exit 2
fi

echo "--- empreinte ---"
EMPREINTE="${ARCHIVE%.dump.gpg}.sha256"
if [ -f "$EMPREINTE" ]; then
  ( cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$EMPREINTE")" )
else
  echo "Aucune empreinte à côté de l'archive : impossible de détecter une"
  echo "dégradation silencieuse du support. Ce n'est pas bloquant, c'est une"
  echo "faiblesse."
fi

CIBLE="fasoschool_epreuve_$$"

# Construire l'URL de la base jetable en ne remplaçant QUE le nom de base :
# une URL peut porter des paramètres (?host=/tmp/pgsock&port=5433) qu'une
# découpe naïve sur le dernier « / » emporterait avec elle.
SANS_QUERY="${ADMIN_DATABASE_URL%%\?*}"
QUERY=""
case "$ADMIN_DATABASE_URL" in
  *\?*) QUERY="?${ADMIN_DATABASE_URL#*\?}" ;;
esac
PREFIXE="${SANS_QUERY%/*}"
CIBLE_URL="${PREFIXE}/${CIBLE}${QUERY}"

nettoyer() {
  psql "$ADMIN_DATABASE_URL" -q -c "drop database if exists \"$CIBLE\"" >/dev/null 2>&1 || true
}
trap nettoyer EXIT

echo
echo "--- restauration dans une base jetable ---"
psql "$ADMIN_DATABASE_URL" -q -c "create database \"$CIBLE\""

gpg --batch --quiet --decrypt --passphrase-fd 3 "$ARCHIVE" 3<<< "$FASOSCHOOL_PASSPHRASE" \
  | pg_restore --dbname "$CIBLE_URL" --no-owner --no-privileges 2>&1 \
  | grep -v "^$" || true

echo
echo "--- vérification du contenu ---"

# Les tables sans lesquelles un établissement a tout perdu. Une restauration
# qui « réussit » en ne rendant que le schéma est un échec silencieux.
VERDICT="$(psql "$CIBLE_URL" -tA -v ON_ERROR_STOP=1 <<'SQL'
do $$
declare
  t text;
  n bigint;
  vides text[] := array[]::text[];
  attendues text[] := array[
    'schools', 'academic_years', 'terms', 'classes', 'students',
    'guardians', 'student_guardians', 'enrolments',
    'grading_policies', 'coefficients', 'evaluations', 'grade_entries',
    'invoices', 'payments', 'receipts'
  ];
begin
  foreach t in array attendues loop
    if to_regclass('public.' || t) is null then
      raise exception 'ECHEC: la table % est absente de la sauvegarde', t;
    end if;
    execute format('select count(*) from %I', t) into n;
    if n = 0 then
      vides := vides || t;
    end if;
  end loop;

  -- LE mode d'échec silencieux : une sauvegarde qui ne contient QUE le schéma.
  -- Elle se restaure sans une erreur, elle a la bonne taille à l'oeil, et elle
  -- ne rend rien. Elle doit faire échouer l'épreuve, pas l'assortir d'un
  -- avertissement que personne ne lit.
  if array_length(vides, 1) = array_length(attendues, 1) then
    raise exception
      'ECHEC: toutes les tables sont vides. Cette sauvegarde ne contient que '
      'le schema — aucune donnee ne serait recuperee.';
  end if;

  select count(*) into n from schools;
  if n = 0 then
    raise exception 'ECHEC: aucun etablissement dans la sauvegarde.';
  end if;

  -- Un établissement tout neuf peut légitimement n'avoir ni reçus ni notes.
  -- Une table vide isolée est donc signalée, pas fatale.
  if array_length(vides, 1) is not null then
    raise warning 'Tables restaurées mais VIDES : %', array_to_string(vides, ', ');
  end if;

  -- Le row-level security doit survivre à la restauration : une base restaurée
  -- sans ses politiques serait ouverte à tous les établissements à la fois.
  select count(*) into n from pg_policies where schemaname = 'public';
  if n < 50 then
    raise exception 'ECHEC: seulement % politiques RLS restaurées', n;
  end if;
  raise notice 'OK  % politiques RLS présentes', n;

  select count(*) into n from students;
  raise notice 'OK  % eleves restaures', n;
  select count(*) into n from grade_entries;
  raise notice 'OK  % notes restaurees', n;
  select count(*) into n from receipts;
  raise notice 'OK  % recus restaures', n;
end $$;
SQL
)"
echo "$VERDICT"

echo
echo "--- restauration d'épreuve réussie ---"
echo "Base jetable supprimée. La sauvegarde est exploitable."
