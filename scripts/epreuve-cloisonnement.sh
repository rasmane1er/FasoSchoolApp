#!/usr/bin/env bash
#
# L'épreuve de cloisonnement.
#
# Deux établissements existent dans la même base. On se place dans le contexte
# du premier et on exige, table par table, geste par geste, de ne rien voir ni
# rien toucher du second : lecture, écriture croisée, suppression croisée, et
# le cas sans contexte du tout. C'est la promesse la plus lourde du produit —
# une fuite ici, c'est le dossier d'un enfant dans les mains d'une autre école.
#
#   ADMIN_DATABASE_URL='postgres://postgres@localhost/postgres' \
#   ./scripts/epreuve-cloisonnement.sh
#
# POURQUOI UN SCRIPT, ET PAS `psql -f` COMME AVANT.
#
# Le README prescrivait `npm run db:test:rls` « avant tout développement ». Sur
# une machine où le produit est installé, la commande échouait : le fichier SQL
# commençait par `drop role if exists fasoschool_app`, et ce rôle porte des
# droits dès qu'une base existe. Le test de sûreté du projet ne pouvait donc
# pas être lancé sur un système installé — c'est-à-dire précisément là où on
# voudrait le lancer.
#
# Et s'il avait réussi, c'eût été pire : il aurait supprimé le compte de
# l'application EN SERVICE pour le recréer avec le mot de passe « test ». Le
# test de cloisonnement était le geste le plus dangereux du dépôt.
#
# Ce script lui fabrique une base à usage unique, y applique les migrations,
# fait passer l'épreuve avec un rôle jetable, puis supprime tout. Il ne touche
# à aucune base réelle et n'a besoin d'aucun rôle existant.
#
set -euo pipefail

if [ -z "${ADMIN_DATABASE_URL:-}" ]; then
  echo "ADMIN_DATABASE_URL n'est pas défini." >&2
  echo "L'épreuve fabrique sa propre base : il lui faut une connexion" >&2
  echo "d'administration, jamais celle de l'application." >&2
  exit 2
fi

BASE="fasoschool_cloisonnement_$$"
CIBLE="$(printf '%s' "$ADMIN_DATABASE_URL" | sed -E "s#(://[^/]*)/[^?]*#\1/${BASE}#")"

nettoyer() {
  psql "$ADMIN_DATABASE_URL" -q -c "drop database if exists ${BASE}" >/dev/null 2>&1 || true
  psql "$ADMIN_DATABASE_URL" -q -c "drop role if exists fasoschool_rls_probe" >/dev/null 2>&1 || true
}
trap nettoyer EXIT

echo "--- base d'épreuve ---"
psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "create database ${BASE}"
echo "base jetable « ${BASE} » créée"

echo
echo "--- schéma ---"
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
  -f db/migrations/0016_famille_injoignable.sql \
  -f db/migrations/0017_echeancier.sql \
  -f db/migrations/0018_recu_fige.sql \
  -f db/migrations/0019_arrivee_en_cours_annee.sql \
  -f db/migrations/0020_fetes_au_dela_de_2028.sql \
  -f db/migrations/0021_dementi_absence.sql \
  -f db/migrations/0022_regle_de_passage_datee.sql \
  -f db/migrations/0023_assiduite_de_l_annee.sql \
  -f db/migrations/0024_ce_qui_est_clos_est_clos.sql \
  -f db/migrations/0025_entre_deux_trimestres.sql \
  -f db/migrations/0026_double_clic_au_guichet.sql \
  -f db/migrations/0027_annuler_une_facture.sql
echo "migrations appliquées"

echo
echo "--- épreuve ---"
psql "$CIBLE" -v ON_ERROR_STOP=1 -f db/tests/rls_isolation.sql

echo
echo "--- cloisonnement vérifié ---"
echo "Base jetable supprimée. Aucune base réelle n'a été touchée."
