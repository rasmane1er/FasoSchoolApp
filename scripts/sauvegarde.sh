#!/usr/bin/env bash
#
# Sauvegarde chiffrée de la base SchoolFaso.
#
# Le scénario réel n'est pas une attaque sophistiquée : c'est l'ordinateur du
# secrétariat volé, le disque qui lâche en pleine composition, ou la clé USB
# oubliée dans un taxi. Le fichier produit ici contient les noms, les dates de
# naissance et les numéros des familles de tout un établissement — il est donc
# chiffré, toujours, et jamais écrit en clair sur le disque, même une seconde.
#
#   ADMIN_DATABASE_URL='postgres://postgres@/schoolfaso' \
#   SCHOOLFASO_PASSPHRASE='...' ./scripts/sauvegarde.sh /media/usb
#
# ADMIN_DATABASE_URL, et NON DATABASE_URL. Le rôle applicatif est soumis au
# row-level security : `pg_dump` lancé avec lui échoue table par table
# (« query would be affected by row-level security policy ») et ne sauvegarde
# RIEN. Ce script demandait DATABASE_URL jusqu'ici — un établissement qui
# suivait la documentation à la lettre n'avait donc aucune sauvegarde, et,
# avant le garde-fou ci-dessous, un fichier de soixante-dix octets pour le lui
# faire croire. La sauvegarde se fait avec le propriétaire des tables, qui
# porte BYPASSRLS et n'est jamais le rôle de l'application.
#
# Produit :
#   schoolfaso-AAAAMMJJ-HHMM.dump.gpg   la sauvegarde
#   schoolfaso-AAAAMMJJ-HHMM.sha256     son empreinte, pour détecter une clé
#                                       USB qui se dégrade en silence
#
set -euo pipefail

DEST="${1:-.}"

SOURCE="${ADMIN_DATABASE_URL:-}"
if [ -z "$SOURCE" ]; then
  echo "ADMIN_DATABASE_URL n'est pas défini." >&2
  echo >&2
  echo "Ce n'est PAS DATABASE_URL. Le rôle applicatif est soumis au" >&2
  echo "row-level security : pg_dump lancé avec lui ne sauvegarde rien." >&2
  echo "Utilisez le propriétaire des tables, qui porte BYPASSRLS." >&2
  exit 2
fi
if [ -z "${SCHOOLFASO_PASSPHRASE:-}" ]; then
  echo "SCHOOLFASO_PASSPHRASE n'est pas défini." >&2
  echo "Une sauvegarde en clair des données d'élèves ne doit pas exister." >&2
  exit 2
fi
if [ ! -d "$DEST" ]; then
  echo "Destination introuvable : $DEST" >&2
  exit 2
fi

HORODATAGE="$(date +%Y%m%d-%H%M)"
BASENAME="schoolfaso-${HORODATAGE}"
ARCHIVE="${DEST}/${BASENAME}.dump.gpg"
EMPREINTE="${DEST}/${BASENAME}.sha256"

# Une sauvegarde ratée ne doit RIEN laisser derrière elle. Sans ce filet, un
# pg_dump qui échoue (base arrêtée, mot de passe changé, disque plein) laissait
# un fichier .dump.gpg de quelques dizaines d'octets, à côté des bonnes
# sauvegardes, avec un nom parfaitement crédible. C'est exactement le fichier
# qu'on restaurera un jour de panne, en croyant tenir ses données.
nettoyer_si_echec() {
  local code=$?
  if [ "$code" -ne 0 ]; then
    rm -f "$ARCHIVE" "$EMPREINTE"
    echo "Sauvegarde ÉCHOUÉE : rien n'a été conservé." >&2
    echo "Un fichier tronqué serait pire que pas de fichier du tout." >&2
  fi
  return "$code"
}
trap nettoyer_si_echec EXIT

# pg_dump écrit sur la sortie standard et gpg chiffre au vol : le contenu en
# clair ne touche jamais le disque.
pg_dump --format=custom --no-owner --no-privileges "$SOURCE" \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 --output "$ARCHIVE" 3<<< "$SCHOOLFASO_PASSPHRASE"

chmod 600 "$ARCHIVE"

# Une archive plus petite qu'un schéma vide n'est pas une archive. Le seuil est
# volontairement bas : il ne prétend pas juger du contenu — c'est le travail de
# l'épreuve de restauration — seulement écarter le fichier manifestement mort.
OCTETS="$(stat -c %s "$ARCHIVE" 2>/dev/null || stat -f %z "$ARCHIVE")"
if [ "$OCTETS" -lt 4096 ]; then
  echo "Archive de ${OCTETS} octets : c'est impossible pour une base réelle." >&2
  exit 1
fi

( cd "$DEST" && sha256sum "${BASENAME}.dump.gpg" > "${BASENAME}.sha256" )

TAILLE="$(du -h "$ARCHIVE" | cut -f1)"
echo "Sauvegarde écrite : ${ARCHIVE} (${TAILLE})"
echo "Empreinte         : ${EMPREINTE}"
echo
echo "Une sauvegarde jamais restaurée n'est pas une sauvegarde."
echo "Lancez ./scripts/restauration-verifiee.sh une fois par mois."
