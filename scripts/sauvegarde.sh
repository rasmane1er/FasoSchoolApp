#!/usr/bin/env bash
#
# Sauvegarde chiffrée de la base FasoSchool.
#
# Le scénario réel n'est pas une attaque sophistiquée : c'est l'ordinateur du
# secrétariat volé, le disque qui lâche en pleine composition, ou la clé USB
# oubliée dans un taxi. Le fichier produit ici contient les noms, les dates de
# naissance et les numéros des familles de tout un établissement — il est donc
# chiffré, toujours, et jamais écrit en clair sur le disque, même une seconde.
#
#   FASOSCHOOL_PASSPHRASE='...' ./scripts/sauvegarde.sh /media/usb
#
# Produit :
#   fasoschool-AAAAMMJJ-HHMM.dump.gpg   la sauvegarde
#   fasoschool-AAAAMMJJ-HHMM.sha256     son empreinte, pour détecter une clé
#                                       USB qui se dégrade en silence
#
set -euo pipefail

DEST="${1:-.}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL n'est pas défini." >&2
  exit 2
fi
if [ -z "${FASOSCHOOL_PASSPHRASE:-}" ]; then
  echo "FASOSCHOOL_PASSPHRASE n'est pas défini." >&2
  echo "Une sauvegarde en clair des données d'élèves ne doit pas exister." >&2
  exit 2
fi
if [ ! -d "$DEST" ]; then
  echo "Destination introuvable : $DEST" >&2
  exit 2
fi

HORODATAGE="$(date +%Y%m%d-%H%M)"
BASENAME="fasoschool-${HORODATAGE}"
ARCHIVE="${DEST}/${BASENAME}.dump.gpg"
EMPREINTE="${DEST}/${BASENAME}.sha256"

# pg_dump écrit sur la sortie standard et gpg chiffre au vol : le contenu en
# clair ne touche jamais le disque.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | gpg --batch --yes --symmetric --cipher-algo AES256 \
        --passphrase-fd 3 --output "$ARCHIVE" 3<<< "$FASOSCHOOL_PASSPHRASE"

chmod 600 "$ARCHIVE"
( cd "$DEST" && sha256sum "${BASENAME}.dump.gpg" > "${BASENAME}.sha256" )

TAILLE="$(du -h "$ARCHIVE" | cut -f1)"
echo "Sauvegarde écrite : ${ARCHIVE} (${TAILLE})"
echo "Empreinte         : ${EMPREINTE}"
echo
echo "Une sauvegarde jamais restaurée n'est pas une sauvegarde."
echo "Lancez ./scripts/restauration-verifiee.sh une fois par mois."
