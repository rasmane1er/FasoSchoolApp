# -----------------------------------------------------------------------------
# SchoolFaso — image de production.
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

# CETTE IMAGE N'INSTALLE RIEN.
#
# Elle a d'abord installé `postgresql-client` (pour `psql`, qu'utilisait la
# commande de release) et `gnupg`. Le constructeur d'images de Railway n'a pas
# d'accès aux miroirs Debian : `apt-get install` y meurt en trois secondes, sur
# un « context canceled », et trois tentatives n'y changent rien.
#
# On aurait pu ruser. La conclusion est meilleure : une image de production qui
# a besoin d'installer un paquet pour démarrer dépend, LE JOUR OÙ ELLE DÉMARRE,
# d'un réseau qu'elle ne contrôle pas. Or ce dont la mise en ligne a besoin,
# c'est d'exécuter du SQL — et le produit embarque déjà `pg`, sa seule
# dépendance. `scripts/preparer-base.mjs` fait donc en Node ce que le script
# shell fait avec `psql`, et l'image n'a plus rien à installer.
#
# Ce qui reste hors de cette image, et c'est dit plutôt que caché : les
# sauvegardes chiffrées (`sauvegarde.sh`) ont besoin de `pg_dump` et de `gpg`.
# Elles tourneront depuis une image qui les porte, ou depuis une machine qui
# les a. Voir DEPLOIEMENT.md.

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
