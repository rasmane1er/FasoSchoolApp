# -----------------------------------------------------------------------------
# FasoSchool — image de production.
#
# CE QU'ELLE CONTIENT, ET CE QU'ELLE NE CONTIENT PAS.
#
# Pas d'étape de compilation. Node 22 lit le TypeScript directement
# (`--experimental-strip-types`) : il retire les annotations de type et
# exécute. Il n'y a donc aucun artefact intermédiaire à produire, à versionner
# ou à désynchroniser de sa source — ce qui tourne en production est
# exactement le fichier qu'on lit dans le dépôt.
#
# Une seule dépendance à installer : `pg`. `npm ci --omit=dev` la pose et rien
# d'autre ; Playwright, TypeScript et le reste de l'outillage restent hors de
# l'image. C'est ce qui la garde à quelques dizaines de mégaoctets et ce qui
# réduit la surface de ce qu'un jour on devra corriger en urgence.
#
# L'image ne contient PAS les migrations exécutées automatiquement au
# démarrage. Un conteneur qui migre en démarrant migre aussi quand il
# redémarre en boucle, et deux instances qui démarrent ensemble migrent en
# même temps. La migration est une commande de RELEASE, lancée une fois, et
# `railway.json` la déclare comme telle.
# -----------------------------------------------------------------------------

FROM node:22-bookworm-slim

# `postgresql-client` pour `psql` : la commande de release l'utilise pour
# appliquer les migrations, et `scripts/sauvegarde.sh` pour `pg_dump`.
# `gnupg` pour le chiffrement des sauvegardes — une sauvegarde en clair est
# une fuite de données qui attend son heure.
# APT RÉESSAIE. Le premier déploiement a échoué ici sur un « context
# canceled » : le réseau du constructeur avait lâché au milieu. Un échec
# transitoire qui casse une mise en ligne coûte plus cher que trois lignes.
RUN set -eux; \
    for essai in 1 2 3; do \
      apt-get update && \
      apt-get install -y --no-install-recommends \
        postgresql-client gnupg ca-certificates && break; \
      echo "apt a échoué (essai $essai), nouvelle tentative"; sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Les dépendances d'abord : cette couche ne change que lorsque le verrou
# change, donc presque jamais.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# ON NE TOURNE PAS EN ROOT. Le processus n'a besoin d'écrire nulle part :
# aucune session sur disque, aucun cache, aucun envoi de fichier stocké
# localement — les pièces jointes vivent dans la base.
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Le garde de démarrage du serveur refuse de booter si `SMS_PROVIDER` n'est
# pas posé : une configuration dangereuse n'a pas de valeur par défaut.
CMD ["node", "--experimental-strip-types", "src/server/app.ts"]
